import { describe, expect, it } from "vitest";
import { PREVIEW_MARKER_VERSION } from "./constants";
import {
  buildPreviewMarker,
  isPreviewExpired,
  parsePreviewMarker,
  parsePreviewTtlMs,
  planPreviewPrune,
  selectPreviewMarkers,
  type PreviewMarker,
} from "./preview";

const NOW = "2026-06-11T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);

function marker(overrides: Partial<PreviewMarker> = {}): PreviewMarker {
  return parsePreviewMarker({
    version: PREVIEW_MARKER_VERSION,
    project: "shop",
    env: "pr-1",
    owner: "shop-pr-1",
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: null,
    domains: ["app-pr-1.example.com"],
    ...overrides,
  });
}

describe("parsePreviewTtlMs", () => {
  it("parses minutes, hours, and days", () => {
    expect(parsePreviewTtlMs("30m")).toBe(30 * 60_000);
    expect(parsePreviewTtlMs("72h")).toBe(72 * 3_600_000);
    expect(parsePreviewTtlMs("7d")).toBe(7 * 86_400_000);
  });

  it("rejects malformed, zero, negative, unit-less, and out-of-range values", () => {
    for (const bad of ["", "h", "12", "0m", "-5h", "1.5h", "12x", "12H ", "999999999d"]) {
      expect(parsePreviewTtlMs(bad), bad).toBeNull();
    }
  });

  it("enforces the 1m–90d bounds", () => {
    expect(parsePreviewTtlMs("1m")).toBe(60_000);
    expect(parsePreviewTtlMs("90d")).toBe(90 * 86_400_000);
    expect(parsePreviewTtlMs("91d")).toBeNull();
  });
});

describe("buildPreviewMarker", () => {
  it("derives the owner footprint, sorts + dedupes domains, and stamps expiry from the TTL", () => {
    const m = buildPreviewMarker({
      project: "shop",
      env: "pr-1",
      now: NOW,
      ttlMs: 60 * 60_000,
      domains: ["b.example.com", "a.example.com", "b.example.com"],
    });
    expect(m.version).toBe(PREVIEW_MARKER_VERSION);
    expect(m.owner).toBe("shop-pr-1");
    expect(m.createdAt).toBe(NOW);
    expect(m.expiresAt).toBe(new Date(NOW_MS + 3_600_000).toISOString());
    expect(m.domains).toEqual(["a.example.com", "b.example.com"]);
  });

  it("records no expiry when there is no TTL", () => {
    const m = buildPreviewMarker({ project: "shop", env: "pr-1", now: NOW, ttlMs: null, domains: [] });
    expect(m.expiresAt).toBeNull();
  });

  it("preserves the original createdAt (and any earlier expiry inputs) on a re-deploy", () => {
    const created = "2026-06-10T00:00:00.000Z";
    const prior = buildPreviewMarker({ project: "shop", env: "pr-1", now: created, ttlMs: null, domains: [] });
    const next = buildPreviewMarker({
      project: "shop",
      env: "pr-1",
      now: NOW,
      ttlMs: 60_000,
      domains: [],
      prior,
    });
    expect(next.createdAt).toBe(created);
    expect(next.updatedAt).toBe(NOW);
    expect(next.expiresAt).toBe(new Date(NOW_MS + 60_000).toISOString());
  });

  it("keeps the prior expiry when a re-deploy passes no TTL", () => {
    const prior = buildPreviewMarker({
      project: "shop",
      env: "pr-1",
      now: "2026-06-10T00:00:00.000Z",
      ttlMs: 60_000,
      domains: [],
    });
    const next = buildPreviewMarker({ project: "shop", env: "pr-1", now: NOW, ttlMs: null, domains: [], prior });
    expect(next.expiresAt).toBe(prior.expiresAt);
  });
});

describe("isPreviewExpired", () => {
  it("never expires a marker without a TTL", () => {
    expect(isPreviewExpired(marker({ expiresAt: null }), NOW_MS)).toBe(false);
  });

  it("expires strictly after the deadline", () => {
    const m = marker({ expiresAt: NOW });
    expect(isPreviewExpired(m, NOW_MS - 1)).toBe(false);
    expect(isPreviewExpired(m, NOW_MS)).toBe(false);
    expect(isPreviewExpired(m, NOW_MS + 1)).toBe(true);
  });

  it("treats an unparsable expiresAt as expired (fail-closed for cleanup)", () => {
    expect(isPreviewExpired(marker({ expiresAt: "not-a-date" }), NOW_MS)).toBe(true);
  });
});

