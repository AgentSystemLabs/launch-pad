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
  usedCpu: number;
  usedMemory: number;
  /** Positive ⇒ this many shares over the limit. */
  cpuOverBy: number;
  /** Positive ⇒ this many MB over the limit. */
  memoryOverBy: number;
}

/**
 * Admission check: does the full set of services fit on the node?
 * `services` must be the *complete* set that would run on the node (this
 * project's new services PLUS every other project's existing services).
 */
export function checkCapacity(input: CapacityCheckInput): CapacityCheckResult {
  const allocatableCpu = input.totalCpu - input.reservedCpu;
  const allocatableMemory = input.totalMemory - input.reservedMemory;
  const usedCpu = input.services.reduce((sum, s) => sum + s.cpu, 0);
  const usedMemory = input.services.reduce((sum, s) => sum + s.memory, 0);
  const cpuOverBy = usedCpu - allocatableCpu;
  const memoryOverBy = usedMemory - allocatableMemory;
  return {
    ok: cpuOverBy <= 0 && memoryOverBy <= 0,
    allocatableCpu,
    allocatableMemory,
    usedCpu,
    usedMemory,
    cpuOverBy,
    memoryOverBy,
  };
}

/** Render shares back to vCPU for display, e.g. 512 ⇒ "0.5". */
export function sharesToVcpu(shares: number): number {
  return shares / CPU_SHARES_PER_VCPU;
}
