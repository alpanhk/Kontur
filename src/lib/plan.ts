import {
  bboxOf,
  distToPolyline,
  pointInRing,
  polylineLength,
  projectionForFeatures,
  ringArea,
  samplePath,
  type XY,
} from "./geo";
import { BATCH_SIZE, MAX_POINTS, type GridMeta, type PointKind, type SamplePoint, type SurveyFeature } from "./types";

export interface PlanOptions {
  /** Spasi grid / interval sampling (meter). */
  spacing: number;
  /** Lebar koridor (m) di sekitar garis; 0 = nonaktif. */
  corridor?: number;
  maxPoints?: number;
  batchSize?: number;
  /** Override zona UTM manual (opsional; kosong = deteksi otomatis). */
  utmOverride?: { zone: number; south: boolean } | null;
}

export interface SamplePlan {
  ok: boolean;
  error: string | null;
  zone: number;
  south: boolean;
  epsg: string;
  spacing: number;
  corridor: number;
  grid: GridMeta | null;
  points: SamplePoint[];
  counts: Record<PointKind, number>;
  areaM2: number;
  lengthM: number;
  /** Perkiraan jumlah permintaan ke layanan elevasi. */
  requests: number;
  /** Saran spasi bila jumlah titik melebihi batas. */
  suggestedSpacing: number | null;
}

export function emptyCounts(): Record<PointKind, number> {
  return { grid: 0, line: 0, boundary: 0, vertex: 0, point: 0 };
}

function failPlan(error: string, extra: Partial<SamplePlan> = {}): SamplePlan {
  return {
    ok: false,
    error,
    zone: 0,
    south: false,
    epsg: "",
    spacing: 0,
    corridor: 0,
    grid: null,
    points: [],
    counts: emptyCounts(),
    areaM2: 0,
    lengthM: 0,
    requests: 0,
    suggestedSpacing: null,
    ...extra,
  };
}

function suggestSpacing(areaM2: number, maxPoints: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(Math.max(areaM2, 1) / (maxPoints * 0.75))));
}

/** Menghitung spasi optimal untuk target ~4.000 titik (cepat namun sangat detail). */
export function recommendHighResSpacing(areaM2: number, lengthM: number, corridor: number): number {
  const effectiveArea = areaM2 + (corridor > 0 ? lengthM * corridor : 0);
  if (effectiveArea <= 0) {
    if (lengthM <= 0) return 10;
    return Math.max(2, Math.min(50, Math.round(lengthM / 300)));
  }
  const raw = Math.sqrt(effectiveArea / 3600);
  const steps = [1, 2, 5, 10, 15, 20, 25, 30, 50, 75, 100, 150, 200, 250, 500];
  for (const s of steps) if (s >= raw) return s;
  return Math.ceil(raw / 100) * 100;
}

interface Shape {
  feature: SurveyFeature;
  xy: XY[];
}

/** Jarak titik ke batas tertutup poligon. */
function distToClosedRing(x: number, y: number, ring: XY[]): number {
  const closed = [...ring, ring[0]];
  return distToPolyline(x, y, closed);
}

/**
 * Membuat rencana sampling dari fitur:
 * - poligon  → node grid reguler di dalam area (+ buffer tepi 1 sel agar kontur utuh hingga batas) + titik sepanjang batas
 * - garis    → titik sepanjang garis (profil); dengan koridor → grid di sekitar garis
 * - titik    → langsung diambil elevasinya
 * Semua perhitungan dilakukan di bidang UTM (meter).
 */
