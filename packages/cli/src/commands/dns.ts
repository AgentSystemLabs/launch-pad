import { promises as dns } from "node:dns";
import { Command } from "commander";
import {
  DEFAULT_CLUSTER,
  envProject,
  LABEL_REGEX,
  nodeRegistryKey,
  parseNodeRegistryEntry,
} from "@agentsystemlabs/launch-pad-shared";
import type { AwsEnv } from "../aws/context";
import { prepareAws } from "../aws/context";
import { makeRoute53 } from "../aws/route53";
import { getJson } from "../aws/s3-state";
import { getClusterConfig } from "../cluster/store";
import { findConfigPath, loadConfig } from "../config/load";
import { classifyDns, type DnsObservation, type DnsVerdict, isIpv4 } from "../dns/classify";
import { type DnsTarget, planDnsTargets } from "../dns/plan";
import { loadDeployedPlacement } from "../deploy/deployed-footprint";
import { CliError } from "../errors";
import { applyGlobalOptions, type GlobalOpts, mergedOpts } from "../globals";
import { isJsonMode, log, printJson } from "../ui/log";
import { panel } from "../ui/box";
import { confirm } from "../ui/prompt";
import { color } from "../ui/theme";

interface DnsOptions extends GlobalOpts {
  service?: string;
  env?: string;
  /** Skip the registry lookup and compare against this IP directly. */
  expect?: string;
}

interface DnsSetupOptions extends GlobalOpts {
  service?: string;
  env?: string;
  /** Record TTL in seconds (default 60). */
  ttl?: string;
  /** Block until Route53 reports the change INSYNC. */
  wait?: boolean;
  /** Skip the confirmation prompt (required in CI). */
  yes?: boolean;
}

/** Resolve a host's live A / AAAA / CNAME records, swallowing "no record" errors to []. */
async function resolveDomain(domain: string): Promise<DnsObservation> {
  const safe = async <T>(p: Promise<T[]>): Promise<T[]> => {
    try {
      return await p;
    } catch {
      return [];
    }
  };
  const [a, aaaa, cname] = await Promise.all([
    safe(dns.resolve4(domain)),
    safe(dns.resolve6(domain)),
    safe(dns.resolveCname(domain)),
  ]);
  return { a, aaaa, cname: cname[0] ?? null };
}

/** The cluster's default edge, or null for the default cluster / no edge configured. */
async function clusterDefaultEdge(aws: AwsEnv): Promise<string | null> {
  if (aws.clusterId === DEFAULT_CLUSTER) return null;
  const cfg = await getClusterConfig(aws, aws.clusterId);
  return cfg?.defaultEdge ?? null;
}

/** Read a node's Elastic IP from the cluster registry, or null when absent/unreadable. */
async function nodeEip(aws: AwsEnv, nodeId: string): Promise<string | null> {
  try {
    const obj = await getJson(aws.s3, aws.bucket, nodeRegistryKey(aws.clusterId, nodeId));
    if (!obj) return null;
    return parseNodeRegistryEntry(obj.raw).publicIp;
  } catch {
    return null;
  }
}

/**
 * Resolve the project's DNS targets (config-derived) and refine any whose fronting node
 * couldn't be determined statically (cluster-placed co-located) from the *published*
 * placement — the node a domain actually landed on fronts it (its ingress edge, or the
 * node itself). Returns [] when not run from a project directory or AWS is unreachable.
 */
async function resolveTargets(aws: AwsEnv, opts: { env?: string; service?: string }): Promise<DnsTarget[]> {
  if (!findConfigPath(process.cwd())) return [];
  const { config } = loadConfig();
  let targets = planDnsTargets(config, opts.env, await clusterDefaultEdge(aws));
  if (opts.service !== undefined) targets = targets.filter((t) => t.service === opts.service);

  // Refine null fronting nodes (cluster-placed co-located) from the deployed placement.
  if (targets.some((t) => t.frontingNode === null)) {
    const owner = envProject(config.project, opts.env);
    const placement = await loadDeployedPlacement(aws.s3, aws.bucket, aws.clusterId, owner);
    const byDomain = new Map<string, string>();
    for (const [nodeId, occupancies] of placement.byNode) {
      for (const o of occupancies) {
        if (o.ingress) byDomain.set(o.ingress.domain, o.ingress.edge ?? nodeId);
      }
    }
    targets = targets.map((t) =>
      t.frontingNode === null ? { ...t, frontingNode: byDomain.get(t.domain) ?? null } : t,
    );
  }
  return targets;
}

function statusColor(v: DnsVerdict): (s: string) => string {
  if (v.status === "ok") return color.green;
  if (v.status === "no-expected-ip") return color.yellow;
  return color.red;
}

