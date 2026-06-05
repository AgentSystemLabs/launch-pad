/** Eight-level block glyphs, low → high. */
const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

export interface SparklineScale {
  /** Lower bound of the scale (default: the data minimum). */
  min?: number;
  /** Upper bound of the scale (default: the data maximum). */
  max?: number;
}

/**
 * Render a numeric series as a unicode sparkline (no chart deps). Values are scaled
 * across `[min, max]` onto the eight block glyphs; pass an explicit scale (e.g.
 * `{ min: 0, max: 100 }` for percentages) so a series reads against a fixed axis
 * rather than auto-fitting. A flat series renders as the lowest block.
 */
export function sparkline(values: number[], scale: SparklineScale = {}): string {
  if (values.length === 0) return "";
  const min = scale.min ?? Math.min(...values);
  const max = scale.max ?? Math.max(...values);
  const span = max - min;
  if (span <= 0) return BLOCKS[0].repeat(values.length);
  return values
    .map((v) => {
      const clamped = Math.max(min, Math.min(max, v));
      const idx = Math.round(((clamped - min) / span) * (BLOCKS.length - 1));
      return BLOCKS[Math.max(0, Math.min(BLOCKS.length - 1, idx))];
    })
    .join("");
}
