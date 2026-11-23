import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { surveys } from "@/db/schema";
import { getSurveyWithPoints } from "@/lib/survey-repo";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET(_req: Request, { params }: Ctx) {
  const id = parseId((await params).id);
  if (id === null) return Response.json({ error: "ID tidak valid." }, { status: 400 });

  const data = await getSurveyWithPoints(id);
  if (!data) return Response.json({ error: "Survei tidak ditemukan." }, { status: 404 });
  return Response.json({ survey: data.survey, points: data.points });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const id = parseId((await params).id);
  if (id === null) return Response.json({ error: "ID tidak valid." }, { status: 400 });

  const db = await getDb();
  const deleted = await db.delete(surveys).where(eq(surveys.id, id)).returning({ id: surveys.id });
  if (deleted.length === 0) return Response.json({ error: "Survei tidak ditemukan." }, { status: 404 });
  return Response.json({ ok: true });
}
