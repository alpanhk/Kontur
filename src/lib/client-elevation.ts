import type { ProviderId } from "./types";

/**
 * Fallback pengambilan elevasi langsung dari browser pengguna apabila server
 * berada di lingkungan tanpa akses internet keluar (mis. sandbox preview).
 * Menggunakan AWS Terrarium HD (z15, 24-bit RGB PNG via Canvas + interpolasi bikubik Catmull-Rom)
 * serta fallback REST ke Open-Meteo Elevation API (CORS terbuka).
 */

interface LatLon {
  lat: number;
  lon: number;
}

const tileCache = new Map<string, Float32Array | null>();
const MAX_CACHE = 96;

function putTileCache(key: string, val: Float32Array | null) {
  if (tileCache.size >= MAX_CACHE) {
    const first = tileCache.keys().next().value;
    if (first !== undefined) tileCache.delete(first);
  }
  tileCache.set(key, val);
}

function cubic1d(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

function sampleTileBicubic(data: Float32Array, fx: number, fy: number): number | null {
  const w = 256;
  const h = 256;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = fx - ix;
  const ty = fy - iy;

  const at = (x: number, y: number): number | null => {
    const cx = Math.max(0, Math.min(w - 1, x));
    const cy = Math.max(0, Math.min(h - 1, y));
    const v = data[cy * w + cx];
    if (!Number.isFinite(v) || v < -12000 || v > 10000) return null;
    return v;
  };

  let okCubic = true;
  const rows = [0, 0, 0, 0];
  for (let j = -1; j <= 2; j++) {
    const v0 = at(ix - 1, iy + j);
    const v1 = at(ix, iy + j);
    const v2 = at(ix + 1, iy + j);
    const v3 = at(ix + 2, iy + j);
    if (v0 == null || v1 == null || v2 == null || v3 == null) {
      okCubic = false;
      break;
    }
    rows[j + 1] = cubic1d(v0, v1, v2, v3, tx);
  }
  if (okCubic) {
    const res = cubic1d(rows[0], rows[1], rows[2], rows[3], ty);
    if (Number.isFinite(res)) return res;
  }

  const a = at(ix, iy);
  const b = at(ix + 1, iy);
  const c = at(ix, iy + 1);
  const d = at(ix + 1, iy + 1);
  if (a != null && b != null && c != null && d != null) {
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }
  return a ?? b ?? c ?? d ?? null;
}

function latLonToTileFloat(lat: number, lon: number, z: number): [number, number] {
  const n = 2 ** z;
  const clampedLat = Math.max(-85.0511, Math.min(85.0511, lat));
  const xf = ((lon + 180) / 360) * n;
  const rad = (clampedLat * Math.PI) / 180;
  const yf = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
  return [xf, yf];
}

async function decodeTerrariumTileInBrowser(
  z: number,
  x: number,
  y: number,
  signal?: AbortSignal,
): Promise<Float32Array | null> {
  const key = `${z}/${x}/${y}`;
  if (tileCache.has(key)) return tileCache.get(key) ?? null;

  const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
  const res = await fetch(url, { mode: "cors", signal });
  if (res.status === 404) {
    putTileCache(key, null);
    return null;
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Canvas 2D tidak tersedia.");
    ctx.drawImage(bitmap, 0, 0, 256, 256);
    const d = ctx.getImageData(0, 0, 256, 256).data;
    const out = new Float32Array(256 * 256);
    for (let i = 0, p = 0; i < out.length; i++, p += 4) {
      out[i] = d[p] * 256 + d[p + 1] + d[p + 2] / 256 - 32768;
    }
    putTileCache(key, out);
    return out;
  } finally {
    bitmap.close();
  }
}

async function fetchBrowserTerrarium(locs: LatLon[], signal?: AbortSignal): Promise<(number | null)[]> {
  let zoom = 15;
  for (const z of [15, 14, 13, 12, 11]) {
    const tiles = new Set<string>();
    for (const l of locs) {
      const [xf, yf] = latLonToTileFloat(l.lat, l.lon, z);
      tiles.add(`${Math.floor(xf)}/${Math.floor(yf)}`);
    }
    zoom = z;
    if (tiles.size <= 32) break;
  }

  const needed = new Map<string, { x: number; y: number }>();
  const coords = locs.map((l) => {
    const [xf, yf] = latLonToTileFloat(l.lat, l.lon, zoom);
    const tx = Math.floor(xf);
    const ty = Math.floor(yf);
    const key = `${tx}/${ty}`;
    if (!needed.has(key)) needed.set(key, { x: tx, y: ty });
    return { key, px: (xf - tx) * 256 - 0.5, py: (yf - ty) * 256 - 0.5 };
  });

  const entries = Array.from(needed.entries());
  const loaded = new Map<string, Float32Array | null>();
  let cursor = 0;
  const worker = async () => {
    while (cursor < entries.length) {
      const [k, { x, y }] = entries[cursor++];
      loaded.set(k, await decodeTerrariumTileInBrowser(zoom, x, y, signal));
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, entries.length) }, () => worker()));

  return coords.map(({ key, px, py }) => {
    const tile = loaded.get(key);
    if (!tile) return null;
    const v = sampleTileBicubic(tile, px, py);
    return v == null ? null : Math.round(v * 1000) / 1000;
  });
}

async function fetchBrowserOpenMeteo(locs: LatLon[], signal?: AbortSignal): Promise<(number | null)[]> {
  const out: (number | null)[] = new Array(locs.length).fill(null);
  const CHUNK = 100;
  for (let i = 0; i < locs.length; i += CHUNK) {
    const slice = locs.slice(i, i + CHUNK);
    const lat = slice.map((l) => l.lat.toFixed(6)).join(",");
    const lon = slice.map((l) => l.lon.toFixed(6)).join(",");
    const res = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`, {
      mode: "cors",
      signal,
    });
    if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
    const data = (await res.json()) as { elevation?: unknown[] };
    if (!Array.isArray(data.elevation)) throw new Error("Respons Open-Meteo tidak valid.");
    data.elevation.forEach((v, k) => {
      out[i + k] = typeof v === "number" && Number.isFinite(v) ? v : null;
    });
  }
  return out;
}

export async function fetchElevationsInBrowser(
  provider: ProviderId,
  locs: LatLon[],
  signal?: AbortSignal,
): Promise<(number | null)[]> {
  if (provider === "open-meteo") {
    try {
      return await fetchBrowserOpenMeteo(locs, signal);
    } catch {
      return fetchBrowserTerrarium(locs, signal);
    }
  }
  try {
    return await fetchBrowserTerrarium(locs, signal);
  } catch {
    return fetchBrowserOpenMeteo(locs, signal);
  }
}