describe("planPreviewPrune", () => {
  it("splits expired from kept and ignores TTL-less markers", () => {
    const expired = marker({ env: "pr-1", owner: "shop-pr-1", expiresAt: "2026-06-11T00:00:00.000Z" });
    const live = marker({ env: "pr-2", owner: "shop-pr-2", expiresAt: "2026-06-12T00:00:00.000Z" });
    const forever = marker({ env: "staging", owner: "shop-staging", expiresAt: null });
    const plan = planPreviewPrune([live, forever, expired], NOW_MS);
    expect(plan.expired.map((m) => m.owner)).toEqual(["shop-pr-1"]);
    expect(plan.kept.map((m) => m.owner).sort()).toEqual(["shop-pr-2", "shop-staging"]);
  });
});

describe("selectPreviewMarkers", () => {
  const a = marker({ project: "shop", env: "pr-1", owner: "shop-pr-1" });
  const b = marker({ project: "blog", env: "pr-1", owner: "blog-pr-1" });
  const cAuth = marker({ project: "shop", component: "auth", env: "pr-1", owner: "shop--auth-pr-1" });
  const cNotes = marker({ project: "shop", component: "notes", env: "pr-1", owner: "shop--notes-pr-1" });

  it("selects by env across projects", () => {
    expect(selectPreviewMarkers([a, b], "pr-1", undefined)).toEqual([a, b]);
  });

  it("narrows by project when given one", () => {
    expect(selectPreviewMarkers([a, b], "pr-1", "blog")).toEqual([b]);
  });

  it("returns [] when nothing matches", () => {
    expect(selectPreviewMarkers([a, b], "pr-9", undefined)).toEqual([]);
  });

  it("a project filter alone matches all of its components", () => {
    expect(selectPreviewMarkers([b, cAuth, cNotes], "pr-1", "shop")).toEqual([cAuth, cNotes]);
  });

  it("narrows by component within a project", () => {
    expect(selectPreviewMarkers([b, cAuth, cNotes], "pr-1", "shop", "notes")).toEqual([cNotes]);
  });
});

describe("component markers", () => {
  it("buildPreviewMarker derives a component-scoped owner and records the component", () => {
    const m = buildPreviewMarker({
      project: "shop",
      component: "auth",
      env: "pr-1",
      now: NOW,
      ttlMs: null,
      domains: [],
    });
    expect(m.owner).toBe("shop--auth-pr-1");
    expect(m.component).toBe("auth");
    expect(parsePreviewMarker(m)).toEqual(m); // round-trips through the strict schema
  });

  it("a marker without a component stays byte-identical to the legacy shape", () => {
    const m = buildPreviewMarker({ project: "shop", env: "pr-1", now: NOW, ttlMs: null, domains: [] });
    expect("component" in m).toBe(false);
    expect(m.owner).toBe("shop-pr-1");
  });

  it("rejects a component marker whose owner disagrees with project+component+env", () => {
    expect(() =>
      marker({ project: "shop", component: "auth", env: "pr-1", owner: "shop-pr-1" } as never),
    ).toThrow();
  });
});

describe("parsePreviewMarker", () => {
  it("rejects a marker whose owner disagrees with project+env", () => {
    expect(() =>
      parsePreviewMarker({
        version: PREVIEW_MARKER_VERSION,
        project: "shop",
        env: "pr-1",
        owner: "other-pr-1",
        createdAt: NOW,
        updatedAt: NOW,
        expiresAt: null,
        domains: [],
      }),
    ).toThrow();
  });

  it("rejects tampered values that would flow into destructive actions", () => {
    // The marker drives an undeploy + an S3 prefix sweep, so every field that
    // reaches those paths is shape-pinned at parse time.
    expect(() => marker({ env: "PR_1" } as never)).toThrow(); // not a DNS label
    expect(() => marker({ project: "shop/evil", owner: "shop/evil-pr-1" } as never)).toThrow();
    expect(() => marker({ domains: ["bad domain"] } as never)).toThrow();
  });

  it("parses (and ignores) the legacy dns array from pre-removal markers", () => {
    const m = marker({ dns: [{ zoneId: "Z1", name: "a.example.com", ip: "1.2.3.4" }] } as never);
    expect("dns" in m).toBe(false);
  });

  it("still rejects unknown fields other than the legacy dns array", () => {
    expect(() => marker({ bogus: true } as never)).toThrow();
  });

  it("defaults domains for an older record", () => {
    const m = parsePreviewMarker({
      version: PREVIEW_MARKER_VERSION,
      project: "shop",
      env: "pr-1",
      owner: "shop-pr-1",
      createdAt: NOW,
      updatedAt: NOW,
      expiresAt: null,
    });
    expect(m.domains).toEqual([]);
  });
});
