"use client";

import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ContourResult } from "@/lib/contour";
import { utmForZone } from "@/lib/geo";
import type { SamplePoint, SurveyFeature } from "@/lib/types";
import { escapeHtml, rampColor } from "@/lib/utils";

export interface ContourMapProps {
  features: SurveyFeature[];
  points: SamplePoint[];
  contours: ContourResult | null;
  zone: number;
  south: boolean;
  showPoints: boolean;
  showLabels: boolean;
}

interface Layers {
  contour: L.LayerGroup;
  labels: L.LayerGroup;
  points: L.LayerGroup;
  features: L.LayerGroup;
  renderer: L.Canvas;
}

/** Peta hasil survei: kontur HD berwarna, label kontur indeks, titik sampel, dan pembacaan UTM real-time. */
export default function ContourMap({
  features,
  points,
  contours,
  zone,
  south,
  showPoints,
  showLabels,
}: ContourMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layersRef = useRef<Layers | null>(null);
  const fittedRef = useRef(false);
  const proj = useMemo(() => utmForZone(zone, south), [zone, south]);
  const [cursorUtm, setCursorUtm] = useState<{ e: number; n: number; lat: number; lon: number } | null>(null);
  const [wheelZoom, setWheelZoom] = useState(false);

  const range = useMemo(() => {
    if (contours && contours.max > contours.min) return { min: contours.min, max: contours.max };
    let min = Infinity;
    let max = -Infinity;
    for (const p of points) {
      if (p.elevation == null) continue;
      if (p.elevation < min) min = p.elevation;
      if (p.elevation > max) max = p.elevation;
    }
    if (!Number.isFinite(min) || max <= min) return { min: 0, max: 1 };
    return { min, max };
  }, [contours, points]);

  const colorOf = (z: number) => rampColor((z - range.min) / (range.max - range.min || 1));

  // ---- Inisialisasi peta ----
  useEffect(() => {
    const el = containerRef.current;
    if (!el || mapRef.current) return;

    const satBase = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 19, attribution: "Imagery &copy; Esri" },
    );
    const satLabels = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 19, opacity: 0.85 },
    );
    const satelliteHybrid = L.layerGroup([satBase, satLabels]);

    const satelliteClean = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 19, attribution: "Imagery &copy; Esri" },
    );
    const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    });
    const topo = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
      maxZoom: 17,
      attribution: "&copy; OpenTopoMap",
    });
    const blankCad = L.gridLayer({ maxZoom: 20 });

    const map = L.map(el, {
      center: [-6.75, 107.6],
      zoom: 13,
      layers: [satelliteHybrid],
      preferCanvas: true,
      scrollWheelZoom: false,
    });
    L.control
      .layers({
        "Satelit + Label": satelliteHybrid,
        "Satelit Polos": satelliteClean,
        OpenStreetMap: osm,
        Topografi: topo,
        "Kanvas CAD (Polos)": blankCad,
      })
      .addTo(map);
    L.control.scale({ metric: true, imperial: false }).addTo(map);

    layersRef.current = {
      renderer: L.canvas({ padding: 0.5 }),
      contour: L.layerGroup().addTo(map),
      labels: L.layerGroup().addTo(map),
      points: L.layerGroup().addTo(map),
      features: L.layerGroup().addTo(map),
    };

    map.on("mousemove", (ev: L.LeafletMouseEvent) => {
      const [e, n] = proj.toUtm(ev.latlng.lng, ev.latlng.lat);
      setCursorUtm({ e, n, lat: ev.latlng.lat, lon: ev.latlng.lng });
    });

    mapRef.current = map;
    setTimeout(() => map.invalidateSize(), 50);

    return () => {
      map.remove();
      mapRef.current = null;
      layersRef.current = null;
      fittedRef.current = false;
    };
  }, [proj]);

  // Biarkan halaman dapat di-scroll ke Tabel & Profil di bawah peta, sambil mendukung Ctrl+Scroll atau tombol Zoom Scroll
  useEffect(() => {
    const map = mapRef.current;
    const el = containerRef.current;
    if (!map || !el) return;

    if (wheelZoom) map.scrollWheelZoom.enable();
    else map.scrollWheelZoom.disable();

    const onWheel = (e: WheelEvent) => {
      if (!wheelZoom && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (e.deltaY < 0) map.zoomIn();
        else if (e.deltaY > 0) map.zoomOut();
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [wheelZoom]);

  // ---- Kontur & label ----
  useEffect(() => {
    const ly = layersRef.current;
    if (!ly) return;
    ly.contour.clearLayers();
    ly.labels.clearLayers();
    if (!contours) return;

    for (const ln of contours.lines) {
      const ll = ln.pts.map(([e, n]) => {
        const [lon, lat] = proj.toLonLat(e, n);
        return [lat, lon] as L.LatLngTuple;
      });
      if (ll.length < 2) continue;
      if (ln.closed) ll.push(ll[0]);
      L.polyline(ll, {
        color: colorOf(ln.level),
        weight: ln.index ? 2.3 : 1.05,
        opacity: ln.index ? 1 : 0.85,
        interactive: false,
        renderer: ly.renderer,
      }).addTo(ly.contour);
    }

    if (showLabels) {
      for (const lb of contours.labels) {
        const [lon, lat] = proj.toLonLat(lb.x, lb.y);
        L.marker([lat, lon], {
          interactive: false,
          icon: L.divIcon({
            className: "",
            html: `<span style="transform:translate(-50%,-50%);display:inline-block;white-space:nowrap;border-radius:4px;background:rgba(255,255,255,.94);padding:0 5px;font:700 10.5px/16px system-ui,sans-serif;color:#7c2d12;box-shadow:0 1px 2px rgba(0,0,0,.2),0 0 0 1px rgba(124,45,18,.3)">${escapeHtml(lb.text)} m</span>`,
          }),
        }).addTo(ly.labels);
      }
    }
  }, [contours, proj, showLabels, range.min, range.max]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Titik sampel (opsional) ----
  useEffect(() => {
    const ly = layersRef.current;
    if (!ly) return;
    ly.points.clearLayers();
    if (!showPoints) return;
    // Batasi tampilan titik interaktif agar browser tetap lancar pada 50.000 titik
    const step = points.length > 6000 ? Math.ceil(points.length / 6000) : 1;
    for (let i = 0; i < points.length; i += step) {
      const p = points[i];
      if (p.elevation == null || p.kind === "line" || p.kind === "boundary") continue;
      L.circleMarker([p.lat, p.lon], {
        radius: p.kind === "grid" ? 2.2 : 4.5,
        color: "#0f172a",
        weight: 0.5,
        fillColor: colorOf(p.elevation),
        fillOpacity: 0.95,
        renderer: ly.renderer,
        interactive: true,
      })
        .bindTooltip(
          `<b>Z ${p.elevation.toFixed(2)} m</b><br/>E ${p.easting.toFixed(2)} m · N ${p.northing.toFixed(2)} m<br/>${escapeHtml(p.feature)} (${p.kind})`,
        )
        .addTo(ly.points);
    }
  }, [points, showPoints, range.min, range.max]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Fitur input (batas, garis, titik) ----
  useEffect(() => {
    const ly = layersRef.current;
    if (!ly) return;
    ly.features.clearLayers();
    for (const f of features) {
      const ll = f.coords.map(([lon, lat]) => [lat, lon] as L.LatLngTuple);
      const tip = escapeHtml(f.name);
      if (f.type === "polygon" && ll.length >= 3) {
        L.polygon(ll, { color: "#0ea5e9", weight: 2.5, dashArray: "8 5", fillOpacity: 0, interactive: false })
          .bindTooltip(tip)
          .addTo(ly.features);
      } else if (f.type === "line" && ll.length >= 2) {
        L.polyline(ll, { color: "#f97316", weight: 4, interactive: false }).bindTooltip(tip).addTo(ly.features);
      } else if (f.type === "point" && ll[0]) {
        L.circleMarker(ll[0], { radius: 6, color: "#b91c1c", weight: 2, fillColor: "#f87171", fillOpacity: 0.9 })
          .bindTooltip(tip)
          .addTo(ly.features);
      }
    }
  }, [features]);

  // ---- Zoom awal ke area data ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || fittedRef.current) return;
    const pts: L.LatLngTuple[] = [];
    for (const f of features) for (const [lon, lat] of f.coords) pts.push([lat, lon]);
    for (const p of points) pts.push([p.lat, p.lon]);
    if (pts.length === 0) return;
    map.fitBounds(L.latLngBounds(pts), { padding: [30, 30], maxZoom: 18 });
    fittedRef.current = true;
  }, [features, points]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />

      <button
        type="button"
        onClick={() => setWheelZoom((v) => !v)}
        className={`absolute left-12 top-3 z-[1000] rounded-md px-2.5 py-1 text-[11px] font-medium shadow ring-1 ${
          wheelZoom
            ? "bg-emerald-600 text-white ring-emerald-700"
            : "bg-white/95 text-slate-700 ring-slate-300 hover:bg-slate-50"
        }`}
      >
        {wheelZoom ? "Zoom Scroll: Aktif" : "Zoom Scroll: Mati (Bisa Scroll Bawah)"}
      </button>

      {contours && contours.lines.length > 0 ? (
        <div className="pointer-events-none absolute bottom-12 left-3 z-[1000] rounded-lg bg-white/95 p-2 text-[11px] shadow-lg ring-1 ring-slate-200">
          <div className="mb-1 font-semibold text-slate-700">Elevasi (m mdpl)</div>
          <div
            className="h-2.5 w-44 rounded"
            style={{
              background: `linear-gradient(to right, ${[0, 0.25, 0.5, 0.75, 1]
                .map((t) => rampColor(t))
                .join(", ")})`,
            }}
          />
          <div className="mt-1 flex justify-between text-slate-600">
            <span>{range.min.toFixed(1)}</span>
            <span>{range.max.toFixed(1)}</span>
          </div>
          <div className="mt-0.5 text-[10px] text-slate-500">
            Interval {contours.interval} m · Indeks tiap {contours.indexEvery} · {contours.refinement}× HD
          </div>
        </div>
      ) : null}

      {cursorUtm ? (
        <div className="pointer-events-none absolute bottom-2 left-3 z-[1000] rounded-md bg-slate-900/85 px-2.5 py-1 font-mono text-[11px] text-emerald-300 shadow">
          UTM {zone}
          {south ? "S" : "N"} · E {cursorUtm.e.toFixed(2)} m · N {cursorUtm.n.toFixed(2)} m
        </div>
      ) : null}
    </div>
  );
}
