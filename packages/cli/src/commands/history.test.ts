import { buildDeployEvent, type DeployEvent } from "@agentsystemlabs/launch-pad-shared";
import { describe, expect, it } from "vitest";
import { selectRecentEvents } from "./history";

function ev(at: string, services: string[], patch: Partial<Parameters<typeof buildDeployEvent>[0]> = {}): DeployEvent {
  return buildDeployEvent({
    at,
    by: "arn:aws:iam::123:user/cody",
    cluster: "default",
    project: "shop",
    env: undefined,
    kind: "build",
    converged: true,
    services: services.map((s) => ({ service: s, image: `repo/${s}:tag`, replicas: 1 })),
    ...patch,
  });
}

const events = [
  ev("2026-06-10T10:00:00.000Z", ["web", "worker"]),
  ev("2026-06-10T12:00:00.000Z", ["web"]),
  ev("2026-06-10T11:00:00.000Z", ["worker"]),
];

describe("selectRecentEvents", () => {
  it("returns events newest-first", () => {
    const r = selectRecentEvents(events, undefined, 10);
    expect(r.map((e) => e.at)).toEqual([
      "2026-06-10T12:00:00.000Z",
      "2026-06-10T11:00:00.000Z",
      "2026-06-10T10:00:00.000Z",
    ]);
  });

  it("filters to events that touched a service", () => {
    const r = selectRecentEvents(events, "worker", 10);
    expect(r.map((e) => e.at)).toEqual(["2026-06-10T11:00:00.000Z", "2026-06-10T10:00:00.000Z"]);
  });

  it("applies the limit after sorting", () => {
    const r = selectRecentEvents(events, undefined, 2);
    expect(r.map((e) => e.at)).toEqual(["2026-06-10T12:00:00.000Z", "2026-06-10T11:00:00.000Z"]);
  });

  it("combines the service filter and the limit", () => {
    const r = selectRecentEvents(events, "web", 1);
    expect(r).toHaveLength(1);
    expect(r[0]!.at).toBe("2026-06-10T12:00:00.000Z");
  });

  it("returns [] for no events or a non-matching service", () => {
    expect(selectRecentEvents([], undefined, 10)).toEqual([]);
    expect(selectRecentEvents(events, "ghost", 10)).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const order = events.map((e) => e.at);
    selectRecentEvents(events, undefined, 10);
    expect(events.map((e) => e.at)).toEqual(order);
  });
});
