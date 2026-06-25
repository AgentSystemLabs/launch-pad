import { DEFAULT_CLUSTER, type NodeRegistryEntry } from "@agentsystemlabs/launch-pad-shared";
import { describe, expect, it } from "vitest";
import type { AwsEnv } from "../../aws/context";
import { nodeProfileName, nodeRoleName } from "../../aws/iam";
import {
  assessEvacuation,
  assessExternalReconcile,
  nodesThatWouldOrphan,
  parseNodeNames,
  scheduledServicesFromDesired,
  teardownNode,
  volumeBearingTargets,
} from "./index";
import { emptyDesiredState, PROTOCOL_VERSION } from "@agentsystemlabs/launch-pad-shared";

describe("parseNodeNames", () => {
  it("parses a single name", () => {
    expect(parseNodeNames("node-a")).toEqual(["node-a"]);
  });

  it("parses comma-separated names with surrounding whitespace", () => {
    expect(parseNodeNames(" node-a , node-b,node-c ")).toEqual(["node-a", "node-b", "node-c"]);
  });

  it("parses multiple positional arguments", () => {
    expect(parseNodeNames(["node-a", "node-b", "node-c"])).toEqual(["node-a", "node-b", "node-c"]);
  });

  it("parses comma-separated values inside positional arguments", () => {
    expect(parseNodeNames(["node-a,node-b", "node-c"])).toEqual(["node-a", "node-b", "node-c"]);
  });

  it("dedupes repeated names while preserving order", () => {
    expect(parseNodeNames("a,b,a,c,b")).toEqual(["a", "b", "c"]);
  });

  it("throws when no names are provided", () => {
    expect(() => parseNodeNames("  ,  ")).toThrow(/no node names provided/);
    expect(() => parseNodeNames([])).toThrow(/no node names provided/);
  });

  it("rejects invalid node names", () => {
    expect(() => parseNodeNames("good-node,bad node")).toThrow(/invalid node name "bad node"/);
    expect(() => parseNodeNames("-starts-with-hyphen")).toThrow(/invalid node name/);
  });
});

describe("nodesThatWouldOrphan", () => {
  it("returns only nodes that still host services", () => {
    const result = nodesThatWouldOrphan([
      { name: "empty", services: [] },
      { name: "busy", services: [{ project: "shop", service: "web" }, { project: "shop", service: "worker" }] },
    ]);
    expect(result).toEqual([
      { name: "busy", services: [{ project: "shop", service: "web" }, { project: "shop", service: "worker" }] },
    ]);
  });

  it("returns [] when every node is empty (safe to destroy without --force)", () => {
    expect(nodesThatWouldOrphan([{ name: "a", services: [] }, { name: "b", services: [] }])).toEqual([]);
  });

  it("flags every busy node when destroying many at once", () => {
    const result = nodesThatWouldOrphan([
      { name: "a", services: [{ project: "p", service: "api" }] },
      { name: "b", services: [{ project: "p", service: "worker" }] },
    ]);
    expect(result.map((r) => r.name)).toEqual(["a", "b"]);
  });
});

