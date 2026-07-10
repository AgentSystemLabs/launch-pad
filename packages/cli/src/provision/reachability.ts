import type { NodeRegistryEntry, NodeStatus } from "@agentsystemlabs/launch-pad-shared";
import { HOST_PORT_MIN } from "@agentsystemlabs/launch-pad-shared";
import type { AwsEnv } from "../aws/context";
import { isIpv4 } from "../dns/classify";
import { CliError } from "../errors";
import { runShellScriptOnInstances } from "../aws/run-command";

export interface ReachabilityTarget {
  nodeId: string;
  advertiseIp: string;
  ports: number[];
}

export interface ReachabilityResult {
  nodeId: string;
  advertiseIp: string;
  ports: number[];
  ok: boolean;
  detail: string;
}

export const REACHABILITY_SAMPLE_PORT = HOST_PORT_MIN;

export function renderTemporaryListenerScript(port = REACHABILITY_SAMPLE_PORT): string {
  return `python3 - <<'PY' >/tmp/launch-pad-reachability-${port}.log 2>&1 &
import socket
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("0.0.0.0", ${port}))
s.listen(1)
s.settimeout(45)
try:
    conn, _ = s.accept()
    conn.close()
finally:
    s.close()
PY
sleep 1
`;
}

export function renderEdgeProbeScript(targets: ReachabilityTarget[]): string[] {
  const lines = [
    "set -u",
    "fail=0",
  ];
  for (const target of targets) {
    // SECURITY: advertiseIp is interpolated into a `bash -lc '...'` command run on the
    // edge node via SSM. `shellQuote` alone is NOT sufficient here — its wrapping quotes
    // are nested inside the already single-quoted `-lc` argument, so a leading quote
    // toggles out of that context and turns the value into executable shell
    // (e.g. `$(...)`, `;`). Only accept a strict dotted-quad IPv4, which cannot contain
    // any shell metacharacter, before it ever reaches the script. `--advertise-ip` and
    // the persisted node registry are otherwise unvalidated on this path.
    if (!isIpv4(target.advertiseIp)) {
      throw new CliError(`refusing to probe node "${target.nodeId}": advertiseIp "${target.advertiseIp}" is not a valid IPv4 address`, {
        hint: "re-run `launchpad node init` with a valid --advertise-ip (dotted-quad, e.g. 10.0.1.50)",
      });
    }
    for (const port of target.ports) {
      // `port` is a number from the schema; `advertiseIp` is validated above — both are
      // now safe to interpolate. The label reuses the same validated values.
      const label = `${target.nodeId} ${target.advertiseIp}:${port}`;
      lines.push(
        `if timeout 5 bash -lc '</dev/tcp/${target.advertiseIp}/${port}' 2>/dev/null; then`,
        `  echo "OK ${label}"`,
        "else",
        `  echo "FAIL ${label}"`,
        "  fail=1",
        "fi",
      );
    }
  }
  lines.push("exit $fail");
  return [lines.join("\n")];
}

export function probePortsFromStatus(status: NodeStatus | null): number[] {
  if (!status) return [];
  const ports = new Set<number>();
  for (const service of status.services) {
    for (const replica of service.replicas) {
      if (replica.hostPort !== null && replica.state === "running") ports.add(replica.hostPort);
    }
  }
  return [...ports].sort((a, b) => a - b);
}

export async function probeEdgeReachability(
  aws: AwsEnv,
  edge: NodeRegistryEntry,
  targets: ReachabilityTarget[],
): Promise<ReachabilityResult[]> {
  if (!edge.instanceId) {
    return targets.map((target) => ({
      nodeId: target.nodeId,
      advertiseIp: target.advertiseIp,
      ports: target.ports,
      ok: false,
      detail: "edge has no EC2 instance for SSM probing",
    }));
  }
  if (targets.length === 0) return [];
  const outcomes = await runShellScriptOnInstances(
    aws.ssm,
    [edge.instanceId],
    renderEdgeProbeScript(targets),
    60_000,
  );
  const outcome = outcomes[0];
  if (!outcome) throw new Error("SSM returned no edge probe result");
  const output = `${outcome.stdout}\n${outcome.stderr}`.trim();
  return targets.map((target) => {
    const failed = target.ports.filter((port) =>
      output.includes(`FAIL ${target.nodeId} ${target.advertiseIp}:${port}`),
    );
    const ok = outcome.status === "Success" && failed.length === 0;
    return {
      nodeId: target.nodeId,
      advertiseIp: target.advertiseIp,
      ports: target.ports,
      ok,
      detail: ok ? "reachable from edge" : `unreachable port(s): ${failed.join(", ") || target.ports.join(", ")}`,
    };
  });
}
