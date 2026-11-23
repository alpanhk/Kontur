import { fromUrl, type GeoTIFFImage } from "geotiff";
import { PNG } from "pngjs";
import type { ProviderId, ProviderInfo } from "./types";

/**
 * Penyedia data elevasi beresolusi tinggi (server-side).
 * 1. copernicus-glo30 : ESA Copernicus DEM GLO-30 (Float32 30m COG via AWS Open Data) + interpolasi bikubik
 * 2. aws-terrarium-hd : AWS Terrain Tiles HD (Terrarium z15/z14 RGB 24-bit sub-meter) + interpolasi bikubik
 * 3. opentopodata-*   : SRTM 30m / ASTER 30m (OpenTopoData, interpolasi cubic)
 * 4. open-meteo       : Copernicus 90m
 * 5. google           : Google Elevation API (butuh GOOGLE_MAPS_API_KEY)
 */

export interface LatLon {
  lat: number;
  lon: number;
}

const PROVIDER_DEFS: Omit<ProviderInfo, "available" | "reason">[] = [
  {
    id: "copernicus-glo30",
    label: "Copernicus DEM GLO-30 HD (Float32 · Rekomendasi)",
    description:
      "DEM 30 m ilmiah paling akurat (ESA/Airbus Float32 EGM2008, interpolasi bikubik). Cepat, tanpa batas rate, kontur halus & presisi.",
    maxBatch: 5000,
    minIntervalMs: 0,
  },
  {
    id: "aws-terrarium-hd",
    label: "AWS Terrain Tiles HD (Terrarium z15 · Super Cepat)",
    description:
      "Grid elevasi 24-bit sub-meter (~5 m/piksel, gabungan DEM & LiDAR global, interpolasi bikubik). Sangat cepat untuk puluhan ribu titik.",
    maxBatch: 5000,
    minIntervalMs: 0,
  },
  {
    id: "opentopodata-srtm30m",
    label: "SRTM 30 m (OpenTopoData)",
    description: "NASA SRTM 30 m (60°LS–60°LU). Gratis tanpa kunci, dibatasi ±1 permintaan/detik.",
    maxBatch: 100,
    minIntervalMs: 1100,
  },
  {
    id: "opentopodata-aster30m",
    label: "ASTER GDEM 30 m (OpenTopoData)",
    description: "ASTER GDEM 30 m (83°LS–83°LU). Gratis tanpa kunci, dibatasi ±1 permintaan/detik.",
    maxBatch: 100,
    minIntervalMs: 1100,
  },
  {
    id: "open-meteo",
    label: "Copernicus DEM 90 m (Open-Meteo)",
    description: "Resolusi 90 m global, gratis untuk non-komersial.",
    maxBatch: 100,
    minIntervalMs: 0,
  },
  {
    id: "google",
    label: "Google Elevation API",
    description: "Sumber elevasi Google (mirip Google Earth). Membutuhkan GOOGLE_MAPS_API_KEY di .env.",
    maxBatch: 100,
    minIntervalMs: 0,
  },
  {
    id: "simulasi-dem",
    label: "Model Topografi Lokal (Offline / Demo)",
    description:
      "Model permukaan medan sintetis kontinu untuk pengujian kontur, profil, dan ekspor CAD/GIS tanpa koneksi internet.",
    maxBatch: 5000,
    minIntervalMs: 0,
  },
];

export function listProviders(): ProviderInfo[] {
  const hasGoogleKey = Boolean(process.env.GOOGLE_MAPS_API_KEY?.trim());
  return PROVIDER_DEFS.map((p) =>
    p.id === "google"
      ? {
          ...p,
          available: hasGoogleKey,
          reason: hasGoogleKey ? null : "Isi GOOGLE_MAPS_API_KEY di file .env untuk mengaktifkan sumber ini.",
        }
      : { ...p, available: true, reason: null },
  );
}

/** Interpolasi Catmull-Rom kubik 1D untuk 4 nilai [p0, p1, p2, p3] pada t ∈ [0,1]. */
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

/** Interpolasi bikubik 4×4 (fallback ke bilinear jika di tepi atau ada NoData). */
function sampleRasterBicubic(
  data: Float32Array | Float64Array,
  w: number,
  h: number,
  fx: number,
  fy: number,
  nodata = -9999,
): number | null {
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = fx - ix;
  const ty = fy - iy;

  const at = (x: number, y: number): number | null => {
    const cx = Math.max(0, Math.min(w - 1, x));
    const cy = Math.max(0, Math.min(h - 1, y));
    const v = data[cy * w + cx];
    if (!Number.isFinite(v) || v <= nodata + 1 || v < -12000 || v > 10000) return null;
    return v;
  };

  // Coba bikubik 4×4
  let okCubic = true;
  const rows: number[] = [0, 0, 0, 0];
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

  // Fallback bilinear 2×2
  const a = at(ix, iy);
  const b = at(ix + 1, iy);
  const c = at(ix, iy + 1);
  const d = at(ix + 1, iy + 1);
  if (a != null && b != null && c != null && d != null) {
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }
  return a ?? b ?? c ?? d ?? null;
}

