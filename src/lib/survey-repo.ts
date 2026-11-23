import { asc, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { elevationPoints, surveys } from "@/db/schema";
import type { PointKind, SamplePoint, SurveyDto } from "./types";

type SurveyRow = typeof surveys.$inferSelect;

export function toSurveyDto(row: SurveyRow): SurveyDto {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    spacingM: row.spacingM,
    corridorM: row.corridorM,
    zone: row.zone,
    south: row.south,
    epsg: row.epsg,
    features: row.features,
    grid: row.grid,
    stats: row.stats,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listSurveys(): Promise<SurveyDto[]> {
  const db = await getDb();
  const rows = await db.select().from(surveys).orderBy(desc(surveys.createdAt)).limit(200);
  return rows.map(toSurveyDto);
}

export async function getSurveyWithPoints(id: number): Promise<{ survey: SurveyDto; points: SamplePoint[] } | null> {
  const db = await getDb();
  const [row] = await db.select().from(surveys).where(eq(surveys.id, id)).limit(1);
  if (!row) return null;

  const pointRows = await db
    .select()
    .from(elevationPoints)
    .where(eq(elevationPoints.surveyId, id))
    .orderBy(asc(elevationPoints.seq));

  const points: SamplePoint[] = pointRows.map((r) => ({
    kind: r.kind as PointKind,
    feature: r.feature,
    seq: r.seq,
    col: r.col,
    row: r.row,
    distance: r.distance,
    lat: r.lat,
    lon: r.lon,
    easting: r.easting,
    northing: r.northing,
    elevation: r.elevation,
  }));

  return { survey: toSurveyDto(row), points };
}
