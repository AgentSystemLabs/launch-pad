/**
 * Thin Route53 client for `launch-pad dns setup` — the only command that *writes* DNS.
 * Route53 is a global service, so the client region only affects endpoint signing; the
 * resolved `--profile` credentials are picked up from the environment (set by
 * `createClients`). The longest-suffix zone match lives in the pure `dns/plan.ts` so it's
 * unit-tested; everything here is the SDK side-effecting shell.
 */
import {
  ChangeResourceRecordSetsCommand,
  GetChangeCommand,
  ListHostedZonesByNameCommand,
  ListResourceRecordSetsCommand,
  Route53Client,
} from "@aws-sdk/client-route-53";
import { type HostedZone, selectHostedZone } from "../dns/plan";

const stripDot = (s: string): string => s.replace(/\.$/, "");

export interface Route53Helper {
  /** Find the hosted zone whose name is the longest suffix of `domain`, or null. */
  findZone(domain: string): Promise<HostedZone | null>;
  /** The current A-record values for `name` in `zoneId` (empty when none exists). */
  currentA(zoneId: string, name: string): Promise<string[]>;
  /** Create/replace the A record `name → ip`. Returns the change id. */
  upsertA(zoneId: string, name: string, ip: string, ttl?: number): Promise<string>;
  /** Delete the A record `name → ip` (no-op when it doesn't exist). */
  deleteA(zoneId: string, name: string, ip: string, ttl?: number): Promise<void>;
  /** Poll until a change is INSYNC across Route53, or throw on timeout. */
  waitInsync(changeId: string, timeoutMs?: number): Promise<void>;
}

export function makeRoute53(region: string): Route53Helper {
  const r53 = new Route53Client({ region });

  async function listAllZones(): Promise<HostedZone[]> {
    const zones: HostedZone[] = [];
    let dnsName: string | undefined;
    let hostedZoneId: string | undefined;
    do {
      const res = await r53.send(
        new ListHostedZonesByNameCommand({ DNSName: dnsName, HostedZoneId: hostedZoneId }),
      );
      for (const z of res.HostedZones ?? []) {
        zones.push({ id: z.Id ?? "", name: z.Name ?? "" });
      }
      dnsName = res.IsTruncated ? res.NextDNSName : undefined;
      hostedZoneId = res.IsTruncated ? res.NextHostedZoneId : undefined;
    } while (dnsName !== undefined);
    return zones;
  }

  async function findZone(domain: string): Promise<HostedZone | null> {
    return selectHostedZone(await listAllZones(), domain);
  }

  async function currentA(zoneId: string, name: string): Promise<string[]> {
    const res = await r53.send(
      new ListResourceRecordSetsCommand({
        HostedZoneId: zoneId,
        StartRecordName: name,
        StartRecordType: "A",
        MaxItems: 1,
      }),
    );
    const rr = (res.ResourceRecordSets ?? []).find(
      (r) => r.Type === "A" && stripDot(r.Name ?? "") === stripDot(name),
    );
    return (rr?.ResourceRecords ?? []).map((r) => r.Value ?? "").filter((v) => v.length > 0);
  }

  async function change(
    action: "UPSERT" | "DELETE",
    zoneId: string,
    name: string,
    ip: string,
    ttl: number,
  ): Promise<string | undefined> {
    const res = await r53.send(
      new ChangeResourceRecordSetsCommand({
        HostedZoneId: zoneId,
        ChangeBatch: {
          Comment: "launch-pad dns setup",
          Changes: [
            {
              Action: action,
              ResourceRecordSet: {
                Name: name,
                Type: "A",
                TTL: ttl,
                ResourceRecords: [{ Value: ip }],
              },
            },
          ],
        },
      }),
    );
    return res.ChangeInfo?.Id;
  }

  async function upsertA(zoneId: string, name: string, ip: string, ttl = 60): Promise<string> {
    const id = await change("UPSERT", zoneId, name, ip, ttl);
    if (!id) throw new Error("Route53 UPSERT returned no change id");
    return id;
  }

  async function deleteA(zoneId: string, name: string, ip: string, ttl = 60): Promise<void> {
    try {
      await change("DELETE", zoneId, name, ip, ttl);
    } catch (error) {
      // Record already gone / never created — nothing to clean up.
      const msg = (error as Error).message ?? "";
      if (/not found|does not exist|InvalidChangeBatch/i.test(msg)) return;
      throw error;
    }
  }

  async function waitInsync(changeId: string, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await r53.send(new GetChangeCommand({ Id: changeId }));
      if (res.ChangeInfo?.Status === "INSYNC") return;
      if (Date.now() > deadline) throw new Error(`Route53 change ${changeId} not INSYNC within ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  return { findZone, currentA, upsertA, deleteA, waitInsync };
}