// ======================== 1. AWS TERRARIUM HD (RGB PNG) ========================

const terrariumCache = new Map<string, Float32Array | null>();
const MAX_TERRARIUM_CACHE = 96;

function setTerrariumCache(key: string, val: Float32Array | null) {
  if (terrariumCache.size >= MAX_TERRARIUM_CACHE) {
    const first = terrariumCache.keys().next().value;
    if (first !== undefined) terrariumCache.delete(first);
  }
  terrariumCache.set(key, val);
}

async function fetchTerrariumTile(z: number, x: number, y: number): Promise<Float32Array | null> {
  const key = `${z}/${x}/${y}`;
  if (terrariumCache.has(key)) return terrariumCache.get(key) ?? null;

  const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "TopoKontur/2.0" },
        signal: AbortSignal.timeout(12000),
        cache: "no-store",
      });
      if (res.status === 404) {
        setTerrariumCache(key, null);
        return null;
      }
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}`);
        await sleep(300 * (attempt + 1));
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const png = PNG.sync.read(buf);
      const out = new Float32Array(256 * 256);
      const d = png.data;
      for (let i = 0, p = 0; i < out.length; i++, p += 4) {
        out[i] = d[p] * 256 + d[p + 1] + d[p + 2] / 256 - 32768;
      }
      setTerrariumCache(key, out);
      return out;
    } catch (err) {
      lastErr = err;
      if (attempt === 0) await sleep(200);
    }
  }
  throw new Error(`Gagal memuat tile elevasi AWS Terrarium (${key}): ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

function latLonToTileFloat(lat: number, lon: number, z: number): [number, number] {
  const n = 2 ** z;
  const clampedLat = Math.max(-85.0511, Math.min(85.0511, lat));
  const xf = ((lon + 180) / 360) * n;
  const rad = (clampedLat * Math.PI) / 180;
  const yf = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
  return [xf, yf];
}

async function fetchAwsTerrarium(locs: LatLon[]): Promise<(number | null)[]> {
  // Pilih zoom optimal (z15 untuk area ≤ 30 tile, turun otomatis bila sangat luas agar tetap cepat)
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

  // Kumpulkan semua tile yang diperlukan (termasuk tile tetangga jika titik dekat tepi piksel? Cukup tile utama + clamping halus)
  const needed = new Map<string, { x: number; y: number }>();
  const coords = locs.map((l) => {
    const [xf, yf] = latLonToTileFloat(l.lat, l.lon, zoom);
    const tx = Math.floor(xf);
    const ty = Math.floor(yf);
    const key = `${tx}/${ty}`;
    if (!needed.has(key)) needed.set(key, { x: tx, y: ty });
    return { key, px: (xf - tx) * 256 - 0.5, py: (yf - ty) * 256 - 0.5 };
  });

  // Unduh tile paralel (maks 8 bersamaan)
  const entries = Array.from(needed.entries());
  const loaded = new Map<string, Float32Array | null>();
  let cursor = 0;
  const worker = async () => {
    while (cursor < entries.length) {
      const [k, { x, y }] = entries[cursor++];
      loaded.set(k, await fetchTerrariumTile(zoom, x, y));
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, entries.length) }, () => worker()));

  return coords.map(({ key, px, py }) => {
    const tile = loaded.get(key);
    if (!tile) return null;
    const v = sampleRasterBicubic(tile, 256, 256, px, py);
    return v == null ? null : Math.round(v * 1000) / 1000;
  });
}

// ======================== 2. COPERNICUS GLO-30 COG (Float32) ========================

interface CopTileMeta {
  url: string;
  missing: boolean;
  originX: number;
  originY: number;
  resX: number;
  resY: number;
  width: number;
  height: number;
  image: GeoTIFFImage | null;
}

const copMetaCache = new Map<string, CopTileMeta>();

function copTileKey(lat: number, lon: number): { key: string; url: string } {
  const latF = Math.floor(lat);
  const lonF = Math.floor(lon);
  const ns = `${latF < 0 ? "S" : "N"}${String(Math.abs(latF)).padStart(2, "0")}`;
  const ew = `${lonF < 0 ? "W" : "E"}${String(Math.abs(lonF)).padStart(3, "0")}`;
  const name = `Copernicus_DSM_COG_10_${ns}_00_${ew}_00_DEM`;
  return {
    key: `${ns}_${ew}`,
    url: `https://copernicus-dem-30m.s3.amazonaws.com/${name}/${name}.tif`,
  };
}

