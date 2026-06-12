import { setTimeout as sleep } from "node:timers/promises";
import {
  AllocateAddressCommand,
  AssociateAddressCommand,
  AuthorizeSecurityGroupIngressCommand,
  CreateSecurityGroupCommand,
  DeleteSecurityGroupCommand,
  DescribeAddressesCommand,
  DescribeInstancesCommand,
  DescribeInstanceTypesCommand,
  DescribeSecurityGroupsCommand,
  DescribeVpcsCommand,
  DisassociateAddressCommand,
  type EC2Client,
  type Instance,
  type IpPermission,
  ModifyInstanceAttributeCommand,
  ReleaseAddressCommand,
  RunInstancesCommand,
  type RunInstancesCommandInput,
  StartInstancesCommand,
  StopInstancesCommand,
  TerminateInstancesCommand,
  waitUntilInstanceRunning,
  waitUntilInstanceStopped,
  waitUntilInstanceTerminated,
} from "@aws-sdk/client-ec2";
import {
  HOST_PORT_MAX,
  HOST_PORT_MIN,
  type InstanceCapacity,
  type NodeRole,
  nodeResourceTags,
  nodeUsesElasticIp,
  rawToCapacity,
} from "@agentsystemlabs/launch-pad-shared";
import { CliError } from "../errors";
import { awsErrorName, isEc2InstanceNotFound, isEc2SecurityGroupNotFound } from "./errors";
import { ensureEc2ResourceTags, ensureSecurityGroupTags } from "./tags";

// AWS is eventually consistent: a resource you just created (an instance profile,
// a security group's freed ENI) can be briefly invisible to the next call. These
// bound the retry loops that absorb that window. Tuned per-operation because the
// inconsistency windows differ.
const MAX_CONSISTENCY_RETRIES = 6;
/** Backoff after RunInstances rejects a not-yet-visible fresh instance profile. */
const RUN_INSTANCE_RETRY_MS = 2500;
/** Backoff while a terminated instance's ENI still pins its security group. */
const SECURITY_GROUP_RETRY_MS = 5000;

// EC2 state-transition waiter ceilings (seconds). "running" is quick; stop and
// terminate involve a full guest shutdown, so they get longer.
const WAIT_RUNNING_SECONDS = 180;
const WAIT_STOPPED_SECONDS = 240;
const WAIT_TERMINATED_SECONDS = 240;

export async function getDefaultVpcId(ec2: EC2Client): Promise<string> {
  const res = await ec2.send(
    new DescribeVpcsCommand({ Filters: [{ Name: "isDefault", Values: ["true"] }] }),
  );
  const id = res.Vpcs?.[0]?.VpcId;
  if (!id) {
    throw new CliError("no default VPC found in this region", {
      hint: "create a default VPC (custom networking is not supported yet)",
    });
  }
  return id;
}

/** Capacity for any instance type via the EC2 API (fallback for unknown types). */
export async function describeInstanceTypeCapacity(
  ec2: EC2Client,
  instanceType: string,
): Promise<InstanceCapacity | null> {
  try {
    const res = await ec2.send(
      new DescribeInstanceTypesCommand({ InstanceTypes: [instanceType as never] }),
    );
    const info = res.InstanceTypes?.[0];
    const vcpu = info?.VCpuInfo?.DefaultVCpus;
    const memoryMiB = info?.MemoryInfo?.SizeInMiB;
    if (vcpu == null || memoryMiB == null) return null;
    return rawToCapacity({ vcpu, memoryMiB });
  } catch {
    return null;
  }
}

export interface SecurityGroupOptions {
  ssh: boolean;
  role: NodeRole;
  /** For an app node: the edge SG allowed to reach the host-port range (no public ingress). */
  edgeSecurityGroupId?: string | undefined;
}

export interface SecurityGroupTagContext {
  clusterId: string;
  nodeId: string;
}