describe("volumeBearingTargets", () => {
  // The data-loss gate keys on this helper: a node hosting a volume-bearing service
  // (a Postgres/data service) is refused even with --force. Destroy only proceeds when
  // it returns [] OR --delete-data is passed.

  // The runDestroy gate is exactly: `volumeRisks.length > 0 && deleteData !== true`.
  const refuses = (risks: ReturnType<typeof volumeBearingTargets>, deleteData: boolean): boolean =>
    risks.length > 0 && deleteData !== true;

  it("(a) flags a node hosting a volume-bearing service (refused even with --force)", () => {
    const risks = volumeBearingTargets([
      { name: "db-node", services: [{ project: "shop", service: "db", hasVolume: true }] },
    ]);
    expect(risks).toEqual([
      { name: "db-node", services: [{ project: "shop", service: "db", hasVolume: true }] },
    ]);
    // --force does not bypass the gate — only --delete-data does, so it still refuses.
    expect(refuses(risks, false)).toBe(true);
  });

  it("(b) --delete-data lets a volume-bearing node through the gate", () => {
    const risks = volumeBearingTargets([
      { name: "db-node", services: [{ project: "shop", service: "db", hasVolume: true }] },
    ]);
    // The gate no longer refuses once --delete-data acknowledges the loss.
    expect(refuses(risks, true)).toBe(false);
  });

  it("(c) a node with no volumes is unaffected by the gate", () => {
    const risks = volumeBearingTargets([
      { name: "web-node", services: [{ project: "shop", service: "web", hasVolume: false }] },
      { name: "worker-node", services: [{ project: "shop", service: "worker" }] }, // hasVolume absent
    ]);
    expect(risks).toEqual([]);
    expect(refuses(risks, false)).toBe(false);
  });

  it("returns only the volume-bearing services on a mixed node", () => {
    const risks = volumeBearingTargets([
      {
        name: "mixed",
        services: [
          { project: "shop", service: "web", hasVolume: false },
          { project: "shop", service: "db", hasVolume: true },
        ],
      },
    ]);
    expect(risks).toEqual([
      { name: "mixed", services: [{ project: "shop", service: "db", hasVolume: true }] },
    ]);
  });

  it("flags every volume-bearing node when destroying many at once", () => {
    const risks = volumeBearingTargets([
      { name: "a", services: [{ project: "p", service: "pg", hasVolume: true }] },
      { name: "b", services: [{ project: "p", service: "redis", hasVolume: true }] },
      { name: "c", services: [{ project: "p", service: "web", hasVolume: false }] },
    ]);
    expect(risks.map((r) => r.name)).toEqual(["a", "b"]);
  });
});

describe("scheduledServicesFromDesired", () => {
  it("maps services and flags volume-bearing ones", () => {
    const raw = {
      ...emptyDesiredState("node-a", "2026-06-25T00:00:00.000Z"),
      services: [
        { project: "shop", service: "web", image: "img:1", cpu: 256, memory: 256, ingress: null },
        {
          project: "shop",
          service: "primary",
          image: "postgres:16",
          cpu: 1024,
          memory: 1024,
          ingress: null,
          volumes: [{ name: "data", path: "/var/lib/postgresql/data" }],
        },
      ],
    };
    const out = scheduledServicesFromDesired(raw);
    expect(out).toEqual([
      { project: "shop", service: "web", hasVolume: false },
      { project: "shop", service: "primary", hasVolume: true },
    ]);
  });

  it("fails CLOSED on an unparseable desired.json (synthetic volume-bearing service)", () => {
    // A present-but-corrupt desired.json must NOT look service-free — that would let
    // `node destroy` wipe a database volume without --delete-data.
    const out = scheduledServicesFromDesired({ version: PROTOCOL_VERSION, garbage: true });
    expect(out).toHaveLength(1);
    expect(out[0]?.hasVolume).toBe(true);
    // And the data-loss gate fires on it.
    expect(volumeBearingTargets([{ name: "node-x", services: out }])).toHaveLength(1);
  });

  it("treats an empty desired.json as no services", () => {
    expect(scheduledServicesFromDesired(emptyDesiredState("node-a", "2026-06-25T00:00:00.000Z"))).toEqual([]);
  });
});

