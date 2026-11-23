import type { GridMeta } from "./types";

/**
 * Grid reguler dalam koordinat UTM. values[row * cols + col] = elevasi (NaN jika tidak ada data).
 * x = x0 + col * dx ; y = y0 + row * dy
 */
export interface Grid {
  cols: number;
  rows: number;
  x0: number;
  y0: number;
  dx: number;
  dy: number;
  values: Float64Array;
}

export interface GridSampleLike {
  kind: string;
  col: number | null;
  row: number | null;
  elevation: number | null;
}

export function gridFromSamples(meta: GridMeta, samples: GridSampleLike[]): Grid {
  const values = new Float64Array(meta.cols * meta.rows);
  values.fill(Number.NaN);
  for (const s of samples) {
    if (s.kind !== "grid" || s.col == null || s.row == null || s.elevation == null) continue;
    if (s.col < 0 || s.col >= meta.cols || s.row < 0 || s.row >= meta.rows) continue;
    values[s.row * meta.cols + s.col] = s.elevation;
  }
  return { cols: meta.cols, rows: meta.rows, x0: meta.x0, y0: meta.y0, dx: meta.spacing, dy: meta.spacing, values };
}

export interface ContourLine {
  level: number;
  index: boolean;
  closed: boolean;
  pts: [number, number][];
}

export interface ContourLabel {
  level: number;
  x: number;
  y: number;
  angle: number;
  text: string;
}

export interface ContourResult {
  interval: number;
  indexEvery: number;
  refinement: number;
  smoothing: number;
  min: number;
  max: number;
  lines: ContourLine[];
  labels: ContourLabel[];
}

export interface BuildContourOptions {
  interval?: number | null;
  indexEvery?: number;
  /** Faktor upsampling bikubik sub-grid: 1 (asli), 2 (halus), 4 (ultra halus). Default: 2. */
  refinement?: 1 | 2 | 4;
  /** Penghalusan garis kontur: 0 (asli), 1 (halus), 2 (sangat halus). Default: 1. */
  smoothing?: 0 | 1 | 2;
}

const NICE_STEPS = [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];

/** Interval "bulat" (0.5, 1, 2, 2.5, 5, 10, ...) yang menghasilkan sekitar 15 garis kontur. */
export function niceInterval(range: number): number {
  const raw = range / 15;
  for (const s of NICE_STEPS) if (s >= raw) return s;
  return Math.ceil(raw / 1000) * 1000;
}

export function formatLevel(level: number, interval: number): string {
  const decimals = Math.min(4, (String(interval).split(".")[1] ?? "").length);
  return level.toFixed(decimals);
}

