import {
  AddRoleToInstanceProfileCommand,
  AttachRolePolicyCommand,
  CreateAccessKeyCommand,
  CreateInstanceProfileCommand,
  CreateRoleCommand,
  CreateUserCommand,
  DeleteAccessKeyCommand,
  DeleteInstanceProfileCommand,
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
  DeleteUserCommand,
  DeleteUserPolicyCommand,
  DetachRolePolicyCommand,
  GetInstanceProfileCommand,
  GetUserCommand,
  type IAMClient,
  ListAccessKeysCommand,
  PutRolePolicyCommand,
  PutUserPolicyCommand,
  RemoveRoleFromInstanceProfileCommand,
  TagUserCommand,
} from "@aws-sdk/client-iam";
import {
  backupsBucketName,
  desiredKey,
  nodePrefix,
  nodeResourceTags,
  statusKey,
  type NodeRegistryEntry,
  type NodeRole,
} from "@agentsystemlabs/launch-pad-shared";
import { CliError } from "../errors";
import { awsErrorName } from "./errors";
import { ensureNodeIamTags } from "./tags";

const NODE_POLICY_NAME = "launch-pad-node-policy";

/** Lets SSM Run Command reach the instance (upgrade-agent, break-glass ops). */
export const SSM_MANAGED_INSTANCE_CORE_ARN = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore";

/** IAM reports an existing entity as `EntityAlreadyExistsException` (Exception suffix). */
function isAlreadyExists(error: unknown): boolean {
  const name = awsErrorName(error);
  return name === "EntityAlreadyExists" || name === "EntityAlreadyExistsException";
}

function isNoSuchEntity(error: unknown): boolean {
  const name = awsErrorName(error);
  return name === "NoSuchEntity" || name === "NoSuchEntityException";
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Attach the AWS-managed SSM core policy to a role (idempotent on a re-attach). */
async function attachSsmManagedPolicy(iam: IAMClient, roleName: string): Promise<void> {
  try {
    await iam.send(
      new AttachRolePolicyCommand({ RoleName: roleName, PolicyArn: SSM_MANAGED_INSTANCE_CORE_ARN }),
    );
  } catch (error) {
    // Idempotent when the policy is already on the role (create or a prior upgrade).
    const msg = error instanceof Error ? error.message : "";
    if (!msg.includes("already") && awsErrorName(error) !== "EntityAlreadyExists") throw error;
  }
}

/** GetInstanceProfile, tolerating the brief NoSuchEntity window after a fresh create. */
async function getInstanceProfileWithRetry(iam: IAMClient, profileName: string) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await iam.send(new GetInstanceProfileCommand({ InstanceProfileName: profileName }));
    } catch (error) {
      if (isNoSuchEntity(error) && attempt < 6) {
        await sleep(2000);
        continue;
      }
      throw error;
    }
  }
}

const TRUST_POLICY = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { Service: "ec2.amazonaws.com" },
      Action: "sts:AssumeRole",
    },
  ],
};

/** Sanitize cluster/node ids into an IAM-safe slug (max length enforced by callers). */
export function iamSlug(clusterId: string, nodeId: string): string {
  return `${clusterId}-${nodeId}`.replace(/[^a-zA-Z0-9+=,.@_-]/g, "-");
}

// ⚠️ IAM role/profile names max out at 64 chars, so these slice(0, 64). If a
// cluster id + node id is long enough that the slug overflows, two nodes that
// differ only past char 64 collapse to the SAME role/profile name — the second
// provision would attach to the first's IAM resources, and tearing one down would
// delete the other's. Keep cluster/node ids short, or add a disambiguating hash
// here if longer ids ever need supporting.

/** Per-node IAM role name for new nodes (existing nodes may still use the legacy shared role). */
export function nodeRoleName(clusterId: string, nodeId: string): string {
  return `launch-pad-node-${iamSlug(clusterId, nodeId)}`.slice(0, 64);
}

/** Per-node instance profile name paired with {@link nodeRoleName}. */
export function nodeProfileName(clusterId: string, nodeId: string): string {
  return `launch-pad-node-profile-${iamSlug(clusterId, nodeId)}`.slice(0, 64);
}

/**
 * Per-node IAM USER name for external (BYOS) nodes. Mirrors {@link nodeRoleName}'s
 * naming + 64-char truncation — see the role/profile truncation warning above for the
 * long-id collision caveat (IAM user names cap at 64 too).
 */
export function nodeUserName(clusterId: string, nodeId: string): string {
  return `launch-pad-node-${iamSlug(clusterId, nodeId)}`.slice(0, 64);
}

