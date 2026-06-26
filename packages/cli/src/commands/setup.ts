import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  CreateOpenIDConnectProviderCommand,
  CreateRoleCommand,
  type IAMClient,
  PutRolePolicyCommand,
  UpdateAssumeRolePolicyCommand,
} from "@aws-sdk/client-iam";
import { S3Client } from "@aws-sdk/client-s3";
import { Command } from "commander";
import { DEFAULT_CLUSTER, LABEL_REGEX, stateBucketName } from "@agentsystemlabs/launch-pad-shared";
import { prepareAws } from "../aws/context";
import { ensureBucket } from "../aws/s3-state";
import { ensureClusterConfig } from "../cluster/store";
import { loadConfig } from "../config/load";
import { loadLocalConfig, localConfigPath, upsertClusterTarget } from "../config/local";
import { CliError } from "../errors";
import { applyGlobalOptions, type GlobalOpts, mergedOpts } from "../globals";
import {
  buildDeployWorkflow,
  buildOidcTrustPolicy,
  githubSubject,
  oidcProviderArn,
  oidcTrustPolicyJson,
  parseRepo,
  type RepoRef,
  validateBranch,
  validateRoleName,
} from "../setup/github-oidc";
import { buildOperatorPolicy, operatorPolicyJson } from "../setup/operator-policy";
import { buildProjectDeployPolicy, projectDeployPolicyJson } from "../setup/project-deploy-policy";
import { buildSetupPlan } from "../setup/wizard";
import { panel, table } from "../ui/box";
import { isJsonMode, log, printJson } from "../ui/log";
import { confirm, promptText } from "../ui/prompt";
import { color } from "../ui/theme";

interface SetupOptions extends GlobalOpts {
  /** Override the AWS account id (so the generator can run fully offline). */
  account?: string;
}

interface GithubOidcOptions extends SetupOptions {
  repo: string;
  branch?: string;
  allBranches?: boolean;
  roleName?: string;
}

const DEFAULT_DEPLOY_ROLE = "launch-pad-deploy";
const DEFAULT_BRANCH = "main";

/**
 * Resolve the account + region the generated ARNs are scoped to. Fully offline only
 * when BOTH `--account` and `--region` are given; otherwise we call STS (the common
 * bootstrap case where the operator already has admin creds and is minting a tighter
 * policy for a CI role / restricted user).
 */
async function resolveAccountRegion(opts: SetupOptions): Promise<{ accountId: string; region: string }> {
  if (opts.account !== undefined && !/^\d{12}$/.test(opts.account)) {
    throw new CliError(`invalid --account "${opts.account}"`, { hint: "an AWS account id is 12 digits" });
  }
  if (opts.account !== undefined && opts.region !== undefined) {
    return { accountId: opts.account, region: opts.region };
  }
  const aws = await prepareAws(opts);
  return { accountId: opts.account ?? aws.accountId, region: aws.region };
}

async function runIamPolicy(opts: SetupOptions): Promise<void> {
  const { accountId, region } = await resolveAccountRegion(opts);
  if (isJsonMode()) {
    printJson(buildOperatorPolicy({ accountId, region }));
    return;
  }

  const bucket = stateBucketName(accountId, region);
  panel("Operator IAM policy", [
    `account ${color.cyan(accountId)} · region ${color.cyan(region)}`,
    `state bucket ${color.cyan(bucket)}`,
    color.dim("least-privilege policy for the human / CI principal that runs launch-pad"),
    color.dim("scoped to this region — re-run with --region for another"),
  ]);
  log.step("Create + attach it:");
  log.plain("  1. Save the JSON below to launch-pad-operator-policy.json");
  log.plain(
    "  2. aws iam create-policy --policy-name launch-pad-operator \\\n" +
      "       --policy-document file://launch-pad-operator-policy.json",
  );
  log.plain("  3. Attach it to your IAM user (or role):");
  log.plain(
    `       aws iam attach-user-policy --user-name <you> \\\n` +
      `         --policy-arn arn:aws:iam::${accountId}:policy/launch-pad-operator`,
  );
  log.dim("  Tip: `launchpad setup iam-policy --json > policy.json` for just the document.");
  log.plain();
  // The policy document itself goes to stdout so `> policy.json` captures only it.
  process.stdout.write(operatorPolicyJson({ accountId, region }));
}

