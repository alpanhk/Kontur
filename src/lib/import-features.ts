import { kml as kmlToGeoJson } from "@tmcw/togeojson";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import JSZip from "jszip";
import { stripClosing, utmForZone } from "./geo";
import type { FeatureType, LngLat } from "./types";

/**
 * Parser impor untuk sisi browser:
 * - .kml / .kmz    : hasil "Save Place As" dari Google Earth Pro
 * - .geojson/.json : GeoJSON (WGS84 atau UTM jika ada properti crs EPSG:326xx/327xx)
 * - .csv / .txt    : koordinat UTM (Easting, Northing) atau Geografis (Lintang, Bujur)
 */

export interface ParsedFeature {
  name: string;
  type: FeatureType;
  coords: LngLat[];
}

export interface ParseResult {
  features: ParsedFeature[];
  warnings: string[];
}

export interface CoordImportOptions {
  /** "utm" = Easting, Northing (meter); "latlon" = Lintang, Bujur; "auto" = deteksi otomatis. */
  coordMode: "auto" | "utm" | "latlon";
  utmZone: number;
  utmSouth: boolean;
}

const toLL = (pos: number[]): LngLat => [Number(pos[0]), Number(pos[1])];

function collect(
  geom: Geometry | null,
  name: string,
  out: ParsedFeature[],
  warnings: string[],
  transform?: (pos: number[]) => LngLat,
): void {
  if (!geom) return;
  const mapPos = transform ?? toLL;
  switch (geom.type) {
    case "Point":
      out.push({ name, type: "point", coords: [mapPos(geom.coordinates)] });
      break;
    case "MultiPoint":
      geom.coordinates.forEach((c, i) =>
        out.push({ name: geom.coordinates.length > 1 ? `${name} ${i + 1}` : name, type: "point", coords: [mapPos(c)] }),
      );
      break;
    case "LineString": {
      const coords = geom.coordinates.map(mapPos);
      if (coords.length >= 2) out.push({ name, type: "line", coords });
      else warnings.push(`Garis "${name}" dilewati (kurang dari 2 titik)`);
      break;
    }
    case "MultiLineString":
      geom.coordinates.forEach((l, i) => {
        const coords = l.map(mapPos);
        const nm = geom.coordinates.length > 1 ? `${name} ${i + 1}` : name;
        if (coords.length >= 2) out.push({ name: nm, type: "line", coords });
      });
      break;
    case "Polygon": {
      if (geom.coordinates.length > 1) warnings.push(`Lubang (hole) pada "${name}" diabaikan`);
      const ring = stripClosing(geom.coordinates[0].map(mapPos));
      if (ring.length >= 3) out.push({ name, type: "polygon", coords: ring });
      else warnings.push(`Poligon "${name}" dilewati (kurang dari 3 titik)`);
      break;
    }
    case "MultiPolygon":
      geom.coordinates.forEach((poly, i) => {
        const ring = stripClosing(poly[0].map(mapPos));
        const nm = geom.coordinates.length > 1 ? `${name} ${i + 1}` : name;
        if (ring.length >= 3) out.push({ name: nm, type: "polygon", coords: ring });
      });
      break;
    case "GeometryCollection":
      for (const g of geom.geometries) collect(g, name, out, warnings, transform);
      break;
    default:
      break;
  }
}

function fromFeatureCollection(fc: FeatureCollection, transform?: (pos: number[]) => LngLat): ParseResult {
  const features: ParsedFeature[] = [];
  const warnings: string[] = [];
  fc.features.forEach((f: Feature, i: number) => {
    const raw = f.properties && typeof f.properties.name === "string" ? f.properties.name.trim() : "";
    collect(f.geometry, raw || `Fitur ${i + 1}`, features, warnings, transform);
  });
  return { features, warnings };
}

function parseKml(text: string): ParseResult {
  const doc = new DOMParser().parseFromString(text, "text/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error("File KML tidak valid (XML rusak).");
  }
  const fc = kmlToGeoJson(doc) as FeatureCollection;
  return fromFeatureCollection(fc);
}

function parseGeoJson(data: unknown): ParseResult {
  const d = data as {
    type?: string;
    crs?: { properties?: { name?: string } };
    features?: Feature[];
    geometry?: Geometry | null;
  };
  // Deteksi jika GeoJSON dalam proyeksi UTM EPSG:326xx / EPSG:327xx
  let transform: ((pos: number[]) => LngLat) | undefined;
  const crsName = d?.crs?.properties?.name ?? "";
  const m = /32([67])(\d{2})/.exec(crsName);
  if (m) {
    const proj = utmForZone(Number(m[2]), m[1] === "7");
    transform = (pos: number[]) => proj.toLonLat(Number(pos[0]), Number(pos[1]));
  }

  if (d && d.type === "FeatureCollection" && Array.isArray(d.features)) {
    return fromFeatureCollection({ type: "FeatureCollection", features: d.features } as FeatureCollection, transform);
  }
  if (d && d.type === "Feature") {
    return fromFeatureCollection({ type: "FeatureCollection", features: [d as Feature] } as FeatureCollection, transform);
  }
  if (d && typeof d.type === "string") {
    const out: ParsedFeature[] = [];
    const warnings: string[] = [];
    collect(d as unknown as Geometry, "GeoJSON", out, warnings, transform);
    return { features: out, warnings };
  }
  throw new Error("Struktur GeoJSON tidak dikenali.");
}