export async function ensureSecurityGroup(
  ec2: EC2Client,
  name: string,
  vpcId: string,
  opts: SecurityGroupOptions,
  tagCtx: SecurityGroupTagContext,
): Promise<string> {
  const tags = nodeResourceTags({
    clusterId: tagCtx.clusterId,
    nodeId: tagCtx.nodeId,
    role: opts.role,
  });

  const existing = await ec2.send(
    new DescribeSecurityGroupsCommand({
      Filters: [
        { Name: "group-name", Values: [name] },
        { Name: "vpc-id", Values: [vpcId] },
      ],
    }),
  );
  const found = existing.SecurityGroups?.[0]?.GroupId;
  if (found) {
    await ensureSecurityGroupTags(ec2, found, tags);
    return found;
  }

  const created = await ec2.send(
    new CreateSecurityGroupCommand({
      GroupName: name,
      Description: `launchpad ${opts.role} node ingress`,
      VpcId: vpcId,
    }),
  );
  const sgId = created.GroupId;
  if (!sgId) throw new CliError(`failed to create security group ${name}`);
  await ensureSecurityGroupTags(ec2, sgId, tags);

  const perms: IpPermission[] = [];
  if (opts.role === "edge") {
    // Public HTTP/HTTPS — this node terminates TLS.
    perms.push(
      { IpProtocol: "tcp", FromPort: 80, ToPort: 80, IpRanges: [{ CidrIp: "0.0.0.0/0", Description: "http" }] },
      { IpProtocol: "tcp", FromPort: 443, ToPort: 443, IpRanges: [{ CidrIp: "0.0.0.0/0", Description: "https" }] },
    );
  }
  if (opts.role === "app") {
    // App containers reachable ONLY by the edge SG, on the host-port range.
    if (!opts.edgeSecurityGroupId) {
      throw new CliError("an app node needs an edge to reach it", {
        hint: "pass --edge <edge-node-id> when creating an app node",
      });
    }
    perms.push({
      IpProtocol: "tcp",
      FromPort: HOST_PORT_MIN,
      ToPort: HOST_PORT_MAX,
      UserIdGroupPairs: [{ GroupId: opts.edgeSecurityGroupId, Description: "edge to app host ports" }],
    });
  }
  if (opts.ssh) {
    perms.push({
      IpProtocol: "tcp",
      FromPort: 22,
      ToPort: 22,
      IpRanges: [{ CidrIp: "0.0.0.0/0", Description: "ssh" }],
    });
  }
  if (perms.length > 0) {
    await ec2.send(new AuthorizeSecurityGroupIngressCommand({ GroupId: sgId, IpPermissions: perms }));
  }
  return sgId;
}

export interface RunNodeParams {
  imageId: string;
  instanceType: string;
  userData: string;
  securityGroupId: string;
  instanceProfileName: string;
  keyName?: string;
  clusterId: string;
  nodeId: string;
  role: NodeRole;
}

export async function runNode(ec2: EC2Client, p: RunNodeParams): Promise<string> {
  const ec2Tags = nodeResourceTags({
    clusterId: p.clusterId,
    nodeId: p.nodeId,
    role: p.role,
  }).map((t) => ({ Key: t.Key, Value: t.Value }));

  // Both roles get a public IPv4 from the default subnet. For the edge it's the
  // ingress address (soon replaced by a stable Elastic IP); for app nodes it is
  // EGRESS-ONLY — launchpad provisions no NAT gateway / VPC endpoints, so an app
  // node needs outbound internet to pull from ECR and read S3 to bootstrap. App
  // nodes stay private at the INBOUND edge: their security group admits only the
  // edge's security group, so nothing on the internet can reach their services.
  const input: RunInstancesCommandInput = {
    ImageId: p.imageId,
    InstanceType: p.instanceType as RunInstancesCommandInput["InstanceType"],
    MinCount: 1,
    MaxCount: 1,
    SecurityGroupIds: [p.securityGroupId],
    IamInstanceProfile: { Name: p.instanceProfileName },
    UserData: Buffer.from(p.userData).toString("base64"),
    MetadataOptions: { HttpTokens: "required", HttpEndpoint: "enabled" },
    TagSpecifications: [
      { ResourceType: "instance", Tags: ec2Tags },
      { ResourceType: "volume", Tags: ec2Tags },
    ],
    ...(p.keyName ? { KeyName: p.keyName } : {}),
  };

  // A freshly-created instance profile may not be visible to RunInstances yet.
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await ec2.send(new RunInstancesCommand(input));
      const id = res.Instances?.[0]?.InstanceId;
      if (!id) throw new CliError("RunInstances returned no instance id");
      return id;
    } catch (error) {
      const name = awsErrorName(error);
      const retriable =
        name === "InvalidParameterValue" || name === "InvalidIamInstanceProfile";
      if (retriable && attempt < MAX_CONSISTENCY_RETRIES) {
        await sleep(RUN_INSTANCE_RETRY_MS);
        continue;
      }
      throw error;
    }
  }
}

