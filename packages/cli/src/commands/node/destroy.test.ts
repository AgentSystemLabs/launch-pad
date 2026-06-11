import { DEFAULT_CLUSTER, type NodeRegistryEntry } from "@agentsystemlabs/launch-pad-shared";
import { describe, expect, it } from "vitest";
import type { AwsEnv } from "../../aws/context";
import { nodeProfileName, nodeRoleName } from "../../aws/iam";
import { nodesThatWouldOrphan, parseNodeNames, teardownNode } from "./index";

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
    expect(kinds.filter((k) => k === "s3:DeleteObjectCommand").length).toBe(3); // status + desired + node.json
  });

  it("is best-effort — an IAM failure does not abort the teardown", async () => {
    const sent: SentCommand[] = [];
    const aws = makeRecordingAws(sent, { iamError: new Error("AccessDenied") });
    // The other teardown steps still run; the call resolves rather than throwing.
    await expect(teardownNode(aws, node())).resolves.toBeUndefined();
    expect(sent.some((c) => c.client === "s3")).toBe(true);
  });
});
