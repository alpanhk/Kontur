"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useMemo, useState, type ReactNode } from "react";
import { buildContours, gridFromSamples } from "@/lib/contour";
import type { PointKind, SamplePoint, SurveyDto } from "@/lib/types";
import { slugify } from "@/lib/utils";
import ProfileChart from "./ProfileChart";

const ContourMap = dynamic(() => import("./ContourMap"), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center text-sm text-slate-500">Memuat peta…</div>,
});

interface Props {
  survey: SurveyDto;
  points: SamplePoint[];
  dwgEnabled: boolean;
}

const fmt = (v: number | null | undefined, d = 2) =>
  v == null || !Number.isFinite(v) ? "–" : v.toLocaleString("id-ID", { maximumFractionDigits: d });

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

function Metric({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="rounded-lg bg-white p-2.5 ring-1 ring-slate-200">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-0.5 text-sm font-bold text-slate-900">
        {value}
        {unit ? <span className="ml-1 text-[11px] font-normal text-slate-500">{unit}</span> : null}
      </div>
    </div>
  );
}

const inputCls =
  "w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20";

export default function SurveyView({ survey, points, dwgEnabled }: Props) {
  const [intervalText, setIntervalText] = useState("");
  const [indexEvery, setIndexEvery] = useState(5);
  const [refinement, setRefinement] = useState<1 | 2 | 4>(2);
  const [smoothing, setSmoothing] = useState<0 | 1 | 2>(1);
  const [showLabels, setShowLabels] = useState(true);
  const [showPoints, setShowPoints] = useState(false);
  const [includeGrid, setIncludeGrid] = useState(false);
  const [includeUtmGrid, setIncludeUtmGrid] = useState(true);
  const [tableFilter, setTableFilter] = useState<"all" | PointKind>("all");
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [directDownloadUrl, setDirectDownloadUrl] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);

  const lineFeatures = useMemo(() => survey.features.filter((f) => f.type === "line"), [survey.features]);
  const [profileName, setProfileName] = useState<string>(lineFeatures[0]?.name ?? "");

  const interval = Number(intervalText) > 0 ? Number(intervalText) : null;

  const contours = useMemo(
    () =>
      survey.grid
        ? buildContours(gridFromSamples(survey.grid, points), {
            interval,
            indexEvery: Math.max(1, indexEvery),
            refinement,
            smoothing,
          })
        : null,
    [survey.grid, points, interval, indexEvery, refinement, smoothing],
  );

  const profile = useMemo(
    () =>
      points
        .filter((p) => (p.kind === "line" || p.kind === "vertex") && p.feature === profileName && p.elevation != null)
        .map((p) => ({ d: p.distance ?? 0, z: p.elevation as number })),
    [points, profileName],
  );

  const filteredPoints = useMemo(
    () => (tableFilter === "all" ? points : points.filter((p) => p.kind === tableFilter)),
    [points, tableFilter],
  );
  const tableRows = filteredPoints.slice(0, 400);
  const s = survey.stats;
  const created = new Date(survey.createdAt).toLocaleString("id-ID");
  const utmLabel = `UTM ${survey.zone}${survey.south ? "S" : "N"} (${survey.epsg})`;

  const query = new URLSearchParams({
    interval: interval == null ? "" : String(interval),
    index: String(Math.max(1, indexEvery)),
    refinement: String(refinement),
    smoothing: String(smoothing),
    grid: includeGrid ? "1" : "0",
    labels: showLabels ? "1" : "0",
    utmgrid: includeUtmGrid ? "1" : "0",
  }).toString();

  const utmTag = `utm${survey.zone}${survey.south ? "s" : "n"}`;
  const baseFilename = `${slugify(survey.name)}-${utmTag}-${survey.id}`;
  const exportHref = (format: string) => `/api/surveys/${survey.id}/export?format=${encodeURIComponent(format)}&${query}`;
  const filenameFor = (format: string): string => {
    switch (format) {
      case "dxf":
        return `${baseFilename}.dxf`;
      case "dwg":
        return `${baseFilename}.dwg`;
      case "xyz":
        return `${baseFilename}-pnezd-utm.txt`;
      case "asc":
        return `${baseFilename}-dem-utm.asc`;
      case "prj":
        return `${baseFilename}-dem-utm.prj`;
      case "csv":
        return `${baseFilename}-utm.csv`;
      case "geojson-utm":
        return `${baseFilename}-utm.geojson`;
      case "geojson":
        return `${baseFilename}-wgs84.geojson`;
      case "kml":
        return `${baseFilename}.kml`;
      case "zip":
        return `${baseFilename}-paket-cad-gis.zip`;
      default:
        return `${baseFilename}.${format}`;
    }
  };

  const copyTextSafe = async (text: string): Promise<boolean> => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // Fallback untuk iframe cross-origin di bawah
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  };

  const onExportClick = (format: string, label: string) => {
    const relUrl = exportHref(format);
    const fullUrl = typeof window !== "undefined" ? new URL(relUrl, window.location.origin).href : relUrl;
    const isFramed = (() => {
      try {
        return typeof window !== "undefined" && window.self !== window.top;
      } catch {
        return true;
      }
    })();

    // Jalankan pembaruan UI setelah aksi bawaan <a download> dipicu oleh browser
    setTimeout(() => {
      setDirectDownloadUrl(fullUrl);
      setCopiedUrl(false);
      setExportStatus(
        isFramed
          ? `Memulai unduhan ${label}… (Catatan: bila panel pratinjau memblokir unduhan otomatis, klik "Salin Link Unduh" di bawah lalu tempel di tab browser baru.)`
          : `Mengunduh ${label}…`,
      );

      void fetch(relUrl, { method: "POST" })
        .then(async (res) => {
          const data = (await res.json().catch(() => ({}))) as {
            ok?: boolean;
            filename?: string;
            savedPath?: string;
            error?: string;
          };
          if (!res.ok || !data.ok) {
            setExportStatus(`Error: ${data.error ?? `Gagal mengekspor (HTTP ${res.status})`}`);
            return;
          }
          setExportStatus(
            isFramed
              ? `File siap: ${data.filename} (tersimpan juga di folder proyek: ${data.savedPath}). Jika belum masuk ke folder Download browser Anda karena batasan iframe pratinjau, klik tombol "Salin Link Unduh" di bawah lalu tempel (Ctrl+V) di tab browser baru.`
              : `Berhasil menyiapkan ${data.filename} (tersimpan juga di ${data.savedPath}).`,
          );
        })
        .catch(() => undefined);
    }, 80);
  };

  return (
    <div className="flex w-full flex-col lg:h-full lg:min-h-0 lg:flex-1 lg:flex-row">
      <aside
        id="panel-ekspor"
        className="order-2 w-full shrink-0 space-y-3 bg-slate-50 p-3.5 pb-8 lg:order-1 lg:h-full lg:min-h-0 lg:w-[410px] lg:overflow-y-auto lg:overscroll-contain lg:border-r lg:border-slate-200"
      >
        <div>
          <Link href="/surveys" className="text-xs font-semibold text-emerald-700 hover:underline">
            ← Riwayat survei
          </Link>
          <h1 className="mt-1 break-words text-lg font-bold text-slate-900">{survey.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
            <span className="rounded bg-emerald-100 px-1.5 py-0.5 font-bold text-emerald-800">{utmLabel}</span>
            <span className="rounded bg-slate-200 px-1.5 py-0.5 font-medium text-slate-700">
              Spasi {survey.spacingM} m
            </span>
            <span className="rounded bg-slate-200 px-1.5 py-0.5 text-slate-700">{survey.provider}</span>
          </div>
          <p className="mt-1 text-[11px] text-slate-500" suppressHydrationWarning>
            Dibuat {created}
            {survey.corridorM > 0 ? ` · Koridor ${survey.corridorM} m` : ""}
          </p>
        </div>

        {s.failed > 0 ? (
          <p className="rounded-lg bg-amber-50 p-2.5 text-xs text-amber-800">
            {s.failed.toLocaleString("id-ID")} titik tanpa data elevasi (area laut / luar cakupan). Titik tersebut
            dilewati pada kontur.
          </p>
        ) : null}
        {!survey.grid ? (
          <p className="rounded-lg bg-amber-50 p-2.5 text-xs text-amber-800">
            Survei ini hanya berisi garis/titik (tanpa area poligon/koridor). Data tersedia sebagai profil &amp; ekspor
            DXF/CSV/XYZ UTM.
          </p>
        ) : null}

        <div className="grid grid-cols-2 gap-2">
          <Metric label="Total Titik" value={fmt(s.count, 0)} />
          <Metric label="Elevasi Min / Maks" value={`${fmt(s.min, 1)} – ${fmt(s.max, 1)}`} unit="m" />
          <Metric label="Beda Tinggi (Relief)" value={fmt(s.relief, 2)} unit="m" />
          <Metric label="Rata-rata Elevasi" value={fmt(s.mean, 2)} unit="m" />
          <Metric label="Luas Area" value={fmt(s.areaM2 / 10000, 2)} unit="ha" />
          <Metric label="Panjang Garis" value={fmt(s.lengthM, 0)} unit="m" />
        </div>

        {/* Pengaturan Resolusi & Kehalusan Kontur */}
        <Card title="Resolusi & Pengaturan Kontur">
          <div className="mb-2">
            <label className="mb-1 block text-[11px] font-medium text-slate-600">Preset Interval Kontur</label>
            <div className="flex flex-wrap gap-1">
              {[
                { val: "", lbl: "Auto" },
                { val: "0.5", lbl: "0.5 m" },
                { val: "1", lbl: "1 m" },
                { val: "2", lbl: "2 m" },
                { val: "5", lbl: "5 m" },
                { val: "10", lbl: "10 m" },
              ].map((p) => (
                <button
                  key={p.lbl}
                  type="button"
                  onClick={() => setIntervalText(p.val)}
                  className={`rounded-md px-2 py-1 text-[11px] font-semibold transition ${
                    intervalText === p.val
                      ? "bg-emerald-600 text-white"
                      : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                  }`}
                >
                  {p.lbl}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-0.5 block text-[11px] text-slate-600">Interval kustom (m)</label>
              <input
                className={inputCls}
                type="number"
                min={0}
                step="any"
                placeholder="Otomatis"
                value={intervalText}
                onChange={(e) => setIntervalText(e.target.value)}
              />
            </div>
            <div>
              <label className="mb-0.5 block text-[11px] text-slate-600">Kontur indeks tiap</label>
              <input
                className={inputCls}
                type="number"
                min={1}
                max={50}
                value={indexEvery}
                onChange={(e) => setIndexEvery(Number(e.target.value) || 1)}
              />
            </div>
            <div>
              <label className="mb-0.5 block text-[11px] text-slate-600">Interpolasi Sub-Grid</label>
              <select
                className={inputCls}
                value={refinement}
                onChange={(e) => setRefinement(Number(e.target.value) as 1 | 2 | 4)}
              >
                <option value={1}>1× (Grid Asli)</option>
                <option value={2}>2× Bikubik HD</option>
                <option value={4}>4× Bikubik Ultra HD</option>
              </select>
            </div>
            <div>
              <label className="mb-0.5 block text-[11px] text-slate-600">Penghalusan Garis</label>
              <select
                className={inputCls}
                value={smoothing}
                onChange={(e) => setSmoothing(Number(e.target.value) as 0 | 1 | 2)}
              >
                <option value={0}>Tanpa (Asli)</option>
                <option value={1}>Halus (Rekomendasi)</option>
                <option value={2}>Sangat Halus</option>
              </select>
            </div>
          </div>

          <div className="mt-3 space-y-1.5 text-xs text-slate-700">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={includeUtmGrid} onChange={(e) => setIncludeUtmGrid(e.target.checked)} />
              Sertakan Grid Koordinat &amp; Bingkai UTM di DXF
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} />
              Tampilkan label angka kontur indeks
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={showPoints} onChange={(e) => setShowPoints(e.target.checked)} />
              Tampilkan titik elevasi di peta
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={includeGrid} onChange={(e) => setIncludeGrid(e.target.checked)} />
              Sertakan seluruh titik 3D grid di DXF/KML/GeoJSON
            </label>
          </div>
          {contours ? (
            <p className="mt-2.5 rounded-lg bg-slate-100 p-2 text-[11px] text-slate-600">
              Interval aktif: <b>{contours.interval} m</b> · {contours.lines.length.toLocaleString("id-ID")} polyline
              kontur · {contours.labels.length} label indeks
            </p>
          ) : null}
        </Card>

        {/* Ekspor Profesional (UTM Utama) */}
        <Card title="Ekspor CAD & GIS (Koordinat Utama: UTM)">
          <div className="space-y-2">
            <a
              href={exportHref("dxf")}
              download={filenameFor("dxf")}
              onClick={() => onExportClick("dxf", "DXF AutoCAD/Civil 3D (UTM)")}
              className="block w-full rounded-lg bg-emerald-600 px-3 py-2.5 text-center text-sm font-bold text-white shadow-sm hover:bg-emerald-700"
            >
              Unduh DXF 3D — UTM (AutoCAD / Civil 3D / BricsCAD)
            </a>

            <div className="grid grid-cols-2 gap-2">
              <a
                href={exportHref("zip")}
                download={filenameFor("zip")}
                onClick={() => onExportClick("zip", "Paket Lengkap CAD & GIS (.zip)")}
                className="block rounded-lg bg-slate-900 px-2.5 py-2 text-center text-xs font-semibold text-white shadow-sm hover:bg-slate-800"
              >
                Paket Lengkap (.ZIP)
              </a>
              {dwgEnabled ? (
                <a
                  href={exportHref("dwg")}
                  download={filenameFor("dwg")}
                  onClick={() => onExportClick("dwg", "DWG AutoCAD (UTM)")}
                  className="block rounded-lg bg-blue-700 px-2.5 py-2 text-center text-xs font-semibold text-white shadow-sm hover:bg-blue-800"
                >
                  Unduh DWG (UTM)
                </a>
              ) : (
                <button
                  type="button"
                  onClick={() =>
                    setExportStatus(
                      "Info DWG: File DXF sudah 100% siap buka di AutoCAD / Civil 3D / BricsCAD lalu Save As .DWG. Untuk ekspor DWG langsung dari server, atur DWG_CONVERTER_COMMAND di .env.",
                    )
                  }
                  className="rounded-lg border border-slate-300 bg-slate-100 px-2.5 py-2 text-center text-xs font-semibold text-slate-600 hover:bg-slate-200"
                >
                  Info DWG
                </button>
              )}
            </div>

            <div className="pt-1 text-[10px] font-bold uppercase tracking-wide text-slate-500">
              Format Program Lainnya (Civil 3D · QGIS · Global Mapper · Surfer · Excel)
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <a
                href={exportHref("xyz")}
                download={filenameFor("xyz")}
                onClick={() => onExportClick("xyz", "PNEZD / XYZ UTM")}
                className="block rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-left hover:bg-slate-50"
              >
                <div className="text-xs font-semibold text-slate-800">XYZ / PNEZD (.txt)</div>
                <div className="text-[10px] text-slate-500">Civil 3D · Surfer · Global Mapper</div>
              </a>

              {survey.grid ? (
                <a
                  href={exportHref("asc")}
                  download={filenameFor("asc")}
                  onClick={() => onExportClick("asc", "Esri ASCII DEM Grid UTM")}
                  className="block rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-left hover:bg-slate-50"
                >
                  <div className="text-xs font-semibold text-slate-800">DEM Grid .ASC (UTM)</div>
                  <div className="text-[10px] text-slate-500">QGIS · ArcGIS · Global Mapper</div>
                </a>
              ) : (
                <div className="cursor-not-allowed rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-left opacity-50">
                  <div className="text-xs font-semibold text-slate-800">DEM Grid .ASC (UTM)</div>
                  <div className="text-[10px] text-slate-500">Butuh area/koridor</div>
                </div>
              )}

              <a
                href={exportHref("geojson-utm")}
                download={filenameFor("geojson-utm")}
                onClick={() => onExportClick("geojson-utm", "GeoJSON UTM")}
                className="block rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-left hover:bg-slate-50"
              >
                <div className="text-xs font-semibold text-slate-800">GeoJSON UTM 3D</div>
                <div className="text-[10px] text-slate-500">QGIS · Global Mapper ({survey.epsg})</div>
              </a>

              <a
                href={exportHref("csv")}
                download={filenameFor("csv")}
                onClick={() => onExportClick("csv", "CSV Koordinat UTM")}
                className="block rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-left hover:bg-slate-50"
              >
                <div className="text-xs font-semibold text-slate-800">CSV UTM Lengkap</div>
                <div className="text-[10px] text-slate-500">Excel (E, N, Z, Zone + Lat/Lon)</div>
              </a>

              <a
                href={exportHref("kml")}
                download={filenameFor("kml")}
                onClick={() => onExportClick("kml", "KML Google Earth Pro")}
                className="block rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-left hover:bg-slate-50"
              >
                <div className="text-xs font-semibold text-slate-800">KML 3D (.kml)</div>
                <div className="text-[10px] text-slate-500">Google Earth Pro</div>
              </a>

              <a
                href={exportHref("prj")}
                download={filenameFor("prj")}
                onClick={() => onExportClick("prj", "File Proyeksi UTM (.prj)")}
                className="block rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-left hover:bg-slate-50"
              >
                <div className="text-xs font-semibold text-slate-800">Proyeksi .PRJ</div>
                <div className="text-[10px] text-slate-500">WKT {utmLabel}</div>
              </a>
            </div>

            {exportStatus ? (
              <p
                className={`rounded-lg p-2.5 text-[11px] leading-relaxed ${
                  exportStatus.startsWith("Error")
                    ? "bg-red-50 text-red-700"
                    : "bg-amber-50 text-amber-900 ring-1 ring-amber-200"
                }`}
              >
                {exportStatus}
              </p>
            ) : null}

            {directDownloadUrl ? (
              <div className="space-y-2 rounded-lg border-2 border-emerald-500 bg-emerald-50/70 p-2.5">
                <div className="text-[11px] font-bold text-emerald-950">
                  Alternatif Unduh Langsung (jika diblokir iframe pratinjau):
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={async () => {
                      const ok = await copyTextSafe(directDownloadUrl);
                      setCopiedUrl(ok);
                    }}
                    className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white shadow-sm hover:bg-emerald-700"
                  >
                    {copiedUrl ? "✓ Link Tersalin! Tempel (Ctrl+V) di Tab Baru" : "Salin Link Unduh"}
                  </button>
                  <a
                    href={directDownloadUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                  >
                    Buka Tab Baru ↗
                  </a>
                </div>
                <input
                  type="text"
                  readOnly
                  value={directDownloadUrl}
                  onFocus={(e) => e.currentTarget.select()}
                  className="w-full rounded border border-slate-300 bg-white px-2 py-1 font-mono text-[10px] text-slate-800"
                />
              </div>
            ) : null}
          </div>

          <p className="mt-2.5 text-[10.5px] leading-relaxed text-slate-500">
            DXF menggunakan satuan <b>Meter</b> dalam <b>{utmLabel}</b> (X = Easting, Y = Northing, Z = Elevasi) dengan
            auto-zoom <code>*ACTIVE VPORT</code> sehingga langsung tampil tepat di tengah layar saat dibuka di AutoCAD /
            Civil 3D / Global Mapper / QGIS / LibreCAD.
          </p>
        </Card>
      </aside>

      <div className="order-1 flex min-h-0 flex-1 flex-col lg:order-2 lg:h-full lg:overflow-y-auto lg:overscroll-contain">
        <div className="relative h-[48vh] min-h-[300px] shrink-0 lg:h-[56vh] lg:min-h-[340px]">
          <ContourMap
            features={survey.features}
            points={points}
            contours={contours}
            zone={survey.zone}
            south={survey.south}
            showPoints={showPoints}
            showLabels={showLabels}
          />
          <div className="absolute bottom-6 right-3 z-[1000] flex items-center gap-1.5">
            <a
              href="#panel-tabel"
              className="rounded-full bg-slate-900/90 px-3 py-1 text-[11px] font-semibold text-white shadow backdrop-blur hover:bg-slate-800"
            >
              ↓ Tabel &amp; Profil
            </a>
            <a
              href="#panel-ekspor"
              className="rounded-full bg-emerald-600/95 px-3 py-1 text-[11px] font-semibold text-white shadow backdrop-blur hover:bg-emerald-700 lg:hidden"
            >
              ↓ Ekspor CAD/GIS
            </a>
          </div>
        </div>

        <div id="panel-tabel" className="space-y-4 p-4 pb-8">
          {lineFeatures.length > 0 ? (
            <Card title="Profil Elevasi Memanjang">
              <div className="mb-3 flex items-center gap-2">
                <label className="text-xs font-medium text-slate-600">Garis:</label>
                <select
                  className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm"
                  value={profileName}
                  onChange={(e) => setProfileName(e.target.value)}
                >
                  {lineFeatures.map((f) => (
                    <option key={f.id} value={f.name}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </div>
              <ProfileChart data={profile} />
            </Card>
          ) : null}

          <Card
            title={`Tabel Koordinat UTM (${tableRows.length} dari ${filteredPoints.length.toLocaleString("id-ID")} titik · ${utmLabel})`}
            right={
              <select
                className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs"
                value={tableFilter}
                onChange={(e) => setTableFilter(e.target.value as "all" | PointKind)}
              >
                <option value="all">Semua jenis</option>
                <option value="vertex">Simpul input</option>
                <option value="point">Titik ukur</option>
                <option value="line">Jalur garis</option>
                <option value="boundary">Batas poligon</option>
                <option value="grid">Grid elevasi</option>
              </select>
            }
          >
            <div className="max-h-[420px] overflow-auto rounded-lg ring-1 ring-slate-200">
              <table className="w-full min-w-[780px] border-collapse text-left text-xs">
                <thead className="sticky top-0 bg-slate-100 text-slate-700">
                  <tr>
                    <th className="px-2 py-2">#</th>
                    <th className="px-2 py-2 text-right font-bold text-emerald-800">Easting X (m)</th>
                    <th className="px-2 py-2 text-right font-bold text-emerald-800">Northing Y (m)</th>
                    <th className="px-2 py-2 text-right font-bold text-emerald-800">Elevasi Z (m)</th>
                    <th className="px-2 py-2">Jenis</th>
                    <th className="px-2 py-2">Fitur</th>
                    <th className="px-2 py-2 text-right text-slate-500">Lintang</th>
                    <th className="px-2 py-2 text-right text-slate-500">Bujur</th>
                    <th className="px-2 py-2 text-right text-slate-500">Jarak (m)</th>
                  </tr>
                </thead>
                <tbody>
                  {tableRows.map((p) => (
                    <tr key={p.seq} className="border-t border-slate-100 odd:bg-white even:bg-slate-50/60">
                      <td className="px-2 py-1.5 text-slate-500">{p.seq + 1}</td>
                      <td className="px-2 py-1.5 text-right font-mono font-semibold tabular-nums text-slate-900">
                        {p.easting.toFixed(3)}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono font-semibold tabular-nums text-slate-900">
                        {p.northing.toFixed(3)}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono font-semibold tabular-nums text-emerald-700">
                        {p.elevation == null ? "–" : p.elevation.toFixed(3)}
                      </td>
                      <td className="px-2 py-1.5">{p.kind}</td>
                      <td className="px-2 py-1.5">{p.feature}</td>
                      <td className="px-2 py-1.5 text-right font-mono tabular-nums text-slate-500">
                        {p.lat.toFixed(6)}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono tabular-nums text-slate-500">
                        {p.lon.toFixed(6)}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">
                        {p.distance == null ? "–" : p.distance.toFixed(1)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {filteredPoints.length > tableRows.length ? (
              <p className="mt-2 text-[11px] text-slate-500">
                Menampilkan {tableRows.length} baris pertama. Unduh <b>CSV UTM</b> atau <b>XYZ/PNEZD</b> untuk seluruh{" "}
                {filteredPoints.length.toLocaleString("id-ID")} titik.
              </p>
            ) : null}
          </Card>
        </div>
      </div>
    </div>
  );
}