/** Interpolasi Catmull-Rom 1D. */
function cubic1d(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

/**
 * Upsampling grid dengan interpolasi bikubik (fallback ke bilinear di dekat NaN/tepi).
 * Menghasilkan kontur jauh lebih halus & presisi tanpa mengubah nilai di node asli.
 */
function upsampleGrid(g: Grid, factor: number): Grid {
  if (factor <= 1 || g.cols < 2 || g.rows < 2) return g;

  // Batasi ukuran grid hasil upsampling agar tetap sangat cepat di browser & server
  let eff = factor;
  while (eff > 1 && (g.cols - 1) * eff * ((g.rows - 1) * eff) > 360_000) {
    eff = Math.floor(eff / 2);
  }
  if (eff <= 1) return g;

  const newCols = (g.cols - 1) * eff + 1;
  const newRows = (g.rows - 1) * eff + 1;
  const out = new Float64Array(newCols * newRows);
  out.fill(Number.NaN);

  const at = (c: number, r: number): number => {
    if (c < 0 || c >= g.cols || r < 0 || r >= g.rows) return Number.NaN;
    return g.values[r * g.cols + c];
  };

  for (let nr = 0; nr < newRows; nr++) {
    const fr = nr / eff;
    const ir = Math.min(g.rows - 2, Math.floor(fr));
    const tr = fr - ir;
    for (let nc = 0; nc < newCols; nc++) {
      const fc = nc / eff;
      const ic = Math.min(g.cols - 2, Math.floor(fc));
      const tc = fc - ic;

      // Cek 4 sudut sel utama; jika salah satu NaN, sel tidak valid (jangan ekstrapolasi keluar batas)
      const v00 = at(ic, ir);
      const v10 = at(ic + 1, ir);
      const v01 = at(ic, ir + 1);
      const v11 = at(ic + 1, ir + 1);
      if (v00 !== v00 || v10 !== v10 || v01 !== v01 || v11 !== v11) continue;

      if (tc === 0 && tr === 0) {
        out[nr * newCols + nc] = v00;
        continue;
      }

      // Coba bikubik 4×4 jika seluruh 16 tetangga valid
      let canCubic = true;
      const rows: number[] = [0, 0, 0, 0];
      for (let j = -1; j <= 2; j++) {
        const a = at(ic - 1, ir + j);
        const b = at(ic, ir + j);
        const c = at(ic + 1, ir + j);
        const d = at(ic + 2, ir + j);
        if (a !== a || b !== b || c !== c || d !== d) {
          canCubic = false;
          break;
        }
        rows[j + 1] = cubic1d(a, b, c, d, tc);
      }

      if (canCubic) {
        out[nr * newCols + nc] = cubic1d(rows[0], rows[1], rows[2], rows[3], tr);
      } else {
        out[nr * newCols + nc] = (v00 * (1 - tc) + v10 * tc) * (1 - tr) + (v01 * (1 - tc) + v11 * tc) * tr;
      }
    }
  }

  return {
    cols: newCols,
    rows: newRows,
    x0: g.x0,
    y0: g.y0,
    dx: g.dx / eff,
    dy: g.dy / eff,
    values: out,
  };
}

/** Penghalusan ringan 3×3 Gaussian (menghilangkan derau mikro DEM tanpa merusak bentuk topografi). */
function smoothGrid(g: Grid, passes: number): Grid {
  if (passes <= 0) return g;
  let cur = g.values;
  const { cols, rows } = g;

  for (let p = 0; p < passes; p++) {
    const next = new Float64Array(cur);
    for (let r = 1; r < rows - 1; r++) {
      for (let c = 1; c < cols - 1; c++) {
        const idx = r * cols + c;
        const center = cur[idx];
        if (center !== center) continue;
        let sum = center * 4;
        let w = 4;
        const nbs: [number, number][] = [
          [cur[idx - 1], 2],
          [cur[idx + 1], 2],
          [cur[idx - cols], 2],
          [cur[idx + cols], 2],
          [cur[idx - cols - 1], 1],
          [cur[idx - cols + 1], 1],
          [cur[idx + cols - 1], 1],
          [cur[idx + cols + 1], 1],
        ];
        for (const [val, wt] of nbs) {
          if (val === val) {
            sum += val * wt;
            w += wt;
          }
        }
        next[idx] = sum / w;
      }
    }
    cur = next;
  }
  return { ...g, values: cur };
}

/** Penghalusan garis kontur metode Chaikin (tetap menjaga ujung garis terbuka & menutup ring dengan mulus). */
function chaikinSmooth(pts: [number, number][], closed: boolean, passes: number): [number, number][] {
  if (passes <= 0 || pts.length < 3) return pts;
  let cur = pts;
  for (let p = 0; p < passes; p++) {
    const n = cur.length;
    if (n < 3) break;
    const next: [number, number][] = [];
    if (closed) {
      for (let i = 0; i < n; i++) {
        const [x0, y0] = cur[i];
        const [x1, y1] = cur[(i + 1) % n];
        next.push([0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1]);
        next.push([0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1]);
      }
    } else {
      next.push(cur[0]);
      for (let i = 0; i < n - 1; i++) {
        const [x0, y0] = cur[i];
        const [x1, y1] = cur[i + 1];
        if (i > 0) next.push([0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1]);
        if (i < n - 2) next.push([0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1]);
      }
      next.push(cur[n - 1]);
    }
    cur = next;
  }
  return cur;
}

/** Simplifikasi Douglas-Peucker sangat halus agar jumlah vertex CAD efisien tanpa mengurangi kehalusan kurva. */
function simplifyRdp(pts: [number, number][], tol: number): [number, number][] {
  if (pts.length <= 3 || tol <= 0) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  const tol2 = tol * tol;

  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let bestD2 = -1;
    let bestI = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      let d2: number;
      if (len2 === 0) {
        d2 = (px - ax) ** 2 + (py - ay) ** 2;
      } else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        const qx = ax + t * dx;
        const qy = ay + t * dy;
        d2 = (px - qx) ** 2 + (py - qy) ** 2;
      }
      if (d2 > bestD2) {
        bestD2 = d2;
        bestI = i;
      }
    }
    if (bestI > 0 && bestD2 > tol2) {
      keep[bestI] = 1;
      stack.push([a, bestI], [bestI, b]);
    }
  }

  const out: [number, number][] = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

