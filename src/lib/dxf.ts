import type { ContourResult } from "./contour";
import type { SamplePoint, SurveyFeature } from "./types";

/**
 * Penulis DXF AutoCAD R12 (AC1009) Profesional — Koordinat Utama UTM (Meter).
 * - Kompatibel 100% dengan AutoCAD (semua versi), Autodesk Civil 3D, BricsCAD, ZWCAD, Global Mapper, QGIS, SketchUp, LibreCAD.
 * - Menyertakan tabel VPORT (*ACTIVE) tepat di tengah koordinat UTM sehingga langsung tampil penuh saat dibuka di AutoCAD.
 * - Kontur ditulis sebagai POLYLINE ber-elevasi (Z = level kontur) agar langsung dapat dipakai membuat Surface/TIN di Civil 3D.
 * - Menyertakan Grid Koordinat UTM, garis tepi, label Easting/Northing, dan keterangan proyeksi WGS84 UTM Zone.
 */

export interface DxfOptions {
  includeGrid: boolean;
  includeLabels: boolean;
  includeVertexLabels: boolean;
  includeUtmGrid: boolean;
}

export interface DxfMeta {
  name: string;
  zone: number;
  south: boolean;
  epsg: string;
  provider: string;
  spacingM: number;
}

export interface DxfInput {
  meta: DxfMeta;
  contours: ContourResult | null;
  points: SamplePoint[];
  features: SurveyFeature[];
  options: DxfOptions;
}

/** [nama layer, warna ACI] */
const LAYERS: [string, number][] = [
  ["0", 7],
  ["CONTOUR_INDEX", 30], // oranye tua (kontur indeks)
  ["CONTOUR_INTER", 42], // kuning kecoklatan (kontur antara)
  ["CONTOUR_LABEL", 7], // putih/hitam
  ["BOUNDARY", 5], // biru (batas poligon)
  ["INPUT_LINE", 4], // cyan (garis input 3D)
  ["INPUT_POINT", 1], // merah (titik input)
  ["VERTEX_LABEL", 2], // kuning (label koordinat UTM simpul)
  ["ELEV_GRID", 3], // hijau (titik grid elevasi 3D)
  ["UTM_GRID", 8], // abu-abu gelap (grid koordinat UTM)
  ["UTM_GRID_LABEL", 7], // label Easting / Northing UTM
  ["MAP_INFO", 7], // informasi proyeksi & legenda
];

const num = (v: number, d = 3): string => (Number.isFinite(v) ? v : 0).toFixed(d);
/** DXF R12 memakai ASCII; karakter lain diganti '?'. */
const txt = (s: string): string => s.replace(/[^\x20-\x7e]/g, "?").slice(0, 255);

const GRID_STEPS = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 25000, 50000];
function pickUtmGridStep(extent: number): number {
  const target = extent / 6;
  for (const s of GRID_STEPS) if (s >= target) return s;
  return Math.ceil(target / 10000) * 10000;
}

