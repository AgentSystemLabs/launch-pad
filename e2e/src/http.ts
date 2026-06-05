import { Socket } from "node:net";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Probe a raw TCP port. A security-group DROP (no route in) surfaces as
 * `"timeout"`; a reachable-but-closed port answers with RST → `"refused"`; a
 * listener accepts → `"open"`. Used to prove an app node's inbound is firewalled.
 */
export function tcpProbe(
  host: string,
  port: number,
  timeoutMs = 6000,
): Promise<"open" | "refused" | "timeout"> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    const finish = (r: "open" | "refused" | "timeout"): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(r);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish("open"));
    socket.once("timeout", () => finish("timeout"));
    socket.once("error", (err: NodeJS.ErrnoException) =>
      finish(err.code === "ECONNREFUSED" ? "refused" : "timeout"),
    );
    socket.connect(port, host);
  });
}

export interface Sample {
  ok: boolean;
  status: number | null;
  body: string;
  error?: string;
}

async function once(url: string, timeoutMs: number): Promise<Sample> {
  try {
    // Node's fetch validates TLS by default — a successful https response here is
    // itself proof of a publicly-trusted (Let's Encrypt) certificate. Do NOT
    // disable verification.
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
  } catch (error) {
    return { ok: false, status: null, body: "", error: (error as Error).message };
  }
}

export interface PollResult {
  ok: boolean;
  body: string;
  attempts: number;
  lastError?: string;
}

/**
 * Poll an HTTPS URL until it returns 200 (with a valid public cert) and — if
 * given — a body containing `bodyIncludes`. Cert-not-ready / connection errors
 * are retried until the deadline. Returns the outcome (caller asserts).
 */
export async function pollHttps(
  url: string,
  opts: { timeoutMs: number; intervalMs?: number; reqTimeoutMs?: number; bodyIncludes?: string },
): Promise<PollResult> {
  const interval = opts.intervalMs ?? 5000;
  const reqTimeout = opts.reqTimeoutMs ?? 10_000;
  const deadline = Date.now() + opts.timeoutMs;
  let attempts = 0;
  let lastError: string | undefined;
  for (;;) {
    attempts += 1;
    const s = await once(url, reqTimeout);
    if (s.ok && (opts.bodyIncludes === undefined || s.body.includes(opts.bodyIncludes))) {
      return { ok: true, body: s.body, attempts };
    }
    lastError = s.error ?? `status ${s.status}${s.body ? `, body: ${s.body.slice(0, 120)}` : ""}`;
    if (Date.now() > deadline) return { ok: false, body: s.body, attempts, lastError };
    await sleep(interval);
  }
}

/**
 * Continuously hits a URL on an interval (used across a rolling deploy to detect
 * downtime). Records every sample; `stats()` summarizes failures and the set of
 * distinct response bodies seen.
 */
export class ZeroDowntimePoller {
  private running = false;
  private loop: Promise<void> | null = null;
  readonly samples: Sample[] = [];

  constructor(
    private readonly url: string,
    private readonly intervalMs = 250,
    private readonly reqTimeoutMs = 5000,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        const start = Date.now();
        this.samples.push(await once(this.url, this.reqTimeoutMs));
        const elapsed = Date.now() - start;
        if (this.running && elapsed < this.intervalMs) await sleep(this.intervalMs - elapsed);
      }
    })();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.loop) await this.loop;
  }

  stats(): {
    total: number;
    failures: number;
    failureRate: number;
    maxConsecutiveFailures: number;
  } {
    let failures = 0;
    let consecutive = 0;
    let maxConsecutive = 0;
    for (const s of this.samples) {
      if (s.ok) {
        consecutive = 0;
      } else {
        failures += 1;
        consecutive += 1;
        if (consecutive > maxConsecutive) maxConsecutive = consecutive;
      }
    }
    const total = this.samples.length;
    return {
      total,
      failures,
      failureRate: total === 0 ? 0 : failures / total,
      maxConsecutiveFailures: maxConsecutive,
    };
  }

  /** How many OK responses contained `marker`. */
  countWith(marker: string): number {
    return this.samples.filter((s) => s.ok && s.body.includes(marker)).length;
  }
}
