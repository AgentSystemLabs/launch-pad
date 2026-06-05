import {
  ChangeResourceRecordSetsCommand,
  GetChangeCommand,
  ListHostedZonesByNameCommand,
  Route53Client,
} from "@aws-sdk/client-route-53";

const stripDot = (s: string): string => s.replace(/\.$/, "");

export interface Dns {
  /** Find the hosted zone whose name is the longest suffix of `domain`. */
  findZoneId(domain: string): Promise<string>;
  /** Create/replace an A record `name → ip`. Returns the change id. */
  upsertA(zoneId: string, name: string, ip: string, ttl?: number): Promise<string>;
  /** Delete the A record `name → ip` (no-op if it doesn't exist). */
  deleteA(zoneId: string, name: string, ip: string, ttl?: number): Promise<void>;
  /** Poll until a change is INSYNC across Route53, or throw on timeout. */
  waitInsync(changeId: string, timeoutMs?: number): Promise<void>;
}

export function makeDns(region = "us-east-1"): Dns {
  // Route53 is global; the client region only affects the endpoint signing.
  const r53 = new Route53Client({ region });

  async function findZoneId(domain: string): Promise<string> {
    const target = stripDot(domain);
    const res = await r53.send(new ListHostedZonesByNameCommand({}));
    const candidates = (res.HostedZones ?? [])
      .map((z) => ({ id: z.Id ?? "", name: stripDot(z.Name ?? "") }))
      .filter((z) => z.id && (target === z.name || target.endsWith(`.${z.name}`)))
      .sort((a, b) => b.name.length - a.name.length);
    const zone = candidates[0];
    if (!zone) {
      throw new Error(
        `no Route53 hosted zone found for "${domain}" — create/own a zone that is a suffix of it`,
      );
    }
    // Ids come back as "/hostedzone/Z123"; ChangeResourceRecordSets accepts either form.
    return zone.id;
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
          Comment: "launch-pad e2e",
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

  return { findZoneId, upsertA, deleteA, waitInsync };
}
