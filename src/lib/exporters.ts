import type { ContourResult, Grid } from "./contour";
import type { UtmProjection } from "./geo";
import type { SamplePoint, SurveyFeature } from "./types";
import { escapeXml } from "./utils";

const csvCell = (v: string | number): string => {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * CSV dengan format koordinat utama UTM (Easting, Northing, Elevasi, Zona, EPSG) di kolom depan,
 * diikuti referensi Lintang/Bujur WGS84. BOM UTF-8 agar Excel membaca rapi.
 */
export function toCsv(points: SamplePoint[], zone: number, south: boolean, epsg: string): string {
  const utmZone = `${zone}${south ? "S" : "N"}`;
  const header = [
    "point_id",
    "easting_m",
    "northing_m",
    "elevation_m",
    "utm_zone",
    "epsg",
    "kind",
    "feature",
    "distance_m",
    "lat_wgs84",
    "lon_wgs84",
  ];
  const rows = points.map((p) =>
    [
      p.seq + 1,
      p.easting.toFixed(3),
      p.northing.toFixed(3),
      p.elevation == null ? "" : p.elevation.toFixed(3),
      utmZone,
      epsg,
      p.kind,
      p.feature,
      p.distance == null ? "" : p.distance.toFixed(2),
      p.lat.toFixed(7),
      p.lon.toFixed(7),
    ]
      .map(csvCell)
      .join(","),
  );
  return "\uFEFF" + [header.join(","), ...rows].join("\r\n") + "\r\n";
}

/**
 * Format PNEZD / XYZ UTM (koma-dipisah tanpa header rumit) — standar impor untuk:
 * Autodesk Civil 3D (PENZD comma delimited), Golden Software Surfer, Global Mapper, ArcGIS, QGIS, Carlson.
 * Kolom: PointNumber, Easting(X), Northing(Y), Elevation(Z), Description
 */
export function toXyzUtm(points: SamplePoint[]): string {
  const rows: string[] = [];
  let num = 1;
  for (const p of points) {
    if (p.elevation == null || !Number.isFinite(p.elevation)) continue;
    const desc = `${p.kind}_${p.feature}`.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 32);
    rows.push(`${num++},${p.easting.toFixed(3)},${p.northing.toFixed(3)},${p.elevation.toFixed(3)},${desc}`);
  }
  return rows.join("\r\n") + "\r\n";
}

/**
 * Esri ASCII Grid (.asc) dalam koordinat UTM (meter).
 * Dapat dibuka langsung sebagai permukaan DEM 3D oleh QGIS, Global Mapper, ArcGIS, Golden Software Surfer, dan Civil 3D.
 * Catatan: baris pertama pada format .asc adalah baris paling utara (row = rows - 1).
 */
export function toAsciiGridUtm(grid: Grid): string {
  const nodata = -9999;
  const xllcorner = grid.x0 - grid.dx / 2;
  const yllcorner = grid.y0 - grid.dy / 2;
  const lines: string[] = [
    `ncols         ${grid.cols}`,
    `nrows         ${grid.rows}`,
    `xllcorner     ${xllcorner.toFixed(3)}`,
    `yllcorner     ${yllcorner.toFixed(3)}`,
    `cellsize      ${grid.dx.toFixed(3)}`,
    `NODATA_value  ${nodata}`,
  ];
  for (let r = grid.rows - 1; r >= 0; r--) {
    const rowVals: string[] = [];
    const base = r * grid.cols;
    for (let c = 0; c < grid.cols; c++) {
      const v = grid.values[base + c];
      rowVals.push(Number.isFinite(v) ? v.toFixed(3) : String(nodata));
    }
    lines.push(rowVals.join(" "));
  }
  return lines.join("\r\n") + "\r\n";
}

export interface ExportArgs {
  name: string;
  proj: UtmProjection;
  contours: ContourResult | null;
  points: SamplePoint[];
  features: SurveyFeature[];
  includeGrid: boolean;
}

/** Titik yang diekspor sebagai spot height (grid hanya bila diminta). */
function spotPoints(points: SamplePoint[], includeGrid: boolean): SamplePoint[] {
  return points.filter(
    (p) => p.elevation != null && (p.kind === "vertex" || p.kind === "point" || (includeGrid && p.kind === "grid")),
  );
}

