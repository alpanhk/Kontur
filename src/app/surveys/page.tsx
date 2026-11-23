import Link from "next/link";
import DeleteSurveyButton from "@/components/DeleteSurveyButton";
import { listSurveys } from "@/lib/survey-repo";

export const dynamic = "force-dynamic";

const fmt = (v: number | null | undefined, d = 1) =>
  v == null || !Number.isFinite(v) ? "–" : v.toLocaleString("id-ID", { maximumFractionDigits: d });

export default async function SurveysPage() {
  const list = await listSurveys();

  return (
    <div className="w-full flex-1 p-6 pb-12 lg:h-full lg:min-h-0 lg:overflow-y-auto">
      <div className="mx-auto max-w-6xl">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-slate-900">Riwayat survei</h1>
            <p className="text-sm text-slate-600">Semua hasil pengambilan elevasi yang tersimpan di database.</p>
          </div>
          <Link
            href="/"
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700"
          >
            + Survei baru
          </Link>
        </div>

        {list.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
            <p className="text-sm text-slate-600">Belum ada survei. Mulai dengan menggambar area di peta.</p>
            <Link href="/" className="mt-3 inline-block text-sm font-semibold text-emerald-700 hover:underline">
              Buka peta →
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
            <table className="w-full min-w-[820px] border-collapse text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Nama</th>
                  <th className="px-4 py-3">Dibuat</th>
                  <th className="px-4 py-3">Sumber</th>
                  <th className="px-4 py-3 text-right">Titik</th>
                  <th className="px-4 py-3 text-right">Elevasi (m)</th>
                  <th className="px-4 py-3 text-right">Luas (ha)</th>
                  <th className="px-4 py-3 text-right">Aksi</th>
                </tr>
              </thead>
              <tbody>
                {list.map((s) => (
                  <tr key={s.id} className="border-t border-slate-100 hover:bg-slate-50/70">
                    <td className="px-4 py-3">
                      <Link href={`/surveys/${s.id}`} className="font-semibold text-slate-900 hover:text-emerald-700">
                        {s.name}
                      </Link>
                      <div className="text-xs text-slate-500">
                        {s.epsg} · spasi {s.spacingM} m · {s.features.length} fitur
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {new Date(s.createdAt).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" })}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-600">{s.provider}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{fmt(s.stats.count, 0)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {fmt(s.stats.min)} – {fmt(s.stats.max)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{fmt(s.stats.areaM2 / 10000, 2)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <Link
                          href={`/surveys/${s.id}`}
                          className="rounded-md px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50"
                        >
                          Buka
                        </Link>
                        <a
                          href={`/api/surveys/${s.id}/export?format=dxf`}
                          download
                          className="rounded-md px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                        >
                          DXF
                        </a>
                        <a
                          href={`/api/surveys/${s.id}/export?format=zip`}
                          download
                          className="rounded-md px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                        >
                          ZIP
                        </a>
                        <DeleteSurveyButton id={s.id} name={s.name} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