describe("assessEvacuation", () => {
  // A service is "movable" by auto-evacuate iff it belongs to the current project AND
  // is cluster-placed (omits node/nodes). Everything else — a pinned service, or any
  // other project's service — can't be moved by `node destroy --evacuate`.
  const owner = "shop";
  const clusterPlaced = new Set(["web", "worker"]);

  it("drains a node hosting the current project's cluster-placed service", () => {
    const a = assessEvacuation(
      [{ name: "a", services: [{ project: owner, service: "web" }] }],
      owner,
      clusterPlaced,
    );
    expect(a.drainNodes).toEqual(["a"]);
    expect(a.unmovable).toEqual([]);
  });

  it("flags a pinned service of the current project as unmovable (not drainable)", () => {
    const a = assessEvacuation(
      [{ name: "a", services: [{ project: owner, service: "db" }] }],
      owner,
      clusterPlaced,
    );
    expect(a.drainNodes).toEqual([]);
    expect(a.unmovable).toEqual([{ name: "a", services: [{ project: owner, service: "db" }] }]);
  });

  it("flags another project's service as unmovable", () => {
    const a = assessEvacuation(
      [{ name: "a", services: [{ project: "blog", service: "web" }] }],
      owner,
      clusterPlaced,
    );
    expect(a.drainNodes).toEqual([]);
    expect(a.unmovable).toEqual([{ name: "a", services: [{ project: "blog", service: "web" }] }]);
  });

  it("drains a mixed node but still reports the unmovable leftovers", () => {
    const a = assessEvacuation(
      [
        {
          name: "a",
          services: [
            { project: owner, service: "web" }, // movable
            { project: "blog", service: "api" }, // unmovable (other project)
          ],
        },
      ],
      owner,
      clusterPlaced,
    );
    expect(a.drainNodes).toEqual(["a"]);
    expect(a.unmovable).toEqual([{ name: "a", services: [{ project: "blog", service: "api" }] }]);
  });

  it("drains every target node that hosts a movable service", () => {
    const a = assessEvacuation(
      [
        { name: "a", services: [{ project: owner, service: "web" }] },
        { name: "b", services: [{ project: owner, service: "worker" }, { project: "blog", service: "x" }] },
        { name: "c", services: [] },
      ],
      owner,
      clusterPlaced,
    );
    expect(a.drainNodes).toEqual(["a", "b"]);
    expect(a.unmovable).toEqual([{ name: "b", services: [{ project: "blog", service: "x" }] }]);
  });

  it("returns nothing for an empty node (already safe to destroy)", () => {
    const a = assessEvacuation([{ name: "a", services: [] }], owner, clusterPlaced);
    expect(a.drainNodes).toEqual([]);
    expect(a.unmovable).toEqual([]);
  });
});

describe("assessExternalReconcile", () => {
  const now = Date.parse("2026-06-20T00:00:00.000Z");

  it("marks a live external provisioning node ready", () => {
    expect(
      assessExternalReconcile(
        { provisioning: "external", state: "provisioning" },
        "2026-06-19T23:59:45.000Z",
        now,
      ),
    ).toEqual({ heartbeat: "live", action: "mark-ready" });
  });

  it("flags stale external ready nodes for operator action", () => {
    expect(
      assessExternalReconcile(
        { provisioning: "external", state: "ready" },
        "2026-06-19T23:58:00.000Z",
        now,
      ),
    ).toEqual({ heartbeat: "stale", action: "operator-action" });
  });

  it("ignores EC2 entries", () => {
    expect(
      assessExternalReconcile(
        { provisioning: "ec2", state: "ready" },
        "2026-06-19T23:58:00.000Z",
        now,
      ),
    ).toEqual({ heartbeat: "stale", action: "noop" });
  });
});

interface SentCommand {
  client: string;
  kind: string;
  input: Record<string, unknown>;
}

/** A fake AwsEnv whose ec2/iam/s3 clients record (and no-op) every command sent. */
function makeRecordingAws(sent: SentCommand[], opts: { iamError?: Error } = {}): AwsEnv {
  const client = (name: string) => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    send: async (command: any): Promise<unknown> => {
      sent.push({ client: name, kind: command.constructor.name, input: command.input ?? {} });
      if (name === "iam" && opts.iamError) throw opts.iamError;
      // Resolve terminateInstance's waitUntilInstanceTerminated immediately.
      if (command.constructor.name === "DescribeInstancesCommand") {
        const id = (command.input?.InstanceIds ?? ["i-x"])[0];
        return { Reservations: [{ Instances: [{ InstanceId: id, State: { Name: "terminated" } }] }] };
      }
      if (command.constructor.name === "ListObjectsV2Command") {
        const prefix = command.input?.Prefix as string | undefined;
        return {
          Contents: prefix?.endsWith("/")
            ? [{ Key: `${prefix}node.json` }, { Key: `${prefix}agent.cjs` }]
            : [],
        };
      }
      return {};
    },
  });
  return {
    clusterId: DEFAULT_CLUSTER,
    bucket: "bucket",
    ec2: client("ec2"),
    iam: client("iam"),
    s3: client("s3"),
  } as unknown as AwsEnv;
}

