import type { EffectiveCluster } from "./config/local";
import { color } from "./ui/theme";

const ART = [
  "  ╦  ╔═╗╦ ╦╔╗╔╔═╗╦ ╦  ╔═╗╔═╗╔╦╗",
  "  ║  ╠═╣║ ║║║║║  ╠═╣  ╠═╝╠═╣ ║║",
  "  ╩═╝╩ ╩╚═╝╝╚╝╚═╝╩ ╩  ╩  ╩ ╩═╩╝",
];

/** The wordmark + tagline, printed to stderr at the top of commands and help. */
export function renderBanner(version: string): string {
  const art = ART.map((line) => color.cyan(line)).join("\n");
  const tagline = color.dim("  deploy your apps to your own AWS — one command");
  return `\n${art}\n${tagline}  ${color.dim(`v${version}`)}\n\n`;
}

/**
 * A compact one-line "cluster: <id> (<region>)" for the banner area, so AWS-touching
 * commands always show which cluster they target. The implicit `default` is dimmed;
 * a `--cluster` override notes the persistent default it's shadowing.
 */
export function renderClusterLine(eff: EffectiveCluster): string {
  const name = eff.isImplicitDefault ? color.dim(eff.cluster) : color.cyan(eff.cluster);
  const parts: string[] = [];
  if (eff.region) parts.push(eff.region);
  if (eff.overridden) parts.push(`override, default: ${eff.persistedDefault}`);
  const suffix = parts.length > 0 ? ` ${color.dim(`(${parts.join(" · ")})`)}` : "";
  return `  ${color.dim("cluster:")} ${name}${suffix}\n`;
}