async function runGithubOidc(opts: GithubOidcOptions): Promise<void> {
  const repo = parseRepo(opts.repo);
  if (opts.branch !== undefined && opts.allBranches) {
    throw new CliError("--branch and --all-branches are mutually exclusive", {
      hint: "pin one branch with --branch, or open to any ref with --all-branches",
    });
  }
  const branch = opts.allBranches ? undefined : validateBranch(opts.branch ?? DEFAULT_BRANCH);
  const subject = githubSubject({ owner: repo.owner, repo: repo.repo, branch });
  const roleName = validateRoleName(opts.roleName ?? DEFAULT_DEPLOY_ROLE);

  const { accountId, region } = await resolveAccountRegion(opts);
  const roleArn = `arn:aws:iam::${accountId}:role/${roleName}`;
  const workflow = buildDeployWorkflow({ roleArn, region, branch: branch ?? DEFAULT_BRANCH });

  if (isJsonMode()) {
    printJson({
      providerArn: oidcProviderArn(accountId),
      roleName,
      roleArn,
      subject,
      trustPolicy: buildOidcTrustPolicy({ accountId, subject }),
      workflow,
    });
    return;
  }

  panel("GitHub Actions OIDC deploy", [
    `repo ${color.cyan(`${repo.owner}/${repo.repo}`)} · ${branch ? `branch ${color.cyan(branch)}` : color.yellow("any ref")}`,
    `account ${color.cyan(accountId)} · region ${color.cyan(region)}`,
    `deploy role ${color.cyan(roleName)}`,
    color.dim("keyless CI deploys — GitHub Actions assumes the role via OIDC (no long-lived keys)"),
  ]);
  if (branch === undefined) {
    log.warn(
      "--all-branches: ANY ref (branches, tags, AND pull requests — including from forks) can " +
        "assume this role. Prefer --branch <name>, or hand-edit the sub to an environment scope " +
        `(repo:${repo.owner}/${repo.repo}:environment:production).`,
    );
  }

  log.step("One-time AWS setup:");
  log.plain("  1. Register the GitHub OIDC provider (skip if it already exists):");
  log.plain(
    "       aws iam create-open-id-connect-provider \\\n" +
      "         --url https://token.actions.githubusercontent.com \\\n" +
      "         --client-id-list sts.amazonaws.com",
  );
  log.plain(`  2. Create the deploy role with the trust policy below:`);
  log.plain(
    `       aws iam create-role --role-name ${roleName} \\\n` +
      `         --assume-role-policy-document file://launch-pad-oidc-trust.json`,
  );
  log.plain("  3. Attach the operator policy (launchpad setup iam-policy) to it:");
  log.plain(
    `       aws iam attach-role-policy --role-name ${roleName} \\\n` +
      `         --policy-arn arn:aws:iam::${accountId}:policy/launch-pad-operator`,
  );
  log.plain("  4. Commit the workflow below as .github/workflows/deploy.yml");
  log.dim("  Tip: `launchpad setup github-oidc --repo … --json` emits both as one JSON object.");

  log.plain();
  log.step("Trust policy → launch-pad-oidc-trust.json");
  process.stderr.write("\n");
  process.stdout.write(oidcTrustPolicyJson({ accountId, subject }));
  process.stderr.write("\n");
  log.step("Workflow → .github/workflows/deploy.yml");
  process.stderr.write("\n");
  process.stdout.write(workflow);
}

interface CiDeployOptions extends SetupOptions {
  repo?: string;
  cluster?: string;
  branch?: string;
  roleName?: string;
  /** Emit the role/trust/policy/workflow without creating anything in AWS or on disk. */
  print?: boolean;
  /** Skip the confirmation prompt before mutating AWS + writing the workflow file. */
  yes?: boolean;
}

const GITHUB_OIDC_PROVIDER_URL = "https://token.actions.githubusercontent.com";
/** GitHub's root-CA thumbprint. AWS ignores it for STS-audience OIDC but the API still requires one. */
const GITHUB_OIDC_THUMBPRINT = "6938fd4d98bab03faadb97b34396831e3780aea1";

