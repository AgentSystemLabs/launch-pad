/** Overview — the landing page: one health rollup for the nav cluster (node list +
 * per-node status fan-out + best-effort env count), an Attention list for anything
 * off-nominal, and quick links. Plain reload for freshness — no polling. */
import { HEARTBEAT_STALE_MS } from "@agentsystemlabs/launch-pad-shared";
import type { Handler } from "hono";
import { runLaunchPad } from "../cli-driver";
import { ErrorCard, errorMessage } from "../components/feedback";
import { ago, isHeartbeatStale } from "../format";
import {
  isBrokenNode,
  type EnvListJson,
  type NodeListEntry,
  type NodeListItem,
  type NodeListJson,
  type NodeStatus,
  type StatusJson,
  type ServiceStatus,
} from "../lp-types";
import { navCluster, lpOpts, pageResponse, type DashboardCtx } from "../render";

interface AttentionItem {
  label: string;
  detail: string;
  href: string;
}

function isRegistryNode(item: NodeListItem): item is NodeListEntry {
  return !isBrokenNode(item);
}

function Stat({ title, value, testid, alert }: { title: string; value: string; testid: string; alert?: boolean }) {
  return (
    <div class="stat" data-testid={testid}>
      <div class="stat-title">{title}</div>
      <div class={`stat-value text-2xl${alert ? " text-error" : ""}`}>{value}</div>
    </div>
  );
}

export function overviewPage(dctx: DashboardCtx): Handler {
  return async (c) => {
    const cluster = navCluster(dctx);
    const meta = { title: "Overview", cluster, active: "overview" as const };

    let nodes: NodeListJson;
    let statusByNode: Map<string, NodeStatus | null>;
    let envs: EnvListJson | null;
    try {
      nodes = await runLaunchPad<NodeListJson>(["node", "list"], lpOpts(dctx, cluster));
      const registered = nodes.filter(isRegistryNode);
      const [statuses, envList] = await Promise.all([
        Promise.all(
          registered.map((n) =>
            runLaunchPad<StatusJson>(["status", "--node", n.nodeId], lpOpts(dctx, cluster)).catch(
              () => [] as StatusJson,
            ),
          ),
        ),
        runLaunchPad<EnvListJson>(["destroy", "--list-envs"], lpOpts(dctx, cluster)).catch(() => null),
      ]);
      statusByNode = new Map(statuses.flat().map((e) => [e.node, e.status]));
      envs = envList;
    } catch (err) {
      return pageResponse(c, meta, <ErrorCard title="Couldn't load cluster overview" message={errorMessage(err)} />);
    }

    const now = Date.now();
    const registered = nodes.filter(isRegistryNode);
    const runningNodes = registered.filter((n) => (n.ec2State ?? n.state) === "running" || n.state === "ready");

    const services: Array<{ node: string; svc: ServiceStatus }> = [];
    for (const [node, status] of statusByNode) {
      for (const svc of status?.services ?? []) services.push({ node, svc });
    }
    const healthyServices = services.filter(({ svc }) => svc.state === "running");

    const staleNodes = registered.filter((n) => {
      const status = statusByNode.get(n.nodeId);
      return status != null && isHeartbeatStale(status.lastSeen, now, HEARTBEAT_STALE_MS);
    });

    const attention: AttentionItem[] = [];
    for (const n of nodes) {
      if (isBrokenNode(n)) {
        attention.push({
          label: `node ${n.nodeId}`,
          detail: n.status === "missing-registry" ? "missing node.json" : "node.json failed to parse",
          href: `/clusters/${cluster}/nodes`,
        });
      }
    }
    for (const n of staleNodes) {
      const status = statusByNode.get(n.nodeId);
      attention.push({
        label: `node ${n.nodeId}`,
        detail: `heartbeat stale (last seen ${ago(status?.lastSeen)})`,
        href: `/clusters/${cluster}/nodes/${n.nodeId}/monitor`,
      });
    }
    for (const { node, svc } of services) {
      const degraded = svc.state === "error" || svc.runningReplicas < svc.desiredReplicas;
      if (!degraded) continue;
      attention.push({
        label: `${svc.project}/${svc.service}`,
        detail: `${svc.state} · ${svc.runningReplicas}/${svc.desiredReplicas} replicas on ${node}`,
        href: `/clusters/${cluster}/logs/${svc.project}/${svc.service}`,
      });
    }

    return pageResponse(
      c,
      meta,
      <div class="space-y-6">
        <h1 class="text-xl font-semibold">Overview</h1>

        <div class="stats shadow bg-base-200 stats-vertical sm:stats-horizontal" data-testid="overview-stats">
          <Stat title="Nodes running" value={`${runningNodes.length}/${nodes.length}`} testid="stat-nodes" />
          <Stat
            title="Services healthy"
            value={`${healthyServices.length}/${services.length}`}
            testid="stat-services"
          />
          <Stat
            title="Stale heartbeats"
            value={String(staleNodes.length)}
            testid="stat-stale"
            alert={staleNodes.length > 0}
          />
          <Stat title="Environments" value={envs ? String(envs.envs.length) : "—"} testid="stat-envs" />
        </div>

        <section class="space-y-2" data-testid="attention">
          <h2 class="text-lg font-semibold">Attention</h2>
          {attention.length === 0 ? (
            <div class="text-center py-6 opacity-70" data-testid="attention-clear">
              <div class="text-lg font-medium">All healthy ✓</div>
              <div class="text-sm mt-1">No stale heartbeats or degraded services.</div>
            </div>
          ) : (
            <ul class="space-y-1" data-testid="attention-list">
              {attention.map((item) => (
                <li class="alert alert-warning py-2 flex flex-wrap items-center gap-2">
                  <a href={item.href} class="link link-hover font-mono font-semibold lp-focus-ring rounded-sm">
                    {item.label}
                  </a>
                  <span class="text-sm opacity-80">{item.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section class="flex flex-wrap gap-2" data-testid="quick-links">
          <a href="/clusters" class="btn btn-sm btn-outline lp-focus-ring">
            Clusters
          </a>
          <a href="/projects" class="btn btn-sm btn-outline lp-focus-ring">
            Projects
          </a>
          <a href={`/clusters/${cluster}/nodes`} class="btn btn-sm btn-outline lp-focus-ring">
            Nodes
          </a>
          <a href={`/clusters/${cluster}/services`} class="btn btn-sm btn-outline lp-focus-ring">
            Services
          </a>
          <a href={`/clusters/${cluster}/environments`} class="btn btn-sm btn-outline lp-focus-ring">
            Environments
          </a>
        </section>
      </div>,
    );
  };
}