export interface EnsureNodeIamParams {
  clusterId: string;
  nodeId: string;
  role: NodeRole;
  bucket: string;
  region: string;
  accountId: string;
}

/**
 * Least-privilege CloudWatch Logs write, scoped to this cluster's log-group namespace
 * (`/launch-pad/{clusterId}/*`) so a node can only write its own cluster's logs. Covers
 * both app stdout groups and the per-node system group. Identical for every role, so
 * the `both` merge dedupes it by Sid.
 */
function cloudWatchLogsStatements(region: string, accountId: string, clusterId: string): object[] {
  return [
    {
      Sid: "CloudWatchLogs",
      Effect: "Allow",
      Action: [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:DescribeLogStreams",
        "logs:PutRetentionPolicy",
      ],
      Resource: `arn:aws:logs:${region}:${accountId}:log-group:/launch-pad/${clusterId}/*`,
    },
    {
      // The CloudWatch Agent calls DescribeLogGroups to manage retention. It's a
      // list action that does NOT support per-log-group resource scoping, so it
      // must target all groups in the region — without it the agent ships NOTHING
      // (it loops on AccessDenied before any PutLogEvents).
      Sid: "CloudWatchLogsDescribe",
      Effect: "Allow",
      Action: ["logs:DescribeLogGroups"],
      Resource: `arn:aws:logs:${region}:${accountId}:log-group:*`,
    },
  ];
}

function ecrStatements(region: string, accountId: string): object[] {
  return [
    {
      Sid: "EcrAuth",
      Effect: "Allow",
      Action: ["ecr:GetAuthorizationToken"],
      Resource: ["*"],
    },
    {
      Sid: "EcrPull",
      Effect: "Allow",
      Action: [
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchCheckLayerAvailability",
      ],
      Resource: [`arn:aws:ecr:${region}:${accountId}:repository/*`],
    },
  ];
}

/**
 * App-only write+prune to the database-backups bucket, scoped to THIS cluster's prefix
 * (`<backupsBucket>/<clusterId>/*`). The agent runs `pg_dump` and uploads/prunes dumps;
 * scoping by cluster (not node) lets any app node back up its own databases while keeping
 * the grant off other clusters' backups. Compiled into the app policy only — an edge runs
 * no containers and never backs up data.
 */
function backupStatements(clusterId: string, region: string, accountId: string): object[] {
  const backupsBucket = backupsBucketName(accountId, region);
  return [
    {
      Sid: "BackupWrite",
      Effect: "Allow",
      Action: ["s3:PutObject", "s3:DeleteObject"],
      Resource: [`arn:aws:s3:::${backupsBucket}/${clusterId}/*`],
    },
    {
      Sid: "BackupList",
      Effect: "Allow",
      Action: ["s3:ListBucket"],
      Resource: [`arn:aws:s3:::${backupsBucket}`],
      Condition: { StringLike: { "s3:prefix": [`${clusterId}/*`] } },
    },
  ];
}

/** App agent: read own desired, write own status + upstream shards for edges. */
export function buildAppPolicy(
  bucket: string,
  clusterId: string,
  nodeId: string,
  region: string,
  accountId: string,
): string {
  const prefix = nodePrefix(clusterId, nodeId);
  const bucketArn = `arn:aws:s3:::${bucket}`;
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "ReadDesired",
        Effect: "Allow",
        Action: ["s3:GetObject"],
        Resource: [`${bucketArn}/${desiredKey(clusterId, nodeId)}`],
      },
      {
        Sid: "WriteStatus",
        Effect: "Allow",
        Action: ["s3:PutObject"],
        Resource: [`${bucketArn}/${statusKey(clusterId, nodeId)}`],
      },
      {
        Sid: "PublishUpstream",
        Effect: "Allow",
        Action: ["s3:PutObject"],
        Resource: [
          `${bucketArn}/nodes/*/upstream/${nodeId}.json`,
          `${bucketArn}/clusters/*/nodes/*/upstream/${nodeId}.json`,
        ],
      },
      {
        // Required so GetObject on a missing desired.json returns 404 (not 403).
        Sid: "ListOwnPrefix",
        Effect: "Allow",
        Action: ["s3:ListBucket"],
        Resource: [bucketArn],
        Condition: { StringLike: { "s3:prefix": [`${prefix}*`] } },
      },
      ...cloudWatchLogsStatements(region, accountId, clusterId),
      ...ecrStatements(region, accountId),
      ...ssmReadStatements(region, accountId, clusterId),
      ...backupStatements(clusterId, region, accountId),
    ],
  });
}

