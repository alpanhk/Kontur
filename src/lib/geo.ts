import proj4 from "proj4";
import type { LngLat, SurveyFeature } from "./types";

/** Koordinat bidang datar (meter UTM): [easting, northing]. */
export type XY = [number, number];

export interface UtmProjection {
  zone: number;
  south: boolean;
  /** Kode EPSG UTM WGS84, mis. EPSG:32748 (UTM 48S). */
  epsg: string;
  toUtm: (lon: number, lat: number) => XY;
  toLonLat: (easting: number, northing: number) => LngLat;
}

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const registered = new Set<string>();
const cache = new Map<string, UtmProjection>();

export function utmZoneFor(lon: number): number {
  return Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));
}

/**
 * Proyeksi UTM (WGS84) untuk zona & belahan tertentu.
 * EPSG 326xx = belahan utara, EPSG 327xx = belahan selatan.
 */
export function utmForZone(zone: number, south: boolean): UtmProjection {
  const epsg = `EPSG:${(south ? 32700 : 32600) + zone}`;
  const hit = cache.get(epsg);
  if (hit) return hit;

  if (!registered.has(epsg)) {
    proj4.defs(epsg, `+proj=utm +zone=${zone}${south ? " +south" : ""} +datum=WGS84 +units=m +no_defs +type=crs`);
    registered.add(epsg);
  }

  const fwd = proj4("EPSG:4326", epsg);
  const inv = proj4(epsg, "EPSG:4326");

  const proj: UtmProjection = {
    zone,
    south,
    epsg,
    toUtm: (lon, lat) => {
      const [e, n] = fwd.forward([lon, lat]) as [number, number];
      return [e, n];
    },
    toLonLat: (e, n) => {
      const [lon, lat] = inv.forward([e, n]) as [number, number];
      return [lon, lat];
    },
  };
  cache.set(epsg, proj);
  return proj;
}

/** Proyeksi UTM untuk kumpulan fitur (otomatis dari rata-rata koordinat, atau zona manual bila ditentukan). */
export function projectionForFeatures(
  features: SurveyFeature[],
  override?: { zone: number; south: boolean } | null,
): UtmProjection {
  if (override && override.zone >= 1 && override.zone <= 60) {
    return utmForZone(Math.trunc(override.zone), Boolean(override.south));
  }
  let sumLon = 0;
  let sumLat = 0;
  let n = 0;
  for (const f of features) {
    for (const [lon, lat] of f.coords) {
      sumLon += lon;
      sumLat += lat;
      n++;
    }
  }
  const lon = n ? sumLon / n : 0;
  const lat = n ? sumLat / n : 0;
  return utmForZone(utmZoneFor(lon), lat < 0);
}

/** String WKT (.prj) standar Esri/OGC untuk zona UTM WGS84 (dibaca otomatis oleh QGIS, Global Mapper, ArcGIS, Civil 3D, Surfer). */
export function utmPrjWkt(zone: number, south: boolean): string {
  const cm = zone * 6 - 183;
  const fn = south ? 10000000 : 0;
  const hemi = south ? "S" : "N";
  const epsg = (south ? 32700 : 32600) + zone;
  return (
    `PROJCS["WGS_1984_UTM_Zone_${zone}${hemi}",` +
    `GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],` +
    `PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],` +
    `PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],` +
    `PARAMETER["False_Northing",${fn}.0],PARAMETER["Central_Meridian",${cm}.0],` +
    `PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],` +
    `UNIT["Meter",1.0],AUTHORITY["EPSG","${epsg}"]]`
  );
}

export function bboxOf(xy: XY[]): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of xy) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/** Uji titik-dalam-poligon (ray casting). */
export function pointInRing(x: number, y: number, ring: XY[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + t * dx - px, ay + t * dy - py);
}

/** Jarak terpendek dari titik ke polyline (meter). */
export function distToPolyline(x: number, y: number, line: XY[]): number {
  if (line.length === 1) return Math.hypot(line[0][0] - x, line[0][1] - y);
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const d = distToSegment(x, y, line[i][0], line[i][1], line[i + 1][0], line[i + 1][1]);
    if (d < best) best = d;
  }
  return best;
}

/** Luas poligon (shoelace) dalam m². Dihitung relatif terhadap titik pertama agar presisi. */
export function ringArea(ring: XY[]): number {
  if (ring.length < 3) return 0;
  const [x0, y0] = ring[0];
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    a += (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  }
  return Math.abs(a) / 2;
}

export function polylineLength(line: XY[]): number {
  let total = 0;
  for (let i = 0; i < line.length - 1; i++) {
    total += Math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1]);
  }
  return total;
}

export interface PathSample {
  e: number;
  n: number;
  /** Jarak kumulatif dari awal jalur (m). */
  d: number;
  /** true jika titik ini adalah simpul asli (input). */
  vertex: boolean;
}

/**
 * Densifikasi jalur dengan interval `step` meter.
 * Setiap simpul asli ikut diambil (vertex = true). Untuk poligon (closed = true),
 * simpul pertama tidak diulang di akhir.
 */
export function samplePath(xy: XY[], step: number, closed: boolean): PathSample[] {
  const out: PathSample[] = [];
  const n = xy.length;
  if (n === 0) return out;
  const segCount = closed ? n : n - 1;
  let cum = 0;
  for (let i = 0; i < segCount; i++) {
    const [ax, ay] = xy[i];
    const [bx, by] = xy[(i + 1) % n];
    const len = Math.hypot(bx - ax, by - ay);
    const steps = len > 0 ? Math.max(1, Math.ceil(len / step)) : 1;
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      out.push({ e: ax + (bx - ax) * t, n: ay + (by - ay) * t, d: cum + len * t, vertex: k === 0 });
    }
    cum += len;
  }
  if (!closed) {
    const [ex, ey] = xy[n - 1];
    out.push({ e: ex, n: ey, d: cum, vertex: true });
  }
  return out;
}

/** Menghapus titik penutup duplikat (titik terakhir = titik pertama). */
export function stripClosing<T extends [number, number]>(coords: T[]): T[] {
  if (coords.length > 1) {
    const a = coords[0];
    const b = coords[coords.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) return coords.slice(0, -1);
  }
  return coords;
}
