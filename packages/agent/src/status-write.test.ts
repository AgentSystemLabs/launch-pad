import { describe, expect, it } from "vitest";
import type { NodeStatus, ReplicaStatus, UpstreamShard } from "@agentsystemlabs/launch-pad-shared";
import {
  createStatusWriter,
  decideStatusWrite,
  fingerprintShard,
  fingerprintStatus,
  resolveLiveness,
} from "./status-write";

function replica(over: Partial<ReplicaStatus> = {}): ReplicaStatus {
  return {
    index: 0,
    containerId: "c0",
    hostPort: 20000,
    state: "running",
    image: "img:1",
    healthy: true,
    ...over,
  };
}

function status(over: Partial<NodeStatus> = {}): NodeStatus {
  return {
    nodeId: "app-1",
    agentId: "agent-1",
    lastSeen: "2026-06-04T00:00:00.000Z",
    agentVersion: "1.0.0",
    services: [
      {
        project: "blog",
        service: "web",
        image: "img:1",
        state: "running",
        message: "running",
        containerId: "c0",
        replicas: [replica()],
        desiredReplicas: 1,
        runningReplicas: 1,
        updatedAt: "2026-06-04T00:00:00.000Z",
      },
    ],
    caddy: { managed: true, lastReloadAt: "2026-06-04T00:00:00.000Z", error: null },
    edgeRoutes: [],
    ...over,
  };
}

function shard(over: Partial<UpstreamShard> = {}): UpstreamShard {
  return {
    nodeId: "app-1",
    privateIp: "10.0.1.5",
    updatedAt: "2026-06-04T00:00:00.000Z",
    backends: [{ domain: "app.example.com", hostPort: 20001, healthPath: "/health" }],
    ...over,
  };
}

describe("fingerprintStatus", () => {
  it("ignores lastSeen, per-service updatedAt and caddy.lastReloadAt", () => {
    const a = status();
    const b = status({
      lastSeen: "2026-06-04T01:23:45.000Z",
      caddy: { managed: true, lastReloadAt: "2026-06-04T09:99:99.000Z", error: null },
      services: [{ ...status().services[0]!, updatedAt: "2026-06-04T05:05:05.000Z" }],
    });
    expect(fingerprintStatus(a)).toBe(fingerprintStatus(b));
  });

  it("changes when a replica image changes", () => {
    const a = status();
    const b = status({
      services: [{ ...status().services[0]!, replicas: [replica({ image: "img:2" })] }],
    });
    expect(fingerprintStatus(a)).not.toBe(fingerprintStatus(b));
  });

  it("changes when a replica state changes", () => {
    const a = status();
    const b = status({
      services: [{ ...status().services[0]!, replicas: [replica({ state: "stopped", healthy: false })] }],
    });
    expect(fingerprintStatus(a)).not.toBe(fingerprintStatus(b));
  });

  it("changes when an error message appears", () => {
    const a = status();
    const b = status({
      services: [{ ...status().services[0]!, state: "error", message: "boom" }],
    });
    expect(fingerprintStatus(a)).not.toBe(fingerprintStatus(b));
  });

  it("is stable under replica reordering", () => {
    const ordered = status({
      services: [
        {
          ...status().services[0]!,
          replicas: [replica({ index: 0 }), replica({ index: 1, containerId: "c1", hostPort: 20001 })],
        },
      ],
    });
    const reversed = status({
      services: [
        {
          ...status().services[0]!,
          replicas: [replica({ index: 1, containerId: "c1", hostPort: 20001 }), replica({ index: 0 })],
        },
      ],
    });
    expect(fingerprintStatus(ordered)).toBe(fingerprintStatus(reversed));
  });

  it("changes when edge route counts change", () => {
    const a = status({ services: [], edgeRoutes: [{ domain: "a.com", upstreams: 1 }] });
    const b = status({ services: [], edgeRoutes: [{ domain: "a.com", upstreams: 2 }] });
    expect(fingerprintStatus(a)).not.toBe(fingerprintStatus(b));
  });
});

describe("decideStatusWrite", () => {
  const fp = "abc";

  it("writes on the first tick (no prior fingerprint)", () => {
    expect(decideStatusWrite({ fingerprint: null, lastWriteMs: 0 }, fp, 1_000, 30_000)).toEqual({
      write: true,
      reason: "first",
    });
  });

  it("writes when the fingerprint changes", () => {
    expect(decideStatusWrite({ fingerprint: "old", lastWriteMs: 1_000 }, fp, 2_000, 30_000)).toEqual({
      write: true,
      reason: "changed",
    });
  });

  it("skips when stable and liveness is not due", () => {
    expect(decideStatusWrite({ fingerprint: fp, lastWriteMs: 1_000 }, fp, 10_000, 30_000)).toEqual({
      write: false,
      reason: "skip",
    });
  });

  it("writes a liveness heartbeat when stable but the interval has elapsed", () => {
    expect(decideStatusWrite({ fingerprint: fp, lastWriteMs: 1_000 }, fp, 31_000, 30_000)).toEqual({
      write: true,
      reason: "liveness",
    });
  });
});