/** Read launchpad secrets scoped to this cluster (app/both agents resolve at container start). */
function ssmReadStatements(region: string, accountId: string, clusterId: string): Array<Record<string, unknown>> {
  return [
    {
      Sid: "ReadSecrets",
      Effect: "Allow",
      Action: ["ssm:GetParameter", "ssm:GetParameters"],
      Resource: [`arn:aws:ssm:${region}:${accountId}:parameter/launch-pad/${clusterId}/*`],
    },
  ];
}

/** Edge agent: read upstream shards in own prefix, write own status + ship system logs. */
export function buildEdgePolicy(
  bucket: string,
  clusterId: string,
  edgeId: string,
  region: string,
  accountId: string,
): string {
  const prefix = nodePrefix(clusterId, edgeId);
  const upstreamPrefix = `${prefix}upstream/`;
  const bucketArn = `arn:aws:s3:::${bucket}`;
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "ReadUpstream",
        Effect: "Allow",
        Action: ["s3:GetObject"],
        Resource: [`${bucketArn}/${upstreamPrefix}*`],
      },
      {
        Sid: "WriteStatus",
        Effect: "Allow",
        Action: ["s3:PutObject"],
        Resource: [`${bucketArn}/${statusKey(clusterId, edgeId)}`],
      },
      {
        Sid: "ListUpstream",
        Effect: "Allow",
        Action: ["s3:ListBucket"],
        Resource: [bucketArn],
        Condition: { StringLike: { "s3:prefix": [`${upstreamPrefix}*`] } },
      },
      ...cloudWatchLogsStatements(region, accountId, clusterId),
    ],
  });
}

function buildNodePolicy(params: EnsureNodeIamParams): string {
  const { role, bucket, clusterId, nodeId, region, accountId } = params;
  if (role === "app") {
    return buildAppPolicy(bucket, clusterId, nodeId, region, accountId);
  }
  return buildEdgePolicy(bucket, clusterId, nodeId, region, accountId);
}

/**
 * Idempotently ensure a per-node IAM role + instance profile with least-privilege
 * inline policy. Existing nodes provisioned with the legacy shared role are unchanged.
 */
/**
 * Idempotently create the node's IAM role + instance profile.
 *
 * ⚠️ The step ORDER below is load-bearing, not incidental:
 *   1. CreateRole
 *   2. PutRolePolicy (inline least-privilege policy)
 *   3. attach the SSM managed policy BY ROLE NAME — must happen before the profile
 *      exists; resolving it via the profile was a NoSuchEntity bug on fresh nodes
 *   4. CreateInstanceProfile
 *   5. read-back-with-retry (IAM create-then-read eventual consistency)
 * Reordering "to clean up" can reintroduce the fresh-provision failures these
 * steps were sequenced to avoid.
 */
export async function ensureNodeIam(
  iam: IAMClient,
  params: EnsureNodeIamParams,
): Promise<{ roleName: string; profileName: string }> {
  const roleName = nodeRoleName(params.clusterId, params.nodeId);
  const profileName = nodeProfileName(params.clusterId, params.nodeId);

  try {
    await iam.send(
      new CreateRoleCommand({
        RoleName: roleName,
        AssumeRolePolicyDocument: JSON.stringify(TRUST_POLICY),
        Description: `launchpad node ${params.nodeId} (${params.role})`,
      }),
    );
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }

  await iam.send(
    new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: NODE_POLICY_NAME,
      PolicyDocument: buildNodePolicy(params),
    }),
  );

  // Attach the SSM managed policy directly to the role we just created. We know
  // its name, so don't resolve it via the instance profile (which doesn't exist
  // yet at this point — doing so was a NoSuchEntity bug on fresh provisions).
  await attachSsmManagedPolicy(iam, roleName);

  try {
    await iam.send(new CreateInstanceProfileCommand({ InstanceProfileName: profileName }));
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }

  // A just-created instance profile can read back as NoSuchEntity for a moment
  // (IAM create-then-read consistency) — retry before trusting the result.
  const profile = await getInstanceProfileWithRetry(iam, profileName);
  const hasRole = profile.InstanceProfile?.Roles?.some((r) => r.RoleName === roleName);
  if (!hasRole) {
    await iam.send(
      new AddRoleToInstanceProfileCommand({
        InstanceProfileName: profileName,
        RoleName: roleName,
      }),
    );
  }

  await ensureNodeIamTags(iam, {
    roleName,
    profileName,
    tags: nodeResourceTags({
      clusterId: params.clusterId,
      nodeId: params.nodeId,
      role: params.role,
    }),
  });

  return { roleName, profileName };
}

