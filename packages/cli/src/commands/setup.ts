import { S3Client } from "@aws-sdk/client-s3";
import { Command } from "commander";
import { DEFAULT_CLUSTER, LABEL_REGEX, stateBucketName } from "@agentsystemlabs/launch-pad-shared";
import { prepareAws } from "../aws/context";
import { ensureBucket } from "../aws/s3-state";
import { ensureClusterConfig } from "../cluster/store";
import { localConfigPath, upsertClusterTarget } from "../config/local";
import { CliError } from "../errors";
import { applyGlobalOptions, type GlobalOpts, mergedOpts } from "../globals";
import {
  buildDeployWorkflow,
  buildOidcTrustPolicy,
  githubSubject,
  oidcProviderArn,
  oidcTrustPolicyJson,
  parseRepo,
  validateBranch,
  validateRoleName,
} from "../setup/github-oidc";
import { buildOperatorPolicy, operatorPolicyJson } from "../setup/operator-policy";
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
  log.dim("  Tip: `launch-pad setup iam-policy --json > policy.json` for just the document.");
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
  log.plain("  3. Attach the operator policy (launch-pad setup iam-policy) to it:");
  log.plain(
    `       aws iam attach-role-policy --role-name ${roleName} \\\n` +
      `         --policy-arn arn:aws:iam::${accountId}:policy/launch-pad-operator`,
  );
  log.plain("  4. Commit the workflow below as .github/workflows/deploy.yml");
  log.dim("  Tip: `launch-pad setup github-oidc --repo … --json` emits both as one JSON object.");

  log.plain();
  log.step("Trust policy → launch-pad-oidc-trust.json");
  process.stderr.write("\n");
  process.stdout.write(oidcTrustPolicyJson({ accountId, subject }));
  process.stderr.write("\n");
  log.step("Workflow → .github/workflows/deploy.yml");
  process.stderr.write("\n");
  process.stdout.write(workflow);
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
 * First-run bootstrap (`launch-pad setup` with no subcommand): pick a region, confirm the
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
  log.plain("  1. launch-pad doctor          # preflight Docker + AWS before any spend");
  log.plain("  2. launch-pad init            # scaffold launch-pad.toml in your app");
  log.plain(
    `  3. launch-pad deploy --yes${plan.isDefaultCluster ? "" : ` --cluster ${cluster}`}   # build, push, auto-provision + run`,
  );
  log.dim("  Tip: `launch-pad setup iam-policy` / `setup github-oidc` for least-privilege + CI.");
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
        "  $ launch-pad setup                       # guided default-cluster bootstrap",
        "  $ launch-pad setup --region us-west-2 --yes",
        "  $ launch-pad setup --cluster prod --region us-east-1 --yes",
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
        "launch-pad state bucket, ECR repos, the launch-pad-node-* IAM roles, /launch-pad/*",
        "secrets, and a single region. Use it instead of attaching AdministratorAccess.",
        "",
        "Examples:",
        "  $ launch-pad setup iam-policy",
        "  $ launch-pad setup iam-policy --json > policy.json",
        "  $ launch-pad setup iam-policy --account 111122223333 --region us-west-2",
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
        "deploy workflow. Pair the role with `launch-pad setup iam-policy` for its permissions.",
        "",
        "Examples:",
        "  $ launch-pad setup github-oidc --repo acme/widgets",
        "  $ launch-pad setup github-oidc --repo acme/widgets --branch release --json",
      ].join("\n"),
    )
    .action(async (_opts, command: Command) => {
      await runGithubOidc(mergedOpts<GithubOidcOptions>(command));
    });
  applyGlobalOptions(oidc);
}
