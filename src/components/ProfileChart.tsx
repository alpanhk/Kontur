"use client";

export interface ProfilePoint {
  d: number;
  z: number;
}

/** Grafik profil elevasi (jarak vs elevasi) berbasis SVG. */
export default function ProfileChart({ data }: { data: ProfilePoint[] }) {
  if (data.length < 2) {
    return <p className="text-sm text-slate-500">Data profil belum cukup (minimal 2 titik).</p>;
  }

  const W = 800;
  const H = 260;
  const PAD = { l: 60, r: 16, t: 16, b: 36 };

  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of data) {
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  const maxD = data[data.length - 1].d || 1;
  const spanZ = maxZ - minZ || 1;

  const x = (d: number) => PAD.l + (d / maxD) * (W - PAD.l - PAD.r);
  const y = (z: number) => PAD.t + (1 - (z - minZ) / spanZ) * (H - PAD.t - PAD.b);

  const line = data.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.d).toFixed(1)},${y(p.z).toFixed(1)}`).join(" ");
  const area = `${line} L${x(maxD).toFixed(1)},${y(minZ).toFixed(1)} L${x(0).toFixed(1)},${y(minZ).toFixed(1)} Z`;

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => minZ + t * spanZ);
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * maxD);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Profil elevasi">
      {yTicks.map((v, i) => (
        <g key={`y${i}`}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="#e2e8f0" />
          <text x={PAD.l - 6} y={y(v) + 4} textAnchor="end" fontSize="11" fill="#475569">
            {v.toFixed(0)}
          </text>
        </g>
      ))}
      {xTicks.map((v, i) => (
        <g key={`x${i}`}>
          <line x1={x(v)} x2={x(v)} y1={PAD.t} y2={H - PAD.b} stroke="#f1f5f9" />
          <text x={x(v)} y={H - PAD.b + 16} textAnchor="middle" fontSize="11" fill="#475569">
            {v.toFixed(0)} m
          </text>
        </g>
      ))}
      <path d={area} fill="rgba(16,185,129,0.15)" />
      <path d={line} fill="none" stroke="#059669" strokeWidth={2} />
      <text x={12} y={PAD.t + 4} fontSize="11" fill="#334155" transform={`rotate(-90 12 ${PAD.t + 4})`}>
        Elevasi (m)
      </text>
    </svg>
  );
}
