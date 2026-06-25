import {
  agentIdForNode,
  DEFAULT_CLUSTER,
  DEFAULT_RESERVED_CPU,
  DEFAULT_RESERVED_MEMORY,
  type InstanceCapacity,
  INSTANCE_CAPACITY_TABLE,
  lookupInstanceCapacity,
  type NodeRegistryEntry,
  type NodeRole,
  nodeFrontsIngress,
  nodeRegistryKey,
  nodeUsesElasticIp,
  parseNodeRegistryEntry,
} from "@agentsystemlabs/launch-pad-shared";
import type { AwsEnv } from "../aws/context";
import {
  describeInstanceTypeCapacity,
  describeInstancesById,
  ensureEipForInstance,
  ensureSecurityGroup,
  getDefaultVpcId,
  modifyInstanceType,
  releaseEip,
  runNode,
  startInstance,
  stopInstance,
  terminateInstance,
  waitForRunning,
} from "../aws/ec2";
import { ensureNodeIam } from "../aws/iam";
import { getJson, PreconditionFailedError, putJson } from "../aws/s3-state";
import { resolveLatestAl2023Ami } from "../aws/ssm";
import { adoptEdgeIfUnset, ensureClusterConfig } from "../cluster/store";
import { CliError } from "../errors";
import { DEFAULT_AGENT_TYPE, presignAgentBinary, uploadAgentBinary } from "./agent-bundle";
import type { AmiBootstrapMode } from "./golden-ami";
import { planResizedEntry } from "./resize-plan";
import { renderUserData } from "./user-data";

function nowIso(): string {
  return new Date().toISOString();
}

export function securityGroupName(nodeId: string): string {
  return `launch-pad-${nodeId}-sg`;
}

/** Capacity for an instance type from the static table, else the EC2 API. */
export async function resolveCapacity(aws: AwsEnv, instanceType: string): Promise<InstanceCapacity> {
  const fromTable = lookupInstanceCapacity(instanceType);
  if (fromTable) return fromTable;
  const fromApi = await describeInstanceTypeCapacity(aws.ec2, instanceType);
  if (fromApi) return fromApi;
  throw new CliError(`could not determine capacity for instance type "${instanceType}"`, {
    hint: `known types: ${Object.keys(INSTANCE_CAPACITY_TABLE).join(", ")}`,
  });
}

export interface ProvisionNodeParams {
  aws: AwsEnv;
  nodeId: string;
  role: NodeRole;
  instanceType: string;
  agentVersion: string;
  /** Pre-resolved capacity (deploy auto-sizes); resolved from the type when absent. */
  capacity?: InstanceCapacity;
  /** Pre-resolved AMI / VPC, so a batch of nodes doesn't re-resolve per node. */
  amiId?: string;
  amiBootstrapMode?: AmiBootstrapMode;
  vpcId?: string;
  /** The edge node fronting this node — required when role === "app". */
  edgeNodeId?: string;
  keyName?: string;
  /** Spinner bridge: called with the current step label. */
  onProgress?: (text: string) => void;
}

/**
 * Provision one EC2 node end-to-end and write its registry entry — the UI-free
 * core shared by `node create` and `deploy`'s auto-provisioning. Performs no
 * prompting/spinner/output of its own (callers own that via `onProgress`).
 */
