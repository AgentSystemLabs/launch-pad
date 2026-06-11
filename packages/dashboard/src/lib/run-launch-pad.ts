/**
 * The dashboard's single integration surface: it drives the `launch-pad` CLI as a
 * subprocess and parses its `--json` output. Nothing here touches AWS/Docker directly.
 *
 *   runLaunchPad(args, opts)    → one-shot reads + mutations (parses stdout JSON)
 *   streamLaunchPad(args, …)    → long-lived `--follow` / `--watch` (NDJSON per line)
 *
 * The CLI writes human errors to stderr and machine JSON to stdout, so a non-zero
 * exit with nothing parseable on stdout surfaces stderr's first line to the caller.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface LpOpts {
  /** target cluster (`--cluster`) */
  cluster?: string;
  /** AWS profile (`--profile`) */
  profile?: string;
  /** AWS region (`--region`) */
  region?: string;
  /** working directory — REQUIRED for status (no --node), logs, deploy (resolve launch-pad.toml) */
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
 *  - `LAUNCH_PAD_BIN` overrides: a `.ts`/`.js` path runs under the current runtime
 *    (Bun for the dashboard / tests); anything else is treated as an executable.
 *  - Default: `node <repo>/packages/cli/dist/index.js` (same monorepo, built dist).
 */
export function resolveLaunchPadBin(): string[] {
  if (cachedBin) return cachedBin;
  const override = process.env.LAUNCH_PAD_BIN;
  if (override && override.trim()) {
    const o = override.trim();
    cachedBin = o.endsWith(".ts") || o.endsWith(".js") ? [process.execPath, o] : [o];
    return cachedBin;
  }
  const dist = fileURLToPath(new URL("../../../cli/dist/index.js", import.meta.url));
  if (!existsSync(dist)) {
    throw new LpError(
      `launch-pad CLI not built at ${dist}`,
      [],
      127,
      "run `pnpm build` in the launch-pad repo, or set LAUNCH_PAD_BIN to the CLI entry",
      "",
    );
  }
  cachedBin = ["node", dist];
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
 * exit (e.g. `deploy` exits 1 but still prints `{converged:false,…}`); the JSON
 * itself carries the outcome. Throws `LpError` only when the command fails *and*
 * left nothing parseable on stdout (a real error, message on stderr).
 */
export async function runLaunchPad<T = unknown>(args: string[], opts: LpOpts = {}): Promise<T> {
  const argv = buildArgv(args, opts);
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const kill = () => {
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  };
  if (opts.timeoutMs) timer = setTimeout(kill, opts.timeoutMs);
  opts.signal?.addEventListener("abort", kill, { once: true });

  try {
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;

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
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });

  let stopped = false;
  let stderrBuf = "";

  void (async () => {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
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
      }
    } catch {
      /* reader torn down on stop() */
    }
  })();

  void (async () => {
    try {
      stderrBuf = await new Response(proc.stderr).text();
    } catch {
      /* ignore */
    }
  })();

  opts.signal?.addEventListener(
    "abort",
    () => {
      stopped = true;
      try {
        proc.kill();
      } catch {
        /* gone */
      }
    },
    { once: true },
  );

  void proc.exited.then((code) => {
    if (!stopped) opts.onClose?.({ code, stderr: stderrBuf });
  });

  return {
    stop: () => {
      stopped = true;
      try {
        proc.kill();
      } catch {
        /* gone */
      }
    },
  };
}
