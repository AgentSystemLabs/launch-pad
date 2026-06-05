import { describe, expect, it } from "vitest";
import {
  buildSystemLogCollectList,
  cwLogFileEntry,
  LOG_RETENTION_DAYS,
  logGroupName,
  logStreamName,
  parseLogStreamName,
  systemComponentsForRole,
  systemCwConfig,
  systemLogGroupName,
  systemLogStreamName,
} from "./logs";

describe("log naming", () => {
  it("derives a service-first log group from cluster/project/service", () => {
    expect(logGroupName("default", "my-app", "api")).toBe("/launch-pad/default/my-app/api");
    expect(logGroupName("lower", "shop", "web")).toBe("/launch-pad/lower/shop/web");
  });

  it("uses the effective (env-projected) project verbatim", () => {
    // The CLI passes envProject(project, env) → my-app-staging — naming just consumes it.
    expect(logGroupName("default", "my-app-staging", "api")).toBe(
      "/launch-pad/default/my-app-staging/api",
    );
  });

  it("encodes node + replica in the stream name", () => {
    expect(logStreamName("node-prod-1", 0)).toBe("node-prod-1/0");
    expect(logStreamName("app-2", 3)).toBe("app-2/3");
  });

  it("derives a per-node system group + component stream", () => {
    expect(systemLogGroupName("default", "node-prod-1")).toBe(
      "/launch-pad/default/system/node-prod-1",
    );
    expect(systemLogStreamName("agent")).toBe("agent");
    expect(systemLogStreamName("caddy")).toBe("caddy");
  });
});

describe("parseLogStreamName", () => {
  it("round-trips a service stream", () => {
    const parsed = parseLogStreamName(logStreamName("node-prod-1", 2));
    expect(parsed).toEqual({ nodeId: "node-prod-1", replicaIndex: 2 });
  });

  it("handles node ids with hyphens (but no slashes)", () => {
    expect(parseLogStreamName("edge-router-1/0")).toEqual({ nodeId: "edge-router-1", replicaIndex: 0 });
  });

  it("returns null for a non-service stream (e.g. system component)", () => {
    expect(parseLogStreamName("agent")).toBeNull();
    expect(parseLogStreamName("")).toBeNull();
    expect(parseLogStreamName("node/notanumber")).toBeNull();
  });
});

describe("CloudWatch agent config shaping", () => {
  it("builds a UTC file entry with the default retention", () => {
    const entry = cwLogFileEntry({
      filePath: "/var/lib/docker/containers/abc/abc-json.log",
      logGroupName: "/launch-pad/default/my-app/api",
      logStreamName: "node-1/0",
    });
    expect(entry).toEqual({
      file_path: "/var/lib/docker/containers/abc/abc-json.log",
      log_group_name: "/launch-pad/default/my-app/api",
      log_stream_name: "node-1/0",
      timezone: "UTC",
      retention_in_days: LOG_RETENTION_DAYS,
    });
  });

  it("ships agent-only system logs for an app node", () => {
    expect(systemComponentsForRole("app")).toEqual(["agent"]);
    const list = buildSystemLogCollectList("default", "app-1", "app");
    expect(list).toHaveLength(1);
    expect(list[0]?.log_group_name).toBe("/launch-pad/default/system/app-1");
    expect(list[0]?.log_stream_name).toBe("agent");
    expect(list[0]?.file_path).toBe("/var/log/launch-pad/agent.log");
  });

  it("ships agent + caddy for edge/both nodes", () => {
    expect(systemComponentsForRole("edge")).toEqual(["agent", "caddy"]);
    expect(systemComponentsForRole("both")).toEqual(["agent", "caddy"]);
    const config = systemCwConfig("lower", "edge-1", "edge");
    const streams = config.logs.logs_collected.files.collect_list.map((e) => e.log_stream_name);
    expect(streams).toEqual(["agent", "caddy"]);
    for (const entry of config.logs.logs_collected.files.collect_list) {
      expect(entry.log_group_name).toBe("/launch-pad/lower/system/edge-1");
    }
  });
});