export async function provisionNode(p: ProvisionNodeParams): Promise<NodeRegistryEntry> {
  const { aws, nodeId, role } = p;
  const report = p.onProgress ?? (() => {});

  const capacity = p.capacity ?? (await resolveCapacity(aws, p.instanceType));
  const amiId = p.amiId ?? (await resolveLatestAl2023Ami(aws.ssm));
  const vpcId = p.vpcId ?? (await getDefaultVpcId(aws.ec2));

  const agentConfig = {
    nodeId,
    agentId: agentIdForNode(nodeId),
    bucket: aws.bucket,
    region: aws.region,
    clusterId: aws.clusterId,
    role,
  };

  const amiBootstrapMode = p.amiBootstrapMode ?? "full";
  const needsDownload = amiBootstrapMode === "full";
  const binaryRole = role === "app" ? "app" : "edge";
  report("uploading agent binary");
  await uploadAgentBinary(aws.s3, aws.bucket, aws.clusterId, nodeId, binaryRole);
  let agentBinaryUrl: string | undefined;
  if (needsDownload) {
    agentBinaryUrl = await presignAgentBinary(aws.s3, aws.bucket, aws.clusterId, nodeId);
  } else {
    report("using baked agent binary");
  }
  const userData = renderUserData({ agent: agentConfig, agentBinaryUrl, bootstrapMode: amiBootstrapMode });

  report("ensuring IAM role + instance profile");
  const { profileName } = await ensureNodeIam(aws.iam, {
    clusterId: aws.clusterId,
    nodeId,
    role,
    bucket: aws.bucket,
    region: aws.region,
    accountId: aws.accountId,
  });

  // An app node's containers are reachable only by its edge's security group.
  let edgeSecurityGroupId: string | undefined;
  if (role === "app") {
    if (!p.edgeNodeId) {
      throw new CliError(`app node "${nodeId}" needs an edge to reach it`, {
        hint: "pass an edge node — an app node is private and only its edge can route to it",
      });
    }
    const edgeObj = await getJson(aws.s3, aws.bucket, nodeRegistryKey(aws.clusterId, p.edgeNodeId));
    if (!edgeObj) {
      throw new CliError(`edge node "${p.edgeNodeId}" does not exist in cluster "${aws.clusterId}"`);
    }
    const edgeEntry = parseNodeRegistryEntry(edgeObj.raw);
    if (!nodeFrontsIngress(edgeEntry.role)) {
      throw new CliError(`node "${p.edgeNodeId}" is not an edge (role=${edgeEntry.role})`);
    }
    edgeSecurityGroupId = edgeEntry.securityGroupId ?? undefined;
    if (!edgeSecurityGroupId) {
      throw new CliError(`edge node "${p.edgeNodeId}" has no security group to reference`);
    }
  }

  report("ensuring security group");
  const sgId = await ensureSecurityGroup(
    aws.ec2,
    securityGroupName(nodeId),
    vpcId,
    {
      ssh: p.keyName !== undefined,
      role,
      edgeSecurityGroupId,
    },
    { clusterId: aws.clusterId, nodeId },
  );

  report(`launching ${p.instanceType}`);
  const instanceId = await runNode(aws.ec2, {
    imageId: amiId,
    instanceType: p.instanceType,
    userData,
    securityGroupId: sgId,
    instanceProfileName: profileName,
    clusterId: aws.clusterId,
    nodeId,
    role,
    ...(p.keyName ? { keyName: p.keyName } : {}),
  });

  // The instance now exists and is billing. If ANY later step fails (EIP quota,
  // registry write, …) tear it down so a partial provision can't strand a running
  // instance the registry doesn't know about — `cluster destroy` only sees nodes
  // with a node.json, so an orphan here would never get cleaned up.
  let eipAllocationId: string | null = null;
  try {
    report(`waiting for ${instanceId} to start`);
    let network = {
      publicIp: null as string | null,
      privateIp: null as string | null,
      availabilityZone: null as string | null,
    };
    try {
      network = await waitForRunning(aws.ec2, instanceId);
    } catch {
      report(`instance ${instanceId} launched but did not reach 'running' in time`);
    }

    let publicIp: string | null = null;
    if (nodeUsesElasticIp(role)) {
      report("assigning a stable Elastic IP");
      const eip = await ensureEipForInstance(
        aws.ec2,
        { clusterId: aws.clusterId, nodeId, role },
        instanceId,
      );
      publicIp = eip.publicIp;
      eipAllocationId = eip.allocationId;
    } else {
      report("VPC-private instance (no public IP)");
    }

    const entry: NodeRegistryEntry = {
      nodeId,
      clusterId: aws.clusterId,
      instanceId,
      instanceType: p.instanceType,
      region: aws.region,
      availabilityZone: network.availabilityZone,
      role,
      privateIp: network.privateIp,
      totalCpu: capacity.totalCpu,
      totalMemory: capacity.totalMemory,
      reservedCpu: DEFAULT_RESERVED_CPU,
      reservedMemory: DEFAULT_RESERVED_MEMORY,
      publicIp,
      eipAllocationId,
      securityGroupId: sgId,
      iamInstanceProfile: profileName,
      provisioning: "ec2",
      advertiseIp: null,
      iamUserName: null,
      agentId: agentIdForNode(nodeId),
      agentVersion: p.agentVersion,
      agentType: DEFAULT_AGENT_TYPE,
      createdAt: nowIso(),
      createdBy: aws.callerArn,
      state: "provisioning",
    };

    try {
      await putJson(aws.s3, aws.bucket, nodeRegistryKey(aws.clusterId, nodeId), entry, {
        ifNoneMatch: "*",
      });
    } catch (error) {
      if (error instanceof PreconditionFailedError) {
        throw new CliError(`node "${nodeId}" already exists`);
      }
      throw error;
    }

    // Wire the node into its (named) cluster: ensure cluster.json exists, and let
    // the first edge node become the cluster's default edge.
    if (aws.clusterId !== DEFAULT_CLUSTER) {
      await ensureClusterConfig(aws, aws.clusterId);
      if (role !== "app") await adoptEdgeIfUnset(aws, aws.clusterId, nodeId);
    }

    return entry;
  } catch (error) {
    report(`provisioning failed after launch — terminating instance ${instanceId}`);
    try {
      await terminateInstance(aws.ec2, instanceId);
    } catch {
      /* best-effort — surface the original failure below */
    }
    if (eipAllocationId) {
      try {
        await releaseEip(aws.ec2, eipAllocationId);
      } catch {
        /* best-effort */
      }
    }
    throw error;
  }
}

