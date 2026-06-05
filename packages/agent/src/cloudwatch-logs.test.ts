import { describe, expect, it, vi } from "vitest";
import {
  buildCombinedCloudWatchConfig,
  buildContainerLogCollectList,
  containerLogFilePath,
  createCloudWatchAgentSync,
} from "./cloudwatch-logs";
import type { ManagedReplica } from "./docker";

function replica(over: Partial<ManagedReplica> & Pick<ManagedReplica, "id" | "project" | "service" | "index">): ManagedReplica {
  return {
    name: `launchpad_${over.project}_${over.service}_${over.index}`,
    state: "running",
    image: "img",
    cpu: 256,
    memory: 256,
    hostPort: null,
    ...over,
  };
}

const live: ManagedReplica[] = [
  replica({ id: "aaa111", project: "my-app", service: "api", index: 0 }),
  replica({ id: "bbb222", project: "my-app", service: "api", index: 1 }),
  replica({ id: "ccc333", project: "my-app", service: "worker", index: 0 }),
];

describe("buildContainerLogCollectList", () => {
  it("maps each container to its json log file under the service-first group", () => {
    const list = buildContainerLogCollectList({ clusterId: "default", nodeId: "node-1", replicas: live });
    expect(list).toHaveLength(3);
    expect(list[0]).toEqual({
      file_path: containerLogFilePath("aaa111"),
      log_group_name: "/launch-pad/default/my-app/api",
      log_stream_name: "node-1/0",
      timezone: "UTC",
      retention_in_days: 7,
    });
    // two replicas of the same service share a group, differ by stream
    expect(list[1]?.log_group_name).toBe("/launch-pad/default/my-app/api");
    expect(list[1]?.log_stream_name).toBe("node-1/1");
    // a worker (no ingress) is shipped just the same
    expect(list[2]?.log_group_name).toBe("/launch-pad/default/my-app/worker");
  });

  it("derives the docker json-file path from the container id", () => {
    expect(containerLogFilePath("deadbeef")).toBe(
      "/var/lib/docker/containers/deadbeef/deadbeef-json.log",
    );
  });

  it("skips entries missing a container id, project, or service", () => {
    const list = buildContainerLogCollectList({
      clusterId: "default",
      nodeId: "node-1",
      replicas: [replica({ id: "", project: "p", service: "s", index: 0 })],
    });
    expect(list).toEqual([]);
  });
});

describe("buildCombinedCloudWatchConfig", () => {
  it("prepends system entries (agent only) for an app node", () => {
    const config = buildCombinedCloudWatchConfig({
      clusterId: "default",
      nodeId: "app-1",
      role: "app",
      replicas: live,
    });
    const list = config.logs.logs_collected.files.collect_list;
    // 1 system (agent) + 3 containers
    expect(list).toHaveLength(4);
    expect(list[0]?.log_stream_name).toBe("agent");
    expect(list[0]?.log_group_name).toBe("/launch-pad/default/system/app-1");
    expect(list.slice(1).map((e) => e.log_stream_name)).toEqual(["app-1/0", "app-1/1", "app-1/0"]);
  });

  it("includes caddy system logs on edge/both", () => {
    const config = buildCombinedCloudWatchConfig({
      clusterId: "lower",
      nodeId: "both-1",
      role: "both",
      replicas: [],
    });
    const streams = config.logs.logs_collected.files.collect_list.map((e) => e.log_stream_name);
    expect(streams).toEqual(["agent", "caddy"]);
  });
});

describe("createCloudWatchAgentSync", () => {
  it("writes + reloads on first sync, then skips when unchanged (write-on-change)", async () => {
    const writeConfig = vi.fn(async (_path: string, _contents: string) => {});
    const reload = vi.fn(async (_configPath: string) => {});
    const sync = createCloudWatchAgentSync(
      { clusterId: "default", nodeId: "node-1", role: "both" },
      { writeConfig, reload, log: () => {} },
    );

    await sync.sync(live);
    expect(writeConfig).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
    const [path, contents] = writeConfig.mock.calls[0]!;
    expect(path).toBe("/etc/launch-pad/cw-agent-combined.json");
    expect(contents).toContain("/launch-pad/default/my-app/api");

    // identical live set → no churn
    await sync.sync(live);
    expect(writeConfig).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);

    // a changed set → re-applies
    await sync.sync([live[0]!]);
    expect(writeConfig).toHaveBeenCalledTimes(2);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("never throws and retries next tick when the CloudWatch Agent is missing", async () => {
    const reload = vi.fn(async () => {
      throw new Error("amazon-cloudwatch-agent-ctl: not found");
    });
    const warn = vi.fn();
    const sync = createCloudWatchAgentSync(
      { clusterId: "default", nodeId: "node-1", role: "app" },
      { writeConfig: async () => {}, reload, log: warn },
    );

    await expect(sync.sync(live)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    // fingerprint not advanced on failure → retried
    await sync.sync(live);
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
