import { Command } from "commander";
import {
  HEARTBEAT_STALE_MS,
  nodeRegistryKey,
  parseNodeRegistryEntry,
  parseNodeStatus,
  statusKey,
} from "@agentsystemlabs/launch-pad-shared";
import { type Alert, type AlertNodeInput, evaluateAlerts } from "../alerts/evaluate";
import { buildAlertPayload, isSecureWebhookUrl, postWebhook } from "../alerts/webhook";
import { prepareAws } from "../aws/context";
import { getJson, listNodeIds } from "../aws/s3-state";
import { CliError } from "../errors";
import { applyGlobalOptions, type GlobalOpts, mergedOpts } from "../globals";
import { panel } from "../ui/box";
import { isJsonMode, log, printJson } from "../ui/log";
import { color } from "../ui/theme";

interface AlertsCheckOptions extends GlobalOpts {
  /** Webhook URL to POST alerts to (Slack/Discord/generic). Falls back to LAUNCHPAD_ALERT_WEBHOOK. */
  webhook?: string;
  /** Heartbeat staleness threshold in ms (default HEARTBEAT_STALE_MS). */
  stale?: string;
}

function parseStaleMs(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new CliError(`invalid --stale "${raw}"`, { hint: "pass a positive whole number of milliseconds, e.g. --stale 60000" });
  }
  return n;
}

function resolveWebhook(opts: AlertsCheckOptions): string | undefined {
  const url = opts.webhook ?? process.env.LAUNCHPAD_ALERT_WEBHOOK;
  if (url === undefined) return undefined;
  if (!isSecureWebhookUrl(url)) {
    throw new CliError(`invalid webhook URL "${url}"`, {
      hint: "pass an HTTPS URL, e.g. --webhook https://hooks.slack.com/services/…",
    });
  }
  return url;
}

const SEVERITY_PAINT = { critical: color.red, warning: color.yellow } as const;

async function runAlertsCheck(opts: AlertsCheckOptions): Promise<void> {
  const staleMs = opts.stale !== undefined ? parseStaleMs(opts.stale) : HEARTBEAT_STALE_MS;
  const webhook = resolveWebhook(opts);
  const aws = await prepareAws(opts);

  const inputs: AlertNodeInput[] = [];
  for (const id of await listNodeIds(aws.s3, aws.bucket, aws.clusterId)) {
    const reg = await getJson(aws.s3, aws.bucket, nodeRegistryKey(aws.clusterId, id));
    if (!reg) continue;
    const entry = parseNodeRegistryEntry(reg.raw);
    const statusObj = await getJson(aws.s3, aws.bucket, statusKey(aws.clusterId, id));
    let status = null;
    if (statusObj) {
      try {
        status = parseNodeStatus(statusObj.raw);
      } catch {
        status = null; // a malformed status.json reads as "no status" → heartbeat alert
      }
    }
    inputs.push({ nodeId: entry.nodeId, state: entry.state, createdAt: entry.createdAt, status });
  }

  const alerts = evaluateAlerts(inputs, Date.now(), { staleMs });

  let delivered = false;
  if (webhook && alerts.length > 0) {
    await postWebhook(webhook, buildAlertPayload(aws.clusterId, alerts));
    delivered = true;
  }

  if (isJsonMode()) {
    printJson({ cluster: aws.clusterId, checkedNodes: inputs.length, alertCount: alerts.length, delivered, alerts });
    if (alerts.length > 0) process.exitCode = 1;
    return;
  }

  if (alerts.length === 0) {
    log.success(`no alerts — ${inputs.length} node(s) in cluster "${aws.clusterId}" look healthy`);
    return;
  }

  panel(
    `Alerts · ${aws.clusterId}`,
    alerts.map((a: Alert) => {
      const paint = SEVERITY_PAINT[a.severity];
      return `${paint("●")} ${color.cyan(a.nodeId)} ${color.dim(`[${a.kind}]`)} — ${a.message}`;
    }),
  );
  if (delivered) log.dim(`  delivered to webhook`);
  else if (webhook === undefined) log.dim(`  set --webhook <url> (or LAUNCHPAD_ALERT_WEBHOOK) to notify Slack/Discord`);
  process.exitCode = 1;
}

export function registerAlerts(program: Command): void {
  const alerts = program.command("alerts").description("Check cluster health and notify on problems");

  const check = alerts
    .command("check")
    .description("Scan the cluster for unhealthy nodes/services; POST alerts to a webhook; non-zero exit on any alert")
    .option("--webhook <url>", "POST alerts to this URL (Slack/Discord/generic); env LAUNCHPAD_ALERT_WEBHOOK")
    .option("--stale <ms>", `heartbeat staleness threshold in ms (default ${HEARTBEAT_STALE_MS})`)
    .addHelpText(
      "after",
      [
        "",
        "Reads each node's registry + status.json and flags real faults on nodes that are",
        "supposed to be running: a ready node whose agent stopped heartbeating, or a service",
        "in error / fully down. A paused node, a provisioning node, and a transient rollout dip",
        "do NOT alert. Exits non-zero when there's any alert, so you can gate it in a scheduled",
        "check (cron / GitHub Action) and POST to Slack/Discord with --webhook.",
        "",
        "Examples:",
        "  $ launchpad alerts check",
        "  $ launchpad alerts check --cluster prod --webhook https://hooks.slack.com/services/…",
        "  $ launchpad alerts check --json",
      ].join("\n"),
    )
    .action(async (_opts, command: Command) => {
      await runAlertsCheck(mergedOpts<AlertsCheckOptions>(command));
    });
  applyGlobalOptions(check);
}