/** Start a paused node back up and flip its registry state to `ready`. UI-free. */
export async function resumeNode(aws: AwsEnv, node: NodeRegistryEntry): Promise<NodeRegistryEntry> {
  if (!node.instanceId) {
    throw new CliError(`node "${node.nodeId}" has no instance to resume`);
  }
  const net = await startInstance(aws.ec2, node.instanceId);
  const publicIp = nodeUsesElasticIp(node.role)
    ? node.eipAllocationId
      ? node.publicIp
      : net.publicIp
    : null;
  const updated: NodeRegistryEntry = {
    ...node,
    state: "ready",
    publicIp,
    privateIp: net.privateIp ?? node.privateIp,
    availabilityZone: net.availabilityZone,
  };
  await putJson(aws.s3, aws.bucket, nodeRegistryKey(node.clusterId, node.nodeId), updated);
  return updated;
}

export interface ResizeNodeParams {
  aws: AwsEnv;
  /** The node to resize (must already have an instance). */
  node: NodeRegistryEntry;
  /** The instance type to resize to. */
  instanceType: string;
  /** Pre-resolved capacity of the target type (so the caller can show/validate it). */
  capacity: InstanceCapacity;
  onProgress?: (text: string) => void;
}

/**
 * Resize a node's EC2 instance to a different type, in place under the same node
 * identity. EC2 can only change the type of a **stopped** instance, so this is a
 * stop → modify → start sequence — the node's services are briefly down while the
 * instance swaps (edge ⇒ ingress downtime; app ⇒ that node's containers).
 *
 * Running/paused intent is preserved: a node that was up comes back up (`ready`);
 * a paused node stays `stopped`, just with new capacity. The registry entry's
 * `instanceType` + capacity are updated, and the network is refreshed on restart
 * (an Elastic IP survives the cycle; an ephemeral public IP / private IP may
 * change). `desired.json` is untouched so the agent reconciles on boot. UI-free.
 */
export async function resizeNode(p: ResizeNodeParams): Promise<NodeRegistryEntry> {
  const { aws, node } = p;
  const report = p.onProgress ?? (() => {});
  if (!node.instanceId) {
    throw new CliError(`node "${node.nodeId}" has no instance to resize`);
  }

  // Preserve running/paused intent: only restart if the instance was up to begin
  // with. A terminated instance can't be resized — point the user at reconcile.
  const obs = (await describeInstancesById(aws.ec2, [node.instanceId])).get(node.instanceId);
  if (obs?.kind === "missing") {
    throw new CliError(`node "${node.nodeId}"'s instance ${node.instanceId} is gone`, {
      hint: "replace it with `launchpad node reconcile`",
    });
  }
  const restarted = obs?.kind !== "stopped";

  report(`stopping ${node.instanceId}`);
  await stopInstance(aws.ec2, node.instanceId);

  report(`changing instance type to ${p.instanceType}`);
  await modifyInstanceType(aws.ec2, node.instanceId, p.instanceType);

  let network:
    | { publicIp: string | null; privateIp: string | null; availabilityZone: string | null }
    | undefined;
  if (restarted) {
    report(`starting ${node.instanceId}`);
    network = await startInstance(aws.ec2, node.instanceId);
  }

  const updated = planResizedEntry({
    node,
    instanceType: p.instanceType,
    capacity: p.capacity,
    restarted,
    network,
  });
  await putJson(aws.s3, aws.bucket, nodeRegistryKey(node.clusterId, node.nodeId), updated);
  return updated;
}

