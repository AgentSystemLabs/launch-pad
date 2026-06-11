import {
  PROTOCOL_VERSION,
  configBaselineKey,
  desiredKey,
  edgeConfigKey,
  parseLaunchPadConfig,
  planUndeploy,
  snapshotConfigBaseline,
  type ServiceConfig,
} from "@agentsystemlabs/launch-pad-shared";
import { describe, expect, it } from "vitest";
import type { AwsEnv } from "../aws/context";
import type { NodeDesiredState } from "../deploy/deployed-footprint";
import { applyUndeploy, drained } from "./undeploy";

const OWNER = "shop";
const CLUSTER = "default";

function svc(project: string, service: string, patch: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    project,
    service,
    image: `123.dkr.ecr.us-east-1.amazonaws.com/${project}/${service}:sha`,
    cpu: 256,
    memory: 256,
    replicas: 1,
    env: {},
    secretRefs: [],
    ingress: null,
    healthCheck: null,
    rollout: { maxSurge: 1, drainTimeout: "20s", stopGrace: "30s" },
    volumes: [],
    ...patch,
  };
}

const webIngress = { domain: "shop.example.com", port: 3000, edge: "node-edge" };

/** A tiny in-memory S3 supporting the get/put/delete the undeploy applies (with CAS). */
class FakeS3 {
  private store = new Map<string, { body: string; etag: string }>();
  private counter = 0;
  /** PreconditionFailed-injection: keys that should fail the FIRST conditional put. */
  failOnceForKey = new Set<string>();

  constructor(initial: Record<string, unknown>) {
    for (const [key, value] of Object.entries(initial)) this.set(key, value);
  }

  private set(key: string, value: unknown): string {
    this.counter += 1;
    const etag = `"e${this.counter}"`;
    this.store.set(key, { body: JSON.stringify(value), etag });
    return etag;
  }

  get raw(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, { body }] of this.store) out[key] = JSON.parse(body);
    return out;
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async send(command: { constructor: { name: string }; input?: any }): Promise<unknown> {
    const kind = command.constructor.name;
    const input = command.input ?? {};
    if (kind === "GetObjectCommand") {
      const entry = this.store.get(input.Key as string);
      if (!entry) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
      return { Body: { transformToString: async () => entry.body }, ETag: entry.etag };
    }
    if (kind === "PutObjectCommand") {
      const key = input.Key as string;
      const existing = this.store.get(key);
      if (this.failOnceForKey.has(key)) {
        this.failOnceForKey.delete(key);
        throw Object.assign(new Error("PreconditionFailed"), { name: "PreconditionFailed" });
      }
      if (input.IfMatch && existing?.etag !== input.IfMatch) {
        throw Object.assign(new Error("PreconditionFailed"), { name: "PreconditionFailed" });
      }
      if (input.IfNoneMatch === "*" && existing) {
        throw Object.assign(new Error("PreconditionFailed"), { name: "PreconditionFailed" });
      }
      return { ETag: this.set(key, JSON.parse(input.Body as string)) };
    }
    if (kind === "DeleteObjectCommand") {
      const key = input.Key as string;
      if (this.failOnceForKey.has(key)) {
        this.failOnceForKey.delete(key);
        throw Object.assign(new Error("PreconditionFailed"), { name: "PreconditionFailed" });
      }
      if (input.IfMatch && this.store.get(key)?.etag !== input.IfMatch) {
        throw Object.assign(new Error("PreconditionFailed"), { name: "PreconditionFailed" });
      }
      this.store.delete(key);
      return {};
    }
    throw new Error(`unexpected S3 command ${kind}`);
  }
}

function makeAws(s3: FakeS3): AwsEnv {
  return { clusterId: CLUSTER, bucket: "bucket", s3 } as unknown as AwsEnv;
}

function desiredDoc(nodeId: string, services: ServiceConfig[]): unknown {
  return { version: PROTOCOL_VERSION, nodeId, updatedAt: "t", services };
}

function config(serviceNames: string[]): ReturnType<typeof parseLaunchPadConfig> {
  return parseLaunchPadConfig({
    project: OWNER,
    service: serviceNames.map((name) => ({
      name,
      node: "node-a",
      dockerfile: "./Dockerfile",
      context: ".",
      cpu: 256,
      memory: 256,
    })),
  });
}

