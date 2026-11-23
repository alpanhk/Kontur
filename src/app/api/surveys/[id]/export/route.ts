import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { buildContours, gridFromSamples } from "@/lib/contour";
import { convertDxfToDwg, dwgConfigured } from "@/lib/dwg";
import { buildDxf } from "@/lib/dxf";
import { toAsciiGridUtm, toCsv, toGeoJson, toGeoJsonUtm, toKml, toXyzUtm } from "@/lib/exporters";
import { utmForZone, utmPrjWkt } from "@/lib/geo";
import { getSurveyWithPoints } from "@/lib/survey-repo";
import { slugify } from "@/lib/utils";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

type ExportResult =
  | { ok: true; bytes: Uint8Array; type: string; filename: string }
  | { ok: false; error: string; status: number };

const enc = new TextEncoder();

async function buildSurveyExport(reqUrl: string, rawId: string): Promise<ExportResult> {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, error: "ID tidak valid.", status: 400 };
  }

  const url = new URL(reqUrl);
  const format = (url.searchParams.get("format") ?? "dxf").toLowerCase();
  const intervalRaw = Number(url.searchParams.get("interval"));
  const interval = Number.isFinite(intervalRaw) && intervalRaw > 0 ? intervalRaw : null;
  const indexRaw = Number(url.searchParams.get("index"));
  const indexEvery = Number.isFinite(indexRaw) && indexRaw >= 1 ? Math.min(50, Math.round(indexRaw)) : 5;

  const refRaw = Number(url.searchParams.get("refinement"));
  const refinement: 1 | 2 | 4 = refRaw === 1 ? 1 : refRaw === 4 ? 4 : 2;

  const smRaw = Number(url.searchParams.get("smoothing"));
  const smoothing: 0 | 1 | 2 = smRaw === 0 ? 0 : smRaw === 2 ? 2 : 1;

  const includeGrid = url.searchParams.get("grid") === "1";
  const includeLabels = url.searchParams.get("labels") !== "0";
  const includeUtmGrid = url.searchParams.get("utmgrid") !== "0";

  const data = await getSurveyWithPoints(id);
  if (!data) {
    return { ok: false, error: "Survei tidak ditemukan.", status: 404 };
  }
  const { survey, points } = data;

  const proj = utmForZone(survey.zone, survey.south);
  const rawGrid = survey.grid ? gridFromSamples(survey.grid, points) : null;
  const contours = rawGrid ? buildContours(rawGrid, { interval, indexEvery, refinement, smoothing }) : null;
  const utmTag = `utm${survey.zone}${survey.south ? "s" : "n"}`;
  const base = `${slugify(survey.name)}-${utmTag}-${survey.id}`;

  const dxfText = () =>
    buildDxf({
      meta: {
        name: survey.name,
        zone: survey.zone,
        south: survey.south,
        epsg: survey.epsg,
        provider: survey.provider,
        spacingM: survey.spacingM,
      },
      contours,
      points,
      features: survey.features,
      options: { includeGrid, includeLabels, includeVertexLabels: true, includeUtmGrid },
    });

  const exportArgs = {
    name: survey.name,
    proj,
    contours,
    points,
    features: survey.features,
    includeGrid,
  };

  const prjText = utmPrjWkt(survey.zone, survey.south);
  const packText = (text: string, type: string, filename: string): ExportResult => ({
    ok: true,
    bytes: enc.encode(text),
    type,
    filename,
  });

  switch (format) {
    case "dxf":
      return packText(dxfText(), "application/dxf; charset=us-ascii", `${base}.dxf`);

    case "dwg": {
      if (!dwgConfigured()) {
        return {
          ok: false,
          error:
            "Konversi DWG langsung membutuhkan konverter eksternal di server (DWG_CONVERTER_COMMAND). Silakan unduh DXF — file DXF R12 kami sudah siap buka langsung di AutoCAD / Civil 3D / BricsCAD lalu Save As DWG.",
          status: 501,
        };
      }
      try {
        const buf = await convertDxfToDwg(dxfText(), base);
        return { ok: true, bytes: new Uint8Array(buf), type: "application/acad", filename: `${base}.dwg` };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Konversi DWG gagal.";
        return { ok: false, error: message, status: 500 };
      }
    }

    case "xyz":
      return packText(toXyzUtm(points), "text/plain; charset=utf-8", `${base}-pnezd-utm.txt`);

    case "asc": {
      if (!rawGrid) {
        return { ok: false, error: "Survei ini tidak memiliki grid area (poligon/koridor).", status: 400 };
      }
      return packText(toAsciiGridUtm(rawGrid), "text/plain; charset=us-ascii", `${base}-dem-utm.asc`);
    }

    case "prj":
      return packText(prjText, "text/plain; charset=us-ascii", `${base}-dem-utm.prj`);

    case "csv":
      return packText(
        toCsv(points, survey.zone, survey.south, survey.epsg),
        "text/csv; charset=utf-8",
        `${base}-utm.csv`,
      );

    case "geojson-utm":
      return packText(toGeoJsonUtm(exportArgs), "application/geo+json; charset=utf-8", `${base}-utm.geojson`);

    case "geojson":
      return packText(toGeoJson(exportArgs), "application/geo+json; charset=utf-8", `${base}-wgs84.geojson`);

    case "kml":
      return packText(toKml(exportArgs), "application/vnd.google-earth.kml+xml; charset=utf-8", `${base}.kml`);

    case "zip": {
      const zip = new JSZip();
      zip.file(`${base}.dxf`, dxfText());
      zip.file(`${base}-pnezd-utm.txt`, toXyzUtm(points));
      zip.file(`${base}-utm.csv`, toCsv(points, survey.zone, survey.south, survey.epsg));
      zip.file(`${base}-utm.geojson`, toGeoJsonUtm(exportArgs));
      zip.file(`${base}-wgs84.geojson`, toGeoJson(exportArgs));
      zip.file(`${base}.kml`, toKml(exportArgs));
      zip.file(`${base}.prj`, prjText);
      if (rawGrid) {
        zip.file(`${base}-dem-utm.asc`, toAsciiGridUtm(rawGrid));
        zip.file(`${base}-dem-utm.prj`, prjText);
      }
      zip.file(
        "INFO_PROYEKSI_UTM.txt",
        [
          `Survei           : ${survey.name}`,
          `Sistem Koordinat : WGS 84 / UTM Zona ${survey.zone}${survey.south ? "S" : "N"} (${survey.epsg})`,
          `Satuan           : Meter (X = Easting, Y = Northing, Z = Elevasi mdpl)`,
          `Sumber DEM       : ${survey.provider}`,
          `Spasi Grid       : ${survey.spacingM} m`,
          `Interval Kontur  : ${contours ? `${contours.interval} m (indeks tiap ${contours.indexEvery})` : "-"}`,
          `Upsampling/Halus : ${refinement}x / level ${smoothing}`,
          "",
          "Daftar file dalam paket:",
          `- ${base}.dxf             : AutoCAD / Civil 3D / BricsCAD / ZWCAD / Global Mapper / QGIS / LibreCAD (UTM 3D)`,
          `- ${base}-pnezd-utm.txt   : Civil 3D (Points from File PENZD) / Golden Software Surfer / Global Mapper`,
          rawGrid
            ? `- ${base}-dem-utm.asc/.prj: Raster DEM Grid UTM untuk QGIS / Global Mapper / ArcGIS / Surfer / Civil 3D`
            : "",
          `- ${base}-utm.geojson     : Vektor Kontur & Batas dalam UTM (${survey.epsg}) untuk QGIS / Global Mapper`,
          `- ${base}-utm.csv         : Tabel koordinat lengkap (Excel) dengan Easting, Northing, Elevasi di kolom awal`,
          `- ${base}.kml             : Google Earth Pro`,
        ]
          .filter(Boolean)
          .join("\r\n") + "\r\n",
      );
      const buf = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
      return { ok: true, bytes: buf, type: "application/zip", filename: `${base}-paket-cad-gis.zip` };
    }

    default:
      return { ok: false, error: "Format tidak didukung.", status: 400 };
  }
}