function reportVerdict(domain: string, verdict: DnsVerdict): void {
  if (isJsonMode()) {
    printJson({ domain, ...verdict });
  } else {
    const paint = statusColor(verdict);
    panel(`DNS ${domain}`, [
      `${paint(verdict.status)} ${verdict.message}`,
      ...(verdict.aaaa.length > 0
        ? [color.dim(`AAAA: ${verdict.aaaa.join(", ")} — launch-pad serves over IPv4; an AAAA can shadow it`)]
        : []),
    ]);
  }
  if (verdict.status === "wrong-ip" || verdict.status === "cloudflare-proxied" || verdict.status === "no-records") {
    process.exitCode = 1;
  }
}

async function runVerify(domain: string, opts: DnsOptions): Promise<void> {
  if (domain.length === 0) {
    throw new CliError("a domain is required", { hint: "e.g. launch-pad dns verify app.example.com" });
  }
  if (opts.env !== undefined && !LABEL_REGEX.test(opts.env)) {
    throw new CliError(`invalid --env "${opts.env}"`, {
      hint: "use lowercase letters, numbers and hyphens (a valid DNS label)",
    });
  }
  if (opts.expect !== undefined && !isIpv4(opts.expect)) {
    throw new CliError(`invalid --expect "${opts.expect}"`, { hint: "pass an IPv4 address, e.g. --expect 54.210.10.20" });
  }

  let expected = opts.expect ?? null;
  if (expected === null) {
    try {
      const aws = await prepareAws(opts);
      const targets = await resolveTargets(aws, opts);
      const match = targets.find((t) => t.domain === domain);
      if (match?.frontingNode) expected = await nodeEip(aws, match.frontingNode);
    } catch {
      // AWS unreachable / not in a project — fall through with no expected IP.
    }
  }

  const observation = await resolveDomain(domain);
  const verdict = classifyDns(observation, expected);
  reportVerdict(domain, verdict);

  if (!isJsonMode() && verdict.status === "no-expected-ip") {
    log.dim(
      `  couldn't find the Elastic IP for "${domain}" — run from the project dir, pass --service, or use --expect <ip>`,
    );
  }
}

/** One planned A-record write, with the change it would make. */
interface SetupPlanItem {
  domain: string;
  service: string;
  zoneId: string;
  ip: string;
  current: string[];
  /** True when the record already points exactly at `ip` (UPSERT would be a no-op). */
  unchanged: boolean;
}

function parseTtl(raw: string | undefined): number {
  if (raw === undefined) return 60;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1 || n > 86400) {
    throw new CliError(`invalid --ttl "${raw}"`, { hint: "pass whole seconds between 1 and 86400" });
  }
  return n;
}

async function runSetup(opts: DnsSetupOptions): Promise<void> {
  if (opts.env !== undefined && !LABEL_REGEX.test(opts.env)) {
    throw new CliError(`invalid --env "${opts.env}"`, {
      hint: "use lowercase letters, numbers and hyphens (a valid DNS label)",
    });
  }
  if (!findConfigPath(process.cwd())) {
    throw new CliError("no launch-pad.toml found", { hint: "run `launch-pad dns setup` from your project directory" });
  }
  const ttl = parseTtl(opts.ttl);

  const aws = await prepareAws(opts);
  const targets = await resolveTargets(aws, opts);
  if (targets.length === 0) {
    log.info(opts.service ? `no web service named "${opts.service}"` : "no web services to set up DNS for (workers only)");
    return;
  }

  const r53 = makeRoute53(aws.region);
  const plan: SetupPlanItem[] = [];
  const skipped: string[] = [];

  for (const t of targets) {
    if (!t.frontingNode) {
      skipped.push(`${t.domain} — couldn't determine which node fronts it (deploy first, or set node/edge)`);
      continue;
    }
    const ip = await nodeEip(aws, t.frontingNode);
    if (!ip) {
      skipped.push(`${t.domain} — node ${t.frontingNode} has no Elastic IP yet (provision/resume it, or it's a private app node)`);
      continue;
    }
    // Defense-in-depth: the EIP comes from our own S3 registry, but never write a
    // malformed value into DNS — Route53 would only reject it with a cryptic error.
    if (!isIpv4(ip)) {
      skipped.push(`${t.domain} — node ${t.frontingNode} has a non-IPv4 address "${ip}" in the registry (skipping)`);
      continue;
    }
    const zone = await r53.findZone(t.domain);
    if (!zone) {
      skipped.push(`${t.domain} — no Route53 hosted zone owns it (use Cloudflare/registrar, or create the zone)`);
      continue;
    }
    const current = await r53.currentA(zone.id, t.domain);
    plan.push({
      domain: t.domain,
      service: t.service,
      zoneId: zone.id,
      ip,
      current,
      unchanged: current.length === 1 && current[0] === ip,
    });
  }

  const toWrite = plan.filter((p) => !p.unchanged);

  // Show the plan (JSON for automation, panel for a human) before any write.
  if (isJsonMode()) {
    printJson({ plan, skipped, willWrite: toWrite.length });
  } else {
    panel("DNS setup (Route53)", [
      ...plan.map((p) =>
        p.unchanged
          ? color.dim(`${p.domain}  →  A ${p.ip}  (already set)`)
          : `${p.domain}  →  A ${p.ip}  ${color.dim(p.current.length ? `(was ${p.current.join(", ")})` : "(new record)")}`,
      ),
      ...skipped.map((s) => color.yellow(`skip  ${s}`)),
    ]);
  }

  if (toWrite.length === 0) {
    if (!isJsonMode()) {
      log.info(plan.length > 0 ? "all records already point at the right Elastic IP — nothing to do" : "nothing to write");
    }
    if (skipped.length > 0) process.exitCode = 1;
    return;
  }

  // A confirmation prompt only makes sense for an interactive human; in JSON / non-TTY
  // automation, --yes is the explicit go-ahead (confirm() would just return its `false`
  // fallback and silently no-op an intended write).
  const proceed =
    opts.yes === true ||
    (!isJsonMode() &&
      (await confirm(`Write ${toWrite.length} DNS-only A record${toWrite.length === 1 ? "" : "s"} to Route53?`, false)));
  if (!proceed) {
    if (!isJsonMode()) log.info("aborted — no DNS records were changed (re-run with --yes to apply)");
    return;
  }

  const changeIds: string[] = [];
  for (const p of toWrite) {
    const id = await r53.upsertA(p.zoneId, p.domain, p.ip, ttl);
    changeIds.push(id);
    if (!isJsonMode()) log.step(`wrote ${color.cyan(p.domain)} → ${p.ip}`);
  }

  if (opts.wait === true) {
    if (!isJsonMode()) log.step("waiting for Route53 to propagate (INSYNC)…");
    for (const id of changeIds) await r53.waitInsync(id);
    if (!isJsonMode()) log.success("all changes INSYNC");
  }

  if (!isJsonMode()) {
    log.plain();
    log.dim("Route53 records are DNS-only by default (no proxy), so Let's Encrypt HTTP-01 will succeed.");
    log.dim(`Verify once propagated:  launch-pad dns verify ${toWrite[0]?.domain}`);
  }
  if (skipped.length > 0) process.exitCode = 1;
}

