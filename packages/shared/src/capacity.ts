/**
 * Capacity model.
 *
 * CPU is measured in **vCPU shares** where `1024 = 1 vCPU` (the ECS convention —
 * integer-friendly and familiar). Memory is measured in **MB**.
 *
 * A node's total capacity is derived from its EC2 instance type. We ship a small
 * lookup table for common types (fast, offline, deterministic); callers that hit
 * an unknown type fall back to the EC2 `DescribeInstanceTypes` API and convert the
 * result with {@link rawToCapacity}.
 */

import { DEFAULT_RESERVED_CPU, DEFAULT_RESERVED_MEMORY } from "./constants";

export const CPU_SHARES_PER_VCPU = 1024;

export interface RawInstanceCapacity {
  /** Physical/virtual CPUs the instance type provides. */
  vcpu: number;
  /** RAM in MiB (treated as MB here for simplicity). */
  memoryMiB: number;
}

export interface InstanceCapacity {
  /** Total CPU in vCPU shares (vcpu * 1024). */
  totalCpu: number;
  /** Total memory in MB. */
  totalMemory: number;
}

/** Common instance types, so the happy path needs no AWS call. */
export const INSTANCE_CAPACITY_TABLE: Record<string, RawInstanceCapacity> = {
  "t3.micro": { vcpu: 2, memoryMiB: 1024 },
  "t3.small": { vcpu: 2, memoryMiB: 2048 },
  "t3.medium": { vcpu: 2, memoryMiB: 4096 },
  "t3.large": { vcpu: 2, memoryMiB: 8192 },
  "t3.xlarge": { vcpu: 4, memoryMiB: 16384 },
  "t3a.micro": { vcpu: 2, memoryMiB: 1024 },
  "t3a.small": { vcpu: 2, memoryMiB: 2048 },
  "t3a.medium": { vcpu: 2, memoryMiB: 4096 },
  "t3a.large": { vcpu: 2, memoryMiB: 8192 },
  "t2.micro": { vcpu: 1, memoryMiB: 1024 },
  "t2.small": { vcpu: 1, memoryMiB: 2048 },
  "t2.medium": { vcpu: 2, memoryMiB: 4096 },
  "m5.large": { vcpu: 2, memoryMiB: 8192 },
  "m5.xlarge": { vcpu: 4, memoryMiB: 16384 },
  "m6i.large": { vcpu: 2, memoryMiB: 8192 },
  "m6i.xlarge": { vcpu: 4, memoryMiB: 16384 },
  "c5.large": { vcpu: 2, memoryMiB: 4096 },
  "c5.xlarge": { vcpu: 4, memoryMiB: 8192 },
};

export function rawToCapacity(raw: RawInstanceCapacity): InstanceCapacity {
  return { totalCpu: raw.vcpu * CPU_SHARES_PER_VCPU, totalMemory: raw.memoryMiB };
}

/** Capacity for a known instance type, or null if it isn't in the table. */
export function lookupInstanceCapacity(instanceType: string): InstanceCapacity | null {
  const raw = INSTANCE_CAPACITY_TABLE[instanceType];
  return raw ? rawToCapacity(raw) : null;
}

export interface CapacityServiceDemand {
  project: string;
  service: string;
  cpu: number;
  memory: number;
  /**
   * Extra CPU shares this service needs *transiently* while it is mid-rollout
   * (`min(maxSurge, replicas) × per-replica cpu`). Only the single largest surge
   * across all services is reserved, because a node rolls one service at a time.
   * Defaults to 0 (no rollout headroom).
   */
  surgeCpu?: number;
  /** Extra memory (MB) needed transiently while this service is mid-rollout. */
  surgeMemory?: number;
}

export interface CapacityCheckInput {
  totalCpu: number;
  totalMemory: number;
  reservedCpu: number;
  reservedMemory: number;
  services: CapacityServiceDemand[];
}

export interface CapacityCheckResult {
  ok: boolean;
  allocatableCpu: number;
  allocatableMemory: number;
  /** Peak demand checked against allocatable: steady-state sum + the largest single surge. */
  usedCpu: number;
  usedMemory: number;
  /** Steady-state demand (sum of all services), excluding rollout surge. */
  steadyCpu: number;
  steadyMemory: number;
  /** Rollout headroom reserved: the largest single-service surge (cpu and memory independently). */
  surgeCpu: number;
  surgeMemory: number;
  /** Positive ⇒ this many shares over the limit. */
  cpuOverBy: number;
  /** Positive ⇒ this many MB over the limit. */
  memoryOverBy: number;
}