/** KML untuk Google Earth Pro: kontur, batas/garis input, dan titik elevasi lengkap koordinat UTM. */
export function toKml(args: ExportArgs): string {
  const { name, proj, contours, points, features, includeGrid } = args;
  const parts: string[] = [];
  const c = (lon: number, lat: number, z = 0) => `${lon.toFixed(8)},${lat.toFixed(8)},${z.toFixed(2)}`;
  const utmLabel = `UTM ${proj.zone}${proj.south ? "S" : "N"} (${proj.epsg})`;

  parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  parts.push('<kml xmlns="http://www.opengis.net/kml/2.2"><Document>');
  parts.push(`<name>${escapeXml(name)}</name>`);
  parts.push(`<description>${escapeXml(`Proyeksi utama: ${utmLabel}`)}</description>`);
  parts.push('<Style id="contourIndex"><LineStyle><color>ff0a64c8</color><width>2.5</width></LineStyle></Style>');
  parts.push('<Style id="contourInter"><LineStyle><color>ff3ca0e6</color><width>1.2</width></LineStyle></Style>');
  parts.push('<Style id="inputLine"><LineStyle><color>ff0b9ef5</color><width>3</width></LineStyle></Style>');
  parts.push(
    '<Style id="inputArea"><LineStyle><color>ff1ab810</color><width>2</width></LineStyle><PolyStyle><color>331ab810</color></PolyStyle></Style>',
  );

  if (contours && contours.lines.length) {
    parts.push("<Folder><name>Kontur</name>");
    for (const ln of contours.lines) {
      const coords = ln.pts.map(([e, n]) => {
        const [lon, lat] = proj.toLonLat(e, n);
        return c(lon, lat, ln.level);
      });
      if (ln.closed && coords.length) coords.push(coords[0]);
      parts.push(
        `<Placemark><name>${ln.level} m</name><styleUrl>#${ln.index ? "contourIndex" : "contourInter"}</styleUrl>` +
          `<LineString><tessellate>1</tessellate><altitudeMode>clampToGround</altitudeMode>` +
          `<coordinates>${coords.join(" ")}</coordinates></LineString></Placemark>`,
      );
    }
    parts.push("</Folder>");
  }

  if (features.length) {
    parts.push("<Folder><name>Input</name>");
    for (const f of features) {
      const fname = escapeXml(f.name);
      if (f.type === "polygon" && f.coords.length >= 3) {
        const ring = [...f.coords, f.coords[0]].map(([lon, lat]) => c(lon, lat, 0)).join(" ");
        parts.push(
          `<Placemark><name>${fname}</name><styleUrl>#inputArea</styleUrl><Polygon><tessellate>1</tessellate>` +
            `<altitudeMode>clampToGround</altitudeMode><outerBoundaryIs><LinearRing><coordinates>${ring}</coordinates>` +
            `</LinearRing></outerBoundaryIs></Polygon></Placemark>`,
        );
      } else if (f.type === "line" && f.coords.length >= 2) {
        const coords = f.coords.map(([lon, lat]) => c(lon, lat, 0)).join(" ");
        parts.push(
          `<Placemark><name>${fname}</name><styleUrl>#inputLine</styleUrl><LineString><tessellate>1</tessellate>` +
            `<altitudeMode>clampToGround</altitudeMode><coordinates>${coords}</coordinates></LineString></Placemark>`,
        );
      }
    }
    parts.push("</Folder>");
  }

  const spots = spotPoints(points, includeGrid);
  if (spots.length) {
    parts.push("<Folder><name>Titik elevasi (UTM)</name>");
    for (const p of spots) {
      const z = p.elevation ?? 0;
      parts.push(
        `<Placemark><name>${escapeXml(`${p.feature} ${z.toFixed(2)} m`)}</name>` +
          `<description>${escapeXml(`${utmLabel}\nEasting: ${p.easting.toFixed(3)} m\nNorthing: ${p.northing.toFixed(3)} m\nElevasi: ${z.toFixed(3)} m`)}</description>` +
          `<Point><altitudeMode>clampToGround</altitudeMode><coordinates>${c(p.lon, p.lat, z)}</coordinates></Point></Placemark>`,
      );
    }
    parts.push("</Folder>");
  }

  parts.push("</Document></kml>");
  return parts.join("\n");
}

/**
 * GeoJSON 3D dalam koordinat UTM (Easting, Northing, Z) lengkap dengan CRS EPSG.
 * Ideal untuk QGIS, Global Mapper, ArcGIS Pro, dan FME.
 */
