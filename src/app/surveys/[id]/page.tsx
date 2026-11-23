import { notFound } from "next/navigation";
import SurveyView from "@/components/SurveyView";
import { dwgConfigured } from "@/lib/dwg";
import { getSurveyWithPoints } from "@/lib/survey-repo";

export const dynamic = "force-dynamic";

export default async function SurveyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const numId = Number(id);
  if (!Number.isInteger(numId) || numId <= 0) notFound();

  const data = await getSurveyWithPoints(numId);
  if (!data) notFound();

  return <SurveyView survey={data.survey} points={data.points} dwgEnabled={dwgConfigured()} />;
}