/** True for the "create X that already exists" IAM error, so ensure-style calls are idempotent. */
function isAlreadyExists(error: unknown): boolean {
  return (error as { name?: string })?.name === "EntityAlreadyExistsException";
}

/** Derive `owner/name` from the repo's `origin` remote, so `--repo` can be omitted in a checkout. */
function deriveRepoFromGit(dir: string): string | undefined {
  let url: string;
  try {
    url = execFileSync("git", ["-C", dir, "config", "--get", "remote.origin.url"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
  // git@github.com:owner/name.git  |  https://github.com/owner/name(.git)
  const match = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

/** Register the GitHub OIDC provider once per account (no-op if it already exists). */
async function ensureOidcProvider(iam: IAMClient): Promise<boolean> {
  try {
    await iam.send(
      new CreateOpenIDConnectProviderCommand({
        Url: GITHUB_OIDC_PROVIDER_URL,
        ClientIDList: ["sts.amazonaws.com"],
        ThumbprintList: [GITHUB_OIDC_THUMBPRINT],
      }),
    );
    return true;
  } catch (error) {
    if (isAlreadyExists(error)) return false;
    throw error;
  }
}

/**
 * `setup ci-deploy` — create the BARE-MINIMUM, single-project, single-cluster CI deploy
 * role and write the matching `.github/workflows/deploy.yml`. The opposite of the broad
 * operator role: see {@link buildProjectDeployPolicy}. Provisioning stays an out-of-band
 * operator action, so the generated workflow is deploy-only (`--no-create/-repair/-recreate`)
 * and the role carries zero EC2/IAM write permissions.
 */
async function runCiDeploy(opts: CiDeployOptions): Promise<void> {
  const { config, dir } = loadConfig();
  const project = config.project;

  // Per-project isolation requires a DEDICATED named cluster: the `default` cluster's
  // state lives at the bucket root and can't be prefix-isolated from other projects.
  const cluster = opts.cluster ?? loadLocalConfig().defaultCluster;
  if (cluster === undefined) {
    throw new CliError("no cluster to scope the role to", {
      hint: "pass --cluster <name> (a dedicated cluster for this project — not the shared `default`)",
    });
  }
  if (cluster === DEFAULT_CLUSTER) {
    throw new CliError("a scoped CI role can't target the `default` cluster", {
      hint: "give this project its own cluster: `launchpad setup --cluster <name> …` then `--cluster <name>` here",
    });
  }
  if (!LABEL_REGEX.test(cluster)) {
    throw new CliError(`invalid cluster name "${cluster}"`, {
      hint: "use lowercase letters, numbers and hyphens (a valid DNS label)",
    });
  }

  const repoSlug = opts.repo ?? deriveRepoFromGit(dir);
  if (repoSlug === undefined) {
    throw new CliError("could not determine the GitHub repo", {
      hint: "pass --repo owner/name (no `origin` remote was found to derive it from)",
    });
  }
  const repo: RepoRef = parseRepo(repoSlug);
  const branch = validateBranch(opts.branch ?? DEFAULT_BRANCH);
  const subject = githubSubject({ owner: repo.owner, repo: repo.repo, branch });
  const roleName = validateRoleName(opts.roleName ?? `${project}-deploy`);
  const policyName = `${project}-deploy`;

  const { accountId, region } = await resolveAccountRegion({ ...opts, cluster });
  const roleArn = `arn:aws:iam::${accountId}:role/${roleName}`;
  const trustPolicy = buildOidcTrustPolicy({ accountId, subject });
  const policy = buildProjectDeployPolicy({ accountId, region, cluster, project });
  const workflow = buildDeployWorkflow({ roleArn, region, branch, cluster, deployOnly: true });
  const workflowPath = join(dir, ".github", "workflows", "deploy.yml");

  if (isJsonMode()) {
    printJson({
      project,
      cluster,
      repo: `${repo.owner}/${repo.repo}`,
      branch,
      roleName,
      roleArn,
      policyName,
      subject,
      trustPolicy,
      policy,
      workflow,
      workflowPath,
      applied: false,
    });
    return;
  }

  panel("Scoped CI deploy role", [
    ...table([
      ["project", color.cyan(project)],
      ["cluster", color.cyan(cluster)],
      ["repo / branch", `${color.cyan(`${repo.owner}/${repo.repo}`)} ${color.dim(`@ ${branch}`)}`],
      ["account / region", `${accountId} ${color.dim(region)}`],
      ["role", color.cyan(roleName)],
      ["workflow", relative(process.cwd(), workflowPath) || workflowPath],
    ]),
    color.dim("bare-minimum: push to this project's ECR + write this cluster's S3 state — nothing else."),
    color.dim("no EC2/IAM writes; deploy-only (provisioning stays a local operator action)."),
  ]);

  // --print: emit the artifacts for review, mutate nothing.
  if (opts.print === true) {
    log.step("Trust policy");
    process.stdout.write(oidcTrustPolicyJson({ accountId, subject }));
    log.step(`Scoped inline policy → ${policyName}`);
    process.stdout.write(projectDeployPolicyJson({ accountId, region, cluster, project }));
    log.step(`Workflow → ${relative(process.cwd(), workflowPath) || workflowPath}`);
    process.stdout.write(workflow);
    log.dim("\n--print: nothing was created. Re-run without --print to apply.");
    return;
  }

  const proceed = opts.yes === true || (await confirm(`create role ${roleName} + write the workflow?`, true));
  if (!proceed) {
    log.info("aborted — nothing was created");
    return;
  }

  const aws = await prepareAws({ ...opts, cluster });

  if (await ensureOidcProvider(aws.iam)) log.success("registered the GitHub OIDC provider");
  else log.dim("GitHub OIDC provider already registered");

  try {
    await aws.iam.send(
      new CreateRoleCommand({
        RoleName: roleName,
        AssumeRolePolicyDocument: JSON.stringify(trustPolicy),
        Description: `Scoped Launch Pad CI deploy role for ${repo.owner}/${repo.repo} → cluster ${cluster}`,
        MaxSessionDuration: 3600,
      }),
    );
    log.success(`created role ${color.cyan(roleName)}`);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    await aws.iam.send(
      new UpdateAssumeRolePolicyCommand({ RoleName: roleName, PolicyDocument: JSON.stringify(trustPolicy) }),
    );
    log.dim(`role ${roleName} already exists — refreshed its trust policy`);
  }

  await aws.iam.send(
    new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: policyName,
      PolicyDocument: JSON.stringify(policy),
    }),
  );
  log.success(`attached scoped inline policy ${color.cyan(policyName)}`);

  mkdirSync(dirname(workflowPath), { recursive: true });
  writeFileSync(workflowPath, workflow);
  log.success(`wrote ${color.cyan(relative(process.cwd(), workflowPath) || workflowPath)}`);

  log.plain();
  log.step("Next steps:");
  log.plain("  1. Provision the cluster's nodes once (privileged, local):");
  log.plain(`       launchpad deploy --cluster ${cluster} --yes`);
  log.plain("  2. Commit + push the workflow — CI deploys keyless via OIDC from then on.");
  log.dim("  The CI role can't provision: re-run step 1 locally if a node is ever added/replaced.");
}

interface SetupWizardOptions extends GlobalOpts {
  /** Skip the confirmation prompt (required in CI / non-interactive). */
  yes?: boolean;
}

/**
 * Resolve the region setup will use: an explicit `--region` wins (and skips the prompt, so
 * `setup --region … --yes` is fully non-interactive); otherwise prompt interactively with the
 * ambient region as the default; otherwise (non-interactive) fall back to the ambient region
 * or fail with guidance. Mirrors the resolution in `createClients` for the non-prompt cases.
 */
async function resolveSetupRegion(opts: SetupWizardOptions): Promise<string> {
  if (opts.region) return opts.region;
  let ambient = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (!ambient) {
    try {
      ambient = await new S3Client({}).config.region();
    } catch {
      ambient = undefined;
    }
  }
  if (process.stdin.isTTY === true) return promptText("AWS region", ambient ?? "us-east-1");
  if (ambient) return ambient;
  throw new CliError("could not determine an AWS region", {
    hint: "pass --region, set AWS_REGION, or run `aws configure`",
  });
}

/**
 * First-run bootstrap (`launchpad setup` with no subcommand): pick a region, confirm the
 * AWS account, create the state bucket, and — for a named cluster — save the local target.
 * The implicit `default` cluster runs on ambient creds, so it only ensures the bucket +
 * prints next steps. Interactive when run on a TTY without flags; fully scriptable with
 * `--region`/`--cluster`/`--yes`.
 */
async function runWizard(opts: SetupWizardOptions): Promise<void> {
  const cluster = opts.cluster ?? DEFAULT_CLUSTER;
  if (cluster !== DEFAULT_CLUSTER && !LABEL_REGEX.test(cluster)) {
    throw new CliError(`invalid cluster name "${cluster}"`, {
      hint: "use lowercase letters, numbers and hyphens (a valid DNS label)",
    });
  }

  const region = await resolveSetupRegion(opts);

  // Resolve identity + bucket name WITHOUT creating anything, so we can confirm first.
  let aws;
  try {
    aws = await prepareAws({ ...opts, region, cluster });
  } catch (error) {
    throw new CliError(`couldn't reach AWS: ${(error as Error).message}`, {
      hint: "configure credentials (AWS_PROFILE, env keys, or `aws configure`) and try again",
    });
  }
  const plan = buildSetupPlan(aws.accountId, aws.region, cluster);

  if (!isJsonMode()) {
    panel("Launch Pad setup", [
      ...table([
        ["account / region", `${plan.accountId} ${color.dim(plan.region)}`],
        [
          "cluster",
          plan.isDefaultCluster ? `${plan.cluster} ${color.dim("(default — ambient AWS creds)")}` : plan.cluster,
        ],
        ["state bucket", plan.bucket],
        ["local config", plan.savesLocalTarget ? localConfigPath() : color.dim("none (default cluster)")],
      ]),
      color.dim("creates the state bucket if missing (idempotent); your app data is untouched"),
    ]);
  }

  const action = plan.savesLocalTarget ? "Create the state bucket + save this cluster locally?" : "Create the state bucket?";
  const proceed = opts.yes === true || (!isJsonMode() && (await confirm(action, true)));
  if (!proceed) {
    if (!isJsonMode()) log.info("aborted — nothing was created");
    return;
  }

  await ensureBucket(aws.s3, aws.bucket, aws.region, cluster);
  if (plan.savesLocalTarget) {
    upsertClusterTarget(cluster, { region: aws.region, ...(opts.profile ? { profile: opts.profile } : {}) });
    await ensureClusterConfig(aws, cluster);
  }

  if (isJsonMode()) {
    printJson({ ...plan, created: true });
    return;
  }

  log.success(`state bucket ready: ${color.cyan(aws.bucket)}`);
  if (plan.savesLocalTarget) {
    log.success(`saved cluster "${cluster}" → ${color.dim(localConfigPath())}`);
  }
  log.plain();
  log.step("Next steps:");
  log.plain("  1. launchpad doctor          # preflight Docker + AWS before any spend");
  log.plain("  2. launchpad init            # scaffold launch-pad.toml in your app");
  log.plain(
    `  3. launchpad deploy --yes${plan.isDefaultCluster ? "" : ` --cluster ${cluster}`}   # build, push, auto-provision + run`,
  );
  log.dim("  Tip: `launchpad setup iam-policy` / `setup github-oidc` for least-privilege + CI.");
}

export function registerSetup(program: Command): void {
  const setup = program
    .command("setup")
    .description("First-run bootstrap (region → state bucket → local config); + IAM/CI template subcommands")
    .option("--yes", "skip the confirmation prompt (required in CI / non-interactive)")
    .addHelpText(
      "after",
      [
        "",
        "Run with no subcommand for the guided first-run setup: pick a region, confirm your AWS",
        "account, create the state bucket, and (for a named --cluster) save the local target.",
        "Interactive on a TTY; fully scriptable with --region / --cluster / --yes.",
        "",
        "Examples:",
        "  $ launchpad setup                       # guided default-cluster bootstrap",
        "  $ launchpad setup --region us-west-2 --yes",
        "  $ launchpad setup --cluster prod --region us-east-1 --yes",
      ].join("\n"),
    )
    .action(async (_opts, command: Command) => {
      await runWizard(mergedOpts<SetupWizardOptions>(command));
    });
  applyGlobalOptions(setup);

  const iam = setup
    .command("iam-policy")
    .description("Print a least-privilege IAM policy for the operator/CI principal that runs launch-pad")
    .option("--account <id>", "AWS account id (default: your current identity)")
    .addHelpText(
      "after",
      [
        "",
        "Emits the exact set of permissions deploy/provision/manage needs — scoped to the",
        "launchpad state bucket, ECR repos, the launch-pad-node-* IAM roles, /launch-pad/*",
        "secrets, and a single region. Use it instead of attaching AdministratorAccess.",
        "",
        "Examples:",
        "  $ launchpad setup iam-policy",
        "  $ launchpad setup iam-policy --json > policy.json",
        "  $ launchpad setup iam-policy --account 111122223333 --region us-west-2",
      ].join("\n"),
    )
    .action(async (_opts, command: Command) => {
      await runIamPolicy(mergedOpts<SetupOptions>(command));
    });
  applyGlobalOptions(iam);

  const oidc = setup
    .command("github-oidc")
    .description("Print a GitHub Actions OIDC trust policy + deploy workflow (keyless CI deploys)")
    .requiredOption("--repo <owner/name>", "the GitHub repository that will deploy")
    .option("--branch <name>", `git branch allowed to assume the role (default: ${DEFAULT_BRANCH})`)
    .option("--all-branches", "allow any ref in the repo to assume the role (broader)")
    .option("--role-name <name>", `IAM deploy-role name (default: ${DEFAULT_DEPLOY_ROLE})`)
    .option("--account <id>", "AWS account id (default: your current identity)")
    .addHelpText(
      "after",
      [
        "",
        "Generates everything for keyless GitHub Actions deploys: the IAM role trust policy",
        "(federating GitHub's OIDC provider, pinned to your repo/branch) and a ready-to-commit",
        "deploy workflow. Pair the role with `launchpad setup iam-policy` for its permissions.",
        "",
        "Examples:",
        "  $ launchpad setup github-oidc --repo acme/widgets",
        "  $ launchpad setup github-oidc --repo acme/widgets --branch release --json",
      ].join("\n"),
    )
    .action(async (_opts, command: Command) => {
      await runGithubOidc(mergedOpts<GithubOidcOptions>(command));
    });
  applyGlobalOptions(oidc);

  const ciDeploy = setup
    .command("ci-deploy")
    .description("Create the bare-minimum CI deploy role + write .github/workflows/deploy.yml for this project")
    .option("--repo <owner/name>", "the GitHub repository that will deploy (default: derived from `origin`)")
    .option("--branch <name>", `git branch allowed to deploy (default: ${DEFAULT_BRANCH})`)
    .option("--role-name <name>", "IAM role name (default: <project>-deploy)")
    .option("--account <id>", "AWS account id (default: your current identity)")
    .option("--print", "print the role/trust/policy/workflow without creating anything")
    .option("--yes", "skip the confirmation prompt (required in CI / non-interactive)")
    .addHelpText(
      "after",
      [
        "",
        "Unlike `setup github-oidc` (which prints a BROAD operator role for you to wire up),",
        "this CREATES a least-privilege role scoped to ONE project on ONE dedicated cluster:",
        "it may push to the project's ECR repos and write that cluster's S3 state — and nothing",
        "else. No EC2/IAM writes, no other cluster, no other project. The generated workflow is",
        "deploy-only (--no-create/-repair/-recreate), so provisioning stays a local operator step.",
        "",
        "Run it from a directory with a launch-pad.toml. Requires a NON-default cluster.",
        "",
        "Examples:",
        "  $ launchpad setup ci-deploy --print            # review what it would create",
        "  $ launchpad setup ci-deploy --cluster prod --yes",
        "  $ launchpad setup ci-deploy --repo acme/widgets --cluster prod --branch release --yes",
      ].join("\n"),
    )
    .action(async (_opts, command: Command) => {
      await runCiDeploy(mergedOpts<CiDeployOptions>(command));
    });
  applyGlobalOptions(ciDeploy);
}