async function getCopMeta(key: string, url: string): Promise<CopTileMeta> {
  const hit = copMetaCache.get(key);
  if (hit) return hit;

  try {
    const head = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(12000) });
    if (head.status === 404) {
      const miss: CopTileMeta = { url, missing: true, originX: 0, originY: 0, resX: 1, resY: -1, width: 0, height: 0, image: null };
      copMetaCache.set(key, miss);
      return miss;
    }
    const tiff = await fromUrl(url);
    const image = await tiff.getImage();
    const [originX, originY] = image.getOrigin();
    const [resX, resY] = image.getResolution();
    const meta: CopTileMeta = {
      url,
      missing: false,
      originX,
      originY,
      resX,
      resY,
      width: image.getWidth(),
      height: image.getHeight(),
      image,
    };
    if (copMetaCache.size > 16) {
      const first = copMetaCache.keys().next().value;
      if (first !== undefined) copMetaCache.delete(first);
    }
    copMetaCache.set(key, meta);
    return meta;
  } catch {
    // Jika gagal membuka COG, tandai missing agar bisa fallback ke Terrarium
    return { url, missing: true, originX: 0, originY: 0, resX: 1, resY: -1, width: 0, height: 0, image: null };
  }
}

async function fetchCopernicusGlo30(locs: LatLon[]): Promise<(number | null)[]> {
  const groups = new Map<string, { url: string; indices: number[] }>();
  locs.forEach((l, idx) => {
    const { key, url } = copTileKey(l.lat, l.lon);
    const g = groups.get(key);
    if (g) g.indices.push(idx);
    else groups.set(key, { url, indices: [idx] });
  });

  const out: (number | null)[] = new Array(locs.length).fill(null);
  const fallbackIndices: number[] = [];

  for (const [key, { url, indices }] of groups.entries()) {
    const meta = await getCopMeta(key, url);
    if (meta.missing || !meta.image) {
      for (const i of indices) fallbackIndices.push(i);
      continue;
    }

    // Hitung jendela raster minimum untuk semua titik pada tile 1° ini
    let minC = Infinity;
    let minR = Infinity;
    let maxC = -Infinity;
    let maxR = -Infinity;
    const ptPix = indices.map((i) => {
      const l = locs[i];
      // Piksel pusat berada di +0.5
      const fx = (l.lon - meta.originX) / meta.resX - 0.5;
      const fy = (l.lat - meta.originY) / meta.resY - 0.5;
      if (fx < minC) minC = fx;
      if (fx > maxC) maxC = fx;
      if (fy < minR) minR = fy;
      if (fy > maxR) maxR = fy;
      return { i, fx, fy };
    });

    const x0 = Math.max(0, Math.floor(minC) - 2);
    const y0 = Math.max(0, Math.floor(minR) - 2);
    const x1 = Math.min(meta.width, Math.ceil(maxC) + 3);
    const y1 = Math.min(meta.height, Math.ceil(maxR) + 3);
    const winW = x1 - x0;
    const winH = y1 - y0;

    if (winW <= 0 || winH <= 0 || winW * winH > 4_000_000) {
      for (const i of indices) fallbackIndices.push(i);
      continue;
    }

    try {
      const rasters = await meta.image.readRasters({ window: [x0, y0, x1, y1] });
      const raw = rasters[0] as Float32Array | Float64Array;
      for (const { i, fx, fy } of ptPix) {
        const v = sampleRasterBicubic(raw, winW, winH, fx - x0, fy - y0);
        if (v == null) fallbackIndices.push(i);
        else out[i] = Math.round(v * 1000) / 1000;
      }
    } catch {
      for (const i of indices) fallbackIndices.push(i);
    }
  }

  // Fallback otomatis ke AWS Terrarium untuk titik laut / tile tidak tersedia
  if (fallbackIndices.length > 0) {
    const fb = await fetchAwsTerrarium(fallbackIndices.map((i) => locs[i]));
    fallbackIndices.forEach((origIdx, j) => {
      if (out[origIdx] == null) out[origIdx] = fb[j] ?? null;
    });
  }

  return out;
}

// ======================== 3. REST API PROVIDERS ========================

const nextSlot = new Map<string, number>();