interface Chain {
  closed: boolean;
  pts: [number, number][];
}

/**
 * Isoline (marching squares) untuk satu level.
 */
function isolines(g: Grid, L: number): Chain[] {
  const { cols, rows, x0, y0, dx, dy, values: v } = g;
  const segA: number[] = [];
  const segB: number[] = [];
  const pointCache = new Map<number, [number, number]>();

  const edgePoint = (id: number): [number, number] => {
    const hit = pointCache.get(id);
    if (hit) return hit;
    const cell = id >> 1;
    const c = cell % cols;
    const r = Math.floor(cell / cols);
    let p: [number, number];
    if ((id & 1) === 0) {
      const va = v[r * cols + c];
      const vb = v[r * cols + c + 1];
      const t = (L - va) / (vb - va);
      p = [x0 + (c + t) * dx, y0 + r * dy];
    } else {
      const va = v[r * cols + c];
      const vb = v[(r + 1) * cols + c];
      const t = (L - va) / (vb - va);
      p = [x0 + c * dx, y0 + (r + t) * dy];
    }
    pointCache.set(id, p);
    return p;
  };

  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const i00 = r * cols + c;
      const i10 = i00 + 1;
      const i01 = i00 + cols;
      const i11 = i01 + 1;
      const v00 = v[i00];
      const v10 = v[i10];
      const v11 = v[i11];
      const v01 = v[i01];
      if (v00 !== v00 || v10 !== v10 || v11 !== v11 || v01 !== v01) continue;

      const idx = (v00 >= L ? 1 : 0) | (v10 >= L ? 2 : 0) | (v11 >= L ? 4 : 0) | (v01 >= L ? 8 : 0);
      if (idx === 0 || idx === 15) continue;

      const bottom = 2 * i00;
      const top = 2 * i01;
      const left = 2 * i00 + 1;
      const right = 2 * i10 + 1;

      const add = (a: number, b: number) => {
        segA.push(a);
        segB.push(b);
      };

      switch (idx) {
        case 1:
        case 14:
          add(left, bottom);
          break;
        case 2:
        case 13:
          add(bottom, right);
          break;
        case 3:
        case 12:
          add(left, right);
          break;
        case 4:
        case 11:
          add(right, top);
          break;
        case 6:
        case 9:
          add(bottom, top);
          break;
        case 7:
        case 8:
          add(left, top);
          break;
        case 5:
        case 10: {
          const centerHigh = (v00 + v10 + v11 + v01) / 4 >= L;
          if ((idx === 5) === centerHigh) {
            add(bottom, right);
            add(left, top);
          } else {
            add(left, bottom);
            add(right, top);
          }
          break;
        }
        default:
          break;
      }
    }
  }

  const nSeg = segA.length;
  if (nSeg === 0) return [];

  const adj = new Map<number, number[]>();
  for (let s = 0; s < nSeg; s++) {
    for (const key of [segA[s], segB[s]]) {
      const arr = adj.get(key);
      if (arr) arr.push(s);
      else adj.set(key, [s]);
    }
  }

  const used = new Uint8Array(nSeg);
  const nextSeg = (key: number): number => {
    const arr = adj.get(key);
    if (!arr) return -1;
    for (const s of arr) if (!used[s]) return s;
    return -1;
  };

  const chains: Chain[] = [];
  for (let s = 0; s < nSeg; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const start = segA[s];

    const fwd: number[] = [segB[s]];
    let closed = false;
    let cur = segB[s];
    for (;;) {
      const nx = nextSeg(cur);
      if (nx < 0) break;
      used[nx] = 1;
      const other = segA[nx] === cur ? segB[nx] : segA[nx];
      fwd.push(other);
      if (other === start) {
        closed = true;
        break;
      }
      cur = other;
    }

    const bwd: number[] = [];
    if (!closed) {
      cur = start;
      for (;;) {
        const nx = nextSeg(cur);
        if (nx < 0) break;
        used[nx] = 1;
        const other = segA[nx] === cur ? segB[nx] : segA[nx];
        bwd.push(other);
        cur = other;
      }
    }

    const keys = closed ? [start, ...fwd.slice(0, -1)] : [...bwd.reverse(), start, ...fwd];
    chains.push({ closed, pts: keys.map((k) => edgePoint(k)) });
  }
  return chains;
}

