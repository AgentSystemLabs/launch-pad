import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderClusterLine } from "./banner";
import type { EffectiveCluster } from "./config/local";
import { configureColor } from "./ui/theme";

// Render without ANSI so assertions match the plain text the user sees.
beforeAll(() => configureColor(false));
afterAll(() => configureColor(true));

function eff(overrides: Partial<EffectiveCluster>): EffectiveCluster {
  return {
    cluster: "default",
    persistedDefault: "default",
    isImplicitDefault: true,
    overridden: false,
    ...overrides,
  };
}

describe("renderClusterLine", () => {
  it("shows just the id for the implicit default", () => {
    expect(renderClusterLine(eff({}))).toBe("  cluster: default\n");
  });

  it("shows id + region for a named cluster", () => {
    expect(
      renderClusterLine(eff({ cluster: "prod", persistedDefault: "prod", isImplicitDefault: false, region: "us-west-2" })),
    ).toBe("  cluster: prod (us-west-2)\n");
  });

  it("notes the shadowed default when --cluster overrides it", () => {
    expect(
      renderClusterLine(
        eff({
          cluster: "staging",
          persistedDefault: "prod",
          isImplicitDefault: false,
          overridden: true,
          region: "eu-west-1",
        }),
      ),
    ).toBe("  cluster: staging (eu-west-1 · override, default: prod)\n");
  });

  it("omits region when unknown", () => {
    expect(renderClusterLine(eff({ cluster: "prod", persistedDefault: "prod", isImplicitDefault: false }))).toBe(
      "  cluster: prod\n",
    );
  });
});
