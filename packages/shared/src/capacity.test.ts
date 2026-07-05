import { describe, expect, it } from "vitest";
import {
  checkCapacity,
  lookupInstanceCapacity,
  rawToCapacity,
  sharesToVcpu,
  smallestInstanceTypeFor,
} from "./capacity";

describe("instance capacity", () => {
  it("derives shares + MB for a known type", () => {
    expect(lookupInstanceCapacity("t3.small")).toEqual({
      totalCpu: 2048,
      totalMemory: 2048,
      architecture: "x86_64",
    });
    expect(lookupInstanceCapacity("t4g.micro")).toEqual({
      totalCpu: 2048,
      totalMemory: 1024,
      architecture: "arm64",
    });
  });

  it("returns null for an unknown type", () => {
    expect(lookupInstanceCapacity("zz.nonsense")).toBeNull();
  });

  it("converts raw EC2 shape to shares", () => {
    expect(rawToCapacity({ vcpu: 4, memoryMiB: 16384, architecture: "arm64" })).toEqual({
      totalCpu: 4096,
      totalMemory: 16384,
      architecture: "arm64",
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

  it("reserves only the single largest surge (one service rolls at a time), not the sum", () => {
    const r = checkCapacity({
      ...base,
      services: [
        { project: "a", service: "web", cpu: 512, memory: 512, surgeCpu: 512, surgeMemory: 512 },
        { project: "b", service: "api", cpu: 256, memory: 256, surgeCpu: 256, surgeMemory: 256 },
      ],
    });
    expect(r.steadyCpu).toBe(768);
    expect(r.steadyMemory).toBe(768);
    // max(512, 256) reserved once — NOT 512 + 256.
    expect(r.surgeCpu).toBe(512);
    expect(r.surgeMemory).toBe(512);
    expect(r.usedCpu).toBe(768 + 512);
    expect(r.usedMemory).toBe(768 + 512);
  });

  it("maxes cpu and memory surge independently across services", () => {
    const r = checkCapacity({
      ...base,
      services: [
        // cpu-heavy roller
        { project: "a", service: "cruncher", cpu: 256, memory: 128, surgeCpu: 256, surgeMemory: 128 },
        // memory-heavy roller
        { project: "b", service: "cache", cpu: 64, memory: 512, surgeCpu: 64, surgeMemory: 512 },
      ],
    });
    expect(r.surgeCpu).toBe(256); // from cruncher
    expect(r.surgeMemory).toBe(512); // from cache
  });

  it("rejects a set that fits at steady state but not once the rollout surge is added", () => {
    // e.g. 3×512 = 1536 steady ≤ allocatable 1792, but a maxSurge=1 roll adds 512 → 2048 > 1792.
    const r = checkCapacity({
      ...base,
      services: [{ project: "a", service: "web", cpu: 1536, memory: 256, surgeCpu: 512, surgeMemory: 256 }],
    });
    expect(r.steadyCpu).toBe(1536);
    expect(r.steadyCpu).toBeLessThanOrEqual(r.allocatableCpu); // fits without the surge
    expect(r.usedCpu).toBe(1536 + 512);
    expect(r.ok).toBe(false);
    expect(r.cpuOverBy).toBe(2048 - 1792); // 256 over
  });
});

describe("smallestInstanceTypeFor", () => {
  it("returns the floor for zero demand (e.g. a dedicated edge)", () => {
    expect(smallestInstanceTypeFor(0, 0)?.instanceType).toBe("t4g.micro");
  });

  it("never returns below the floor even for a tiny demand", () => {
    // 256 shares / 256 MB would fit t4g.nano, but the floor is t4g.micro.
    expect(smallestInstanceTypeFor(256, 256)?.instanceType).toBe("t4g.micro");
  });

  it("steps up to the next size when memory exceeds the floor's allocatable", () => {
    // t4g.micro allocatable mem = 1024 − 512 = 512; 3000 needs the 4096 tier.
    expect(smallestInstanceTypeFor(0, 3000)?.instanceType).toBe("t4g.medium");
  });

  it("respects reserved capacity at the boundary", () => {
    // t4g.micro allocatable cpu = 2048 − 256 = 1792; exactly 1792 still fits.
    expect(smallestInstanceTypeFor(1792, 0)?.instanceType).toBe("t4g.micro");
    // one share over and no 2-vCPU type fits → smallest 4-vCPU box (by memory).
    expect(smallestInstanceTypeFor(1793, 0)?.instanceType).toBe("t4g.xlarge");
  });

  it("prefers the t3 family over equal-capacity alternatives", () => {
    // c5.large / t2.medium / t3.medium / t4g.medium all = 2 vCPU · 4096 MB → t4g wins.
    expect(smallestInstanceTypeFor(0, 3584)?.instanceType).toBe("t4g.medium");
  });

  it("returns null when nothing in the table fits", () => {
    expect(smallestInstanceTypeFor(999_999, 0)).toBeNull();
  });

  it("honors a custom floor + reserved overrides", () => {
    const r = smallestInstanceTypeFor(0, 0, { floor: "t3.micro", reservedCpu: 0, reservedMemory: 0 });
    expect(r?.instanceType).toBe("t3.micro");
  });

  it("can restrict sizing to x86_64 for an existing x86 pool", () => {
    const r = smallestInstanceTypeFor(0, 0, { architecture: "x86_64" });
    expect(r?.instanceType).toBe("t3.micro");
    expect(r?.capacity.architecture).toBe("x86_64");
  });
});