/** Membuang simpul berhimpitan (< 0.1 mm) agar polyline bersih di CAD. */
function dedupePoints(pts: [number, number][], closed: boolean): [number, number][] {
  const out: [number, number][] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-4) out.push(p);
  }
  if (closed && out.length > 2) {
    const a = out[0];
    const b = out[out.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= 1e-4) out.pop();
  }
  return out;
}

function chainLength(pts: [number, number][], closed: boolean): number {
  let len = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    len += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  }
  if (closed && pts.length > 2) {
    len += Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]);
  }
  return len;
}

/**
 * Membangun garis kontur beresolusi tinggi dari grid UTM.
 */
export function buildContours(rawGrid: Grid, opts: BuildContourOptions = {}): ContourResult {
  const indexEvery = Math.max(1, Math.round(opts.indexEvery ?? 5));
  const refinement = opts.refinement ?? 2;
  const smoothing = opts.smoothing ?? 1;

  // Hitung rentang elevasi asli (sebelum smoothing agar statistik akurat)
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < rawGrid.values.length; i++) {
    const v = rawGrid.values[i];
    if (v === v) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!(max > min)) {
    return {
      interval: 0,
      indexEvery,
      refinement,
      smoothing,
      min: Number.isFinite(min) ? min : 0,
      max: Number.isFinite(max) ? max : 0,
      lines: [],
      labels: [],
    };
  }

  // 1. Upsampling bikubik sub-grid + penghalusan ringan bila dipilih
  const grid0 = smoothing >= 2 ? smoothGrid(rawGrid, 1) : rawGrid;
  const grid = upsampleGrid(grid0, refinement);

  let interval = opts.interval && opts.interval > 0 ? opts.interval : niceInterval(max - min);
  while ((max - min) / interval > 350) interval *= 2;

  const kStart = Math.ceil(min / interval);
  const kEnd = Math.floor(max / interval);
  const lines: ContourLine[] = [];
  const simpTol = grid.dx * 0.04;

  for (let k = kStart; k <= kEnd; k++) {
    const level = Math.round(k * interval * 1e6) / 1e6;
    const index = Math.abs(k) % indexEvery === 0;
    const cutLevel = level + 1e-9 * Math.max(1, Math.abs(level));
    for (const ch of isolines(grid, cutLevel)) {
      let pts = dedupePoints(ch.pts, ch.closed);
      if (pts.length < 2) continue;
      if (smoothing > 0 && pts.length >= 3) {
        pts = chaikinSmooth(pts, ch.closed, smoothing);
        pts = simplifyRdp(pts, simpTol);
        pts = dedupePoints(pts, ch.closed);
      }
      if (pts.length < 2) continue;
      lines.push({ level, index, closed: ch.closed, pts });
    }
  }

  // Penempatan label kontur indeks yang rapi (hindari tumpang tindih & lewati fragmen pendek)
  const extent = Math.max((rawGrid.cols - 1) * rawGrid.dx, (rawGrid.rows - 1) * rawGrid.dy, 1);
  const minLineLen = extent * 0.05;
  const minLabelSep = extent * 0.09;
  const labels: ContourLabel[] = [];

  const farEnough = (x: number, y: number) =>
    labels.every((lb) => Math.hypot(lb.x - x, lb.y - y) >= minLabelSep);

  for (const ln of lines) {
    if (!ln.index || ln.pts.length < 3) continue;
    const totalLen = chainLength(ln.pts, ln.closed);
    if (totalLen < minLineLen) continue;

    // Untuk garis sangat panjang, coba tempatkan beberapa label berjarak merata
    const slots = Math.min(4, Math.max(1, Math.floor(totalLen / (extent * 0.45))));
    for (let s = 0; s < slots; s++) {
      const frac = (s + 0.5) / slots;
      const mid = Math.min(ln.pts.length - 1, Math.max(0, Math.floor(ln.pts.length * frac)));
      const [lx, ly] = ln.pts[mid];
      if (!farEnough(lx, ly)) continue;

      const a = ln.pts[Math.max(0, mid - 1)];
      const b = ln.pts[Math.min(ln.pts.length - 1, mid + 1)];
      let angle = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
      if (angle > 90) angle -= 180;
      if (angle < -90) angle += 180;
      labels.push({
        level: ln.level,
        x: lx,
        y: ly,
        angle,
        text: formatLevel(ln.level, interval),
      });
    }
  }

  return { interval, indexEvery, refinement, smoothing, min, max, lines, labels };
}
