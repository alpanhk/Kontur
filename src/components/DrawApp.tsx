"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DrawMode, ProbeInfo } from "./MapEditor";
import { fetchElevationsInBrowser } from "@/lib/client-elevation";
import { coordsToFeatures, parseCoordinateText, parseImportFile } from "@/lib/import-features";
import { buildPlan, recommendHighResSpacing } from "@/lib/plan";
import { polylineLength, projectionForFeatures, ringArea, utmForZone, utmZoneFor } from "@/lib/geo";
import {
  MAX_POINTS,
  type FeatureType,
  type LngLat,
  type ProviderId,
  type ProviderInfo,
  type SurveyFeature,
} from "@/lib/types";
import { formatDuration, nextName, samePoint, uniqueName } from "@/lib/utils";

const MapEditor = dynamic(() => import("./MapEditor"), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center text-sm text-slate-500">Memuat peta…</div>,
});

const MODES: { id: DrawMode; label: string; hint: string }[] = [
  { id: "pan", label: "Geser", hint: "Geser & zoom peta, atau cari lokasi/koordinat UTM di kolom pencarian." },
  {
    id: "polygon",
    label: "Poligon",
    hint: "Klik sudut poligon di peta. Klik titik hijau pertama, dobel-klik, atau tekan Enter untuk menutup area.",
  },
  { id: "rect", label: "Kotak", hint: "Klik pojok pertama lalu klik pojok berlawanan untuk membuat area persegi." },
  { id: "line", label: "Garis", hint: "Klik titik jalur di peta. Dobel-klik atau Enter untuk selesai. Isi Koridor > 0 untuk kontur jalur." },
  { id: "point", label: "Titik", hint: "Klik peta untuk menambahkan titik ukur (spot height UTM)." },
  { id: "probe", label: "Cek Elevasi", hint: "Klik lokasi mana saja di peta untuk melihat elevasi & koordinat UTM-nya." },
];

const FALLBACK_PROVIDERS: ProviderInfo[] = [
  {
    id: "copernicus-glo30",
    label: "Copernicus DEM GLO-30 HD (Float32 · Rekomendasi)",
    description: "DEM 30 m ilmiah paling akurat (ESA Float32, interpolasi bikubik). Cepat, tanpa batas rate.",
    maxBatch: 5000,
    minIntervalMs: 0,
    available: true,
    reason: null,
  },
  {
    id: "aws-terrarium-hd",
    label: "AWS Terrain Tiles HD (Terrarium z15 · Super Cepat)",
    description: "Grid elevasi 24-bit sub-meter (~5 m/piksel, interpolasi bikubik).",
    maxBatch: 5000,
    minIntervalMs: 0,
    available: true,
    reason: null,
  },
  {
    id: "simulasi-dem",
    label: "Model Topografi Lokal (Offline / Demo)",
    description: "Model permukaan medan sintetis kontinu untuk pengujian kontur tanpa koneksi internet.",
    maxBatch: 5000,
    minIntervalMs: 0,
    available: true,
    reason: null,
  },
];

const uid = () => Math.random().toString(36).slice(2, 10);

function rectFromCorners(a: LngLat, b: LngLat): LngLat[] {
  const minLon = Math.min(a[0], b[0]);
  const maxLon = Math.max(a[0], b[0]);
  const minLat = Math.min(a[1], b[1]);
  const maxLat = Math.max(a[1], b[1]);
  return [
    [minLon, minLat],
    [maxLon, minLat],
    [maxLon, maxLat],
    [minLon, maxLat],
  ];
}

let preferBrowserDem = false;

async function requestElevations(
  provider: ProviderId,
  points: { lat: number; lon: number }[],
  signal?: AbortSignal,
): Promise<(number | null)[]> {
  if (preferBrowserDem && provider !== "simulasi-dem" && provider !== "google") {
    return fetchElevationsInBrowser(provider, points, signal);
  }

  const res = await fetch("/api/elevation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, points }),
    signal,
  });
  const data = (await res.json().catch(() => ({}))) as { elevations?: (number | null)[]; error?: string };
  if (res.ok && data.elevations) {
    return data.elevations;
  }

  if (res.status === 502 && provider !== "simulasi-dem" && provider !== "google") {
    try {
      const direct = await fetchElevationsInBrowser(provider, points, signal);
      preferBrowserDem = true;
      return direct;
    } catch {
      // Lanjutkan dengan pesan error server di bawah bila browser juga gagal mengakses internet
    }
  }

  throw new Error(data.error ?? `Permintaan elevasi gagal (HTTP ${res.status}).`);
}

