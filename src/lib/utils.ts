/** Escape untuk disisipkan ke HTML (tooltip / popup Leaflet). */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escape untuk dokumen XML (KML). */
export function escapeXml(s: string): string {
  return escapeHtml(s);
}

/** Nama file aman (ASCII, huruf kecil, tanda hubung). */
export function slugify(s: string): string {
  const out = s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 60);
  return out || "survei";
}

/** Nama baru berurutan, mis. "Garis 3" jika "Garis 1" dan "Garis 2" sudah ada. */
export function nextName(prefix: string, existing: { name: string }[]): string {
  const names = new Set(existing.map((e) => e.name));
  let i = 1;
  while (names.has(`${prefix} ${i}`)) i++;
  return `${prefix} ${i}`;
}

/** Menjamin nama unik dengan menambahkan "(2)", "(3)", dst. */
export function uniqueName(base: string, existing: { name: string }[]): string {
  const names = new Set(existing.map((e) => e.name));
  if (!names.has(base)) return base;
  let i = 2;
  while (names.has(`${base} (${i})`)) i++;
  return `${base} (${i})`;
}

export function samePoint(a?: [number, number], b?: [number, number]): boolean {
  return !!a && !!b && Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
}

export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "-";
  if (totalSeconds < 60) return `${Math.max(1, Math.round(totalSeconds))} detik`;
  const m = Math.floor(totalSeconds / 60);
  const s = Math.round(totalSeconds % 60);
  return `${m} menit ${s} detik`;
}

/** Skala warna elevasi (hijau → kuning → merah). */
const RAMP: [number, [number, number, number]][] = [
  [0, [26, 150, 65]],
  [0.25, [145, 207, 96]],
  [0.5, [255, 255, 191]],
  [0.75, [252, 141, 89]],
  [1, [215, 48, 39]],
];

export function rampColor(t: number): string {
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  for (let i = 1; i < RAMP.length; i++) {
    const [t1, c1] = RAMP[i];
    const [t0, c0] = RAMP[i - 1];
    if (x <= t1) {
      const k = (x - t0) / (t1 - t0);
      const c = c0.map((v, j) => Math.round(v + (c1[j] - v) * k));
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    }
  }
  return "rgb(215,48,39)";
}

/** CSS linear-gradient untuk legenda. */
export function rampGradientCss(): string {
  return `linear-gradient(to right, ${RAMP.map(([t, c]) => `rgb(${c[0]},${c[1]},${c[2]}) ${t * 100}%`).join(", ")})`;
}