async function reserveSlot(id: ProviderId, minIntervalMs: number): Promise<void> {
  if (minIntervalMs <= 0) return;
  const key = id.startsWith("opentopodata") ? "opentopodata" : id;
  const now = Date.now();
  const slot = Math.max(now, nextSlot.get(key) ?? 0);
  nextSlot.set(key, slot + minIntervalMs);
  const wait = slot - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string, attempts = 3): Promise<{ status: number; body: unknown }> {
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "TopoKontur/2.0" },
        signal: AbortSignal.timeout(20000),
        cache: "no-store",
      });
      const text = await res.text();
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        await sleep(1500 * 2 ** i);
        continue;
      }
      return { status: res.status, body };
    } catch (err) {
      lastErr = err;
      await sleep(800 * 2 ** i);
    }
  }
  throw new Error(`Gagal menghubungi layanan elevasi: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

const finiteOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

async function fetchOpenTopoData(dataset: string, locs: LatLon[]): Promise<(number | null)[]> {
  const q = locs.map((l) => `${l.lat.toFixed(6)},${l.lon.toFixed(6)}`).join("|");
  const { status, body } = await getJson(
    `https://api.opentopodata.org/v1/${dataset}?locations=${encodeURIComponent(q)}&interpolation=cubic`,
  );
  const b = body as { status?: string; error?: string; results?: { elevation: unknown }[] } | null;
  if (status !== 200 || !b || b.status !== "OK" || !Array.isArray(b.results)) {
    throw new Error(`OpenTopoData (${dataset}): ${b?.error ?? `HTTP ${status}`}`);
  }
  return b.results.map((r) => finiteOrNull(r.elevation));
}

async function fetchOpenMeteo(locs: LatLon[]): Promise<(number | null)[]> {
  const lat = locs.map((l) => l.lat.toFixed(6)).join(",");
  const lon = locs.map((l) => l.lon.toFixed(6)).join(",");
  const { status, body } = await getJson(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`);
  const b = body as { elevation?: unknown[]; reason?: string } | null;
  if (status !== 200 || !b || !Array.isArray(b.elevation)) {
    throw new Error(`Open-Meteo: ${b?.reason ?? `HTTP ${status}`}`);
  }
  return b.elevation.map((v) => finiteOrNull(v));
}

async function fetchGoogle(locs: LatLon[]): Promise<(number | null)[]> {
  const key = process.env.GOOGLE_MAPS_API_KEY?.trim();
  if (!key) throw new Error("GOOGLE_MAPS_API_KEY belum diisi.");
  const q = locs.map((l) => `${l.lat.toFixed(6)},${l.lon.toFixed(6)}`).join("|");
  const { status, body } = await getJson(
    `https://maps.googleapis.com/maps/api/elevation/json?locations=${encodeURIComponent(q)}&key=${encodeURIComponent(key)}`,
  );
  const b = body as { status?: string; error_message?: string; results?: { elevation: unknown }[] } | null;
  if (!b || b.status !== "OK" || !Array.isArray(b.results)) {
    const detail = b?.error_message ? ` - ${b.error_message}` : "";
    throw new Error(`Google Elevation: ${b?.status ?? `HTTP ${status}`}${detail}`);
  }
  return b.results.map((r) => finiteOrNull(r.elevation));
}

function computeSyntheticDem(locs: LatLon[]): number[] {
  return locs.map(({ lat, lon }) => {
    const mx = lon * 111_320 * Math.cos((lat * Math.PI) / 180);
    const my = lat * 110_540;
    const base = 650 + 180 * Math.sin(mx / 1800) * Math.cos(my / 1600);
    const ridge = 75 * Math.sin((mx + my * 0.7) / 420) + 45 * Math.cos((mx * 0.6 - my) / 310);
    const hill = 22 * Math.sin(mx / 120) * Math.sin(my / 135) + 9 * Math.cos((mx + my) / 65);
    return Math.round((base + ridge + hill) * 1000) / 1000;
  });
}

/** Mengambil elevasi (meter) untuk satu batch lokasi. Nilai null berarti di luar cakupan / tanpa data. */
export async function fetchElevations(provider: ProviderId, locs: LatLon[]): Promise<(number | null)[]> {
  const def = PROVIDER_DEFS.find((p) => p.id === provider);
  await reserveSlot(provider, def?.minIntervalMs ?? 0);

  let res: (number | null)[];
  switch (provider) {
    case "copernicus-glo30":
      res = await fetchCopernicusGlo30(locs);
      break;
    case "aws-terrarium-hd":
      res = await fetchAwsTerrarium(locs);
      break;
    case "opentopodata-srtm30m":
      res = await fetchOpenTopoData("srtm30m", locs);
      break;
    case "opentopodata-aster30m":
      res = await fetchOpenTopoData("aster30m", locs);
      break;
    case "open-meteo":
      res = await fetchOpenMeteo(locs);
      break;
    case "google":
      res = await fetchGoogle(locs);
      break;
    case "simulasi-dem":
      res = computeSyntheticDem(locs);
      break;
    default:
      throw new Error("Sumber elevasi tidak dikenal.");
  }
  return locs.map((_, i) => res[i] ?? null);
}