describe("applyUndeploy — whole footprint", () => {
  it("drops only the footprint's services and clears the baseline", async () => {
    const states: NodeDesiredState[] = [
      { nodeId: "node-a", services: [svc(OWNER, "web", { ingress: webIngress }), svc("other", "api")] },
      { nodeId: "node-b", services: [svc(OWNER, "worker")] },
    ];
    const s3 = new FakeS3({
      [desiredKey(CLUSTER, "node-a")]: desiredDoc("node-a", states[0]!.services),
      [desiredKey(CLUSTER, "node-b")]: desiredDoc("node-b", states[1]!.services),
      [configBaselineKey(CLUSTER, OWNER)]: snapshotConfigBaseline(config(["web", "worker"]), "t"),
      [edgeConfigKey(CLUSTER, "node-edge")]: {
        nodeId: "node-edge",
        domains: ["shop.example.com", "kept.example.com"],
        updatedAt: "t",
      },
    });
    const plan = planUndeploy(states, OWNER, null);

    const result = await applyUndeploy(makeAws(s3), OWNER, null, plan);

    expect(result.baselineCleared).toBe(true);
    expect(new Set(result.nodes)).toEqual(new Set(["node-a", "node-b"]));
    // node-a keeps the other project's service; the footprint's web is gone.
    const nodeA = s3.raw[desiredKey(CLUSTER, "node-a")] as { services: ServiceConfig[] };
    expect(nodeA.services.map((s) => `${s.project}/${s.service}`)).toEqual(["other/api"]);
    const nodeB = s3.raw[desiredKey(CLUSTER, "node-b")] as { services: ServiceConfig[] };
    expect(nodeB.services).toEqual([]);
    // baseline file deleted.
    expect(s3.has(configBaselineKey(CLUSTER, OWNER))).toBe(false);
    // edge.json pruned of the now-unserved domain, keeping the unrelated one.
    const edge = s3.raw[edgeConfigKey(CLUSTER, "node-edge")] as { domains: string[] };
    expect(edge.domains).toEqual(["kept.example.com"]);
    expect(result.prunedEdges).toEqual(["node-edge"]);
  });
});

describe("applyUndeploy — single service", () => {
  it("removes one service, keeps the rest, and trims (not deletes) the baseline", async () => {
    const states: NodeDesiredState[] = [
      { nodeId: "node-a", services: [svc(OWNER, "web", { ingress: webIngress }), svc(OWNER, "worker")] },
    ];
    const s3 = new FakeS3({
      [desiredKey(CLUSTER, "node-a")]: desiredDoc("node-a", states[0]!.services),
      [configBaselineKey(CLUSTER, OWNER)]: snapshotConfigBaseline(config(["web", "worker"]), "t"),
    });
    const plan = planUndeploy(states, OWNER, ["worker"]);

    const result = await applyUndeploy(makeAws(s3), OWNER, ["worker"], plan);

    expect(result.removedServices).toEqual(["worker"]);
    expect(result.baselineCleared).toBe(false);
    const nodeA = s3.raw[desiredKey(CLUSTER, "node-a")] as { services: ServiceConfig[] };
    expect(nodeA.services.map((s) => s.service)).toEqual(["web"]);
    // baseline now lists only web (so a deploy without the worker block passes the lock).
    const baseline = s3.raw[configBaselineKey(CLUSTER, OWNER)] as { services: Array<{ name: string }> };
    expect(baseline.services.map((s) => s.name)).toEqual(["web"]);
    // worker had no ingress → no edge prune.
    expect(result.prunedEdges).toEqual([]);
  });

  it("deletes the baseline when the removed service was the last one", async () => {
    const states: NodeDesiredState[] = [{ nodeId: "node-a", services: [svc(OWNER, "web")] }];
    const s3 = new FakeS3({
      [desiredKey(CLUSTER, "node-a")]: desiredDoc("node-a", states[0]!.services),
      [configBaselineKey(CLUSTER, OWNER)]: snapshotConfigBaseline(config(["web"]), "t"),
    });
    const plan = planUndeploy(states, OWNER, ["web"]);

    const result = await applyUndeploy(makeAws(s3), OWNER, ["web"], plan);

    expect(result.baselineCleared).toBe(true);
    expect(s3.has(configBaselineKey(CLUSTER, OWNER))).toBe(false);
  });
});

