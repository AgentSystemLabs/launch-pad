import { describe, expect, it } from "vitest";
import {
  checkCapacity,
  lookupInstanceCapacity,
  rawToCapacity,
  sharesToVcpu,
} from "./capacity";

describe("instance capacity", () => {
  it("derives shares + MB for a known type", () => {
    expect(lookupInstanceCapacity("t3.small")).toEqual({ totalCpu: 2048, totalMemory: 2048 });
  });

  it("returns null for an unknown type", () => {
    expect(lookupInstanceCapacity("zz.nonsense")).toBeNull();
  });

  it("converts raw EC2 shape to shares", () => {
    expect(rawToCapacity({ vcpu: 4, memoryMiB: 16384 })).toEqual({
      totalCpu: 4096,
      totalMemory: 16384,
    });
  });

  it("renders shares back to vCPU", () => {
    expect(sharesToVcpu(512)).toBe(0.5);
  });
});

describe("checkCapacity", () => {
  const base = { totalCpu: 2048, totalMemory: 2048, reservedCpu: 256, reservedMemory: 512 };

  it("passes when the set fits within allocatable capacity", () => {
    const r = checkCapacity({
      ...base,
      services: [
        { project: "a", service: "web", cpu: 512, memory: 512 },
        { project: "b", service: "worker", cpu: 256, memory: 256 },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.allocatableCpu).toBe(1792);
    expect(r.allocatableMemory).toBe(1536);
    expect(r.usedCpu).toBe(768);
    expect(r.usedMemory).toBe(768);
    expect(r.cpuOverBy).toBeLessThan(0);
  });

  it("fails and reports the overage when memory is exceeded", () => {
    const r = checkCapacity({
      ...base,
      services: [{ project: "a", service: "web", cpu: 256, memory: 2000 }],
    });
    expect(r.ok).toBe(false);
    expect(r.memoryOverBy).toBe(2000 - 1536);
  });

  it("treats an empty set as trivially fitting", () => {
    const r = checkCapacity({ ...base, services: [] });
    expect(r.ok).toBe(true);
    expect(r.usedCpu).toBe(0);
  });
});
