#!/usr/bin/env node
/**
 * Fake `launch-pad` CLI for the dashboard e2e tests. The dashboard spawns this
 * instead of the real CLI (via LAUNCH_PAD_BIN — a `.mjs` path runs under node)
 * so Playwright can drive the whole read-only UI without AWS.
 *
 * It emits the same `--json` shapes the real CLI does (see
 * packages/cli/src/dashboard/lp-types.ts and the printJson call sites in
 * packages/cli/src/commands/*), persists to FAKE_LP_STATE so state is coherent
 * across the fresh process per invocation, and streams NDJSON for
 * `--watch` / `--follow`. Read commands only — the new dashboard never mutates.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

// ── arg parsing ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const positionals = [];
const flags = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  } else {
    positionals.push(a);
  }
}
const [c0, c1, c2] = positionals;

// ── state ────────────────────────────────────────────────────────────────────
const STATE_PATH = process.env.FAKE_LP_STATE || join(process.cwd(), ".fake-lp-state.json");

const HOUR = 3_600_000;

function defaultState() {
  const now = Date.now();
  return {
    clusters: [
      { clusterId: "default", region: "us-east-1", source: "implicit" },
      { clusterId: "prod", region: "us-east-1", source: "both" },
    ],
    defaultCluster: "prod",
    nodes: [seedNode("web-1", "prod", "app"), seedNode("edge-1", "prod", "edge")],
    services: {
      "web-1": [
        {
          project: "shop",
          service: "api",
          image: "1234.dkr.ecr/shop/api:abc123",
          cpu: 512,
          memory: 512,
          replicas: 2,
          env: { NODE_ENV: "production", LOG_LEVEL: "info" },
        },
        {
          project: "shop",
          service: "worker",
          image: "1234.dkr.ecr/shop/worker:abc123",
          cpu: 256,
          memory: 256,
          replicas: 1,
          env: {},
        },
      ],
    },
    // `destroy --list-envs` markers: shared PreviewMarker & { expired } (preview.ts)
    envs: [
      {
        version: 1,
        project: "shop",
        env: "staging",
        owner: "shop-staging",
        createdAt: new Date(now - 48 * HOUR).toISOString(),
        updatedAt: new Date(now - 2 * HOUR).toISOString(),
        expiresAt: null,
        domains: ["staging.shop.example.com"],
        expired: false,
      },
      {
        version: 1,
        project: "shop",
        env: "pr-42",
        owner: "shop-pr-42",
        createdAt: new Date(now - 96 * HOUR).toISOString(),
        updatedAt: new Date(now - 80 * HOUR).toISOString(),
        expiresAt: new Date(now - 8 * HOUR).toISOString(),
        domains: ["pr-42.shop.example.com"],
        expired: true,
      },
    ],
    // `history` events: shared DeployEvent (events.ts), newest first
    history: {
      project: "shop",
      events: [
        {
          version: 1,
          at: new Date(now - 1 * HOUR).toISOString(),
          by: "arn:aws:iam::111122223333:user/tester",
          cluster: "prod",
          project: "shop",
          env: null,
          kind: "restart",
          services: [{ service: "api", image: "1234.dkr.ecr/shop/api:abc123", replicas: 2 }],
          converged: true,
        },
        {
          version: 1,
          at: new Date(now - 12 * HOUR).toISOString(),
          by: "arn:aws:iam::111122223333:user/tester",
          cluster: "prod",
          project: "shop",
          env: null,
          kind: "build",
          services: [
            { service: "api", image: "1234.dkr.ecr/shop/api:abc123", replicas: 2 },
            { service: "worker", image: "1234.dkr.ecr/shop/worker:abc123", replicas: 1 },
          ],
          converged: true,
        },
        {
          version: 1,
          at: new Date(now - 36 * HOUR).toISOString(),
          by: "arn:aws:iam::111122223333:user/tester",
          cluster: "prod",
          project: "shop",
          env: null,
          kind: "build",
          services: [
            { service: "api", image: "1234.dkr.ecr/shop/api:9f8e7d6", replicas: 2 },
            { service: "worker", image: "1234.dkr.ecr/shop/worker:9f8e7d6", replicas: 1 },
          ],
          converged: false,
        },
      ],
    },
  };
}

function seedNode(nodeId, clusterId, role) {
  return {
    nodeId,
    clusterId,
    instanceId: `i-${nodeId}0000`,
    instanceType: role === "edge" ? "t3.nano" : "t3.small",
    region: "us-east-1",
    availabilityZone: "us-east-1a",
    role,
    privateIp: "10.0.0.10",
    totalCpu: 2048,
    totalMemory: 1900,
    reservedCpu: 256,
    reservedMemory: 256,
    publicIp: role === "app" ? null : "203.0.113.10",
    eipAllocationId: role === "app" ? null : "eipalloc-1",
    securityGroupId: "sg-1",
    iamInstanceProfile: "launch-pad-node",
    agentId: `agent-${nodeId}`,
    agentVersion: "0.1.0",
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    createdBy: "tester",
    state: "ready",
    ec2State: "running",
    drift: "none",
  };
}

function loadState() {
  if (!existsSync(STATE_PATH)) {
    const s = defaultState();
    saveState(s);
    return s;
  }
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return defaultState();
  }
}
function saveState(s) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

// ── output helpers ────────────────────────────────────────────────────────────
// A stream consumer closing our stdout (EPIPE) means "done" — exit quietly.
process.stdout.on("error", (err) => {
  if (err && err.code === "EPIPE") process.exit(0);
  throw err;
});

function out(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}
function ndjson(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}
function fail(message, code = 1) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(code);
}

const state = loadState();
const cluster = (typeof flags.cluster === "string" && flags.cluster) || state.defaultCluster || "default";

// ── shapes ────────────────────────────────────────────────────────────────────
function nodesIn(clusterId) {
  return state.nodes.filter((n) => n.clusterId === clusterId);
}

/** One `node list --json` entry: registry + live EC2 annotations + footprints. */
function nodeListEntry(node) {
  return {
    ...node,
    ec2State: node.ec2State ?? "running",
    drift: node.drift ?? "none",
    services: (state.services[node.nodeId] ?? []).map((s) => ({
      project: s.project,
      service: s.service,
      replicas: s.replicas,
      cron: false,
    })),
  };
}