export function toGeoJsonUtm(args: ExportArgs): string {
  const { name, proj, contours, points, features, includeGrid } = args;
  const out: unknown[] = [];
  const r3 = (v: number) => Math.round(v * 1000) / 1000;

  if (contours) {
    for (const ln of contours.lines) {
      const coords = ln.pts.map(([e, n]) => [r3(e), r3(n), r3(ln.level)]);
      if (ln.closed && coords.length) coords.push(coords[0]);
      out.push({
        type: "Feature",
        properties: { kind: "contour", elevation: ln.level, index: ln.index, epsg: proj.epsg },
        geometry: { type: "LineString", coordinates: coords },
      });
    }
  }

  for (const f of features) {
    const xy = f.coords.map(([lon, lat]) => {
      const [e, n] = proj.toUtm(lon, lat);
      return [r3(e), r3(n)];
    });
    if (f.type === "polygon" && xy.length >= 3) {
      out.push({
        type: "Feature",
        properties: { kind: "input-polygon", name: f.name, epsg: proj.epsg },
        geometry: { type: "Polygon", coordinates: [[...xy, xy[0]]] },
      });
    } else if (f.type === "line" && xy.length >= 2) {
      out.push({
        type: "Feature",
        properties: { kind: "input-line", name: f.name, epsg: proj.epsg },
        geometry: { type: "LineString", coordinates: xy },
      });
    } else if (f.type === "point" && xy.length >= 1) {
      out.push({
        type: "Feature",
        properties: { kind: "input-point", name: f.name, epsg: proj.epsg },
        geometry: { type: "Point", coordinates: xy[0] },
      });
    }
  }

  for (const p of spotPoints(points, includeGrid)) {
    out.push({
      type: "Feature",
      properties: {
        kind: p.kind,
        feature: p.feature,
        easting: r3(p.easting),
        northing: r3(p.northing),
        elevation: p.elevation == null ? null : r3(p.elevation),
        epsg: proj.epsg,
        lat: p.lat,
        lon: p.lon,
      },
      geometry: { type: "Point", coordinates: [r3(p.easting), r3(p.northing), r3(p.elevation ?? 0)] },
    });
  }

  return JSON.stringify({
    type: "FeatureCollection",
    name,
    crs: { type: "name", properties: { name: proj.epsg } },
    features: out,
  });
}

/** GeoJSON 3D (WGS84) untuk kompatibilitas web GIS / Mapbox / Leaflet. */
export function toGeoJson(args: ExportArgs): string {
  const { name, proj, contours, points, features, includeGrid } = args;
  const out: unknown[] = [];

  if (contours) {
    for (const ln of contours.lines) {
      const coords = ln.pts.map(([e, n]) => {
        const [lon, lat] = proj.toLonLat(e, n);
        return [lon, lat, ln.level];
      });
      if (ln.closed && coords.length) coords.push(coords[0]);
      out.push({
        type: "Feature",
        properties: { kind: "contour", elevation: ln.level, index: ln.index },
        geometry: { type: "LineString", coordinates: coords },
      });
    }
  }

  for (const f of features) {
    if (f.type === "polygon" && f.coords.length >= 3) {
      out.push({
        type: "Feature",
        properties: { kind: "input-polygon", name: f.name },
        geometry: { type: "Polygon", coordinates: [[...f.coords, f.coords[0]]] },
      });
    } else if (f.type === "line" && f.coords.length >= 2) {
      out.push({
        type: "Feature",
        properties: { kind: "input-line", name: f.name },
        geometry: { type: "LineString", coordinates: f.coords },
      });
    } else if (f.type === "point" && f.coords.length >= 1) {
      out.push({
        type: "Feature",
        properties: { kind: "input-point", name: f.name },
        geometry: { type: "Point", coordinates: f.coords[0] },
      });
    }
  }

  for (const p of spotPoints(points, includeGrid)) {
    out.push({
      type: "Feature",
      properties: {
        kind: p.kind,
        feature: p.feature,
        easting: p.easting,
        northing: p.northing,
        elevation: p.elevation,
        epsg: proj.epsg,
        distance: p.distance,
      },
      geometry: { type: "Point", coordinates: [p.lon, p.lat, p.elevation ?? 0] },
    });
  }

  return JSON.stringify({ type: "FeatureCollection", name, features: out });
}
