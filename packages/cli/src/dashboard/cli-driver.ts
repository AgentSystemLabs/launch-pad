/**
 * The dashboard's single integration surface: it drives this same `launch-pad` CLI
 * as a subprocess and parses its `--json` output. Nothing here touches AWS directly,
 * so the dashboard inherits exactly the CLI's behavior, auth, and safety guarantees.
 *
 *   runLaunchPad(args, opts)    → one-shot reads (parses stdout JSON)
 *   streamLaunchPad(args, …)    → long-lived `--follow` / `--watch` (NDJSON per line)
 *
 * The CLI writes human errors to stderr and machine JSON to stdout, so a non-zero
 * exit with nothing parseable on stdout surfaces stderr's first line to the caller.
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";

export interface LpOpts {
  /** target cluster (`--cluster`) */
  cluster?: string;
  /** AWS profile (`--profile`) */
  profile?: string;
  /** AWS region (`--region`) */
  region?: string;
  /** working directory — REQUIRED for status (no --node), logs, history (resolve launch-pad.toml) */
  cwd?: string;
  /** kill the subprocess after this many ms (default: none) */
  timeoutMs?: number;
  /** external cancellation */
  signal?: AbortSignal;
}

export class LpError extends Error {
  constructor(
    message: string,
    readonly argv: string[],
    readonly exitCode: number,
    readonly stderr: string,
    readonly stdout: string,
  ) {
    super(message);
    this.name = "LpError";
  }
}

let cachedBin: string[] | undefined;

/**
 * Resolve the argv prefix that invokes the CLI.
 *  - `LAUNCH_PAD_BIN` overrides: a `.ts`/`.js`/`.mjs` path runs under the current
 *    runtime (node — the e2e fake CLI relies on this); anything else is an executable.
 *  - Default: this very process's entry (`process.execPath process.argv[1]`) — the
 *    dashboard lives inside the CLI, so the running entry IS the CLI.
 */
export function resolveLaunchPadBin(): string[] {
  if (cachedBin) return cachedBin;
  // process.execArgv carries the tsx loader flags when running from source
  // (npm link / pnpm dev) — without them, spawning the .ts entry under bare
  // node dies on extensionless ESM imports. It's empty for the dist bundle.
  const override = process.env.LAUNCH_PAD_BIN;
  if (override && override.trim()) {
    const o = override.trim();
    cachedBin =
      o.endsWith(".ts") || o.endsWith(".js") || o.endsWith(".mjs") || o.endsWith(".cjs")
        ? [process.execPath, ...process.execArgv, o]
        : [o];
    return cachedBin;
  }
  const self = process.argv[1];
  if (!self) {
    throw new LpError(
      "cannot resolve the launch-pad CLI entry from process.argv",
      [],
      127,
      "set LAUNCH_PAD_BIN to the CLI entry",
      "",
    );
  }
  cachedBin = [process.execPath, ...process.execArgv, self];
  return cachedBin;
}

/** Reset the cached bin resolution (tests that flip LAUNCH_PAD_BIN at runtime). */
export function resetLaunchPadBin(): void {
  cachedBin = undefined;
}

function buildArgv(args: string[], opts: LpOpts): string[] {
  const flags = ["--json"];
  if (opts.cluster) flags.push("--cluster", opts.cluster);
  if (opts.profile) flags.push("--profile", opts.profile);
  if (opts.region) flags.push("--region", opts.region);
  // Globals are accepted on every leaf command, so trailing them is safe.
  return [...resolveLaunchPadBin(), ...args, ...flags];
}

function firstLine(s: string): string {
  return s.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "";
}

/**
 * Run a one-shot CLI command and return its parsed JSON.
 *
 * Returns parsed stdout whenever stdout holds a JSON document — even on a non-zero
 * exit; the JSON itself carries the outcome. Throws `LpError` only when the command
 * fails *and* left nothing parseable on stdout (a real error, message on stderr).
 */
export async function runLaunchPad<T = unknown>(args: string[], opts: LpOpts = {}): Promise<T> {
  const argv = buildArgv(args, opts);
  const [cmd, ...rest] = argv as [string, ...string[]];
  const proc = spawn(cmd, rest, {
    // A neutral default cwd: the dashboard process may sit in a project dir
    // (auto-register), and cwd-sensitive commands (`destroy --list-envs`) would
    // silently scope cluster-wide reads to that project's launch-pad.toml.
    cwd: opts.cwd ?? homedir(),
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const kill = () => {
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  };
  // One-shot reads always get a deadline — a hung AWS call (expired SSO, network
  // blackhole) must not hang the page forever.
  timer = setTimeout(kill, opts.timeoutMs ?? 30_000);
  opts.signal?.addEventListener("abort", kill, { once: true });
  if (opts.signal?.aborted) kill(); // an already-aborted signal never fires the event

  try {
    let out = "";
    let err = "";
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      out += chunk;
    });
    proc.stderr.on("data", (chunk: string) => {
      err += chunk;
    });
    const code = await new Promise<number>((resolve, reject) => {
      proc.on("error", reject);
      proc.on("close", (c) => resolve(c ?? 1));
    });

    const trimmed = out.trim();
    if (trimmed) {
      try {
        return JSON.parse(trimmed) as T;
      } catch {
        /* fall through to error handling */
      }
    }
    if (code !== 0) {
      throw new LpError(
        firstLine(err) || `launch-pad ${args.join(" ")} exited ${code}`,
        argv,
        code,
        err,
        out,
      );
    }
    return undefined as T;
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener("abort", kill);
  }
}

export interface StreamHandle {
  stop: () => void;
}

export interface StreamOpts extends LpOpts {
  /** called when the subprocess exits on its own (not via stop()) */
  onClose?: (info: { code: number; stderr: string }) => void;
}

/**
 * Run a long-lived `--follow` / `--watch` command, invoking `onLine` with each
 * parsed NDJSON object. Non-JSON lines are ignored. `stop()` kills the process.
 */
export function streamLaunchPad(
  args: string[],
  onLine: (obj: unknown) => void,
  opts: StreamOpts = {},
): StreamHandle {
  const argv = buildArgv(args, opts);
  const [cmd, ...rest] = argv as [string, ...string[]];
  const proc = spawn(cmd, rest, {
    cwd: opts.cwd ?? homedir(), // neutral default — see runLaunchPad
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stopped = false;
  let stderrBuf = "";
  let buf = "";

  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        onLine(JSON.parse(line));
      } catch {
        /* not a JSON line — ignore */
      }
    }
  });

  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk: string) => {
    // Rooms live for days; only the tail is ever surfaced (first line at exit),
    // so cap the buffer instead of accumulating every SDK warning forever.
    stderrBuf = (stderrBuf + chunk).slice(-8192);
  });

  const kill = () => {
    stopped = true;
    try {
      proc.kill();
    } catch {
      /* gone */
    }
  };
  opts.signal?.addEventListener("abort", kill, { once: true });
  if (opts.signal?.aborted) kill(); // an already-aborted signal never fires the event

  proc.on("error", () => {
    opts.signal?.removeEventListener("abort", kill);
    if (!stopped) opts.onClose?.({ code: 127, stderr: stderrBuf || "failed to spawn launch-pad" });
  });
  proc.on("close", (code) => {
    opts.signal?.removeEventListener("abort", kill);
    if (!stopped) opts.onClose?.({ code: code ?? 1, stderr: stderrBuf });
  });

  return { stop: kill };
}
