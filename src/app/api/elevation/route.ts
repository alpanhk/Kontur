import { fetchElevations, listProviders } from "@/lib/elevation-providers";

export const dynamic = "force-dynamic";

/** Daftar sumber elevasi yang tersedia (Google hanya jika kunci API diisi di server). */
export async function GET() {
  return Response.json({ providers: listProviders() });
}

/**
 * Proxy elevasi: menerima satu batch lokasi (maks 100) dan mengembalikan elevasi dalam meter.
 * Body: { provider: string, points: [{ lat, lon }] }
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Body JSON tidak valid." }, { status: 400 });
  }

  const { provider, points } = (body ?? {}) as { provider?: unknown; points?: unknown };
  const info = listProviders().find((p) => p.id === provider);
  if (!info) {
    return Response.json({ error: "Sumber elevasi tidak dikenal." }, { status: 400 });
  }
  if (!info.available) {
    return Response.json({ error: info.reason ?? "Sumber elevasi tidak tersedia." }, { status: 400 });
  }
  if (!Array.isArray(points) || points.length === 0 || points.length > info.maxBatch) {
    return Response.json(
      { error: `Jumlah titik per permintaan harus 1–${info.maxBatch}.` },
      { status: 400 },
    );
  }

  const locs: { lat: number; lon: number }[] = [];
  for (const p of points) {
    const q = (p ?? {}) as Record<string, unknown>;
    const lat = Number(q.lat);
    const lon = Number(q.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return Response.json({ error: "Koordinat tidak valid." }, { status: 400 });
    }
    locs.push({ lat, lon });
  }

  try {
    const elevations = await fetchElevations(info.id, locs);
    return Response.json({ provider: info.id, elevations });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Gagal mengambil data elevasi.";
    return Response.json({ error: message }, { status: 502 });
  }
}