const labelFor = (type: FeatureType) => (type === "line" ? "Garis" : type === "polygon" ? "Poligon" : "Titik");

function Card({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <h2 className="text-xs font-bold uppercase tracking-wide text-slate-700">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

const inputCls =
  "w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20";
const btnPrimary =
  "rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300";
const btnSecondary =
  "rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";

export default function DrawApp() {
  const router = useRouter();
  const abortRef = useRef<AbortController | null>(null);

  const [tab, setTab] = useState<"draw" | "import">("draw");
  const [providers, setProviders] = useState<ProviderInfo[]>(FALLBACK_PROVIDERS);
  const [providerId, setProviderId] = useState<ProviderId>("copernicus-glo30");
  const [mode, setMode] = useState<DrawMode>("polygon");
  const [features, setFeatures] = useState<SurveyFeature[]>([]);
  const [draft, setDraft] = useState<LngLat[]>([]);
  const [spacing, setSpacing] = useState(10);
  const [corridor, setCorridor] = useState(0);
  const [surveyName, setSurveyName] = useState("Survei Topografi UTM");

  // Pengaturan UTM (utama)
  const [utmAuto, setUtmAuto] = useState(true);
  const [manualZone, setManualZone] = useState(48);
  const [manualSouth, setManualSouth] = useState(true);

  // Impor koordinat / KML / KMZ
  const [pasteType, setPasteType] = useState<FeatureType>("polygon");
  const [pasteCoordMode, setPasteCoordMode] = useState<"auto" | "utm" | "latlon">("auto");
  const [pasteText, setPasteText] = useState("");

  const [probe, setProbe] = useState<ProbeInfo | null>(null);
  const [fitToken, setFitToken] = useState(0);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; phase: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/elevation")
      .then((r) => r.json())
      .then((d: { providers?: ProviderInfo[] }) => {
        if (Array.isArray(d.providers) && d.providers.length) {
          setProviders(d.providers);
        }
      })
      .catch(() => undefined);
  }, []);

  const currentProvider = providers.find((p) => p.id === providerId) ?? providers[0];
  const utmOverride = useMemo(
    () => (utmAuto ? null : { zone: manualZone, south: manualSouth }),
    [utmAuto, manualZone, manualSouth],
  );

  const plan = useMemo(
    () =>
      buildPlan(features, {
        spacing,
        corridor,
        batchSize: currentProvider?.maxBatch ?? 100,
        utmOverride,
      }),
    [features, spacing, corridor, currentProvider, utmOverride],
  );

  const activeZone = plan.zone || manualZone;
  const activeSouth = plan.zone ? plan.south : manualSouth;

  const optimalSpacing = useMemo(
    () => (features.length > 0 ? recommendHighResSpacing(plan.areaM2, plan.lengthM, corridor) : 10),
    [features.length, plan.areaM2, plan.lengthM, corridor],
  );

  const metrics = useMemo(() => {
    const map = new Map<string, { length: number; area: number; e0: number; n0: number }>();
    if (features.length === 0) return map;
    const proj = projectionForFeatures(features, utmOverride);
    for (const f of features) {
      const xy = f.coords.map(([lon, lat]) => proj.toUtm(lon, lat));
      map.set(f.id, {
        length: f.type === "line" ? polylineLength(xy) : 0,
        area: f.type === "polygon" ? ringArea(xy) : 0,
        e0: xy[0]?.[0] ?? 0,
        n0: xy[0]?.[1] ?? 0,
      });
    }
    return map;
  }, [features, utmOverride]);

  const addFeature = (type: FeatureType, coords: LngLat[], prefix: string) => {
    setFeatures((fs) => {
      const next = [...fs, { id: uid(), name: nextName(prefix, fs), type, coords }];
      // Jika ini fitur area pertama, otomatis sarankan spasi yang cocok bila spasi sekarang akan melebihi batas
      if (fs.length === 0) {
        const test = buildPlan(next, { spacing, corridor, utmOverride });
        if (!test.ok && test.suggestedSpacing) {
          setSpacing(test.suggestedSpacing);
        }
      }
      return next;
    });
  };

  const finishDraft = useCallback(() => {
    if (mode === "line") {
      if (draft.length >= 2) {
        addFeature("line", draft, "Garis");
        setDraft([]);
      } else {
        setError("Garis membutuhkan minimal 2 titik.");
      }
    } else if (mode === "polygon") {
      if (draft.length >= 3) {
        addFeature("polygon", draft, "Poligon");
        setDraft([]);
      } else {
        setError("Poligon membutuhkan minimal 3 titik.");
      }
    }
  }, [mode, draft]); // eslint-disable-line react-hooks/exhaustive-deps

  const probeAt = async (ll: LngLat) => {
    const [lon, lat] = ll;
    const proj = utmOverride ? utmForZone(utmOverride.zone, utmOverride.south) : utmForZone(utmZoneFor(lon), lat < 0);
    const [easting, northing] = proj.toUtm(lon, lat);
    const zoneLabel = `${proj.zone}${proj.south ? "S" : "N"}`;
    setProbe({ lat, lon, easting, northing, zoneLabel, elevation: null, error: "Mengambil elevasi…" });
    try {
      const [elev] = await requestElevations(providerId, [{ lat, lon }]);
      setProbe({
        lat,
        lon,
        easting,
        northing,
        zoneLabel,
        elevation: elev ?? null,
        error: elev == null ? "Tidak ada data (laut / di luar cakupan)" : null,
      });
    } catch (e) {
      setProbe({
        lat,
        lon,
        easting,
        northing,
        zoneLabel,
        elevation: null,
        error: e instanceof Error ? e.message : "Gagal mengambil elevasi",
      });
    }
  };

  const handleMapClick = (ll: LngLat) => {
    setError(null);
    if (mode === "line" || mode === "polygon") {
      setDraft((d) => (samePoint(d[d.length - 1], ll) ? d : [...d, ll]));
    } else if (mode === "rect") {
      if (draft.length === 0) {
        setDraft([ll]);
      } else {
        const a = draft[0];
        if (Math.abs(a[0] - ll[0]) < 1e-9 || Math.abs(a[1] - ll[1]) < 1e-9) {
          setError("Pojok kedua harus berbeda dari pojok pertama.");
          return;
        }
        addFeature("polygon", rectFromCorners(a, ll), "Kotak");
        setDraft([]);
      }
    } else if (mode === "point") {
      if (!features.some((f) => f.type === "point" && samePoint(f.coords[0], ll))) {
        addFeature("point", [ll], "Titik");
      }
    } else if (mode === "probe") {
      void probeAt(ll);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON") return;
      if (e.key === "Enter") finishDraft();
      else if (e.key === "Escape") setDraft([]);
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        setDraft((d) => d.slice(0, -1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [finishDraft]);

  const onFile = async (file: File) => {
    setError(null);
    setNotice(null);
    try {
      const res = await parseImportFile(file, pasteType, {
        coordMode: pasteCoordMode,
        utmZone: activeZone,
        utmSouth: activeSouth,
      });
      if (res.features.length === 0) throw new Error("Tidak ada geometri yang dikenali pada file ini.");
      setFeatures((fs) => {
        let cur = fs;
        for (const pf of res.features) {
          cur = [...cur, { id: uid(), name: uniqueName(pf.name, cur), type: pf.type, coords: pf.coords }];
        }
        // Sesuaikan spasi otomatis bila impor area besar
        const check = buildPlan(cur, { spacing, corridor, utmOverride });
        if (!check.ok && check.suggestedSpacing) setSpacing(check.suggestedSpacing);
        return cur;
      });
      setFitToken((t) => t + 1);
      setTab("draw");
      const warn = res.warnings.length ? ` (${res.warnings.join("; ")})` : "";
      setNotice(`Berhasil mengimpor ${res.features.length} fitur dari ${file.name}${warn}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal membaca file.");
    }
  };

  const addPasted = () => {
    const { coords, skipped, detectedUtm } = parseCoordinateText(pasteText, {
      coordMode: pasteCoordMode,
      utmZone: activeZone,
      utmSouth: activeSouth,
    });
    const parsed = coordsToFeatures(coords, pasteType, "Koordinat");
    if (parsed.length === 0) {
      setError("Koordinat belum cukup untuk jenis fitur yang dipilih (garis ≥ 2 titik, poligon ≥ 3 titik).");
      return;
    }
    setFeatures((fs) => {
      let cur = fs;
      for (const pf of parsed) {
        cur = [...cur, { id: uid(), name: nextName(labelFor(pf.type), cur), type: pf.type, coords: pf.coords }];
      }
      const check = buildPlan(cur, { spacing, corridor, utmOverride });
      if (!check.ok && check.suggestedSpacing) setSpacing(check.suggestedSpacing);
      return cur;
    });
    setPasteText("");
    setFitToken((t) => t + 1);
    setTab("draw");
    setError(null);
    setNotice(
      `${parsed.length} fitur ditambahkan (${detectedUtm ? `UTM ${activeZone}${activeSouth ? "S" : "N"}` : "WGS84"}${skipped ? `, ${skipped} baris dilewati` : ""}).`,
    );
  };

  const removeFeature = (id: string) => setFeatures((fs) => fs.filter((f) => f.id !== id));

  const clearAll = () => {
    setFeatures([]);
    setDraft([]);
    setProbe(null);
    setNotice(null);
    setError(null);
  };

  const cancelSampling = () => {
    abortRef.current?.abort();
  };

  const runSampling = async () => {
    if (!plan.ok || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);

    const controller = new AbortController();
    abortRef.current = controller;

    const batchSize = currentProvider?.maxBatch ?? 100;
    const samples = plan.points.map((p) => ({ ...p }));
    const total = samples.length;
    const batches: number[][] = [];
    for (let i = 0; i < total; i += batchSize) {
      batches.push(Array.from({ length: Math.min(batchSize, total - i) }, (_, k) => i + k));
    }

    const state = { done: 0, next: 0, error: null as string | null, aborted: false };
    setProgress({ done: 0, total, phase: "Mengambil data elevasi HD" });

    const worker = async () => {
      while (state.error === null && !state.aborted && state.next < batches.length) {
        const batch = batches[state.next++];
        try {
          const elev = await requestElevations(
            providerId,
            batch.map((i) => ({ lat: samples[i].lat, lon: samples[i].lon })),
            controller.signal,
          );
          batch.forEach((idx, j) => {
            samples[idx].elevation = elev[j] ?? null;
          });
          state.done += batch.length;
          setProgress({ done: state.done, total, phase: "Mengambil data elevasi HD" });
        } catch (e) {
          if (controller.signal.aborted) {
            state.aborted = true;
          } else {
            state.error = e instanceof Error ? e.message : "Gagal mengambil data elevasi.";
          }
        }
      }
    };

    const maxConc = providerId.startsWith("opentopodata") ? 2 : 3;
    const concurrency = Math.max(1, Math.min(maxConc, batches.length));
    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    if (state.aborted) {
      setNotice("Pengambilan data dibatalkan.");
      setBusy(false);
      setProgress(null);
      return;
    }

    if (state.error) {
      setError(
        `${state.error} (${state.done.toLocaleString("id-ID")} dari ${total.toLocaleString("id-ID")} titik selesai). Coba gunakan Copernicus GLO-30 HD atau AWS Terrain HD.`,
      );
      setBusy(false);
      setProgress(null);
      return;
    }

    setProgress({ done: total, total, phase: "Menyimpan & membangun peta kontur" });
    try {
      const res = await fetch("/api/surveys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: surveyName.trim() || "Survei Topografi",
          provider: providerId,
          spacingM: plan.spacing,
          corridorM: plan.corridor,
          zone: plan.zone,
          south: plan.south,
          epsg: plan.epsg,
          features,
          grid: plan.grid,
          points: samples,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { id?: number; error?: string };
      if (!res.ok || !data.id) throw new Error(data.error ?? "Gagal menyimpan survei.");
      router.push(`/surveys/${data.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal menyimpan survei.");
      setBusy(false);
      setProgress(null);
    }
  };

  const currentHint = MODES.find((m) => m.id === mode)?.hint ?? "";
  const isFastProvider = providerId === "copernicus-glo30" || providerId === "aws-terrarium-hd";
  const etaSec = providerId.startsWith("opentopodata")
    ? plan.requests * 1.15
    : isFastProvider
      ? Math.max(1.5, plan.requests * 2.2)
      : (plan.requests * 0.4) / 3;
  const hasArea = plan.counts.grid > 0;
  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="flex w-full flex-col lg:h-full lg:min-h-0 lg:flex-1 lg:flex-row">
      <aside
        id="panel-pengaturan"
        className="order-2 flex w-full shrink-0 flex-col bg-slate-50 lg:order-1 lg:h-full lg:min-h-0 lg:w-[420px] lg:border-r lg:border-slate-200"
      >
        {/* Header & Tab Navigasi */}
        <div className="shrink-0 border-b border-slate-200 bg-white px-4 pb-3 pt-3">
          <div className="flex items-center justify-between">
            <h1 className="text-base font-bold text-slate-900">Pengambilan Elevasi &amp; Kontur UTM</h1>
            <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700 ring-1 ring-emerald-200">
              UTM WGS84
            </span>
          </div>
          <div className="mt-2.5 grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1">
            <button
              type="button"
              onClick={() => setTab("draw")}
              className={`rounded-md py-1.5 text-xs font-semibold transition ${
                tab === "draw" ? "bg-white text-emerald-700 shadow-sm" : "text-slate-600 hover:text-slate-900"
              }`}
            >
              1. Gambar &amp; Pengaturan
            </button>
            <button
              type="button"
              onClick={() => setTab("import")}
              className={`rounded-md py-1.5 text-xs font-semibold transition ${
                tab === "import" ? "bg-white text-emerald-700 shadow-sm" : "text-slate-600 hover:text-slate-900"
              }`}
            >
              2. Impor KML / UTM
            </button>
          </div>
        </div>

        {/* Konten Scrollable */}
        <div className="min-h-0 flex-1 space-y-3 p-3.5 pb-6 lg:overflow-y-auto lg:overscroll-contain">
          {tab === "draw" ? (
            <>
              <Card title="Mode Gambar di Peta">
                <div className="grid grid-cols-3 gap-1.5">
                  {MODES.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => {
                        setMode(m.id);
                        setDraft([]);
                        setError(null);
                      }}
                      disabled={busy}
                      className={`rounded-lg border px-2 py-2 text-xs font-semibold transition ${
                        mode === m.id
                          ? "border-emerald-600 bg-emerald-600 text-white shadow-sm"
                          : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
                <p className="mt-2 rounded-lg bg-slate-100 px-2.5 py-2 text-[11px] leading-relaxed text-slate-600">
                  {currentHint}
                </p>
              </Card>

              <Card
                title="Sumber DEM & Resolusi Grid"
                right={
                  features.length > 0 ? (
                    <button
                      type="button"
                      onClick={() => setSpacing(optimalSpacing)}
                      disabled={busy}
                      className="text-[11px] font-semibold text-emerald-700 hover:underline"
                    >
                      Optimal ({optimalSpacing} m)
                    </button>
                  ) : null
                }
              >
                <label className="mb-1 block text-[11px] font-medium text-slate-600">Sumber Data Elevasi</label>
                <select
                  className={inputCls}
                  value={providerId}
                  onChange={(e) => setProviderId(e.target.value as ProviderId)}
                  disabled={busy}
                >
                  {providers.map((p) => (
                    <option key={p.id} value={p.id} disabled={!p.available}>
                      {p.label}
                      {p.available ? "" : " (perlu kunci API)"}
                    </option>
                  ))}
                </select>
                {currentProvider ? (
                  <p className="mt-1 text-[11px] leading-snug text-slate-500">
                    {currentProvider.description}
                    {currentProvider.reason ? ` ${currentProvider.reason}` : ""}
                  </p>
                ) : null}

                {/* Preset Spasi Resolusi */}
                <div className="mt-3">
                  <label className="mb-1 block text-[11px] font-medium text-slate-600">
                    Spasi Grid Elevasi (semakin kecil = kontur lebih detail)
                  </label>
                  <div className="mb-2 flex flex-wrap gap-1">
                    {[
                      { s: 5, lbl: "Ultra 5m" },
                      { s: 10, lbl: "Tinggi 10m" },
                      { s: 20, lbl: "Detail 20m" },
                      { s: 30, lbl: "Standar 30m" },
                      { s: 50, lbl: "Luas 50m" },
                    ].map((p) => (
                      <button
                        key={p.s}
                        type="button"
                        disabled={busy}
                        onClick={() => setSpacing(p.s)}
                        className={`rounded-md px-2 py-1 text-[11px] font-medium transition ${
                          spacing === p.s
                            ? "bg-emerald-600 text-white"
                            : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                        }`}
                      >
                        {p.lbl}
                      </button>
                    ))}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="mb-0.5 block text-[11px] text-slate-500">Spasi kustom (m)</label>
                      <input
                        type="number"
                        min={1}
                        step={1}
                        className={inputCls}
                        value={Number.isFinite(spacing) ? spacing : ""}
                        onChange={(e) => setSpacing(Number(e.target.value))}
                        disabled={busy}
                      />
                    </div>
                    <div>
                      <label className="mb-0.5 block text-[11px] text-slate-500">Koridor garis (m)</label>
                      <input
                        type="number"
                        min={0}
                        step={10}
                        className={inputCls}
                        value={Number.isFinite(corridor) ? corridor : ""}
                        onChange={(e) => setCorridor(Number(e.target.value))}
                        disabled={busy}
                      />
                    </div>
                  </div>
                </div>

                {/* Sistem Koordinat UTM */}
                <div className="mt-3 rounded-lg bg-slate-50 p-2.5 ring-1 ring-slate-200">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold text-slate-700">Sistem Koordinat Utama: UTM (Meter)</span>
                    <label className="flex items-center gap-1.5 text-[11px] text-slate-600">
                      <input
                        type="checkbox"
                        checked={utmAuto}
                        onChange={(e) => setUtmAuto(e.target.checked)}
                        disabled={busy}
                      />
                      Zona otomatis
                    </label>
                  </div>
                  {!utmAuto ? (
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <div>
                        <label className="mb-0.5 block text-[10px] text-slate-500">Zona UTM (1–60)</label>
                        <input
                          type="number"
                          min={1}
                          max={60}
                          className={inputCls}
                          value={manualZone}
                          onChange={(e) => setManualZone(Math.max(1, Math.min(60, Number(e.target.value) || 48)))}
                        />
                      </div>
                      <div>
                        <label className="mb-0.5 block text-[10px] text-slate-500">Belahan Bumi</label>
                        <select
                          className={inputCls}
                          value={manualSouth ? "S" : "N"}
                          onChange={(e) => setManualSouth(e.target.value === "S")}
                        >
                          <option value="S">Selatan (S · 327xx)</option>
                          <option value="N">Utara (N · 326xx)</option>
                        </select>
                      </div>
                    </div>
                  ) : (
                    <p className="mt-1 text-[11px] text-slate-500">
                      {plan.zone
                        ? `Terdeteksi otomatis: WGS84 / UTM Zona ${plan.zone}${plan.south ? "S" : "N"} (${plan.epsg})`
                        : "Zona UTM otomatis mengikuti lokasi gambar (contoh Indonesia: 46S–54S / 46N–53N)."}
                    </p>
                  )}
                </div>

                <label className="mb-1 mt-3 block text-[11px] font-medium text-slate-600">Nama Survei</label>
                <input
                  className={inputCls}
                  value={surveyName}
                  onChange={(e) => setSurveyName(e.target.value)}
                  maxLength={120}
                  disabled={busy}
                />
              </Card>

              <Card
                title={`Fitur Terpilih (${features.length})`}
                right={
                  features.length > 0 ? (
                    <button type="button" onClick={clearAll} disabled={busy} className="text-[11px] font-medium text-red-600 hover:underline">
                      Hapus semua
                    </button>
                  ) : null
                }
              >
                {features.length === 0 ? (
                  <p className="text-xs text-slate-500">
                    Belum ada area/garis. Gambar langsung di peta atau buka tab <b>Impor KML / UTM</b>.
                  </p>
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {features.map((f) => {
                      const m = metrics.get(f.id);
                      const detail =
                        f.type === "line"
                          ? `${f.coords.length} titik · ${(m?.length ?? 0).toLocaleString("id-ID", { maximumFractionDigits: 0 })} m`
                          : f.type === "polygon"
                            ? `${f.coords.length} sudut · ${((m?.area ?? 0) / 10000).toLocaleString("id-ID", { maximumFractionDigits: 2 })} ha`
                            : `E ${(m?.e0 ?? 0).toFixed(2)} · N ${(m?.n0 ?? 0).toFixed(2)}`;
                      return (
                        <li key={f.id} className="flex items-center gap-2 py-1.5">
                          <span
                            className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                              f.type === "line"
                                ? "bg-amber-100 text-amber-800"
                                : f.type === "polygon"
                                  ? "bg-emerald-100 text-emerald-800"
                                  : "bg-red-100 text-red-800"
                            }`}
                          >
                            {f.type === "line" ? "garis" : f.type === "polygon" ? "poligon" : "titik"}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-xs font-semibold text-slate-800">{f.name}</div>
                            <div className="truncate text-[11px] text-slate-500">{detail}</div>
                          </div>
                          <button
                            type="button"
                            onClick={() => removeFeature(f.id)}
                            disabled={busy}
                            className="rounded px-2 py-1 text-[11px] text-red-600 hover:bg-red-50 disabled:opacity-40"
                          >
                            Hapus
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Card>

              <Card title="Ringkasan Sampling">
                {plan.ok ? (
                  <div className="space-y-2 text-xs text-slate-700">
                    <div className="grid grid-cols-2 gap-2">
                      <Stat label="Total Titik" value={plan.points.length.toLocaleString("id-ID")} />
                      <Stat label="Estimasi Waktu" value={`± ${formatDuration(etaSec)}`} />
                      <Stat label="Proyeksi Utama" value={`UTM ${plan.zone}${plan.south ? "S" : "N"} · ${plan.epsg}`} />
                      <Stat
                        label="Luas / Panjang"
                        value={
                          plan.areaM2 > 0
                            ? `${(plan.areaM2 / 10000).toLocaleString("id-ID", { maximumFractionDigits: 2 })} ha`
                            : `${plan.lengthM.toLocaleString("id-ID", { maximumFractionDigits: 0 })} m`
                        }
                      />
                    </div>
                    {!hasArea ? (
                      <p className="rounded-lg bg-amber-50 p-2 text-[11px] text-amber-800">
                        Hanya garis/titik — peta kontur membutuhkan poligon/kotak, atau isi <b>Koridor garis &gt; 0</b>.
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="rounded-lg bg-slate-100 p-2 text-xs text-slate-600">{plan.error}</p>
                    {plan.suggestedSpacing ? (
                      <button
                        type="button"
                        className={btnSecondary}
                        onClick={() => setSpacing(plan.suggestedSpacing ?? 20)}
                      >
                        Terapkan spasi yang disarankan ({plan.suggestedSpacing} m)
                      </button>
                    ) : null}
                  </div>
                )}
              </Card>
            </>
          ) : (
            <>
              <Card title="Impor File Google Earth Pro / GIS">
                <div className="mb-3 rounded-lg bg-emerald-50 p-2.5 text-[11px] leading-relaxed text-emerald-900">
                  <b>Dari Google Earth Pro:</b> Gambar Path / Polygon → klik kanan di panel Places →{" "}
                  <b>Save Place As…</b> → pilih <b>.kml</b> atau <b>.kmz</b>, lalu unggah di bawah.
                </div>
                <label className="mb-1 block text-xs font-medium text-slate-600">
                  Pilih file (.kml, .kmz, .geojson, .csv, .txt)
                </label>
                <input
                  type="file"
                  accept=".kml,.kmz,.geojson,.json,.csv,.txt"
                  disabled={busy}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void onFile(f);
                    e.target.value = "";
                  }}
                  className="block w-full text-xs text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-emerald-600 file:px-3 file:py-2 file:text-xs file:font-semibold file:text-white hover:file:bg-emerald-700"
                />
              </Card>

              <Card title="Tempel Koordinat UTM / Geografis">
                <div className="mb-2 grid grid-cols-2 gap-2">
                  <div>
                    <label className="mb-0.5 block text-[11px] text-slate-600">Format koordinat</label>
                    <select
                      className={inputCls}
                      value={pasteCoordMode}
                      onChange={(e) => setPasteCoordMode(e.target.value as "auto" | "utm" | "latlon")}
                    >
                      <option value="auto">Otomatis (UTM / LatLon)</option>
                      <option value="utm">UTM (Easting, Northing)</option>
                      <option value="latlon">WGS84 (Lintang, Bujur)</option>
                    </select>
                  </div>
                  <div>
                    <label className="mb-0.5 block text-[11px] text-slate-600">Bentuk fitur</label>
                    <select
                      className={inputCls}
                      value={pasteType}
                      onChange={(e) => setPasteType(e.target.value as FeatureType)}
                    >
                      <option value="polygon">Poligon (Area Kontur)</option>
                      <option value="line">Garis (Profil/Jalur)</option>
                      <option value="point">Titik-titik (Spot)</option>
                    </select>
                  </div>
                </div>

                <div className="mb-2 grid grid-cols-2 gap-2 rounded-lg bg-slate-50 p-2 ring-1 ring-slate-200">
                  <div>
                    <label className="block text-[10px] text-slate-500">Zona UTM untuk impor</label>
                    <input
                      type="number"
                      min={1}
                      max={60}
                      className={inputCls}
                      value={manualZone}
                      onChange={(e) => {
                        setUtmAuto(false);
                        setManualZone(Math.max(1, Math.min(60, Number(e.target.value) || 48)));
                      }}
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-500">Belahan</label>
                    <select
                      className={inputCls}
                      value={manualSouth ? "S" : "N"}
                      onChange={(e) => {
                        setUtmAuto(false);
                        setManualSouth(e.target.value === "S");
                      }}
                    >
                      <option value="S">Selatan (S)</option>
                      <option value="N">Utara (N)</option>
                    </select>
                  </div>
                </div>

                <textarea
                  rows={6}
                  className={`${inputCls} font-mono text-xs`}
                  placeholder={
                    "Contoh UTM (Easting, Northing):\n788000, 9251500\n789200, 9251500\n789200, 9252700\n788000, 9252700\n\nAtau Lat, Lon:\n-6.760, 107.605"
                  }
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  disabled={busy}
                />
                <button
                  type="button"
                  className={`${btnPrimary} mt-2 w-full`}
                  onClick={addPasted}
                  disabled={busy || !pasteText.trim()}
                >
                  Tambahkan ke Peta
                </button>
              </Card>
            </>
          )}

          {notice ? <p className="rounded-lg bg-emerald-50 p-2.5 text-xs text-emerald-800">{notice}</p> : null}
          {error ? <p className="rounded-lg bg-red-50 p-2.5 text-xs text-red-700">{error}</p> : null}
        </div>

        {/* Footer Tombol Eksekusi (selalu terlihat) */}
        <div className="sticky bottom-0 z-20 shrink-0 space-y-2 border-t border-slate-200 bg-white px-4 py-3 lg:static">
          {progress ? (
            <div>
              <div className="mb-1 flex justify-between text-xs text-slate-600">
                <span>{progress.phase}…</span>
                <span className="font-semibold">
                  {progress.done.toLocaleString("id-ID")} / {progress.total.toLocaleString("id-ID")} ({pct}%)
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-200">
                <div className="h-full bg-emerald-600 transition-all" style={{ width: `${pct}%` }} />
              </div>
            </div>
          ) : null}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={runSampling}
              disabled={!plan.ok || busy}
              className={`${btnPrimary} flex-1 py-2.5`}
            >
              {busy ? "Memproses…" : "Ambil Elevasi & Buat Peta Kontur"}
            </button>
            {busy ? (
              <button
                type="button"
                onClick={cancelSampling}
                className="rounded-lg border border-red-300 bg-red-50 px-3 py-2.5 text-xs font-semibold text-red-700 hover:bg-red-100"
              >
                Batal
              </button>
            ) : null}
          </div>
          <p className="text-center text-[10px] text-slate-400">
            Maks. {MAX_POINTS.toLocaleString("id-ID")} titik/survei · Koordinat utama UTM (meter) · Ekspor DXF/CAD/GIS
          </p>
        </div>
      </aside>

      <section className="relative order-1 h-[45vh] min-h-[290px] w-full shrink-0 lg:order-2 lg:h-full lg:min-h-0 lg:flex-1">
        <MapEditor
          features={features}
          draft={draft}
          mode={mode}
          probe={probe}
          fitToken={fitToken}
          utmOverride={utmOverride}
          onClick={handleMapClick}
          onFinishDraft={finishDraft}
          onUndoDraft={() => setDraft((d) => d.slice(0, -1))}
          onCancelDraft={() => setDraft([])}
        />
        <a
          href="#panel-pengaturan"
          className="absolute bottom-10 right-3 z-[1000] rounded-full bg-emerald-600/95 px-3 py-1.5 text-[11px] font-semibold text-white shadow-lg backdrop-blur hover:bg-emerald-700 lg:hidden"
        >
          ↓ Pengaturan &amp; Kontur
        </a>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-slate-50 p-2 ring-1 ring-slate-200">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="truncate text-xs font-bold text-slate-800">{value}</div>
    </div>
  );
}