/** Resolve the IAM role backing a node's instance profile (per-node or legacy shared). */
export async function resolveNodeIamRoleName(
  iam: IAMClient,
  entry: Pick<NodeRegistryEntry, "clusterId" | "nodeId" | "iamInstanceProfile">,
): Promise<string> {
  const profileName = entry.iamInstanceProfile ?? nodeProfileName(entry.clusterId, entry.nodeId);
  const profile = await iam.send(
    new GetInstanceProfileCommand({ InstanceProfileName: profileName }),
  );
  const roleName = profile.InstanceProfile?.Roles?.[0]?.RoleName;
  if (!roleName) {
    throw new CliError(`instance profile "${profileName}" has no IAM role`, {
      hint: "recreate the node's IAM resources with `launchpad node destroy` then `node create`",
    });
  }
  return roleName;
}

/** Attach the AWS-managed SSM core policy so `upgrade-agent` can run remote installs. */
export async function ensureSsmManagedPolicyForNode(
  iam: IAMClient,
  entry: Pick<NodeRegistryEntry, "clusterId" | "nodeId" | "iamInstanceProfile">,
): Promise<void> {
  // For an EXISTING node we don't know the role name locally, so resolve it via
  // the instance profile (which exists by now). `ensureNodeIam` uses the direct
  // `attachSsmManagedPolicy` path instead, before the profile is created.
  const roleName = await resolveNodeIamRoleName(iam, entry);
  await attachSsmManagedPolicy(iam, roleName);
}

/**
 * Delete a node's per-node IAM role + instance profile (best-effort, idempotent).
 * Used by `cluster destroy` to fully tear down a cluster — detach the role from
 * the profile, delete the profile, detach managed + inline policies, delete the
 * role. Tolerant of anything already gone.
 */
export async function deleteNodeIam(iam: IAMClient, clusterId: string, nodeId: string): Promise<void> {
  const roleName = nodeRoleName(clusterId, nodeId);
  const profileName = nodeProfileName(clusterId, nodeId);
  const ignoreMissing = async (op: () => Promise<unknown>): Promise<void> => {
    try {
      await op();
    } catch (error) {
      if (!isNoSuchEntity(error)) throw error;
    }
  };

  await ignoreMissing(() =>
    iam.send(
      new RemoveRoleFromInstanceProfileCommand({ InstanceProfileName: profileName, RoleName: roleName }),
    ),
  );
  await ignoreMissing(() =>
    iam.send(new DeleteInstanceProfileCommand({ InstanceProfileName: profileName })),
  );
  await ignoreMissing(() =>
    iam.send(
      new DetachRolePolicyCommand({ RoleName: roleName, PolicyArn: SSM_MANAGED_INSTANCE_CORE_ARN }),
    ),
  );
  await ignoreMissing(() =>
    iam.send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: NODE_POLICY_NAME })),
  );
  await ignoreMissing(() => iam.send(new DeleteRoleCommand({ RoleName: roleName })));
}

/**
 * Ensure the IAM USER backing an external (BYOS) node. An external host has no EC2
 * instance-profile, so it authenticates with long-lived access keys delivered into
 * `/etc/launch-pad/agent.env`. The user carries the SAME least-privilege inline policy
 * an EC2 node's role would ({@link buildNodePolicy}), so a BYOS node is scoped exactly
 * like a managed one (read own desired, write own status, app-only upstream shards).
 *
 * Idempotent on the user (tolerates EntityAlreadyExists) and the policy. The returned
 * `secretAccessKey` is the ONLY time AWS reveals it — callers must capture it now.
 */
export async function ensureExternalNodeIam(
  iam: IAMClient,
  params: EnsureNodeIamParams,
): Promise<{ userName: string; userArn: string; accessKeyId: string; secretAccessKey: string }> {
  const userName = nodeUserName(params.clusterId, params.nodeId);

  let userArn: string | undefined;
  try {
    const created = await iam.send(new CreateUserCommand({ UserName: userName }));
    userArn = created.User?.Arn;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    // Already exists — fetch its ARN for the return value.
    const got = await iam.send(new GetUserCommand({ UserName: userName }));
    userArn = got.User?.Arn;
  }
  // Fall back to constructing the ARN if neither call surfaced one.
  userArn ??= `arn:aws:iam::${params.accountId}:user/${userName}`;

  await iam.send(
    new PutUserPolicyCommand({
      UserName: userName,
      PolicyName: NODE_POLICY_NAME,
      PolicyDocument: buildNodePolicy(params),
    }),
  );

  await iam.send(
    new TagUserCommand({
      UserName: userName,
      Tags: nodeResourceTags({
        clusterId: params.clusterId,
        nodeId: params.nodeId,
        role: params.role,
      }).map((t) => ({ Key: t.Key, Value: t.Value })),
    }),
  );

  const { accessKeyId, secretAccessKey } = await createExternalNodeAccessKey(iam, userName);

  return { userName, userArn, accessKeyId, secretAccessKey };
}

