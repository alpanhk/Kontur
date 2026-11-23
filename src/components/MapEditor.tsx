"use client";

import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef, useState } from "react";
import { polylineLength, ringArea, utmForZone, utmZoneFor } from "@/lib/geo";
import type { LngLat, SurveyFeature } from "@/lib/types";
import { escapeHtml } from "@/lib/utils";

export type DrawMode = "pan" | "line" | "polygon" | "rect" | "point" | "probe";

export interface ProbeInfo {
  lat: number;
  lon: number;
  easting: number;
  northing: number;
  zoneLabel: string;
  elevation: number | null;
  error: string | null;
}

export interface MapEditorProps {
  features: SurveyFeature[];
  draft: LngLat[];
  mode: DrawMode;
  probe: ProbeInfo | null;
  fitToken: number;
  utmOverride: { zone: number; south: boolean } | null;
  onClick: (ll: LngLat) => void;
  onFinishDraft: () => void;
  onUndoDraft: () => void;
  onCancelDraft: () => void;
}

const DRAWING_MODES: DrawMode[] = ["line", "polygon", "rect", "point", "probe"];

interface Groups {
  features: L.LayerGroup;
  draft: L.LayerGroup;
  preview: L.LayerGroup;
  probe: L.LayerGroup;
  search: L.LayerGroup;
}

interface SearchHit {
  label: string;
  lat: number;
  lon: number;
}

interface CursorPos {
  lat: number;
  lon: number;
  easting: number;
  northing: number;
  zoneLabel: string;
}

function resolveProj(lon: number, lat: number, ov: { zone: number; south: boolean } | null) {
  if (ov) return utmForZone(ov.zone, ov.south);
  return utmForZone(utmZoneFor(lon), lat < 0);
}