export function registerDns(program: Command): void {
  const dnsCmd = program.command("dns").description("Inspect, verify, and set up a service's DNS");

  const verify = dnsCmd
    .command("verify <domain>")
    .description("Check a domain's A/AAAA/CNAME against the node's Elastic IP (warns on Cloudflare proxy)")
    .option("--service <name>", "service the domain belongs to (disambiguates the expected node)")
    .option("--env <name>", "environment footprint (same as deploy --env)")
    .option("--expect <ip>", "compare against this IPv4 directly (skips the registry lookup)")
    .addHelpText(
      "after",
      [
        "",
        "Resolves the domain's live records and compares them to the Elastic IP of the node",
        "that fronts it (its edge, or its co-located node). Run from the project directory so",
        "the expected IP can be looked up — or pass --expect <ip> to check any domain.",
        "",
        "Catches the common first-deploy HTTPS blockers: a missing A record, the wrong IP, and",
        "a Cloudflare-proxied (orange-cloud) record, which silently breaks Let's Encrypt HTTP-01.",
        "",
        "Examples:",
        "  $ launch-pad dns verify app.example.com",
        "  $ launch-pad dns verify app.example.com --expect 54.210.10.20",
        "  $ launch-pad dns verify app-staging.example.com --env staging",
      ].join("\n"),
    )
    .action(async (domain: string, _opts, command: Command) => {
      await runVerify(domain, mergedOpts<DnsOptions>(command));
    });
  applyGlobalOptions(verify);

  const setup = dnsCmd
    .command("setup")
    .description("Create/update DNS-only A records in Route53 for this project's web services")
    .option("--service <name>", "only set up DNS for this service")
    .option("--env <name>", "environment footprint (same as deploy --env)")
    .option("--ttl <seconds>", "record TTL in seconds (default 60)")
    .option("--wait", "block until Route53 reports the change INSYNC")
    .option("--yes", "skip the confirmation prompt (required in CI)")
    .addHelpText(
      "after",
      [
        "",
        "Points each web service's domain at the Elastic IP of the node that fronts it, using",
        "your AWS Route53 hosted zone. Records are written DNS-only (never proxied), so Caddy's",
        "Let's Encrypt HTTP-01 challenge succeeds. Run from the project directory after a deploy.",
        "",
        "Requires a Route53 hosted zone that owns the domain. Domains on Cloudflare / another",
        "registrar are skipped — add a grey-cloud A record there by hand, then `dns verify`.",
        "",
        "Examples:",
        "  $ launch-pad dns setup",
        "  $ launch-pad dns setup --service web --wait",
        "  $ launch-pad dns setup --env staging --yes",
      ].join("\n"),
    )
    .action(async (_opts, command: Command) => {
      await runSetup(mergedOpts<DnsSetupOptions>(command));
    });
  applyGlobalOptions(setup);
}
