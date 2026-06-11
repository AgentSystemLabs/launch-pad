import { execa } from "execa";
import {
  LABELS,
  serviceConfigStamp,
  type ServiceConfig,
  serviceKey,
} from "@agentsystemlabs/launch-pad-shared";
import { resolveServiceEnv } from "./secrets";

export interface ManagedReplica {
  id: string;
  name: string;
  index: number;
  /** docker container state: running | exited | created | ... */
  state: string;
  project: string;
  service: string;
  /** The desired image recorded on the container (launchpad.image label). */
  image: string;
  /** vCPU shares (1024 = 1 vCPU) from launchpad.cpu label. */
  cpu: number;
  /** Memory limit in MB from launchpad.memory label. */
  memory: number;
  /** Published host port (null for workers / unpublished). */
  hostPort: number | null;
  /** Fingerprint of env + secretRefs + restartAt at container create time. */
  configStamp: string;
}

export function containerName(project: string, service: string, index: number): string {
  return `launchpad_${project}_${service}_${index}`;
}

interface DockerInspect {
  Id: string;
  Name: string;
  State?: { Status?: string };
  Config?: { Labels?: Record<string, string>; Image?: string };
  NetworkSettings?: { Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null> };
}

function parseHostPort(net: DockerInspect["NetworkSettings"]): number | null {
  const map = net?.Ports;
  if (!map) return null;
  for (const bindings of Object.values(map)) {
    const hp = bindings?.[0]?.HostPort;
    if (hp) return Number.parseInt(hp, 10);
  }
  return null;
}

/** Inspect all managed containers, grouped per `project/service` (sorted by index). */
export async function inspectManaged(): Promise<Map<string, ManagedReplica[]>> {
  const map = new Map<string, ManagedReplica[]>();
  const ids = (
    await execa("docker", ["ps", "-aq", "--filter", `label=${LABELS.managed}=true`])
  ).stdout.trim();
  if (!ids) return map;

  const { stdout } = await execa("docker", ["inspect", ...ids.split("\n")]);
  const inspected = JSON.parse(stdout) as DockerInspect[];
  for (const c of inspected) {
    const labels = c.Config?.Labels ?? {};
    const project = labels[LABELS.project];
    const service = labels[LABELS.service];
    if (!project || !service) continue;
    const index = Number.parseInt(labels[LABELS.replica] ?? "0", 10) || 0;
    const key = serviceKey(project, service);
    const list = map.get(key) ?? [];
    list.push({
      id: c.Id,
      name: (c.Name ?? "").replace(/^\//, ""),
      index,
      state: c.State?.Status ?? "unknown",
      project,
      service,
      image: labels[LABELS.image] ?? c.Config?.Image ?? "",
      cpu: Number.parseInt(labels[LABELS.cpu] ?? "0", 10) || 0,
      memory: Number.parseInt(labels[LABELS.memory] ?? "0", 10) || 0,
      hostPort: parseHostPort(c.NetworkSettings),
      configStamp: labels[LABELS.configStamp] ?? "",
    });
    map.set(key, list);
  }
  for (const list of map.values()) list.sort((a, b) => a.index - b.index);
  return map;
}

export async function pull(image: string): Promise<void> {
  await execa("docker", ["pull", image]);
}

/** Hard remove (SIGKILL after 10s) — used for cleanup / non-graceful paths. */
export async function removeContainer(nameOrId: string): Promise<void> {
  await execa("docker", ["rm", "-f", nameOrId]).catch(() => undefined);
}

/** Graceful stop (SIGTERM → wait grace → SIGKILL) then remove. */
export async function stopContainer(nameOrId: string, graceSeconds: number): Promise<void> {
  await execa("docker", ["stop", "--time", String(graceSeconds), nameOrId]).catch(() => undefined);
  await execa("docker", ["rm", nameOrId]).catch(() => undefined);
}

export async function startContainer(nameOrId: string): Promise<void> {
  await execa("docker", ["start", nameOrId]);
}

export interface RunSpec {
  config: ServiceConfig;
  index: number;
  /** Host port for a web replica; undefined for workers. */
  hostPort?: number | undefined;
  /** "127.0.0.1" (co-located) or "0.0.0.0" (reachable by a remote edge). */
  bindHost: string;
}

export async function runContainer(spec: RunSpec): Promise<void> {
  const c = spec.config;
  const mergedEnv = await resolveServiceEnv(c);
  const stamp = serviceConfigStamp(c);
  const args = [
    "run",
    "-d",
    "--name",
    containerName(c.project, c.service, spec.index),
    "--label",
    `${LABELS.managed}=true`,
    "--label",
    `${LABELS.project}=${c.project}`,
    "--label",
    `${LABELS.service}=${c.service}`,
    "--label",
    `${LABELS.image}=${c.image}`,
    "--label",
    `${LABELS.replica}=${spec.index}`,
    "--label",
    `${LABELS.cpu}=${c.cpu}`,
    "--label",
    `${LABELS.memory}=${c.memory}`,
    "--label",
    `${LABELS.configStamp}=${stamp}`,
    "--restart",
    "unless-stopped",
    "--cpus",
    String(c.cpu / 1024),
    "--memory",
    `${c.memory}m`,
  ];
  for (const [key, value] of Object.entries(mergedEnv)) {
    args.push("-e", `${key}=${value}`);
  }
  if (c.ingress && spec.hostPort !== undefined) {
    args.push("-p", `${spec.bindHost}:${spec.hostPort}:${c.ingress.port}`);
  }
  args.push(c.image);
  await execa("docker", args);
}