describe("applyUndeploy — concurrency", () => {
  it("retries the desired.json write after a CAS conflict", async () => {
    const states: NodeDesiredState[] = [
      { nodeId: "node-a", services: [svc(OWNER, "web"), svc(OWNER, "worker")] },
    ];
    const s3 = new FakeS3({
      [desiredKey(CLUSTER, "node-a")]: desiredDoc("node-a", states[0]!.services),
    });
    // First conditional put loses the CAS; the retry re-reads and succeeds.
    s3.failOnceForKey.add(desiredKey(CLUSTER, "node-a"));
    const plan = planUndeploy(states, OWNER, ["worker"]);

    await applyUndeploy(makeAws(s3), OWNER, ["worker"], plan);

    const nodeA = s3.raw[desiredKey(CLUSTER, "node-a")] as { services: ServiceConfig[] };
    expect(nodeA.services.map((s) => s.service)).toEqual(["web"]);
  });

  it("retries the baseline trim after a CAS conflict (a racing deploy rewrote it)", async () => {
    const states: NodeDesiredState[] = [
      { nodeId: "node-a", services: [svc(OWNER, "web"), svc(OWNER, "worker")] },
    ];
    const s3 = new FakeS3({
      [desiredKey(CLUSTER, "node-a")]: desiredDoc("node-a", states[0]!.services),
      [configBaselineKey(CLUSTER, OWNER)]: snapshotConfigBaseline(config(["web", "worker"]), "t"),
    });
    s3.failOnceForKey.add(configBaselineKey(CLUSTER, OWNER));
    const plan = planUndeploy(states, OWNER, ["worker"]);

    await applyUndeploy(makeAws(s3), OWNER, ["worker"], plan);

    const baseline = s3.raw[configBaselineKey(CLUSTER, OWNER)] as { services: Array<{ name: string }> };
    expect(baseline.services.map((s) => s.name)).toEqual(["web"]);
  });

  it("does NOT delete the baseline on a whole-footprint undeploy when a deploy rewrote it concurrently", async () => {
    const states: NodeDesiredState[] = [{ nodeId: "node-a", services: [svc(OWNER, "web")] }];
    const s3 = new FakeS3({
      [desiredKey(CLUSTER, "node-a")]: desiredDoc("node-a", states[0]!.services),
      [configBaselineKey(CLUSTER, OWNER)]: snapshotConfigBaseline(config(["web"]), "t"),
    });
    // The conditional delete loses the CAS — a racing deploy re-recorded the baseline,
    // so undeploy must LEAVE it in place rather than unlock a now-live re-added footprint.
    s3.failOnceForKey.add(configBaselineKey(CLUSTER, OWNER));
    const plan = planUndeploy(states, OWNER, null);

    const result = await applyUndeploy(makeAws(s3), OWNER, null, plan);

    expect(result.baselineCleared).toBe(false);
    expect(s3.has(configBaselineKey(CLUSTER, OWNER))).toBe(true);
  });
});

describe("drained", () => {
  const runningReplica = {
    index: 0,
    containerId: "c",
    hostPort: null,
    state: "running",
    image: "i",
    healthy: true,
  };
  const svcStatus = (project: string, service: string, running: number): unknown => ({
    project,
    service,
    image: "i",
    state: running > 0 ? "running" : "stopped",
    updatedAt: "t",
    runningReplicas: running,
    replicas: running > 0 ? [runningReplica] : [],
  });
  const status = (services: unknown[]): unknown => ({
    nodeId: "node-a",
    agentId: "a",
    lastSeen: "t",
    agentVersion: "1",
    services,
    caddy: { managed: false, lastReloadAt: null, error: null },
  });

  it("is true when the removed service is gone from status", () => {
    const raw = status([svcStatus(OWNER, "web", 1)]);
    expect(drained(raw, OWNER, new Set(["worker"]))).toBe(true);
  });

  it("is false while the removed service still reports a running replica", () => {
    const raw = status([svcStatus(OWNER, "worker", 1)]);
    expect(drained(raw, OWNER, new Set(["worker"]))).toBe(false);
  });

  it("is true when the removed service reports zero running replicas", () => {
    const raw = status([svcStatus(OWNER, "worker", 0)]);
    expect(drained(raw, OWNER, new Set(["worker"]))).toBe(true);
  });

  it("ignores another project's identically-named service", () => {
    const raw = status([svcStatus("other", "worker", 1)]);
    expect(drained(raw, OWNER, new Set(["worker"]))).toBe(true);
  });

  it("returns false on an unparseable status (treat as not-yet-drained)", () => {
    expect(drained({ not: "valid" }, OWNER, new Set(["worker"]))).toBe(false);
  });
});
