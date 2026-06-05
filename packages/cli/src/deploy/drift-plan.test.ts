import type { NodeState } from "@agentsystemlabs/launch-pad-shared";
import { describe, expect, it } from "vitest";
import type { Ec2Observation } from "../aws/ec2";
import { planNodeDrift } from "./drift-plan";

const running: Ec2Observation = {
  kind: "running",
  publicIp: "1.2.3.4",
  privateIp: "10.0.0.1",
  availabilityZone: "us-east-1a",
};
const stopped: Ec2Observation = { kind: "stopped" };
const pending: Ec2Observation = { kind: "transitional", state: "pending" };
const missing: Ec2Observation = { kind: "missing" };

const plan = (state: NodeState, ec2: Ec2Observation, allowRecreate = true) =>
  planNodeDrift({ state }, ec2, { allowRecreate });

describe("planNodeDrift", () => {
  // ── intended-running (ready / provisioning) ──────────────────────────────────
  it("ready + running → no drift, noop", () => {
    expect(plan("ready", running)).toEqual({ drift: "none", action: { kind: "noop" } });
  });

  it("provisioning + running → no drift, noop (state stuck at provisioning is still 'up')", () => {
    expect(plan("provisioning", running)).toEqual({ drift: "none", action: { kind: "noop" } });
  });

  it("ready + stopped → drift stopped, resume (console stopped a live node)", () => {
    expect(plan("ready", stopped)).toEqual({ drift: "stopped", action: { kind: "resume" } });
  });

  it("provisioning + stopped → drift stopped, resume", () => {
    expect(plan("provisioning", stopped)).toEqual({ drift: "stopped", action: { kind: "resume" } });
  });

  // ── intentionally paused (stopped) ───────────────────────────────────────────
  it("stopped + stopped → no drift, but resume (normal pause → deploy brings it up)", () => {
    expect(plan("stopped", stopped)).toEqual({ drift: "none", action: { kind: "resume" } });
  });

  it("stopped + running → drift running, sync registry from EC2 (console started it)", () => {
    expect(plan("stopped", running)).toEqual({
      drift: "running",
      action: { kind: "sync", publicIp: "1.2.3.4", privateIp: "10.0.0.1", availabilityZone: "us-east-1a" },
    });
  });

  // ── transitional ─────────────────────────────────────────────────────────────
  it("ready + transitional → blocked (wait for stable)", () => {
    expect(plan("ready", pending)).toEqual({
      drift: "transitional",
      action: { kind: "blocked", reason: expect.stringContaining("pending") },
    });
  });

  it("stopped + transitional → blocked", () => {
    expect(plan("stopped", pending).action.kind).toBe("blocked");
  });

  // ── missing (terminated / gone) ──────────────────────────────────────────────
  it("ready + missing, recreate allowed → recreate", () => {
    expect(plan("ready", missing, true)).toEqual({ drift: "gone", action: { kind: "recreate" } });
  });

  it("stopped + missing, recreate allowed → recreate", () => {
    expect(plan("stopped", missing, true)).toEqual({ drift: "gone", action: { kind: "recreate" } });
  });

  it("missing, recreate disallowed → gone but blocked", () => {
    const r = plan("ready", missing, false);
    expect(r.drift).toBe("gone");
    expect(r.action.kind).toBe("blocked");
  });
});
