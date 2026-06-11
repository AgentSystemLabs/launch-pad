import { createInterface } from "node:readline/promises";
import { color } from "./theme";

/** Read a secret value from stdin (piped) or a hidden TTY prompt. */
export async function promptSecret(question: string): Promise<string> {
  if (process.stdin.isTTY !== true) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8").replace(/\n$/, "");
  }

  process.stderr.write(`${question}: `);
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (ch: string) => {
      if (ch === "\n" || ch === "\r" || ch === "\u0004") {
        stdin.setRawMode?.(wasRaw ?? false);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.stderr.write("\n");
        resolve(value);
        return;
      }
      if (ch === "\u0003") {
        stdin.setRawMode?.(wasRaw ?? false);
        stdin.pause();
        stdin.removeListener("data", onData);
        reject(new Error("aborted"));
        return;
      }
      if (ch === "\u007f") {
        value = value.slice(0, -1);
        return;
      }
      value += ch;
    };
    stdin.on("data", onData);
  });
}

/** Free-text prompt with a default. Returns `fallback` immediately on a non-interactive stdin. */
export async function promptText(question: string, fallback: string): Promise<string> {
  if (process.stdin.isTTY !== true) return fallback;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(`${question} ${color.dim(`[${fallback}]`)}: `)).trim();
    return answer === "" ? fallback : answer;
  } finally {
    rl.close();
  }
}

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
