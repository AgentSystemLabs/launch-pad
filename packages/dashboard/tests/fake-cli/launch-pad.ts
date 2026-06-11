#!/usr/bin/env bun
/**
 * Fake `launch-pad` CLI for e2e tests. The dashboard spawns this instead of the
 * real CLI (via LAUNCH_PAD_BIN) so Playwright can drive the whole UI without AWS.
 *
 * It emits the same `--json` shapes the real CLI does (see packages/cli/src/commands/*),
 * persists mutations to FAKE_LP_STATE so create/destroy/list flows are coherent across
 * the fresh process per invocation, and streams NDJSON for `--watch` / `--follow`.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

// ── arg parsing ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const positionals: string[] = [];
const flags: Record<string, string | boolean> = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i] as string;
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
interface FNode {
  nodeId: string;
  clusterId: string;
  instanceId: string | null;
  instanceType: string;
  region: string;
  availabilityZone: string | null;
  role: string;
  privateIp: string | null;
  totalCpu: number;
  totalMemory: number;
  reservedCpu: number;
  reservedMemory: number;
  publicIp: string | null;
  eipAllocationId: string | null;
  securityGroupId: string | null;
  iamInstanceProfile: string | null;
  agentId: string;
  agentVersion: string | null;
  createdAt: string;
  createdBy: string;
  state: string;
  ec2State: string | null;
  drift: string;
}
interface FService {
  project: string;
  service: string;
  image: string;
  cpu: number;
  memory: number;
  replicas: number;
  env: Record<string, string>;
}
interface FState {
  clusters: Array<{ clusterId: string; region: string | null; source: string }>;
  defaultCluster: string | null;
  nodes: FNode[];
  services: Record<string, FService[]>; // keyed by nodeId (desired)
}

const STATE_PATH = process.env.FAKE_LP_STATE || join(process.cwd(), ".fake-lp-state.json");

function defaultState(): FState {
  return {
    clusters: [
      { clusterId: "default", region: "us-east-1", source: "s3" },
      { clusterId: "prod", region: "us-east-1", source: "both" },
    ],
    defaultCluster: "prod",
    nodes: [seedNode("web-1", "prod", "both"), seedNode("edge-1", "prod", "edge")],
    services: {
      "web-1": [
        {
          project: "shop",
          service: "api",
          image: "1234.dkr.ecr/shop-api:abc123",
          cpu: 512,
          memory: 512,
          replicas: 2,
          env: { NODE_ENV: "production", LOG_LEVEL: "info" },
        },
        {
          project: "shop",
          service: "worker",
          image: "1234.dkr.ecr/shop-worker:abc123",
          cpu: 256,
          memory: 256,
          replicas: 1,
          env: {},
        },
      ],
    },
  };
}

function seedNode(nodeId: string, clusterId: string, role: string): FNode {
  return {
    nodeId,
    clusterId,
    instanceId: `i-${nodeId}0000`,
    instanceType: "t3.small",
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

function loadState(): FState {
  if (!existsSync(STATE_PATH)) {
    const s = defaultState();
    saveState(s);
    return s;
  }
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8")) as FState;
  } catch {
    return defaultState();
  }
}
function saveState(s: FState): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

// ── output helpers ────────────────────────────────────────────────────────────
function out(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}
function ndjson(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}
function fail(message: string, code = 1): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(code);
}

const state = loadState();
const cluster = (flags.cluster as string) || state.defaultCluster || "default";

// ── command dispatch ────────────────────────────────────────────────────────────
function nodesIn(clusterId: string): FNode[] {
  return state.nodes.filter((n) => n.clusterId === clusterId);
}

function statusForNode(nodeId: string) {
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

function sample(nodeId: string, n: number) {
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

function logEvent(nodeId: string, service: string, n: number) {
  return {
    timestamp: new Date().toISOString(),
    epochMillis: Date.now(),
    node: nodeId,
    replica: n % 2,
    stream: `${nodeId}/${n % 2}`,
    message: `[${service}] request ${n} handled in ${10 + (n % 20)}ms`,
  };
}

async function streamForever(emit: (n: number) => void, intervalMs = 400): Promise<void> {
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
  case "cluster create": {
    const name = c2 ?? fail("cluster name required");
    if (!state.clusters.some((c) => c.clusterId === name)) {
      state.clusters.push({
        clusterId: name,
        region: (flags.region as string) ?? "us-east-1",
        source: "both",
      });
      saveState(state);
    }
    out({ cluster: { clusterId: name }, account: "111122223333", bucket: `launch-pad-state-${name}` });
    break;
  }
  case "cluster destroy": {
    const name = c2 ?? fail("cluster name required");
    const destroyed = nodesIn(name).map((n) => n.nodeId);
    state.clusters = state.clusters.filter((c) => c.clusterId !== name);
    state.nodes = state.nodes.filter((n) => n.clusterId !== name);
    if (state.defaultCluster === name) state.defaultCluster = null;
    saveState(state);
    out({ cluster: name, destroyed, warnings: [] });
    break;
  }
  case "cluster show": {
    const name = c2 ?? cluster;
    out({
      cluster: { clusterId: name, defaultEdge: nodesIn(name).find((n) => n.role !== "app")?.nodeId ?? null },
      account: "111122223333",
      region: "us-east-1",
      nodes: nodesIn(name),
    });
    break;
  }
  case "node list": {
    out(nodesIn(cluster));
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
  case "node create": {
    const name = c2 ?? fail("node name required");
    if (!state.nodes.some((n) => n.nodeId === name && n.clusterId === cluster)) {
      const node = seedNode(name, cluster, (flags.role as string) || "both");
      if (flags["instance-type"]) node.instanceType = flags["instance-type"] as string;
      state.nodes.push(node);
      saveState(state);
    }
    out(state.nodes.find((n) => n.nodeId === name));
    break;
  }
  case "node destroy": {
    const names = positionals.slice(2);
    state.nodes = state.nodes.filter((n) => !(names.includes(n.nodeId) && n.clusterId === cluster));
    saveState(state);
    out({ destroyed: names, warnings: [] });
    break;
  }
  case "node pause": {
    const name = c2 ?? fail("node name required");
    const node = state.nodes.find((n) => n.nodeId === name && n.clusterId === cluster);
    if (node) {
      node.state = "stopped";
      node.ec2State = "stopped";
      saveState(state);
    }
    out({ paused: name });
    break;
  }
  case "node resume": {
    const name = c2 ?? fail("node name required");
    const node = state.nodes.find((n) => n.nodeId === name && n.clusterId === cluster);
    if (node) {
      node.state = "ready";
      node.ec2State = "running";
      saveState(state);
    }
    out({ resumed: name });
    break;
  }
  case "node resize": {
    const name = c2 ?? fail("node name required");
    const node = state.nodes.find((n) => n.nodeId === name && n.clusterId === cluster);
    if (node && flags["instance-type"]) {
      node.instanceType = flags["instance-type"] as string;
      saveState(state);
    }
    out({ resized: name, instanceType: node?.instanceType });
    break;
  }
  case "node monitor": {
    const name = c2 ?? fail("node name required");
    if (flags.watch) {
      await streamForever((n) => ndjson(sample(name, n)));
    } else {
      const samples = Array.from({ length: 12 }, (_, i) => sample(name, i));
      out({ node: name, cluster, window: (flags.window as string) ?? "5m", samples });
    }
    break;
  }
  default:
    // Single-word commands (status/logs/deploy/init) land here.
    handleSingle();
}

function handleSingle(): void {
  switch (c0) {
    case "status": {
      const nodeId = (flags.node as string) || nodesIn(cluster)[0]?.nodeId;
      const ids = nodeId ? [nodeId] : nodesIn(cluster).map((n) => n.nodeId);
      out(ids.map((id) => ({ node: id, status: statusForNode(id) })));
      break;
    }
    case "logs": {
      const service = c1 ?? fail("service required");
      const nodeId = nodesIn(cluster)[0]?.nodeId ?? "web-1";
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
    case "deploy": {
      out({
        converged: true,
        services: (state.services["web-1"] ?? []).map((s) => ({
          nodeId: "web-1",
          project: s.project,
          service: s.service,
          image: s.image,
          state: "running",
          ok: true,
        })),
      });
      break;
    }
    case "init": {
      const name = (flags.name as string) ?? "app";
      const port = (flags.port as string) ?? "3000";
      const cpu = (flags.cpu as string) ?? "512";
      const memory = (flags.memory as string) ?? "512";
      const domainLine = flags.domain ? `domain = "${flags.domain}"\n` : "";
      const toml =
        `project = "${name}"\n\n` +
        `[[service]]\n` +
        `name = "${name}"\n` +
        `port = ${port}\n` +
        domainLine +
        `cpu = ${cpu}\n` +
        `memory = ${memory}\n` +
        `env = { NODE_ENV = "production" }\n`;
      const tomlPath = join(process.cwd(), "launch-pad.toml");
      writeFileSync(tomlPath, toml);
      out({ path: tomlPath, project: name, service: name });
      break;
    }
    default:
      fail(`fake-cli: unhandled command "${positionals.join(" ")}"`);
  }
}
