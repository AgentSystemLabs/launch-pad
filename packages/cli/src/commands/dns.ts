import { promises as dns } from "node:dns";
import { Command } from "commander";
import {
  DEFAULT_CLUSTER,
  footprintOwner,
  LABEL_REGEX,
  nodeFrontsIngress,
  nodeRegistryKey,
  parseNodeRegistryEntry,
} from "@agentsystemlabs/launch-pad-shared";
import type { AwsEnv } from "../aws/context";
import { prepareAws } from "../aws/context";
import { getJson, listNodeIds } from "../aws/s3-state";
import { getClusterConfig } from "../cluster/store";
import { findConfigPath, loadConfig } from "../config/load";
import { classifyDns, type DnsObservation, type DnsVerdict, isIpv4 } from "../dns/classify";
import { type DnsTarget, planDnsTargets } from "../dns/plan";
import { loadDeployedPlacement } from "../deploy/deployed-footprint";
import { CliError } from "../errors";
import { applyGlobalOptions, type GlobalOpts, mergedOpts } from "../globals";
import { isJsonMode, log, printJson } from "../ui/log";
import { panel } from "../ui/box";
import { color } from "../ui/theme";

interface DnsOptions extends GlobalOpts {
  service?: string;
  env?: string;
  /** Skip the registry lookup and compare against this IP directly. */
  expect?: string;
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

/** The cluster's default edge, or the single edge-role node when no cluster default is stored. */
async function clusterDefaultEdge(aws: AwsEnv): Promise<string | null> {
  const cfg = aws.clusterId === DEFAULT_CLUSTER ? null : await getClusterConfig(aws, aws.clusterId);
  if (cfg?.defaultEdge) return cfg.defaultEdge;
  const edgeIds: string[] = [];
  for (const id of await listNodeIds(aws.s3, aws.bucket, aws.clusterId)) {
    const obj = await getJson(aws.s3, aws.bucket, nodeRegistryKey(aws.clusterId, id));
    if (!obj) continue;
    try {
      if (nodeFrontsIngress(parseNodeRegistryEntry(obj.raw).role)) edgeIds.push(id);
    } catch {
      /* malformed nodes surface elsewhere */
    }
  }
  return edgeIds.length === 1 ? edgeIds[0]! : null;
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
 * couldn't be determined statically (no cluster default edge recorded) from the *published*
 * placement — the node a domain actually landed on fronts it (its ingress edge, or the
 * node itself). Returns [] when not run from a project directory or AWS is unreachable.
 */
async function resolveTargets(aws: AwsEnv, opts: { env?: string; service?: string }): Promise<DnsTarget[]> {
  if (!findConfigPath(process.cwd())) return [];
  const { config } = loadConfig();
  let targets = planDnsTargets(config, opts.env, await clusterDefaultEdge(aws));
  if (opts.service !== undefined) targets = targets.filter((t) => t.service === opts.service);

  // Refine null fronting nodes (edge unknown statically) from the deployed placement.
  if (targets.some((t) => t.frontingNode === null)) {
    const owner = footprintOwner(config, opts.env);
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
        ? [color.dim(`AAAA: ${verdict.aaaa.join(", ")} — launchpad serves over IPv4; an AAAA can shadow it`)]
        : []),
    ]);
  }
  if (verdict.status === "wrong-ip" || verdict.status === "no-records") {
    process.exitCode = 1;
  }
}

async function runVerify(domain: string, opts: DnsOptions): Promise<void> {
  if (domain.length === 0) {
    throw new CliError("a domain is required", { hint: "e.g. launchpad dns verify app.example.com" });
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

export function registerDns(program: Command): void {
  const dnsCmd = program.command("dns").description("Verify a service's DNS against its node's Elastic IP");

  const verify = dnsCmd
    .command("verify <domain>")
    .description("Check a domain's A/AAAA/CNAME against the node's Elastic IP")
    .option("--service <name>", "service the domain belongs to (disambiguates the expected node)")
    .option("--env <name>", "environment footprint (same as deploy --env)")
    .option("--expect <ip>", "compare against this IPv4 directly (skips the registry lookup)")
    .addHelpText(
      "after",
      [
        "",
        "Resolves the domain's live records and compares them to the Elastic IP of the node",
        "that fronts it (the cluster's dedicated edge). Run from the project directory so",
        "the expected IP can be looked up — or pass --expect <ip> to check any domain.",
        "",
        "DNS is yours to configure: point each web domain (or a wildcard covering your env",
        "subdomains) as an A record at the edge's Elastic IP — deploy prints the exact",
        "targets. This command is the CI-friendly check that you got it right.",
        "",
        "Catches the common first-deploy HTTPS blockers: a missing A record and a record that",
        "doesn't resolve directly to the edge IP (e.g. via a proxy/CDN), which breaks Let's",
        "Encrypt HTTP-01.",
        "",
        "Examples:",
        "  $ launchpad dns verify app.example.com",
        "  $ launchpad dns verify app.example.com --expect 54.210.10.20",
        "  $ launchpad dns verify app-staging.example.com --env staging",
      ].join("\n"),
    )
    .action(async (domain: string, _opts, command: Command) => {
      await runVerify(domain, mergedOpts<DnsOptions>(command));
    });
  applyGlobalOptions(verify);
}
