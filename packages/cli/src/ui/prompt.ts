import { createInterface } from "node:readline/promises";
import { color } from "./theme";

/** Yes/no confirmation. Returns `fallback` immediately on a non-interactive stdin. */
export async function confirm(question: string, fallback = false): Promise<boolean> {
  if (process.stdin.isTTY !== true) return fallback;
  const hint = fallback ? "Y/n" : "y/N";
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(`${question} ${color.dim(`(${hint})`)}: `)).trim().toLowerCase();
    if (answer === "") return fallback;
    return answer.startsWith("y");
  } finally {
    rl.close();
  }
}
