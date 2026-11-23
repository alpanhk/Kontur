/**
 * Tipe & konstanta bersama (aman dipakai di client maupun server).
 * Jangan mengimpor modul server (db, fetch provider, fs) dari file ini.
 */

/** Koordinat [longitude, latitude] (urutan GeoJSON / KML). */
export type LngLat = [number, number];

export type FeatureType = "line" | "polygon" | "point";

/**
 * Jenis titik hasil sampling:
 * - grid     : node grid di dalam poligon / koridor (dipakai untuk peta kontur)
 * - line     : titik hasil densifikasi sepanjang garis (profil)
 * - boundary : titik hasil densifikasi sepanjang batas poligon
 * - vertex   : titik simpul yang digambar / diimpor
 * - point    : titik tunggal (spot height)
 */
export type PointKind = "grid" | "line" | "boundary" | "vertex" | "point";

export const FEATURE_TYPES: FeatureType[] = ["line", "polygon", "point"];
export const POINT_KINDS: PointKind[] = ["grid", "line", "boundary", "vertex", "point"];

/** Batas jumlah titik per survei (50.000 titik untuk resolusi tinggi). */
export const MAX_POINTS = 50000;

/** Batch default untuk API REST biasa (OpenTopoData / Open-Meteo / Google). */
export const BATCH_SIZE = 100;

export type ProviderId =
  | "copernicus-glo30"
  | "aws-terrarium-hd"
  | "opentopodata-srtm30m"
  | "opentopodata-aster30m"
  | "open-meteo"
  | "google"
  | "simulasi-dem";

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  description: string;
  maxBatch: number;
  /** Jarak minimum antar-permintaan dari server (untuk menghormati rate limit). */
  minIntervalMs: number;
  available: boolean;
  reason: string | null;
}

/** Fitur geometri hasil gambar / impor (koordinat WGS84). */
export interface SurveyFeature {
  id: string;
  name: string;
  type: FeatureType;
  coords: LngLat[];
}

/** Metadata grid reguler dalam koordinat UTM (meter). */
export interface GridMeta {
  cols: number;
  rows: number;
  x0: number;
  y0: number;
  spacing: number;
}

export interface SamplePoint {
  kind: PointKind;
  feature: string;
  seq: number;
  col: number | null;
  row: number | null;
  /** Jarak kumulatif (m) sepanjang garis / batas. */
  distance: number | null;
  lat: number;
  lon: number;
  easting: number;
  northing: number;
  elevation: number | null;
}

export interface SurveyStats {
  count: number;
  counts: Partial<Record<PointKind, number>>;
  min: number | null;
  max: number | null;
  mean: number | null;
  relief: number | null;
  areaM2: number;
  lengthM: number;
  ascentM: number | null;
  descentM: number | null;
  failed: number;
}

export interface SurveyDto {
  id: number;
  name: string;
  provider: string;
  spacingM: number;
  corridorM: number;
  zone: number;
  south: boolean;
  epsg: string;
  features: SurveyFeature[];
  grid: GridMeta | null;
  stats: SurveyStats;
  createdAt: string;
}

export interface ContourConfig {
  interval: number | null;
  indexEvery: number;
  /** Faktor upsampling bikubik sub-grid: 1 (asli), 2 (halus), 4 (ultra halus). */
  refinement: 1 | 2 | 4;
  /** Tingkat penghalusan garis kontur: 0 (asli), 1 (halus), 2 (sangat halus). */
  smoothing: 0 | 1 | 2;
}