export function buildDxf({ meta, contours, points, features, options }: DxfInput): string {
  // ---- Hitung Extents (UTM meter) ----
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  const expand = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  if (contours) for (const ln of contours.lines) for (const [x, y] of ln.pts) expand(x, y);
  for (const p of points) {
    expand(p.easting, p.northing);
    if (p.elevation != null && Number.isFinite(p.elevation)) {
      if (p.elevation < minZ) minZ = p.elevation;
      if (p.elevation > maxZ) maxZ = p.elevation;
    }
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 100;
    maxY = 100;
  }
  if (!Number.isFinite(minZ)) {
    minZ = 0;
    maxZ = 0;
  }

  const dx = Math.max(maxX - minX, 1);
  const dy = Math.max(maxY - minY, 1);
  const extent = Math.max(dx, dy);
  const pad = extent * 0.06;

  const frameMinX = minX - pad;
  const frameMaxX = maxX + pad;
  const frameMinY = minY - pad;
  const frameMaxY = maxY + pad;
  const midX = (frameMinX + frameMaxX) / 2;
  const midY = (frameMinY + frameMaxY) / 2;
  const viewH = Math.max(frameMaxY - frameMinY, (frameMaxX - frameMinX) * 0.7) * 1.2;

  /** Tinggi teks (m), proporsional terhadap luas area. */
  const th = Math.min(250, Math.max(0.25, extent / 140));
  const ox = th * 0.35;

  const out: string[] = [];
  const w = (...vals: (string | number)[]) => {
    for (const v of vals) out.push(String(v));
  };

  // ---- HEADER ----
  w(0, "SECTION", 2, "HEADER");
  w(9, "$ACADVER", 1, "AC1009");
  w(9, "$DWGCODEPAGE", 3, "ANSI_1252");
  w(9, "$INSUNITS", 70, 6); // 6 = Meters
  w(9, "$MEASUREMENT", 70, 1); // 1 = Metric
  w(9, "$LUNITS", 70, 2); // 2 = Decimal
  w(9, "$LUPREC", 70, 3);
  w(9, "$PDMODE", 70, 34); // titik ditampilkan sebagai lingkaran+silang di AutoCAD
  w(9, "$PDSIZE", 40, num(th * 0.4, 3));
  w(9, "$EXTMIN", 10, num(frameMinX - pad), 20, num(frameMinY - pad), 30, num(minZ));
  w(9, "$EXTMAX", 10, num(frameMaxX + pad), 20, num(frameMaxY + pad), 30, num(maxZ));
  w(9, "$LIMMIN", 10, num(frameMinX - pad), 20, num(frameMinY - pad));
  w(9, "$LIMMAX", 10, num(frameMaxX + pad), 20, num(frameMaxY + pad));
  w(0, "ENDSEC");

  // ---- TABLES ----
  w(0, "SECTION", 2, "TABLES");

  // VPORT (*ACTIVE) — sangat penting agar AutoCAD langsung zoom ke koordinat UTM!
  w(0, "TABLE", 2, "VPORT", 70, 1);
  w(
    0,
    "VPORT",
    2,
    "*ACTIVE",
    70,
    0,
    10,
    "0.0",
    20,
    "0.0",
    11,
    "1.0",
    21,
    "1.0",
    12,
    num(midX),
    22,
    num(midY),
    13,
    "0.0",
    23,
    "0.0",
    14,
    "10.0",
    24,
    "10.0",
    15,
    "10.0",
    25,
    "10.0",
    16,
    "0.0",
    26,
    "0.0",
    36,
    "1.0",
    17,
    "0.0",
    27,
    "0.0",
    37,
    "0.0",
    40,
    num(viewH),
    41,
    "1.6",
    42,
    "50.0",
    43,
    "0.0",
    44,
    "0.0",
    50,
    "0.0",
    51,
    "0.0",
    71,
    0,
    72,
    100,
    73,
    1,
    74,
    3,
    75,
    0,
    76,
    0,
    77,
    0,
    78,
    0,
  );
  w(0, "ENDTAB");

  w(0, "TABLE", 2, "LTYPE", 70, 2);
  w(0, "LTYPE", 2, "CONTINUOUS", 70, 0, 3, "Solid line", 72, 65, 73, 0, 40, "0.0");
  w(0, "LTYPE", 2, "DASHED", 70, 0, 3, "Dashed __ __ __", 72, 65, 73, 2, 40, "0.75", 49, "0.5", 49, "-0.25");
  w(0, "ENDTAB");

  w(0, "TABLE", 2, "LAYER", 70, LAYERS.length);
  for (const [name, color] of LAYERS) {
    w(0, "LAYER", 2, name, 70, 0, 62, color, 6, name === "UTM_GRID" ? "DASHED" : "CONTINUOUS");
  }
  w(0, "ENDTAB");

  w(0, "TABLE", 2, "STYLE", 70, 1);
  w(0, "STYLE", 2, "STANDARD", 70, 0, 40, "0.0", 41, "1.0", 50, "0.0", 71, 0, 42, num(th, 3), 3, "txt", 4, "");
  w(0, "ENDTAB");

  w(0, "ENDSEC");

  // ---- BLOCKS ----
  w(0, "SECTION", 2, "BLOCKS");
  w(0, "ENDSEC");

  // ---- ENTITIES ----
  w(0, "SECTION", 2, "ENTITIES");

  /** Garis lurus 2D/3D (dipakai untuk grid UTM & frame). */
  const line = (layer: string, x1: number, y1: number, x2: number, y2: number, z = 0) => {
    w(0, "LINE", 8, layer, 10, num(x1), 20, num(y1), 30, num(z), 11, num(x2), 21, num(y2), 31, num(z));
  };

  /**
   * 2D POLYLINE dengan elevasi konstan (Z pada grup 30).
   * Format terbaik untuk garis kontur di AutoCAD, Civil 3D (Create Surface from Contours), BricsCAD, Global Mapper, QGIS, LibreCAD.
   */
  const contourPolyline = (layer: string, pts: [number, number][], elevation: number, closed: boolean) => {
    if (pts.length < 2) return;
    w(0, "POLYLINE", 8, layer, 66, 1, 10, "0.0", 20, "0.0", 30, num(elevation), 70, closed ? 1 : 0);
    for (const [x, y] of pts) {
      w(0, "VERTEX", 8, layer, 10, num(x), 20, num(y), 30, num(elevation));
    }
    w(0, "SEQEND", 8, layer);
  };

  /** 3D POLYLINE (tiap simpul memiliki Z berbeda, untuk batas & jalur survei). */
  const polyline3d = (layer: string, pts: [number, number, number][], closed: boolean) => {
    if (pts.length < 2) return;
    w(0, "POLYLINE", 8, layer, 66, 1, 10, "0.0", 20, "0.0", 30, "0.0", 70, closed ? 9 : 8);
    for (const [x, y, z] of pts) {
      w(0, "VERTEX", 8, layer, 10, num(x), 20, num(y), 30, num(z), 70, 32);
    }
    w(0, "SEQEND", 8, layer);
  };

  const point = (layer: string, x: number, y: number, z: number) => {
    w(0, "POINT", 8, layer, 10, num(x), 20, num(y), 30, num(z));
  };

  const text = (layer: string, x: number, y: number, z: number, h: number, s: string, rot = 0) => {
    w(0, "TEXT", 8, layer, 10, num(x), 20, num(y), 30, num(z), 40, num(h, 3), 1, txt(s), 50, num(rot, 2), 7, "STANDARD");
  };

  /** Label koordinat simpul dengan UTM sebagai format utama. */
  const coordLabels = (p: SamplePoint, title: string) => {
    const h = th * 0.55;
    const x = p.easting + ox;
    const z = p.elevation ?? 0;
    text(
      "VERTEX_LABEL",
      x,
      p.northing + th * 1.6,
      z,
      h,
      `${title}  Z=${p.elevation == null ? "-" : p.elevation.toFixed(2)}m`,
    );
    text("VERTEX_LABEL", x, p.northing + th * 0.7, z, h, `E=${p.easting.toFixed(3)}  N=${p.northing.toFixed(3)}`);
  };

  // ---- 1. Grid Koordinat UTM & Frame Peta ----
  if (options.includeUtmGrid) {
    // Bingkai luar
    line("UTM_GRID", frameMinX, frameMinY, frameMaxX, frameMinY, 0);
    line("UTM_GRID", frameMaxX, frameMinY, frameMaxX, frameMaxY, 0);
    line("UTM_GRID", frameMaxX, frameMaxY, frameMinX, frameMaxY, 0);
    line("UTM_GRID", frameMinX, frameMaxY, frameMinX, frameMinY, 0);

    const step = pickUtmGridStep(extent);
    const startE = Math.ceil(frameMinX / step) * step;
    const startN = Math.ceil(frameMinY / step) * step;
    const tickH = th * 0.85;

    for (let e = startE; e <= frameMaxX; e += step) {
      line("UTM_GRID", e, frameMinY, e, frameMaxY, 0);
      text("UTM_GRID_LABEL", e + th * 0.25, frameMinY - tickH * 1.4, 0, tickH, `${Math.round(e)} mE`, 0);
      text("UTM_GRID_LABEL", e + th * 0.25, frameMaxY + tickH * 0.5, 0, tickH, `${Math.round(e)} mE`, 0);
    }
    for (let n = startN; n <= frameMaxY; n += step) {
      line("UTM_GRID", frameMinX, n, frameMaxX, n, 0);
      text("UTM_GRID_LABEL", frameMaxX + th * 0.4, n - tickH * 0.3, 0, tickH, `${Math.round(n)} mN`, 0);
      text("UTM_GRID_LABEL", frameMinX - tickH * 8.5, n - tickH * 0.3, 0, tickH, `${Math.round(n)} mN`, 0);
    }

    // Keterangan Proyeksi UTM & Metadata di bawah frame
    const hemi = meta.south ? "S" : "N";
    const infoY = frameMinY - tickH * 3.8;
    const ci = contours ? `${contours.interval} m (indeks tiap ${contours.indexEvery})` : "-";
    text(
      "MAP_INFO",
      frameMinX,
      infoY,
      0,
      th * 1.0,
      `SURVEI: ${meta.name} | PROYEKSI: WGS84 / UTM ZONA ${meta.zone}${hemi} (${meta.epsg}) | UNIT: METER`,
    );
    text(
      "MAP_INFO",
      frameMinX,
      infoY - th * 1.5,
      0,
      th * 0.85,
      `INTERVAL KONTUR: ${ci} | SPASI GRID: ${meta.spacingM} m | SUMBER DEM: ${meta.provider} | ELEVASI: ${minZ.toFixed(2)} - ${maxZ.toFixed(2)} m`,
    );
  }

  // ---- 2. Garis Kontur ----
  if (contours) {
    for (const ln of contours.lines) {
      contourPolyline(ln.index ? "CONTOUR_INDEX" : "CONTOUR_INTER", ln.pts, ln.level, ln.closed);
    }
    if (options.includeLabels) {
      for (const lb of contours.labels) {
        text("CONTOUR_LABEL", lb.x, lb.y, lb.level, th * 0.9, `${lb.text}`, lb.angle);
      }
    }
  }

  // ---- 3. Fitur Input (Batas Poligon, Garis, Titik) + Label UTM Simpul ----
  const byName = new Map<string, SamplePoint[]>();
  for (const p of points) {
    if (p.kind === "grid") continue;
    const arr = byName.get(p.feature);
    if (arr) arr.push(p);
    else byName.set(p.feature, [p]);
  }

  for (const f of features) {
    const arr = byName.get(f.name) ?? [];
    if (f.type === "polygon") {
      const ring = arr.filter((p) => p.kind === "vertex" || p.kind === "boundary");
      if (ring.length >= 3) {
        polyline3d(
          "BOUNDARY",
          ring.map((p) => [p.easting, p.northing, p.elevation ?? 0] as [number, number, number]),
          true,
        );
      }
    } else if (f.type === "line") {
      const ln = arr.filter((p) => p.kind === "vertex" || p.kind === "line");
      if (ln.length >= 2) {
        polyline3d(
          "INPUT_LINE",
          ln.map((p) => [p.easting, p.northing, p.elevation ?? 0] as [number, number, number]),
          false,
        );
      }
    } else {
      for (const p of arr) {
        if (p.kind !== "point") continue;
        point("INPUT_POINT", p.easting, p.northing, p.elevation ?? 0);
        if (options.includeVertexLabels) coordLabels(p, f.name);
      }
    }

    if (options.includeVertexLabels && f.type !== "point") {
      let vi = 0;
      for (const p of arr) {
        if (p.kind !== "vertex") continue;
        vi++;
        coordLabels(p, `V${vi}`);
      }
    }
  }

  // ---- 4. Titik Grid Elevasi 3D (opsional) ----
  if (options.includeGrid) {
    for (const p of points) {
      if (p.kind === "grid" && p.elevation != null) point("ELEV_GRID", p.easting, p.northing, p.elevation);
    }
  }

  w(0, "ENDSEC");
  w(0, "EOF");
  return out.join("\r\n") + "\r\n";
}