export interface ReplaceInstanceParams {
  aws: AwsEnv;
  /** The existing registry entry whose EC2 instance is gone (terminated). */
  node: NodeRegistryEntry;
  /** Agent version to install on the replacement (the caller's CLI version). */
  agentVersion: string;
  amiId?: string;
  amiBootstrapMode?: AmiBootstrapMode;
  onProgress?: (text: string) => void;
}

/**
 * Replace a terminated/missing instance under the SAME node identity — reuse the
 * node's preserved security group and IAM instance profile (and Elastic IP when
 * the edge); only the
 * EC2 instance is new. Overwrites the registry entry in place (keeps capacity,
 * createdAt, role) and leaves `desired.json` untouched so the agent reconciles on
 * boot. UI-free.
 */
export async function replaceInstance(p: ReplaceInstanceParams): Promise<NodeRegistryEntry> {
  const { aws, node } = p;
  const report = p.onProgress ?? (() => {});
  const { nodeId, role } = node;

  if (!node.securityGroupId || !node.iamInstanceProfile) {
    throw new CliError(
      `node "${nodeId}" can't be recreated — its security group or IAM profile is gone`,
      { hint: "recreate its supporting resources with `launchpad node destroy` then `node create`" },
    );
  }

  const amiId = p.amiId ?? (await resolveLatestAl2023Ami(aws.ssm));

  const agentConfig = {
    nodeId,
    agentId: agentIdForNode(nodeId),
    bucket: aws.bucket,
    region: aws.region,
    clusterId: aws.clusterId,
    role,
  };

  const amiBootstrapMode = p.amiBootstrapMode ?? "full";
  const needsDownload = amiBootstrapMode === "full";
  report("uploading agent binary");
  await uploadAgentBinary(aws.s3, aws.bucket, aws.clusterId, nodeId, role === "app" ? "app" : "edge");
  let agentBinaryUrl: string | undefined;
  if (needsDownload) {
    agentBinaryUrl = await presignAgentBinary(aws.s3, aws.bucket, aws.clusterId, nodeId);
  } else {
    report("using baked agent binary");
  }
  const userData = renderUserData({ agent: agentConfig, agentBinaryUrl, bootstrapMode: amiBootstrapMode });

  report(`launching ${node.instanceType}`);
  const instanceId = await runNode(aws.ec2, {
    imageId: amiId,
    instanceType: node.instanceType,
    userData,
    securityGroupId: node.securityGroupId,
    instanceProfileName: node.iamInstanceProfile,
    clusterId: aws.clusterId,
    nodeId,
    role,
  });

  report(`waiting for ${instanceId} to start`);
  let network = {
    publicIp: null as string | null,
    privateIp: null as string | null,
    availabilityZone: null as string | null,
  };
  try {
    network = await waitForRunning(aws.ec2, instanceId);
  } catch {
    report(`instance ${instanceId} launched but did not reach 'running' in time`);
  }

  let publicIp: string | null = null;
  let eipAllocationId: string | null = null;
  if (nodeUsesElasticIp(role)) {
    report("re-associating the Elastic IP");
    const eip = await ensureEipForInstance(aws.ec2, { clusterId: aws.clusterId, nodeId, role }, instanceId);
    publicIp = eip.publicIp;
    eipAllocationId = eip.allocationId;
  } else {
    if (node.eipAllocationId) {
      report("releasing unused Elastic IP");
      await releaseEip(aws.ec2, node.eipAllocationId);
    }
    report("VPC-private instance (no public IP)");
  }

  const updated: NodeRegistryEntry = {
    ...node,
    instanceId,
    availabilityZone: network.availabilityZone,
    privateIp: network.privateIp,
    publicIp,
    eipAllocationId,
    agentVersion: p.agentVersion,
    agentType: DEFAULT_AGENT_TYPE,
    state: "ready",
  };

  // Overwrite the existing entry in place — same identity, new instance.
  await putJson(aws.s3, aws.bucket, nodeRegistryKey(aws.clusterId, nodeId), updated);
  return updated;
}