/**
 * Admission check: does the full set of services fit on the node — including the
 * transient surge of a rolling update? `services` must be the *complete* set that
 * would run on the node (this project's new services PLUS every other project's
 * existing services).
 *
 * A node rolls **one service at a time** (the agent applies rollout actions
 * sequentially), so the transient peak adds only the single largest surge, not the
 * sum of all surges. CPU and memory are maxed independently: the cpu-heaviest and
 * memory-heaviest rolling services may differ, and each resource must hold at its
 * own peak.
 */
export function checkCapacity(input: CapacityCheckInput): CapacityCheckResult {
  const allocatableCpu = input.totalCpu - input.reservedCpu;
  const allocatableMemory = input.totalMemory - input.reservedMemory;
  const steadyCpu = input.services.reduce((sum, s) => sum + s.cpu, 0);
  const steadyMemory = input.services.reduce((sum, s) => sum + s.memory, 0);
  const surgeCpu = input.services.reduce((m, s) => Math.max(m, s.surgeCpu ?? 0), 0);
  const surgeMemory = input.services.reduce((m, s) => Math.max(m, s.surgeMemory ?? 0), 0);
  const usedCpu = steadyCpu + surgeCpu;
  const usedMemory = steadyMemory + surgeMemory;
  const cpuOverBy = usedCpu - allocatableCpu;
  const memoryOverBy = usedMemory - allocatableMemory;
  return {
    ok: cpuOverBy <= 0 && memoryOverBy <= 0,
    allocatableCpu,
    allocatableMemory,
    usedCpu,
    usedMemory,
    steadyCpu,
    steadyMemory,
    surgeCpu,
    surgeMemory,
    cpuOverBy,
    memoryOverBy,
  };
}

/** Render shares back to vCPU for display, e.g. 512 ⇒ "0.5". */
export function sharesToVcpu(shares: number): number {
  return shares / CPU_SHARES_PER_VCPU;
}

export interface SmallestTypeOptions {
  /** Held-back CPU shares (default {@link DEFAULT_RESERVED_CPU}). */
  reservedCpu?: number;
  /** Held-back memory MB (default {@link DEFAULT_RESERVED_MEMORY}). */
  reservedMemory?: number;
  /** Never return a type smaller than this (default "t3.small" — t3.micro's 1 GB is
   * tight for the OS + agent + Caddy). */
  floor?: string;
}

/** Burstable t-series first (cheap, the right default for small nodes), then others. */
function familyRank(instanceType: string): number {
  if (instanceType.startsWith("t3.")) return 0;
  if (instanceType.startsWith("t3a.")) return 1;
  if (instanceType.startsWith("t2.")) return 2;
  return 3;
}

/**
 * Smallest known instance type whose **allocatable** capacity (total − reserved)
 * fits `cpuShares` + `memoryMb`, never returning something below `floor`. Returns
 * `null` when nothing in the table fits. Used to auto-size a node that `deploy`
 * provisions for the services placed on it — zero demand resolves to the floor.
 */
export function smallestInstanceTypeFor(
  cpuShares: number,
  memoryMb: number,
  opts: SmallestTypeOptions = {},
): { instanceType: string; capacity: InstanceCapacity } | null {
  const reservedCpu = opts.reservedCpu ?? DEFAULT_RESERVED_CPU;
  const reservedMemory = opts.reservedMemory ?? DEFAULT_RESERVED_MEMORY;
  const floorCap = lookupInstanceCapacity(opts.floor ?? "t3.small");

  const candidates = Object.entries(INSTANCE_CAPACITY_TABLE)
    .map(([instanceType, raw]) => ({ instanceType, capacity: rawToCapacity(raw) }))
    .filter(({ capacity }) =>
      floorCap
        ? capacity.totalCpu >= floorCap.totalCpu && capacity.totalMemory >= floorCap.totalMemory
        : true,
    )
    .sort(
      (a, b) =>
        a.capacity.totalCpu - b.capacity.totalCpu ||
        a.capacity.totalMemory - b.capacity.totalMemory ||
        familyRank(a.instanceType) - familyRank(b.instanceType) ||
        a.instanceType.localeCompare(b.instanceType),
    );

  for (const c of candidates) {
    if (
      c.capacity.totalCpu - reservedCpu >= cpuShares &&
      c.capacity.totalMemory - reservedMemory >= memoryMb
    ) {
      return c;
    }
  }
  return null;
}
