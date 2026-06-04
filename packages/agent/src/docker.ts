import { execa } from "execa";
import { LABELS, type ServiceConfig, serviceKey } from "@agentsystemlabs/launch-pad-shared";

export interface ManagedContainer {
  id: string;
  name: string;
  /** docker container state: running | exited | created | ... */
  state: string;
  project: string;
  service: string;
  /** The desired image recorded on the container (launchpad.image label). */
  image: string;
}

export function containerName(project: string, service: string): string {
  return `launchpad_${project}_${service}`;
}

interface DockerInspect {
  Id: string;
  Name: string;
  State?: { Status?: string };
  Config?: { Labels?: Record<string, string>; Image?: string };
}

/** Inspect all launch-pad-managed containers, keyed by `project/service`. */
export async function inspectManaged(): Promise<Map<string, ManagedContainer>> {
  const map = new Map<string, ManagedContainer>();
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
    map.set(serviceKey(project, service), {
      id: c.Id,
      name: (c.Name ?? "").replace(/^\//, ""),
      state: c.State?.Status ?? "unknown",
      project,
      service,
      image: labels[LABELS.image] ?? c.Config?.Image ?? "",
    });
  }
  return map;
}

export async function pull(image: string): Promise<void> {
  await execa("docker", ["pull", image]);
}

export async function removeContainer(name: string): Promise<void> {
  // -f stops and removes; ignore "no such container".
  await execa("docker", ["rm", "-f", name]).catch(() => undefined);
}

export async function startContainer(name: string): Promise<void> {
  await execa("docker", ["start", name]);
}

export interface RunSpec {
  config: ServiceConfig;
  /** Host port for a web service; undefined for workers (no port binding). */
  hostPort?: number | undefined;
}

export async function runContainer(spec: RunSpec): Promise<void> {
  const c = spec.config;
  const args = [
    "run",
    "-d",
    "--name",
    containerName(c.project, c.service),
    "--label",
    `${LABELS.managed}=true`,
    "--label",
    `${LABELS.project}=${c.project}`,
    "--label",
    `${LABELS.service}=${c.service}`,
    "--label",
    `${LABELS.image}=${c.image}`,
    "--restart",
    "unless-stopped",
    "--cpus",
    String(c.cpu / 1024),
    "--memory",
    `${c.memory}m`,
  ];
  for (const [key, value] of Object.entries(c.env)) {
    args.push("-e", `${key}=${value}`);
  }
  // Web services bind to localhost only; Caddy (also local) is the public entry.
  if (c.ingress && spec.hostPort !== undefined) {
    args.push("-p", `127.0.0.1:${spec.hostPort}:${c.ingress.port}`);
  }
  args.push(c.image);
  await execa("docker", args);
}