/**
 * GET /api/surveys/[id]/export — unduh langsung lewat HTTP Content-Disposition: attachment.
 */
export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  const res = await buildSurveyExport(req.url, id);
  if (!res.ok) {
    console.warn(`[EXPORT GET ERROR] id=${id} status=${res.status} error=${res.error}`);
    return Response.json({ error: res.error }, { status: res.status });
  }
  console.log(`[EXPORT GET OK] id=${id} file=${res.filename} bytes=${res.bytes.byteLength}`);
  const body = new Blob([new Uint8Array(res.bytes)]);
  return new Response(body, {
    headers: {
      "Content-Type": res.type,
      "Content-Disposition": `attachment; filename="${res.filename}"`,
      "Content-Length": String(res.bytes.byteLength),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
}

/**
 * POST /api/surveys/[id]/export — simpan salinan file ekspor ke folder proyek `exports/`
 * agar tetap mudah diakses bila pratinjau berjalan di dalam iframe terbatas.
 */
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  const res = await buildSurveyExport(req.url, id);
  if (!res.ok) {
    return Response.json({ error: res.error }, { status: res.status });
  }
  const exportsDir = path.resolve(/*turbopackIgnore: true*/ process.cwd(), "exports");
  await fs.mkdir(exportsDir, { recursive: true });
  const safeName = path.basename(res.filename);
  const fullPath = path.join(exportsDir, safeName);
  await fs.writeFile(fullPath, res.bytes);
  console.log(`[EXPORT POST SAVED] id=${id} path=exports/${safeName} bytes=${res.bytes.byteLength}`);
  return Response.json({
    ok: true,
    filename: safeName,
    savedPath: `exports/${safeName}`,
    bytes: res.bytes.byteLength,
  });
}
