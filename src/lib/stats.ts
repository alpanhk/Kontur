import { polylineLength, ringArea, utmForZone, type XY } from "./geo";
import type { PointKind, SamplePoint, SurveyFeature, SurveyStats } from "./types";

/** Ringkasan statistik survei (dihitung di server saat disimpan). */
export function computeStats(points: SamplePoint[], features: SurveyFeature[], zone: number, south: boolean): SurveyStats {
  const proj = utmForZone(zone, south);
  const counts: Partial<Record<PointKind, number>> = {};

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let valid = 0;
  let failed = 0;
  for (const p of points) {
    counts[p.kind] = (counts[p.kind] ?? 0) + 1;
    if (p.elevation == null || !Number.isFinite(p.elevation)) {
      failed++;
      continue;
    }
    valid++;
    sum += p.elevation;
    if (p.elevation < min) min = p.elevation;
    if (p.elevation > max) max = p.elevation;
  }

  let areaM2 = 0;
  let lengthM = 0;
  const lineNames = new Set<string>();
  for (const f of features) {
    if (f.type === "line") lineNames.add(f.name);
    const xy: XY[] = f.coords.map(([lon, lat]) => proj.toUtm(lon, lat));
    if (f.type === "polygon" && xy.length >= 3) areaM2 += ringArea(xy);
    else if (f.type === "line" && xy.length >= 2) lengthM += polylineLength(xy);
  }

  // Kenaikan & penurunan kumulatif sepanjang garis (profil)
  let ascentM = 0;
  let descentM = 0;
  let hasProfile = false;
  const prev = new Map<string, number>();
  for (const p of points) {
    if (!(p.kind === "line" || p.kind === "vertex") || !lineNames.has(p.feature) || p.elevation == null) continue;
    const last = prev.get(p.feature);
    if (last !== undefined) {
      const d = p.elevation - last;
      if (d > 0) ascentM += d;
      else descentM -= d;
    }
    prev.set(p.feature, p.elevation);
    hasProfile = true;
  }

  return {
    count: points.length,
    counts,
    min: valid ? min : null,
    max: valid ? max : null,
    mean: valid ? sum / valid : null,
    relief: valid ? max - min : null,
    areaM2,
    lengthM,
    ascentM: hasProfile ? ascentM : null,
    descentM: hasProfile ? descentM : null,
    failed,
  };
}