async function deleteInactiveAccessKeys(iam: IAMClient, userName: string): Promise<void> {
  const keys = await iam.send(new ListAccessKeysCommand({ UserName: userName }));
  for (const meta of keys.AccessKeyMetadata ?? []) {
    if (!meta.AccessKeyId || meta.Status !== "Inactive") continue;
    await iam.send(new DeleteAccessKeyCommand({ UserName: userName, AccessKeyId: meta.AccessKeyId }));
  }
}

export async function createExternalNodeAccessKey(
  iam: IAMClient,
  userName: string,
): Promise<{ accessKeyId: string; secretAccessKey: string }> {
  await deleteInactiveAccessKeys(iam, userName);
  const keys = await iam.send(new ListAccessKeysCommand({ UserName: userName }));
  const activeCount = (keys.AccessKeyMetadata ?? []).filter((k) => k.Status !== "Inactive").length;
  if (activeCount >= 2) {
    throw new CliError(`can't create a new access key for external node user "${userName}"`, {
      hint: "IAM allows max 2 active access keys per user; delete a stale key or run node rotate-creds after the host is reachable",
    });
  }

  const key = await iam.send(new CreateAccessKeyCommand({ UserName: userName }));
  const accessKeyId = key.AccessKey?.AccessKeyId;
  const secretAccessKey = key.AccessKey?.SecretAccessKey;
  if (!accessKeyId || !secretAccessKey) {
    throw new CliError(`failed to create access key for external node user "${userName}"`, {
      hint: "check the IAM access-key-per-user limit (max 2) and retry",
    });
  }
  return { accessKeyId, secretAccessKey };
}

export async function deleteExternalNodeAccessKeysExcept(
  iam: IAMClient,
  userName: string,
  keepAccessKeyId: string,
): Promise<string[]> {
  const keys = await iam.send(new ListAccessKeysCommand({ UserName: userName }));
  const deleted: string[] = [];
  for (const meta of keys.AccessKeyMetadata ?? []) {
    const accessKeyId = meta.AccessKeyId;
    if (!accessKeyId || accessKeyId === keepAccessKeyId) continue;
    await iam.send(new DeleteAccessKeyCommand({ UserName: userName, AccessKeyId: accessKeyId }));
    deleted.push(accessKeyId);
  }
  return deleted;
}

export async function deleteExternalNodeAccessKey(
  iam: IAMClient,
  userName: string,
  accessKeyId: string,
): Promise<void> {
  await iam.send(new DeleteAccessKeyCommand({ UserName: userName, AccessKeyId: accessKeyId }));
}

/**
 * Delete an external (BYOS) node's IAM user (best-effort, idempotent). Mirrors
 * {@link deleteNodeIam}'s tolerant style: delete every access key, the inline policy,
 * then the user. Tolerant of anything already gone. Called by node teardown for
 * external nodes (there is no role/instance-profile to remove).
 */
export async function deleteExternalNodeIam(
  iam: IAMClient,
  clusterId: string,
  nodeId: string,
): Promise<void> {
  const userName = nodeUserName(clusterId, nodeId);
  const ignoreMissing = async (op: () => Promise<unknown>): Promise<void> => {
    try {
      await op();
    } catch (error) {
      if (!isNoSuchEntity(error)) throw error;
    }
  };

  // Access keys must be deleted before the user can be removed.
  await ignoreMissing(async () => {
    const keys = await iam.send(new ListAccessKeysCommand({ UserName: userName }));
    for (const meta of keys.AccessKeyMetadata ?? []) {
      if (!meta.AccessKeyId) continue;
      await ignoreMissing(() =>
        iam.send(new DeleteAccessKeyCommand({ UserName: userName, AccessKeyId: meta.AccessKeyId })),
      );
    }
  });
  await ignoreMissing(() =>
    iam.send(new DeleteUserPolicyCommand({ UserName: userName, PolicyName: NODE_POLICY_NAME })),
  );
  await ignoreMissing(() => iam.send(new DeleteUserCommand({ UserName: userName })));
}