describe("createStatusWriter", () => {
  it("writes once, then skips an unchanged status until liveness is due", async () => {
    const writer = createStatusWriter(30_000);
    const writes: NodeStatus[] = [];
    const put = async (s: NodeStatus): Promise<void> => {
      writes.push(s);
    };

    expect(await writer.maybeWrite(status(), 0, put)).toBe("first");
    expect(await writer.maybeWrite(status({ lastSeen: "x" }), 10_000, put)).toBe("skip");
    expect(await writer.maybeWrite(status({ lastSeen: "y" }), 20_000, put)).toBe("skip");
    expect(await writer.maybeWrite(status({ lastSeen: "z" }), 30_000, put)).toBe("liveness");
    expect(writes).toHaveLength(2);
  });

  it("writes immediately when content changes before liveness is due", async () => {
    const writer = createStatusWriter(30_000);
    const writes: NodeStatus[] = [];
    const put = async (s: NodeStatus): Promise<void> => {
      writes.push(s);
    };

    await writer.maybeWrite(status(), 0, put);
    const changed = status({
      services: [{ ...status().services[0]!, replicas: [replica({ image: "img:2" })] }],
    });
    expect(await writer.maybeWrite(changed, 5_000, put)).toBe("changed");
    expect(writes).toHaveLength(2);
  });

  it("forceWrite always PUTs (rollout heartbeat) and refreshes the tracker", async () => {
    const writer = createStatusWriter(30_000);
    let count = 0;
    const put = async (): Promise<void> => {
      count += 1;
    };

    // Two identical statuses a second apart: forceWrite must PUT both.
    await writer.forceWrite(status(), 0, put);
    await writer.forceWrite(status({ lastSeen: "x" }), 1_000, put);
    expect(count).toBe(2);

    // After a forced write the tracker is current, so an unchanged maybeWrite skips.
    expect(await writer.maybeWrite(status({ lastSeen: "y" }), 2_000, put)).toBe("skip");
    expect(count).toBe(2);
  });
});

describe("fingerprintShard", () => {
  it("ignores updatedAt", () => {
    expect(fingerprintShard(shard())).toBe(fingerprintShard(shard({ updatedAt: "later" })));
  });

  it("changes when a backend host port changes", () => {
    const a = shard();
    const b = shard({ backends: [{ domain: "app.example.com", hostPort: 20009, healthPath: "/health" }] });
    expect(fingerprintShard(a)).not.toBe(fingerprintShard(b));
  });

  it("changes when the private IP changes (node replaced)", () => {
    expect(fingerprintShard(shard())).not.toBe(fingerprintShard(shard({ privateIp: "10.0.9.9" })));
  });

  it("is stable under backend reordering", () => {
    const a = shard({
      backends: [
        { domain: "a.com", hostPort: 1 },
        { domain: "b.com", hostPort: 2 },
      ],
    });
    const b = shard({
      backends: [
        { domain: "b.com", hostPort: 2 },
        { domain: "a.com", hostPort: 1 },
      ],
    });
    expect(fingerprintShard(a)).toBe(fingerprintShard(b));
  });
});

describe("resolveLiveness", () => {
  it("keeps a sane default under the stale window", () => {
    const r = resolveLiveness({ livenessMs: 30_000, pollMs: 10_000, staleMs: 60_000 });
    expect(r.livenessMs).toBe(30_000);
    expect(r.warnings).toHaveLength(0);
  });

  it("clamps a liveness that exceeds half the stale window", () => {
    const r = resolveLiveness({ livenessMs: 90_000, pollMs: 10_000, staleMs: 60_000 });
    expect(r.livenessMs).toBe(30_000);
    expect(r.warnings.some((w) => w.includes("clamping"))).toBe(true);
  });

  it("warns when the poll interval is at/above the stale window", () => {
    const r = resolveLiveness({ livenessMs: 30_000, pollMs: 60_000, staleMs: 60_000 });
    expect(r.warnings.some((w) => w.includes("LAUNCHPAD_POLL_MS"))).toBe(true);
  });

  it("repairs an invalid liveness value", () => {
    const r = resolveLiveness({ livenessMs: Number.NaN, pollMs: 10_000, staleMs: 60_000 });
    expect(r.livenessMs).toBe(30_000);
    expect(r.warnings.some((w) => w.includes("invalid"))).toBe(true);
  });
});