/** Peta interaktif dengan Satelit Hybrid, pencarian lokasi/UTM, pembacaan koordinat UTM real-time, dan gambar yang mulus. */
export default function MapEditor(props: MapEditorProps) {
  const { features, draft, mode, probe, fitToken, utmOverride, onFinishDraft, onUndoDraft, onCancelDraft } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const groupsRef = useRef<Groups | null>(null);
  const latestRef = useRef(props);
  const lastClickRef = useRef<{ time: number; x: number; y: number }>({ time: 0, x: 0, y: 0 });

  const [cursor, setCursor] = useState<CursorPos | null>(null);
  const [searchText, setSearchText] = useState("");
  const [searchResults, setSearchResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchMsg, setSearchMsg] = useState<string | null>(null);
  const [mobileWheelZoom, setMobileWheelZoom] = useState(false);

  useEffect(() => {
    latestRef.current = props;
  });

  // ---- Inisialisasi peta (sekali) ----
  useEffect(() => {
    const el = containerRef.current;
    if (!el || mapRef.current) return;

    const satBase = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 19, attribution: "Imagery &copy; Esri" },
    );
    const satLabels = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 19, opacity: 0.9 },
    );
    const satRoads = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 19, opacity: 0.7 },
    );
    const satelliteHybrid = L.layerGroup([satBase, satRoads, satLabels]);

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
      center: [-6.7596, 107.6098], // Bandung / Tangkuban Perahu (topografi jelas)
      zoom: 12,
      layers: [satelliteHybrid],
      preferCanvas: true,
      zoomControl: false,
      scrollWheelZoom: window.innerWidth >= 1024,
    });
    L.control.zoom({ position: "topright" }).addTo(map);
    L.control
      .layers(
        {
          "Satelit + Label": satelliteHybrid,
          "Satelit Polos": satelliteClean,
          OpenStreetMap: osm,
          Topografi: topo,
          "Kanvas Polos (CAD)": blankCad,
        },
        undefined,
        { position: "topright" },
      )
      .addTo(map);
    L.control.scale({ metric: true, imperial: false, position: "bottomright" }).addTo(map);

    groupsRef.current = {
      features: L.layerGroup().addTo(map),
      draft: L.layerGroup().addTo(map),
      preview: L.layerGroup().addTo(map),
      probe: L.layerGroup().addTo(map),
      search: L.layerGroup().addTo(map),
    };

    map.on("click", (e: L.LeafletMouseEvent) => {
      const { mode: m, draft: d } = latestRef.current;
      // Cegah klik ganda menambahkan titik duplikat tepat sebelum dblclick
      const now = Date.now();
      const prev = lastClickRef.current;
      const distPx = Math.hypot(e.containerPoint.x - prev.x, e.containerPoint.y - prev.y);
      lastClickRef.current = { time: now, x: e.containerPoint.x, y: e.containerPoint.y };
      if ((m === "line" || m === "polygon") && now - prev.time < 280 && distPx < 10) {
        return;
      }

      // Jika mode poligon & klik dekat titik pertama (>= 3 titik) -> langsung tutup poligon!
      if (m === "polygon" && d.length >= 3) {
        const firstPx = map.latLngToContainerPoint([d[0][1], d[0][0]]);
        if (Math.hypot(e.containerPoint.x - firstPx.x, e.containerPoint.y - firstPx.y) <= 14) {
          latestRef.current.onFinishDraft();
          return;
        }
      }

      latestRef.current.onClick([e.latlng.lng, e.latlng.lat]);
    });

    map.on("dblclick", (e: L.LeafletMouseEvent) => {
      const m = latestRef.current.mode;
      if (m === "line" || m === "polygon") {
        L.DomEvent.stop(e);
        latestRef.current.onFinishDraft();
      }
    });

    map.on("mousemove", (e: L.LeafletMouseEvent) => {
      const lat = e.latlng.lat;
      const lon = e.latlng.lng;
      const proj = resolveProj(lon, lat, latestRef.current.utmOverride);
      const [easting, northing] = proj.toUtm(lon, lat);
      setCursor({
        lat,
        lon,
        easting,
        northing,
        zoneLabel: `${proj.zone}${proj.south ? "S" : "N"}`,
      });

      // Pratinjau rubber-band saat menggambar
      const { mode: m, draft: d } = latestRef.current;
      const g = groupsRef.current;
      if (!g) return;
      g.preview.clearLayers();
      if (m === "rect" && d.length === 1) {
        const a = d[0];
        const b: LngLat = [lon, lat];
        L.rectangle(
          [
            [Math.min(a[1], b[1]), Math.min(a[0], b[0])],
            [Math.max(a[1], b[1]), Math.max(a[0], b[0])],
          ],
          { color: "#38bdf8", weight: 2, dashArray: "6 6", fillColor: "#38bdf8", fillOpacity: 0.14, interactive: false },
        ).addTo(g.preview);
      } else if ((m === "line" || m === "polygon") && d.length >= 1) {
        const last = d[d.length - 1];
        L.polyline(
          [
            [last[1], last[0]],
            [lat, lon],
          ],
          { color: "#38bdf8", weight: 2, dashArray: "5 5", interactive: false },
        ).addTo(g.preview);
        if (m === "polygon" && d.length >= 2) {
          const first = d[0];
          L.polyline(
            [
              [lat, lon],
              [first[1], first[0]],
            ],
            { color: "#38bdf8", weight: 1.5, dashArray: "3 6", opacity: 0.75, interactive: false },
          ).addTo(g.preview);
        }
      }
    });

    mapRef.current = map;
    setTimeout(() => map.invalidateSize(), 50);

    return () => {
      map.remove();
      mapRef.current = null;
      groupsRef.current = null;
    };
  }, []);

    // Kursor & zoom ganda sesuai mode
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const drawing = DRAWING_MODES.includes(mode);
    map.getContainer().style.cursor = drawing ? "crosshair" : "";
    if (drawing) map.doubleClickZoom.disable();
    else map.doubleClickZoom.enable();
    if (!drawing) groupsRef.current?.preview.clearLayers();
  }, [mode]);

  // Pada layar bertumpuk (< 1024px), biarkan scroll roda mouse menggulir halaman ke bawah kecuali pengguna mengaktifkan Zoom Scroll atau menahan Ctrl/Cmd
  useEffect(() => {
    const map = mapRef.current;
    const el = containerRef.current;
    if (!map || !el) return;

    const syncWheelZoom = () => {
      if (window.innerWidth >= 1024 || mobileWheelZoom) {
        map.scrollWheelZoom.enable();
      } else {
        map.scrollWheelZoom.disable();
      }
    };
    syncWheelZoom();

    const onWheel = (e: WheelEvent) => {
      if (window.innerWidth < 1024 && !mobileWheelZoom && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (e.deltaY < 0) map.zoomIn();
        else if (e.deltaY > 0) map.zoomOut();
      }
    };

    window.addEventListener("resize", syncWheelZoom);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("resize", syncWheelZoom);
      el.removeEventListener("wheel", onWheel);
    };
  }, [mobileWheelZoom]);

  // ---- Titik & garis draft ----
  useEffect(() => {
    const g = groupsRef.current;
    if (!g) return;
    g.draft.clearLayers();
    if (draft.length === 0) return;

    const ll = draft.map(([lon, lat]) => [lat, lon] as L.LatLngTuple);
    if (draft.length >= 2 && mode === "polygon") {
      L.polygon(ll, {
        color: "#38bdf8",
        weight: 2.5,
        dashArray: "6 5",
        fillColor: "#38bdf8",
        fillOpacity: 0.16,
        interactive: false,
      }).addTo(g.draft);
    } else if (draft.length >= 2 && mode === "line") {
      L.polyline(ll, { color: "#38bdf8", weight: 3, dashArray: "6 5", interactive: false }).addTo(g.draft);
    }
    ll.forEach((p, i) => {
      const isCloseTarget = i === 0 && mode === "polygon" && draft.length >= 3;
      L.circleMarker(p, {
        radius: isCloseTarget ? 8 : 5,
        color: isCloseTarget ? "#059669" : "#0284c7",
        weight: 2.5,
        fillColor: isCloseTarget ? "#34d399" : "#ffffff",
        fillOpacity: 1,
        interactive: false,
      }).addTo(g.draft);
    });
  }, [draft, mode]);

  // ---- Fitur tersimpan (garis, poligon, titik) ----
  useEffect(() => {
    const g = groupsRef.current;
    if (!g) return;
    g.features.clearLayers();
    for (const f of features) {
      const ll = f.coords.map(([lon, lat]) => [lat, lon] as L.LatLngTuple);
      const tip = escapeHtml(f.name);
      if (f.type === "point" && ll[0]) {
        L.circleMarker(ll[0], { radius: 6, color: "#b91c1c", weight: 2, fillColor: "#f87171", fillOpacity: 0.9 })
          .bindTooltip(tip)
          .addTo(g.features);
      } else if (f.type === "line" && ll.length >= 2) {
        L.polyline(ll, { color: "#f59e0b", weight: 4, opacity: 0.95 })
          .bindTooltip(tip, { sticky: true })
          .addTo(g.features);
      } else if (f.type === "polygon" && ll.length >= 3) {
        L.polygon(ll, { color: "#10b981", weight: 2.5, fillColor: "#10b981", fillOpacity: 0.18 })
          .bindTooltip(tip, { sticky: true })
          .addTo(g.features);
      }
    }
  }, [features]);

  // ---- Zoom ke fitur setelah impor ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || fitToken === 0) return;
    const pts: L.LatLngTuple[] = [];
    for (const f of latestRef.current.features) {
      for (const [lon, lat] of f.coords) pts.push([lat, lon]);
    }
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [50, 50], maxZoom: 17 });
  }, [fitToken]);

  // ---- Hasil cek elevasi ----
  useEffect(() => {
    const g = groupsRef.current;
    if (!g) return;
    g.probe.clearLayers();
    if (!probe) return;
    const val =
      probe.elevation != null
        ? `<b>${probe.elevation.toFixed(2)} m</b> mdpl`
        : escapeHtml(probe.error ?? "Tidak tersedia");
    L.circleMarker([probe.lat, probe.lon], {
      radius: 7,
      color: "#6d28d9",
      weight: 2,
      fillColor: "#a78bfa",
      fillOpacity: 1,
    })
      .bindPopup(
        `<div style="font-size:12px;line-height:1.45">
          <div>Elevasi: ${val}</div>
          <div><b>UTM ${escapeHtml(probe.zoneLabel)}:</b> E ${probe.easting.toFixed(2)}, N ${probe.northing.toFixed(2)}</div>
          <div style="color:#64748b">WGS84: ${probe.lat.toFixed(6)}, ${probe.lon.toFixed(6)}</div>
        </div>`,
      )
      .addTo(g.probe)
      .openPopup();
  }, [probe]);

  // ---- Pencarian Lokasi / Koordinat UTM / LatLon ----
  const flyTo = (lat: number, lon: number, label: string, zoom = 15) => {
    const map = mapRef.current;
    const g = groupsRef.current;
    if (!map || !g) return;
    g.search.clearLayers();
    L.circleMarker([lat, lon], {
      radius: 7,
      color: "#0f172a",
      weight: 2,
      fillColor: "#facc15",
      fillOpacity: 0.95,
    })
      .bindTooltip(escapeHtml(label), { permanent: false })
      .addTo(g.search);
    map.setView([lat, lon], zoom);
    setSearchResults([]);
    setSearchMsg(null);
  };

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = searchText.trim();
    if (!q) return;
    setSearchMsg(null);
    setSearchResults([]);

    // 1. Cek apakah pengguna mengetik koordinat "E, N" (UTM) atau "lat, lon"
    const nums = q.split(/[,;\s]+/).map(Number);
    if (nums.length === 2 && Number.isFinite(nums[0]) && Number.isFinite(nums[1])) {
      const [a, b] = nums;
      if (Math.abs(a) > 180 || Math.abs(b) > 180) {
        // Koordinat UTM (gunakan zona override atau zona tengah peta saat ini)
        const center = mapRef.current?.getCenter();
        const proj = utmOverride
          ? utmForZone(utmOverride.zone, utmOverride.south)
          : utmForZone(utmZoneFor(center?.lng ?? 107.6), (center?.lat ?? -6.8) < 0);
        const easting = a > 1_000_000 && b < 1_000_000 ? b : a;
        const northing = a > 1_000_000 && b < 1_000_000 ? a : b;
        const [lon, lat] = proj.toLonLat(easting, northing);
        if (Math.abs(lat) <= 85 && Math.abs(lon) <= 180) {
          flyTo(lat, lon, `UTM ${proj.zone}${proj.south ? "S" : "N"}: E ${easting}, N ${northing}`, 15);
          return;
        }
      } else if (Math.abs(a) <= 90 && Math.abs(b) <= 180) {
        flyTo(a, b, `${a.toFixed(5)}, ${b.toFixed(5)}`, 15);
        return;
      }
    }

    // 2. Pencarian nama lokasi via /api/geocode (dengan fallback langsung ke Nominatim dari browser)
    setSearching(true);
    try {
      const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
      const data = (await res.json()) as { results?: SearchHit[] };
      let hits = data.results ?? [];
      if (hits.length === 0) {
        const directRes = await fetch(
          `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=5&addressdetails=0`,
          { headers: { Accept: "application/json" } },
        ).catch(() => null);
        if (directRes?.ok) {
          const raw = (await directRes.json()) as { display_name?: string; lat?: string; lon?: string }[];
          hits = (Array.isArray(raw) ? raw : [])
            .map((r) => ({ label: String(r.display_name ?? ""), lat: Number(r.lat), lon: Number(r.lon) }))
            .filter((r) => r.label && Number.isFinite(r.lat) && Number.isFinite(r.lon));
        }
      }
      if (hits.length === 0) setSearchMsg("Lokasi tidak ditemukan.");
      else if (hits.length === 1) flyTo(hits[0].lat, hits[0].lon, hits[0].label, 14);
      else setSearchResults(hits);
    } catch {
      setSearchMsg("Gagal mencari lokasi.");
    } finally {
      setSearching(false);
    }
  };

  // Ringkasan ukuran draft saat menggambar
  let draftMeasure: string | null = null;
  if (draft.length >= 2) {
    const proj = resolveProj(draft[0][0], draft[0][1], utmOverride);
    const xy = draft.map(([lon, lat]) => proj.toUtm(lon, lat));
    if (mode === "line") {
      draftMeasure = `${draft.length} titik · ${polylineLength(xy).toLocaleString("id-ID", { maximumFractionDigits: 0 })} m`;
    } else if (mode === "polygon" && draft.length >= 3) {
      draftMeasure = `${draft.length} sudut · ${(ringArea(xy) / 10000).toLocaleString("id-ID", { maximumFractionDigits: 2 })} ha`;
    }
  }

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />

      {/* Pencarian Lokasi / Koordinat UTM */}
      <div className="absolute left-3 top-3 z-[1010] w-72 max-w-[calc(100%-5rem)]">
        <form onSubmit={handleSearch} className="flex overflow-hidden rounded-lg bg-white shadow-lg ring-1 ring-slate-300">
          <input
            type="text"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="Cari tempat, UTM (E, N), atau Lat, Lon…"
            className="w-full px-3 py-2 text-xs text-slate-800 placeholder:text-slate-400 focus:outline-none"
          />
          <button
            type="submit"
            disabled={searching}
            className="shrink-0 bg-emerald-600 px-3 text-xs font-semibold text-white hover:bg-emerald-700 disabled:bg-slate-400"
          >
            {searching ? "…" : "Cari"}
          </button>
        </form>
        {searchMsg ? (
          <div className="mt-1 rounded-md bg-white/95 px-2.5 py-1.5 text-xs text-slate-600 shadow">{searchMsg}</div>
        ) : null}
        {searchResults.length > 0 ? (
          <ul className="mt-1 max-h-56 divide-y divide-slate-100 overflow-y-auto rounded-lg bg-white text-xs shadow-lg ring-1 ring-slate-200">
            {searchResults.map((h, i) => (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => flyTo(h.lat, h.lon, h.label, 14)}
                  className="block w-full px-3 py-2 text-left text-slate-700 hover:bg-emerald-50"
                >
                  {h.label}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {/* Tombol aksi cepat saat menggambar */}
      {(mode === "line" || mode === "polygon" || mode === "rect") && draft.length > 0 ? (
        <div className="absolute bottom-14 left-1/2 z-[1000] flex -translate-x-1/2 items-center gap-2 rounded-full bg-slate-900/90 px-3 py-1.5 text-xs text-white shadow-xl backdrop-blur">
          <span className="px-1 font-medium text-emerald-300">{draftMeasure ?? `${draft.length} titik`}</span>
          {mode !== "rect" ? (
            <button
              type="button"
              onClick={onFinishDraft}
              disabled={(mode === "line" && draft.length < 2) || (mode === "polygon" && draft.length < 3)}
              className="rounded-full bg-emerald-600 px-3 py-1 font-semibold text-white hover:bg-emerald-500 disabled:bg-slate-600"
            >
              Selesai
            </button>
          ) : null}
          <button
            type="button"
            onClick={onUndoDraft}
            className="rounded-full bg-slate-700 px-2.5 py-1 hover:bg-slate-600"
          >
            Urungkan
          </button>
          <button
            type="button"
            onClick={onCancelDraft}
            className="rounded-full bg-slate-700 px-2.5 py-1 hover:bg-red-600"
          >
            Batal
          </button>
        </div>
      ) : null}

      {/* Pembacaan Koordinat UTM Real-time */}
      {cursor ? (
        <div className="pointer-events-none absolute bottom-3 left-3 z-[1000] rounded-lg bg-slate-900/85 px-3 py-1.5 font-mono text-[11px] leading-snug text-white shadow-lg backdrop-blur">
          <div className="font-semibold text-emerald-300">
            UTM {cursor.zoneLabel} · E {cursor.easting.toFixed(2)} m · N {cursor.northing.toFixed(2)} m
          </div>
          <div className="text-[10px] text-slate-300">
            WGS84: {cursor.lat.toFixed(6)}, {cursor.lon.toFixed(6)}
          </div>
        </div>
      ) : null}

      {/* Tombol opsional pengunci Zoom Scroll pada tampilan bertumpuk */}
      <button
        type="button"
        onClick={() => setMobileWheelZoom((v) => !v)}
        className={`absolute left-3 top-14 z-[1000] rounded-md px-2.5 py-1 text-[11px] font-medium shadow ring-1 lg:hidden ${
          mobileWheelZoom
            ? "bg-emerald-600 text-white ring-emerald-700"
            : "bg-white/95 text-slate-700 ring-slate-300 hover:bg-slate-50"
        }`}
      >
        {mobileWheelZoom ? "Zoom Scroll: Aktif" : "Zoom Scroll: Mati (Bisa Scroll Bawah)"}
      </button>
    </div>
  );
}
