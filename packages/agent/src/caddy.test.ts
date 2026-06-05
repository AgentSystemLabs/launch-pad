import { describe, expect, it } from "vitest";
import { buildConfig } from "./caddy";

// Loose shape we assert against (buildConfig returns `unknown`).
interface CaddyConfig {
  admin: { listen: string; origins: string[] };
  apps: {
    http: {
      servers: Record<
        string,
        {
          listen: string[];
          routes: Array<{
            match: Array<{ host: string[] }>;
            handle: Array<{
              handler: string;
              upstreams: Array<{ dial: string }>;
              load_balancing?: {
                selection_policy: { policy: string };
                try_duration?: string;
                retries?: number;
              };
              health_checks?: {
                active?: { uri: string; expect_status: number };
                passive?: { fail_duration: string; max_fails: number };
              };
            }>;
          }>;
        }
      >;
    };
  };
}

describe("caddy buildConfig", () => {
  it("includes a permissive admin block so the loopback agent isn't rejected", () => {
    const cfg = buildConfig([]) as CaddyConfig;
    expect(cfg.admin.origins).toContain("");
    expect(cfg.admin.origins).toContain("127.0.0.1:2019");
  });

  it("clears all servers when there are no web routes", () => {
    const cfg = buildConfig([]) as CaddyConfig;
    expect(cfg.apps.http.servers).toEqual({});
  });

  it("drops a route that has no upstreams", () => {
    const cfg = buildConfig([{ domain: "x.com", upstreams: [] }]) as CaddyConfig;
    expect(cfg.apps.http.servers).toEqual({});
  });

  it("builds a load-balanced, health-checked route across replicas", () => {
    const cfg = buildConfig([
      {
        domain: "app.example.com",
        upstreams: ["127.0.0.1:20001", "127.0.0.1:20002"],
        healthPath: "/healthz",
      },
    ]) as CaddyConfig;
    const server = cfg.apps.http.servers.launchpad;
    expect(server?.listen).toEqual([":443"]);
    const handler = server?.routes[0]?.handle[0];
    expect(server?.routes[0]?.match[0]?.host).toEqual(["app.example.com"]);
    expect(handler?.handler).toBe("reverse_proxy");
    expect(handler?.upstreams.map((u) => u.dial)).toEqual(["127.0.0.1:20001", "127.0.0.1:20002"]);
    expect(handler?.load_balancing?.selection_policy.policy).toBe("round_robin");
    // Retries + passive eviction keep rollouts zero-downtime when an upstream drains.
    expect(handler?.load_balancing?.try_duration).toBe("5s");
    expect(handler?.health_checks?.active?.uri).toBe("/healthz");
    expect(handler?.health_checks?.passive?.max_fails).toBe(1);
  });

  it("keeps passive health checks (retry/evict) even with no active health path", () => {
    const cfg = buildConfig([{ domain: "app.example.com", upstreams: ["127.0.0.1:20001"] }]) as CaddyConfig;
    const handler = cfg.apps.http.servers.launchpad?.routes[0]?.handle[0];
    expect(handler?.health_checks?.passive?.fail_duration).toBe("10s");
    expect(handler?.health_checks?.active).toBeUndefined();
  });
});
