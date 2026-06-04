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
  type IpPermission,
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
import { type InstanceCapacity, rawToCapacity } from "@agentsystemlabs/launch-pad-shared";
import { CliError } from "../errors";
import { awsErrorName } from "./errors";

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

export async function ensureSecurityGroup(
  ec2: EC2Client,
  name: string,
  vpcId: string,
  opts: { ssh: boolean },
): Promise<string> {
  const existing = await ec2.send(
    new DescribeSecurityGroupsCommand({
      Filters: [
        { Name: "group-name", Values: [name] },
        { Name: "vpc-id", Values: [vpcId] },
      ],
    }),
  );
  const found = existing.SecurityGroups?.[0]?.GroupId;
  if (found) return found;

  const created = await ec2.send(
    new CreateSecurityGroupCommand({
      GroupName: name,
      Description: "launch-pad node ingress (Caddy http/https)",
      VpcId: vpcId,
    }),
  );
  const sgId = created.GroupId;
  if (!sgId) throw new CliError(`failed to create security group ${name}`);

  const perms: IpPermission[] = [
    { IpProtocol: "tcp", FromPort: 80, ToPort: 80, IpRanges: [{ CidrIp: "0.0.0.0/0", Description: "http" }] },
    { IpProtocol: "tcp", FromPort: 443, ToPort: 443, IpRanges: [{ CidrIp: "0.0.0.0/0", Description: "https" }] },
  ];
  if (opts.ssh) {
    perms.push({
      IpProtocol: "tcp",
      FromPort: 22,
      ToPort: 22,
      IpRanges: [{ CidrIp: "0.0.0.0/0", Description: "ssh" }],
    });
  }
  await ec2.send(new AuthorizeSecurityGroupIngressCommand({ GroupId: sgId, IpPermissions: perms }));
  return sgId;
}

export interface RunNodeParams {
  imageId: string;
  instanceType: string;
  userData: string;
  securityGroupId: string;
  instanceProfileName: string;
  keyName?: string;
  nodeId: string;
}

export async function runNode(ec2: EC2Client, p: RunNodeParams): Promise<string> {
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
      {
        ResourceType: "instance",
        Tags: [
          { Key: "Name", Value: `launch-pad-${p.nodeId}` },
          { Key: "launch-pad:node", Value: p.nodeId },
        ],
      },
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
      if (retriable && attempt < 6) {
        await sleep(2500);
        continue;
      }
      throw error;
    }
  }
}

export interface InstanceNetwork {
  publicIp: string | null;
  availabilityZone: string | null;
}

export async function waitForRunning(
  ec2: EC2Client,
  instanceId: string,
): Promise<InstanceNetwork> {
  await waitUntilInstanceRunning({ client: ec2, maxWaitTime: 180 }, { InstanceIds: [instanceId] });
  const res = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
  const inst = res.Reservations?.[0]?.Instances?.[0];
  return {
    publicIp: inst?.PublicIpAddress ?? null,
    availabilityZone: inst?.Placement?.AvailabilityZone ?? null,
  };
}

/** Current public IP for an instance, or null. */
export async function describeInstanceIp(ec2: EC2Client, instanceId: string): Promise<string | null> {
  try {
    const res = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    return res.Reservations?.[0]?.Instances?.[0]?.PublicIpAddress ?? null;
  } catch {
    return null;
  }
}

export async function terminateInstance(ec2: EC2Client, instanceId: string): Promise<void> {
  await ec2.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
  await waitUntilInstanceTerminated({ client: ec2, maxWaitTime: 240 }, { InstanceIds: [instanceId] });
}

export async function deleteSecurityGroup(ec2: EC2Client, groupId: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await ec2.send(new DeleteSecurityGroupCommand({ GroupId: groupId }));
      return;
    } catch (error) {
      // The instance's network interface can linger briefly after termination.
      if (awsErrorName(error) === "DependencyViolation" && attempt < 6) {
        await sleep(5000);
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
export async function ensureEipForInstance(
  ec2: EC2Client,
  nodeId: string,
  instanceId: string,
): Promise<{ allocationId: string; publicIp: string }> {
  let eip = await findNodeEip(ec2, nodeId);
  if (!eip) {
    const allocated = await ec2.send(
      new AllocateAddressCommand({
        Domain: "vpc",
        TagSpecifications: [
          {
            ResourceType: "elastic-ip",
            Tags: [
              { Key: "Name", Value: `launch-pad-${nodeId}` },
              { Key: "launch-pad:node", Value: nodeId },
            ],
          },
        ],
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
  await waitUntilInstanceStopped({ client: ec2, maxWaitTime: 240 }, { InstanceIds: [instanceId] });
}

export async function startInstance(ec2: EC2Client, instanceId: string): Promise<InstanceNetwork> {
  await ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
  return waitForRunning(ec2, instanceId);
}
