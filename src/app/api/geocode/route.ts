export const dynamic = "force-dynamic";

/** Proxy pencarian lokasi (Nominatim OSM) agar pengguna mudah menemukan area survei di peta. */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 2 || q.length > 160) {
    return Response.json({ results: [] });
  }

  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=5&addressdetails=0`;
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "TopoKontur/2.0 (topographic survey tool)",
      },
      signal: AbortSignal.timeout(10000),
      cache: "no-store",
    });
    if (!res.ok) return Response.json({ results: [] });
    const raw = (await res.json()) as { display_name?: string; lat?: string; lon?: string }[];
    const results = (Array.isArray(raw) ? raw : [])
      .map((r) => ({
        label: String(r.display_name ?? ""),
        lat: Number(r.lat),
        lon: Number(r.lon),
      }))
      .filter((r) => r.label && Number.isFinite(r.lat) && Number.isFinite(r.lon));
    return Response.json({ results });
  } catch {
    return Response.json({ results: [] });
  }
}