export interface InstanceNetwork {
  publicIp: string | null;
  privateIp: string | null;
  availabilityZone: string | null;
}

export async function waitForRunning(
  ec2: EC2Client,
  instanceId: string,
): Promise<InstanceNetwork> {
  await waitUntilInstanceRunning(
    { client: ec2, maxWaitTime: WAIT_RUNNING_SECONDS },
    { InstanceIds: [instanceId] },
  );
  const res = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
  const inst = res.Reservations?.[0]?.Instances?.[0];
  return {
    publicIp: inst?.PublicIpAddress ?? null,
    privateIp: inst?.PrivateIpAddress ?? null,
    availabilityZone: inst?.Placement?.AvailabilityZone ?? null,
  };
}

/**
 * A node's EC2 instance as drift reconciliation sees it — the live EC2 state
 * normalized to the cases the registry cares about. `missing` covers terminated,
 * fully deregistered, or "exists in another account/region we can't see".
 */
export type Ec2Observation =
  | { kind: "running"; publicIp: string | null; privateIp: string | null; availabilityZone: string | null }
  | { kind: "stopped" }
  | { kind: "transitional"; state: string }
  | { kind: "missing" };

function observationFromInstance(inst: Instance): Ec2Observation {
  const state = inst.State?.Name ?? "unknown";
  if (state === "running") {
    return {
      kind: "running",
      publicIp: inst.PublicIpAddress ?? null,
      privateIp: inst.PrivateIpAddress ?? null,
      availabilityZone: inst.Placement?.AvailabilityZone ?? null,
    };
  }
  if (state === "stopped") return { kind: "stopped" };
  if (state === "terminated") return { kind: "missing" };
  // pending, stopping, shutting-down, rebooting, or anything unexpected → not stable yet.
  return { kind: "transitional", state };
}

/**
 * Observe a batch of instances by id in one call. Uses an `instance-id` filter
 * (not `InstanceIds`) so ids that no longer exist are simply absent from the
 * result rather than throwing `InvalidInstanceID.NotFound` for the whole batch —
 * any requested id we don't see back is reported as `missing`.
 */
export async function describeInstancesById(
  ec2: EC2Client,
  ids: string[],
): Promise<Map<string, Ec2Observation>> {
  const out = new Map<string, Ec2Observation>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return out;

  let token: string | undefined;
  do {
    const res = await ec2.send(
      new DescribeInstancesCommand({
        Filters: [{ Name: "instance-id", Values: unique }],
        ...(token ? { NextToken: token } : {}),
      }),
    );
    for (const reservation of res.Reservations ?? []) {
      for (const inst of reservation.Instances ?? []) {
        if (inst.InstanceId) out.set(inst.InstanceId, observationFromInstance(inst));
      }
    }
    token = res.NextToken;
  } while (token);

  for (const id of unique) {
    if (!out.has(id)) out.set(id, { kind: "missing" });
  }
  return out;
}

export async function terminateInstance(ec2: EC2Client, instanceId: string): Promise<void> {
  try {
    await ec2.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
  } catch (error) {
    if (isEc2InstanceNotFound(error)) return;
    throw error;
  }
  try {
    await waitUntilInstanceTerminated(
      { client: ec2, maxWaitTime: WAIT_TERMINATED_SECONDS },
      { InstanceIds: [instanceId] },
    );
  } catch (error) {
    if (isEc2InstanceNotFound(error)) return;
    throw error;
  }
}

export async function deleteSecurityGroup(ec2: EC2Client, groupId: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await ec2.send(new DeleteSecurityGroupCommand({ GroupId: groupId }));
      return;
    } catch (error) {
      if (isEc2SecurityGroupNotFound(error)) return;
      // The instance's network interface can linger briefly after termination.
      if (awsErrorName(error) === "DependencyViolation" && attempt < MAX_CONSISTENCY_RETRIES) {
        await sleep(SECURITY_GROUP_RETRY_MS);
        continue;
      }
      throw error;
    }
  }
}

// ── Elastic IP (stable public IP that survives stop/start) ───────────────────────