function statusForNode(nodeId) {
  const desired = state.services[nodeId] ?? [];
  return {
    nodeId,
    agentId: `agent-${nodeId}`,
    lastSeen: new Date().toISOString(),
    agentVersion: "0.1.0",
    services: desired.map((s) => ({
      project: s.project,
      service: s.service,
      image: s.image,
      state: "running",
      message: "",
      containerId: "deadbeef",
      replicas: Array.from({ length: s.replicas }, (_, i) => ({
        index: i,
        containerId: `c-${s.service}-${i}`,
        hostPort: 30000 + i,
        state: "running",
        image: s.image,
        healthy: true,
      })),
      desiredReplicas: s.replicas,
      runningReplicas: s.replicas,
      updatedAt: new Date().toISOString(),
    })),
    caddy: { configured: true, lastReloadAt: new Date().toISOString(), lastError: null },
    edgeRoutes: [],
  };
}

/** One `node monitor --watch` NDJSON sample (StatsLine & { epochMillis }). */
function sample(nodeId, n) {
  const base = 20 + (n % 5) * 8;
  const desired = state.services[nodeId] ?? [];
  return {
    event: "launchpad.stats",
    nodeId,
    ts: new Date().toISOString(),
    epochMillis: Date.now(),
    host: {
      cpuPercent: base + Math.round(Math.random() * 15),
      memoryUsedMb: 700 + Math.round(Math.random() * 300),
      memoryTotalMb: 1900,
    },
    services: desired.flatMap((s) =>
      Array.from({ length: s.replicas }, (_, r) => ({
        project: s.project,
        service: s.service,
        replica: r,
        cpuPercent: 10 + Math.round(Math.random() * 40),
        memoryUsedMb: 80 + Math.round(Math.random() * 120),
        memoryLimitMb: s.memory,
      })),
    ),
  };
}

function logEvent(nodeId, service, n) {
  return {
    timestamp: new Date().toISOString(),
    epochMillis: Date.now(),
    node: nodeId,
    replica: n % 2,
    stream: `${nodeId}/${n % 2}`,
    message: `[${service}] request ${n} handled in ${10 + (n % 20)}ms`,
  };
}

async function streamForever(emit, intervalMs = 400) {
  let n = 0;
  emit(n++);
  const stop = () => process.exit(0);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  // keep the process alive emitting lines until killed
  for (;;) {
    await new Promise((r) => setTimeout(r, intervalMs));
    emit(n++);
  }
}

// ── command dispatch ─────────────────────────────────────────────────────────
switch (`${c0} ${c1}`) {
  case "cluster list": {
    out({
      defaultCluster: state.defaultCluster,
      clusters: state.clusters.map((c) => ({
        clusterId: c.clusterId,
        region: c.region,
        source: c.source,
      })),
    });
    break;
  }
  case "node list": {
    out(nodesIn(cluster).map(nodeListEntry));
    break;
  }
  case "node show": {
    const name = c2 ?? fail("node name required");
    const node = state.nodes.find((n) => n.nodeId === name && n.clusterId === cluster);
    if (!node) fail(`node "${name}" not found`);
    const desired = state.services[name] ?? [];
    out({
      node,
      ec2: { state: node.ec2State ?? "running", drift: node.drift },
      desired: JSON.stringify({ nodeId: name, services: desired, updatedAt: new Date().toISOString() }),
      status: JSON.stringify(statusForNode(name)),
    });
    break;
  }
  case "node monitor": {
    const name = c2 ?? fail("node name required");
    if (flags.watch) {
      await streamForever((n) => ndjson(sample(name, n)));
    } else {
      // historic one-shot (`--since <window>`)
      const samples = Array.from({ length: 12 }, (_, i) => sample(name, i));
      out({ node: name, cluster, window: (typeof flags.since === "string" && flags.since) || "15m", samples });
    }
    break;
  }
  default:
    // Single-word commands (status/logs/destroy/history) land here.
    handleSingle();
}

function handleSingle() {
  switch (c0) {
    case "status": {
      const nodeId = typeof flags.node === "string" ? flags.node : undefined;
      const ids = nodeId ? [nodeId] : nodesIn(cluster).map((n) => n.nodeId);
      out(ids.map((id) => ({ node: id, status: statusForNode(id) })));
      break;
    }
    case "logs": {
      const service = c1 ?? fail("service required");
      const nodeId = nodesIn(cluster).find((n) => n.role === "app")?.nodeId ?? "web-1";
      if (flags.follow) {
        void streamForever((n) => ndjson(logEvent(nodeId, service, n)));
      } else {
        out({
          logGroup: `/launch-pad/${cluster}/shop/${service}`,
          events: Array.from({ length: 20 }, (_, i) => logEvent(nodeId, service, i)),
        });
      }
      break;
    }
    case "destroy": {
      if (!flags["list-envs"]) fail("fake-cli: destroy supports only --list-envs (read-only dashboard)");
      out({ envs: state.envs ?? [] });
      break;
    }
    case "history": {
      out(state.history ?? { project: "shop", events: [] });
      break;
    }
    default:
      fail(`fake-cli: unhandled command "${positionals.join(" ")}"`);
  }
}
