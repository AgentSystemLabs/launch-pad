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
            handle: Array<{ handler: string; upstreams: Array<{ dial: string }> }>;
          }>;
        }
      >;
    };
  };
}

describe("caddy buildConfig", () => {
  it("includes a permissive admin block so the loopback agent isn't rejected", () => {
    const cfg = buildConfig([]) as CaddyConfig;
    // The empty origin is what a server-side fetch sends — it must be allowed.
    expect(cfg.admin.origins).toContain("");
    expect(cfg.admin.origins).toContain("127.0.0.1:2019");
  });

  it("clears all servers when there are no web routes", () => {
    const cfg = buildConfig([]) as CaddyConfig;
    expect(cfg.apps.http.servers).toEqual({});
  });

  it("builds a host-matched reverse-proxy route per web service", () => {
    const cfg = buildConfig([{ domain: "app.example.com", hostPort: 20001 }]) as CaddyConfig;
    const server = cfg.apps.http.servers.launchpad;
    expect(server?.listen).toEqual([":443"]);
    const route = server?.routes[0];
    expect(route?.match[0]?.host).toEqual(["app.example.com"]);
    expect(route?.handle[0]?.handler).toBe("reverse_proxy");
    expect(route?.handle[0]?.upstreams[0]?.dial).toBe("127.0.0.1:20001");
  });
});