export interface NodeEip {
  allocationId: string;
  publicIp: string;
  associationId: string | null;
  instanceId: string | null;
}

/** Find an existing Elastic IP tagged for this node (reused across re-provisions). */
export async function findNodeEip(ec2: EC2Client, nodeId: string): Promise<NodeEip | null> {
  const res = await ec2.send(
    new DescribeAddressesCommand({ Filters: [{ Name: "tag:launch-pad:node", Values: [nodeId] }] }),
  );
  const addr = res.Addresses?.[0];
  if (!addr?.AllocationId || !addr.PublicIp) return null;
  return {
    allocationId: addr.AllocationId,
    publicIp: addr.PublicIp,
    associationId: addr.AssociationId ?? null,
    instanceId: addr.InstanceId ?? null,
  };
}

/** Ensure the node has an Elastic IP (reuse the tagged one or allocate) and point it
 * at the instance. Returns the stable IP + its allocation id. */
export interface EipTagContext {
  clusterId: string;
  nodeId: string;
  role: NodeRole;
}

export async function ensureEipForInstance(
  ec2: EC2Client,
  tagCtx: EipTagContext,
  instanceId: string,
): Promise<{ allocationId: string; publicIp: string }> {
  const eipTags = nodeResourceTags({
    clusterId: tagCtx.clusterId,
    nodeId: tagCtx.nodeId,
    role: tagCtx.role,
  }).map((t) => ({ Key: t.Key, Value: t.Value }));

  let eip = await findNodeEip(ec2, tagCtx.nodeId);
  if (!eip) {
    const allocated = await ec2.send(
      new AllocateAddressCommand({
        Domain: "vpc",
        TagSpecifications: [{ ResourceType: "elastic-ip", Tags: eipTags }],
      }),
    );
    if (!allocated.AllocationId || !allocated.PublicIp) {
      throw new CliError("failed to allocate an Elastic IP");
    }
    eip = {
      allocationId: allocated.AllocationId,
      publicIp: allocated.PublicIp,
      associationId: null,
      instanceId: null,
    };
  } else {
    await ensureEc2ResourceTags(ec2, eip.allocationId, nodeResourceTags(tagCtx));
  }

  await ec2.send(
    new AssociateAddressCommand({ AllocationId: eip.allocationId, InstanceId: instanceId }),
  );
  return { allocationId: eip.allocationId, publicIp: eip.publicIp };
}

/** Disassociate (if needed) and release an Elastic IP. */
export async function releaseEip(ec2: EC2Client, allocationId: string): Promise<void> {
  try {
    const res = await ec2.send(
      new DescribeAddressesCommand({ AllocationIds: [allocationId] }),
    );
    const assoc = res.Addresses?.[0]?.AssociationId;
    if (assoc) {
      await ec2.send(new DisassociateAddressCommand({ AssociationId: assoc }));
    }
    await ec2.send(new ReleaseAddressCommand({ AllocationId: allocationId }));
  } catch (error) {
    // Already released / not found — nothing to do.
    if (awsErrorName(error) === "InvalidAllocationID.NotFound") return;
    throw error;
  }
}

// ── stop / start (pause to save money) ───────────────────────────────────────────

export async function stopInstance(ec2: EC2Client, instanceId: string): Promise<void> {
  await ec2.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
  await waitUntilInstanceStopped(
    { client: ec2, maxWaitTime: WAIT_STOPPED_SECONDS },
    { InstanceIds: [instanceId] },
  );
}

export async function startInstance(ec2: EC2Client, instanceId: string): Promise<InstanceNetwork> {
  await ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
  return waitForRunning(ec2, instanceId);
}

// ── resize (change instance type) ────────────────────────────────────────────────

/**
 * Change an instance's type. EC2 requires the instance to be **stopped** first;
 * callers (`resizeNode`) stop → modify → start. AWS rejects incompatible swaps
 * (e.g. across architectures / virtualization types) — that error surfaces to the
 * caller unchanged.
 */
export async function modifyInstanceType(
  ec2: EC2Client,
  instanceId: string,
  instanceType: string,
): Promise<void> {
  await ec2.send(
    new ModifyInstanceAttributeCommand({
      InstanceId: instanceId,
      InstanceType: { Value: instanceType },
    }),
  );
}