/**
 * Membaca teks berisi koordinat:
 * - Mode "utm"   : Easting, Northing (meter) pada zona UTM yang dipilih
 * - Mode "latlon": Lintang, Bujur (derajat desimal)
 * - Mode "auto"  : Jika angka > 180 otomatis diperlakukan sebagai UTM (Easting, Northing)
 */
export function parseCoordinateText(
  text: string,
  opts: CoordImportOptions = { coordMode: "auto", utmZone: 48, utmSouth: true },
): { coords: LngLat[]; skipped: number; detectedUtm: boolean } {
  const proj = utmForZone(opts.utmZone, opts.utmSouth);
  const coords: LngLat[] = [];
  let skipped = 0;
  let detectedUtm = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/[,;\t\s]+/).filter(Boolean);
    if (parts.length < 2) {
      skipped++;
      continue;
    }

    // Dukung format PNEZD (nomor, E, N, Z, ...) jika kolom pertama angka urut kecil dan kolom 2-3 koordinat UTM
    let a = Number(parts[0]);
    let b = Number(parts[1]);
    if (
      parts.length >= 3 &&
      Number.isFinite(Number(parts[1])) &&
      Number.isFinite(Number(parts[2])) &&
      Math.abs(Number(parts[1])) > 10000 &&
      Math.abs(Number(parts[2])) > 10000
    ) {
      a = Number(parts[1]);
      b = Number(parts[2]);
    }

    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      skipped++;
      continue;
    }

    const isUtmRow =
      opts.coordMode === "utm" ||
      (opts.coordMode === "auto" && (Math.abs(a) > 180 || Math.abs(b) > 180));

    if (isUtmRow) {
      // Validasi kasar rentang UTM: Easting 100.000–900.000, Northing 0–10.000.000
      let easting = a;
      let northing = b;
      if (a > 1_000_000 && b < 1_000_000) {
        // Jika pengguna terbalik memasukkan Northing, Easting
        northing = a;
        easting = b;
      }
      if (easting < 50_000 || easting > 950_000 || northing < 0 || northing > 10_500_000) {
        skipped++;
        continue;
      }
      coords.push(proj.toLonLat(easting, northing));
      detectedUtm = true;
    } else {
      if (Math.abs(a) > 90 && Math.abs(b) <= 90) [a, b] = [b, a];
      if (Math.abs(a) > 90 || Math.abs(b) > 180) {
        skipped++;
        continue;
      }
      coords.push([b, a]);
    }
  }
  return { coords, skipped, detectedUtm };
}

/** Mengubah daftar koordinat menjadi fitur sesuai jenis yang dipilih pengguna. */
export function coordsToFeatures(coords: LngLat[], type: FeatureType, baseName: string): ParsedFeature[] {
  if (type === "point") {
    return coords.map((c, i) => ({
      name: coords.length > 1 ? `${baseName} ${i + 1}` : baseName,
      type: "point" as const,
      coords: [c],
    }));
  }
  if (type === "line") return coords.length >= 2 ? [{ name: baseName, type, coords }] : [];
  const ring = stripClosing(coords);
  return ring.length >= 3 ? [{ name: baseName, type, coords: ring }] : [];
}

export async function parseImportFile(
  file: File,
  textType: FeatureType,
  coordOpts?: CoordImportOptions,
): Promise<ParseResult> {
  const lower = file.name.toLowerCase();
  const baseName = file.name.replace(/\.[^.]+$/, "") || "Impor";

  if (lower.endsWith(".kmz")) {
    const zip = await JSZip.loadAsync(file);
    const entry = Object.values(zip.files).find((f) => !f.dir && f.name.toLowerCase().endsWith(".kml"));
    if (!entry) throw new Error("File KMZ tidak berisi berkas .kml.");
    return parseKml(await entry.async("string"));
  }
  if (lower.endsWith(".kml")) return parseKml(await file.text());
  if (lower.endsWith(".geojson") || lower.endsWith(".json")) {
    return parseGeoJson(JSON.parse(await file.text()));
  }
  if (lower.endsWith(".csv") || lower.endsWith(".txt")) {
    const { coords, skipped, detectedUtm } = parseCoordinateText(await file.text(), coordOpts);
    const features = coordsToFeatures(coords, textType, baseName);
    const warnings: string[] = [];
    if (detectedUtm && coordOpts) {
      warnings.push(`Koordinat dibaca sebagai UTM Zona ${coordOpts.utmZone}${coordOpts.utmSouth ? "S" : "N"}`);
    }
    if (skipped) warnings.push(`${skipped} baris header/non-koordinat dilewati`);
    if (features.length === 0) warnings.push("Tidak ada koordinat valid untuk jenis yang dipilih");
    return { features, warnings };
  }
  throw new Error("Format tidak didukung. Gunakan .kml, .kmz, .geojson, .csv, atau .txt");
}