export function buildPlan(features: SurveyFeature[], opts: PlanOptions): SamplePlan {
  const spacing = Number(opts.spacing);
  const corridor = Math.max(0, Number(opts.corridor) || 0);
  const maxPoints = opts.maxPoints ?? MAX_POINTS;
  const batchSize = Math.max(1, opts.batchSize ?? BATCH_SIZE);

  if (features.length === 0) {
    return failPlan("Belum ada fitur. Gambar garis, poligon, atau titik di peta, atau impor KML/KMZ/UTM.");
  }
  if (!(spacing >= 1)) {
    return failPlan("Spasi grid minimal 1 meter.");
  }

  const proj = projectionForFeatures(features, opts.utmOverride);
  const shapes: Shape[] = [];
  for (const f of features) {
    const xy = f.coords.map(([lon, lat]) => proj.toUtm(lon, lat));
    if (f.type === "polygon" && xy.length >= 3) shapes.push({ feature: f, xy });
    else if (f.type === "line" && xy.length >= 2) shapes.push({ feature: f, xy });
    else if (f.type === "point" && xy.length >= 1) shapes.push({ feature: f, xy: [xy[0]] });
  }
  if (shapes.length === 0) {
    return failPlan("Geometri tidak valid. Garis butuh minimal 2 titik, poligon minimal 3 titik.");
  }

  const polys = shapes.filter((s) => s.feature.type === "polygon");
  const lines = shapes.filter((s) => s.feature.type === "line");
  const areaM2 = polys.reduce((acc, s) => acc + ringArea(s.xy), 0);
  const lengthM = lines.reduce((acc, s) => acc + polylineLength(s.xy), 0);

  const counts = emptyCounts();
  const points: SamplePoint[] = [];
  let seq = 0;
  const addPoint = (
    kind: PointKind,
    feature: string,
    e: number,
    n: number,
    distance: number | null,
    col: number | null = null,
    row: number | null = null,
  ) => {
    const [lon, lat] = proj.toLonLat(e, n);
    points.push({ kind, feature, seq: seq++, col, row, distance, lat, lon, easting: e, northing: n, elevation: null });
    counts[kind]++;
  };

  const common = {
    zone: proj.zone,
    south: proj.south,
    epsg: proj.epsg,
    spacing,
    corridor,
    areaM2,
    lengthM,
  };

  // ---- 1. Grid reguler (poligon + koridor garis) ----
  let grid: GridMeta | null = null;
  const needGrid = polys.length > 0 || (corridor > 0 && lines.length > 0);
  if (needGrid) {
    const pad = corridor / 2;
    const edgePad = spacing * 1.05;
    let minE = Infinity;
    let minN = Infinity;
    let maxE = -Infinity;
    let maxN = -Infinity;
    const grow = (xy: XY[], m: number) => {
      const b = bboxOf(xy);
      minE = Math.min(minE, b.minX - m);
      minN = Math.min(minN, b.minY - m);
      maxE = Math.max(maxE, b.maxX + m);
      maxN = Math.max(maxN, b.maxY + m);
    };
    for (const s of polys) grow(s.xy, edgePad);
    if (corridor > 0) for (const s of lines) grow(s.xy, pad + edgePad * 0.5);

    // Grid dikunci ke kelipatan spasi agar koordinat UTM CAD rapi & bulat.
    const x0 = Math.floor(minE / spacing) * spacing;
    const y0 = Math.floor(minN / spacing) * spacing;
    const cols = Math.ceil((maxE - x0) / spacing) + 1;
    const rows = Math.ceil((maxN - y0) / spacing) + 1;
    const boxArea = (maxE - minE) * (maxN - minN);

    if (cols * rows > 3_500_000) {
      return failPlan(
        `Area terlalu besar untuk spasi ${spacing} m (±${(cols * rows).toLocaleString("id-ID")} sel). Perbesar spasi grid.`,
        { ...common, suggestedSpacing: suggestSpacing(areaM2 > 0 ? areaM2 : boxArea, maxPoints) },
      );
    }

    const ringBoxes = polys.map((s) => {
      const b = bboxOf(s.xy);
      return {
        ring: s.xy,
        box: {
          minX: b.minX - edgePad,
          minY: b.minY - edgePad,
          maxX: b.maxX + edgePad,
          maxY: b.maxY + edgePad,
        },
      };
    });
    const lineBoxes =
      corridor > 0
        ? lines.map((s) => {
            const b = bboxOf(s.xy);
            const m = pad + edgePad * 0.5;
            return {
              xy: s.xy,
              box: { minX: b.minX - m, minY: b.minY - m, maxX: b.maxX + m, maxY: b.maxY + m },
            };
          })
        : [];

    const nodes: { c: number; r: number; e: number; n: number }[] = [];
    for (let r = 0; r < rows; r++) {
      const ny = y0 + r * spacing;
      for (let c = 0; c < cols; c++) {
        const ex = x0 + c * spacing;
        let inside = false;
        for (const rb of ringBoxes) {
          if (ex < rb.box.minX || ex > rb.box.maxX || ny < rb.box.minY || ny > rb.box.maxY) continue;
          if (pointInRing(ex, ny, rb.ring) || distToClosedRing(ex, ny, rb.ring) <= edgePad) {
            inside = true;
            break;
          }
        }
        if (!inside) {
          for (const lb of lineBoxes) {
            if (ex < lb.box.minX || ex > lb.box.maxX || ny < lb.box.minY || ny > lb.box.maxY) continue;
            if (distToPolyline(ex, ny, lb.xy) <= pad + edgePad * 0.5) {
              inside = true;
              break;
            }
          }
        }
        if (inside) {
          nodes.push({ c, r, e: ex, n: ny });
          if (nodes.length > maxPoints) {
            return failPlan(
              `Jumlah node grid melebihi batas ${maxPoints.toLocaleString("id-ID")} titik. Perbesar spasi grid.`,
              { ...common, suggestedSpacing: suggestSpacing(areaM2 > 0 ? areaM2 : boxArea, maxPoints) },
            );
          }
        }
      }
    }

    grid = { cols, rows, x0, y0, spacing };
    for (const nd of nodes) addPoint("grid", "Grid", nd.e, nd.n, null, nd.c, nd.r);
  }

  // ---- 2. Titik, garis (profil), dan batas poligon sesuai urutan fitur ----
  for (const s of shapes) {
    const name = s.feature.name;
    if (s.feature.type === "point") {
      addPoint("point", name, s.xy[0][0], s.xy[0][1], null);
    } else if (s.feature.type === "line") {
      for (const p of samplePath(s.xy, spacing, false)) {
        addPoint(p.vertex ? "vertex" : "line", name, p.e, p.n, p.d);
      }
    } else {
      for (const p of samplePath(s.xy, spacing, true)) {
        addPoint(p.vertex ? "vertex" : "boundary", name, p.e, p.n, p.d);
      }
    }
  }

  if (points.length > maxPoints) {
    const boxArea = areaM2 > 0 ? areaM2 : lengthM * spacing;
    return failPlan(
      `Jumlah titik ${points.length.toLocaleString("id-ID")} melebihi batas ${maxPoints.toLocaleString("id-ID")}. Perbesar spasi atau kurangi area.`,
      { ...common, counts, suggestedSpacing: suggestSpacing(boxArea, maxPoints) },
    );
  }

  return {
    ok: true,
    error: null,
    zone: proj.zone,
    south: proj.south,
    epsg: proj.epsg,
    spacing,
    corridor,
    grid,
    points,
    counts,
    areaM2,
    lengthM,
    requests: Math.ceil(points.length / batchSize),
    suggestedSpacing: null,
  };
}
