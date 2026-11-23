import { getDb } from "@/db";
import { elevationPoints, surveys } from "@/db/schema";
import { computeStats } from "@/lib/stats";
import { listSurveys } from "@/lib/survey-repo";
import {
  FEATURE_TYPES,
  MAX_POINTS,
  POINT_KINDS,
  type FeatureType,
  type GridMeta,
  type LngLat,
  type PointKind,
  type SamplePoint,
  type SurveyFeature,
} from "@/lib/types";

export const dynamic = "force-dynamic";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isLngLat = (v: unknown): v is LngLat =>
  Array.isArray(v) && v.length >= 2 && isNum(v[0]) && isNum(v[1]) && Math.abs(v[0]) <= 180 && Math.abs(v[1]) <= 90;

const bad = (message: string) => Response.json({ error: message }, { status: 400 });

export async function GET() {
  const list = await listSurveys();
  return Response.json({ surveys: list });
}

/** Menyimpan survei beserta seluruh titik elevasinya. */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return bad("Body JSON tidak valid.");
  }
  if (!isObj(body)) return bad("Body harus berupa objek JSON.");

  // --- metadata ---
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 120) : "Survei";
  const provider = typeof body.provider === "string" ? body.provider.slice(0, 60) : "";
  const spacingM = Number(body.spacingM);
  const corridorM = Number(body.corridorM ?? 0);
  const zone = Number(body.zone);
  const south = body.south === true;
  const epsg = typeof body.epsg === "string" ? body.epsg : "";
  if (!isNum(spacingM) || spacingM < 1 || spacingM > 10000) return bad("Spasi grid harus 1–10000 m.");
  if (!isNum(corridorM) || corridorM < 0 || corridorM > 10000) return bad("Lebar koridor tidak valid.");
  if (!Number.isInteger(zone) || zone < 1 || zone > 60) return bad("Zona UTM tidak valid.");
  if (!/^EPSG:\d{5}$/.test(epsg)) return bad("Kode EPSG tidak valid.");

  // --- fitur ---
  if (!Array.isArray(body.features) || body.features.length === 0) return bad("Minimal satu fitur diperlukan.");
  const features: SurveyFeature[] = [];
  for (const [i, raw] of body.features.entries()) {
    if (
      !isObj(raw) ||
      typeof raw.name !== "string" ||
      !FEATURE_TYPES.includes(raw.type as FeatureType) ||
      !Array.isArray(raw.coords) ||
      !raw.coords.every(isLngLat)
    ) {
      return bad(`Fitur #${i + 1} tidak valid.`);
    }
    features.push({
      id: String(raw.id ?? i),
      name: raw.name.slice(0, 120),
      type: raw.type as FeatureType,
      coords: raw.coords as LngLat[],
    });
  }

  // --- grid ---
  let grid: GridMeta | null = null;
  if (body.grid !== null && body.grid !== undefined) {
    const g = body.grid as Record<string, unknown>;
    if (!isObj(g) || !isNum(g.cols) || !isNum(g.rows) || !isNum(g.x0) || !isNum(g.y0) || !isNum(g.spacing)) {
      return bad("Metadata grid tidak valid.");
    }
    grid = { cols: g.cols, rows: g.rows, x0: g.x0, y0: g.y0, spacing: g.spacing };
  }

  // --- titik ---
  if (!Array.isArray(body.points) || body.points.length === 0) return bad("Tidak ada titik elevasi.");
  if (body.points.length > MAX_POINTS) return bad(`Jumlah titik maksimal ${MAX_POINTS}.`);
  const points: SamplePoint[] = [];
  for (const [i, raw] of body.points.entries()) {
    if (
      !isObj(raw) ||
      !POINT_KINDS.includes(raw.kind as PointKind) ||
      typeof raw.feature !== "string" ||
      !isNum(raw.lat) ||
      !isNum(raw.lon) ||
      !isNum(raw.easting) ||
      !isNum(raw.northing)
    ) {
      return bad(`Titik #${i + 1} tidak valid.`);
    }
    const elevation = raw.elevation == null ? null : isNum(raw.elevation) ? raw.elevation : undefined;
    if (elevation === undefined) return bad(`Elevasi titik #${i + 1} tidak valid.`);
    points.push({
      kind: raw.kind as PointKind,
      feature: raw.feature.slice(0, 120),
      seq: i,
      col: isNum(raw.col) ? Math.trunc(raw.col) : null,
      row: isNum(raw.row) ? Math.trunc(raw.row) : null,
      distance: isNum(raw.distance) ? raw.distance : null,
      lat: raw.lat,
      lon: raw.lon,
      easting: raw.easting,
      northing: raw.northing,
      elevation,
    });
  }

  const stats = computeStats(points, features, zone, south);

  const db = await getDb();
  const id = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(surveys)
      .values({
        name,
        provider,
        spacingM,
        corridorM,
        zone,
        south,
        epsg,
        features,
        grid,
        stats,
      })
      .returning({ id: surveys.id });

    const CHUNK = 1000;
    for (let i = 0; i < points.length; i += CHUNK) {
      const slice = points.slice(i, i + CHUNK);
      await tx.insert(elevationPoints).values(
        slice.map((p) => ({
          surveyId: row.id,
          seq: p.seq,
          kind: p.kind,
          feature: p.feature,
          col: p.col,
          row: p.row,
          distance: p.distance,
          lat: p.lat,
          lon: p.lon,
          easting: p.easting,
          northing: p.northing,
          elevation: p.elevation,
        })),
      );
    }
    return row.id;
  });

  return Response.json({ id }, { status: 201 });
}
