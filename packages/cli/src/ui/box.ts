import { color } from "./theme";
import { log } from "./log";

/**
 * A left-barred panel. We avoid full boxes so we never need ANSI-aware width math
 * — the lines may contain color codes of unknown display width.
 */
export function panel(title: string, lines: string[]): void {
  log.plain();
  log.plain(`  ${color.cyan("┌─")} ${color.bold(title)}`);
  for (const line of lines) {
    log.plain(`  ${color.cyan("│")}  ${line}`);
  }
  log.plain(`  ${color.cyan("└─")}`);
  log.plain();
}

/** Render a simple two-column aligned table (no outer border). */
export function table(rows: Array<[string, string]>): string[] {
  const width = rows.reduce((max, [k]) => Math.max(max, k.length), 0);
  return rows.map(([k, v]) => `${color.dim(k.padEnd(width))}  ${v}`);
}
