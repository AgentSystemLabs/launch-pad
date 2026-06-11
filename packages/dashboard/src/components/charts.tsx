/** Server-rendered inline-SVG charts. Templates re-render on each sample; morph updates the SVG. */
import { utilColorClass } from "../lib/format";

export function Sparkline({
  values,
  max = 100,
  width = 280,
  height = 56,
}: {
  values: number[];
  max?: number;
  width?: number;
  height?: number;
}) {
  if (values.length === 0) {
    return (
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} class="opacity-40">
        <line x1="0" y1={height - 1} x2={width} y2={height - 1} stroke="currentColor" stroke-width="1" />
      </svg>
    );
  }
  const safeMax = max <= 0 ? 1 : max;
  const n = values.length;
  const stepX = n > 1 ? width / (n - 1) : width;
  const y = (v: number) => height - (Math.max(0, Math.min(safeMax, v)) / safeMax) * height;
  const pts = values.map((v, i) => `${(i * stepX).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const lastX = ((n - 1) * stepX).toFixed(1);
  const area = `0,${height} ${pts} ${lastX},${height}`;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      class="text-primary"
    >
      <polyline points={area} fill="currentColor" fill-opacity="0.15" stroke="none" />
      <polyline points={pts} fill="none" stroke="currentColor" stroke-width="1.5" />
    </svg>
  );
}

/** A metric card: label, big current value, sparkline history, and a usage bar. */
export function MetricCard({
  label,
  current,
  percent,
  values,
}: {
  label: string;
  current: string;
  /** 0–100 for the usage bar (and sparkline scale) */
  percent: number;
  values: number[];
}) {
  return (
    <div class="card bg-base-200">
      <div class="card-body p-4 gap-2">
        <div class="flex items-baseline justify-between">
          <span class="text-sm opacity-70">{label}</span>
          <span class="text-2xl font-mono font-semibold">{current}</span>
        </div>
        <Sparkline values={values} max={100} />
        <progress
          class={`progress ${utilColorClass(percent)} w-full`}
          value={Math.round(percent)}
          max="100"
        ></progress>
      </div>
    </div>
  );
}
