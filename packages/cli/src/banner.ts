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