function node(patch: Partial<NodeRegistryEntry> = {}): NodeRegistryEntry {
  return {
    nodeId: "node-1",
    clusterId: DEFAULT_CLUSTER,
    instanceId: "i-123",
    eipAllocationId: "eipalloc-1",
    securityGroupId: "sg-1",
    ...patch,
  } as NodeRegistryEntry;
}

describe("teardownNode — per-node IAM cleanup", () => {
  it("deletes the node's per-node IAM role + instance profile", async () => {
    const sent: SentCommand[] = [];
    await teardownNode(makeRecordingAws(sent), node());

    const iam = sent.filter((c) => c.client === "iam");
    const kinds = iam.map((c) => c.kind);
    expect(kinds).toContain("DeleteRoleCommand");
    expect(kinds).toContain("DeleteInstanceProfileCommand");
    expect(kinds).toContain("RemoveRoleFromInstanceProfileCommand");

    const del = iam.find((c) => c.kind === "DeleteRoleCommand");
    expect(del?.input.RoleName).toBe(nodeRoleName(DEFAULT_CLUSTER, "node-1"));
    const profile = iam.find((c) => c.kind === "DeleteInstanceProfileCommand");
    expect(profile?.input.InstanceProfileName).toBe(nodeProfileName(DEFAULT_CLUSTER, "node-1"));
  });

  it("still tears down EC2 + S3 even though it also deletes IAM", async () => {
    const sent: SentCommand[] = [];
    await teardownNode(makeRecordingAws(sent), node());
    const kinds = sent.map((c) => `${c.client}:${c.kind}`);
    expect(kinds).toContain("ec2:TerminateInstancesCommand");
    expect(kinds).toContain("ec2:ReleaseAddressCommand");
    expect(kinds).toContain("ec2:DeleteSecurityGroupCommand");
    expect(kinds).toContain("s3:ListObjectsV2Command");
    expect(kinds).toContain("s3:DeleteObjectsCommand");
  });

  it("is best-effort — an IAM failure does not abort the teardown", async () => {
    const sent: SentCommand[] = [];
    const aws = makeRecordingAws(sent, { iamError: new Error("AccessDenied") });
    // The other teardown steps still run; the call resolves rather than throwing.
    await expect(teardownNode(aws, node())).resolves.toBeUndefined();
    expect(sent.some((c) => c.client === "s3")).toBe(true);
  });

  it("cordons an external node before deleting its IAM user and S3 state", async () => {
    const sent: SentCommand[] = [];
    await teardownNode(
      makeRecordingAws(sent),
      node({
        instanceId: null,
        eipAllocationId: null,
        securityGroupId: null,
        provisioning: "external",
        iamUserName: "launch-pad-node-default-node-1",
        state: "ready",
      }),
    );

    const s3 = sent.filter((c) => c.client === "s3");
    const cordon = s3.find((c) => c.kind === "PutObjectCommand");
    expect(cordon?.input.Key).toBe("nodes/node-1/node.json");
    expect(JSON.parse(cordon?.input.Body as string).state).toBe("terminating");
    expect(sent.map((c) => `${c.client}:${c.kind}`)).toContain("iam:DeleteUserCommand");
    expect(sent.map((c) => `${c.client}:${c.kind}`)).toContain("s3:DeleteObjectsCommand");
  });
});
