import { describe, expect, it } from "vitest";
import {
  buildServiceBuildPaths,
  collectChangedPaths,
  type ServiceBuildPaths,
  selectChangedServices,
} from "./changed-services";

const sp = (name: string, contextDir: string, dockerfile: string): ServiceBuildPaths => ({
  name,
  contextDir,
  dockerfile,
});

describe("selectChangedServices", () => {
  const services: ServiceBuildPaths[] = [
    sp("api", "apps/api", "apps/api/Dockerfile"),
    sp("web", "apps/web", "apps/web/Dockerfile"),
    sp("worker", "apps/worker", "docker/worker.Dockerfile"),
  ];

  it("selects a service when a changed path lives under its build context", () => {
    expect(selectChangedServices(services, ["apps/api/src/index.ts"])).toEqual(["api"]);
  });

  it("selects only the services whose context the changes touch, in input order", () => {
    const changed = ["apps/web/src/App.tsx", "apps/api/server.ts"];
    expect(selectChangedServices(services, changed)).toEqual(["api", "web"]);
  });

  it("selects a service when its dockerfile changes even though it lives outside the context", () => {
    expect(selectChangedServices(services, ["docker/worker.Dockerfile"])).toEqual(["worker"]);
  });

  it("returns no services when nothing under any context changed", () => {
    expect(selectChangedServices(services, ["README.md", "docs/guide.md"])).toEqual([]);
  });

  it("does not match a sibling directory that merely shares a path prefix", () => {
    // `apps/api-internal/...` must NOT count as a change to context `apps/api`.
    expect(selectChangedServices(services, ["apps/api-internal/x.ts"])).toEqual([]);
  });

  it("matches the context directory entry itself", () => {
    expect(selectChangedServices(services, ["apps/api"])).toEqual(["api"]);
  });

  it("treats an empty-string context as the whole repo (matches any change)", () => {
    const all: ServiceBuildPaths[] = [sp("mono", "", "Dockerfile")];
    expect(selectChangedServices(all, ["anything/at/all.ts"])).toEqual(["mono"]);
  });

  it("selects every service sharing a whole-repo context on any change", () => {
    const shared: ServiceBuildPaths[] = [sp("a", "", "a.Dockerfile"), sp("b", "", "b.Dockerfile")];
    expect(selectChangedServices(shared, ["src/lib/util.ts"])).toEqual(["a", "b"]);
  });

  it("ignores empty path entries (trailing newline artifacts)", () => {
    expect(selectChangedServices(services, ["", "apps/api/x.ts", ""])).toEqual(["api"]);
  });

  it("normalizes backslash paths (defensive, for Windows git output)", () => {
    expect(selectChangedServices(services, ["apps\\api\\src\\x.ts"])).toEqual(["api"]);
  });
});

describe("buildServiceBuildPaths", () => {
  const svc = (name: string, context: string, dockerfile: string) => ({ name, context, dockerfile });

  it("maps a repo-root config: context '.' → '' and './Dockerfile' → 'Dockerfile'", () => {
    const out = buildServiceBuildPaths([svc("web", ".", "./Dockerfile")], "/repo", "/repo");
    expect(out).toEqual([{ name: "web", contextDir: "", dockerfile: "Dockerfile" }]);
  });

  it("makes paths relative to the repo root when the config lives in a subdirectory", () => {
    const out = buildServiceBuildPaths([svc("web", ".", "./Dockerfile")], "/repo/deploy", "/repo");
    expect(out).toEqual([{ name: "web", contextDir: "deploy", dockerfile: "deploy/Dockerfile" }]);
  });

  it("resolves a per-service context + a dockerfile outside that context", () => {
    const out = buildServiceBuildPaths(
      [svc("api", "./apps/api", "./docker/api.Dockerfile")],
      "/repo",
      "/repo",
    );
    expect(out).toEqual([
      { name: "api", contextDir: "apps/api", dockerfile: "docker/api.Dockerfile" },
    ]);
  });
});

describe("collectChangedPaths", () => {
  const SHA = "a".repeat(40);

  it("unions committed/working-tree diff with untracked files, deduped", async () => {
    const calls: string[][] = [];
    const git = async (args: string[]): Promise<string> => {
      calls.push(args);
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return "/repo\n";
      if (args[0] === "rev-parse") return `${SHA}\n`; // ref verification → resolved SHA
      if (args[0] === "diff") return "apps/api/x.ts\nshared/y.ts\n";
      if (args[0] === "ls-files") return "apps/api/new.ts\nshared/y.ts\n"; // y.ts overlaps diff
      throw new Error(`unexpected git ${args.join(" ")}`);
    };
    const paths = await collectChangedPaths("/repo", "origin/main", { git });
    expect([...paths].sort()).toEqual(["apps/api/new.ts", "apps/api/x.ts", "shared/y.ts"]);
  });

  it("diffs against the RESOLVED sha, never the raw ref (git revision-expression injection)", async () => {
    const seen: string[][] = [];
    const git = async (args: string[]): Promise<string> => {
      seen.push(args);
      if (args[0] === "rev-parse") return `${SHA}\n`;
      if (args[0] === "diff") return "apps/api/x.ts\n";
      if (args[0] === "ls-files") return "";
      throw new Error(`unexpected git ${args.join(" ")}`);
    };
    // A ref that's a non-trivial gitrevision expression: it must only ever reach
    // `rev-parse` (which resolves it); the diff must use the resolved SHA.
    await collectChangedPaths("/repo", "HEAD:../../etc/passwd", { git });
    const diffCall = seen.find((a) => a[0] === "diff");
    expect(diffCall).toContain(SHA);
    expect(diffCall?.some((a) => a.includes("passwd"))).toBe(false);
  });

  it("throws when rev-parse returns something that isn't a commit sha", async () => {
    const git = async (args: string[]): Promise<string> => {
      if (args[0] === "rev-parse") return "not-a-sha\n";
      return "";
    };
    await expect(collectChangedPaths("/repo", "weird", { git })).rejects.toThrow(/weird/);
  });

  it("throws a clear error when the ref does not resolve", async () => {
    const git = async (args: string[]): Promise<string> => {
      if (args[0] === "rev-parse" && args[1] === "--verify") throw new Error("bad revision");
      return "";
    };
    await expect(collectChangedPaths("/repo", "nope", { git })).rejects.toThrow(/nope/);
  });

  it("refuses a ref starting with '-' (git option injection) WITHOUT invoking git", async () => {
    let called = false;
    const git = async (): Promise<string> => {
      called = true;
      return "";
    };
    await expect(collectChangedPaths("/repo", "--output=/etc/passwd", { git })).rejects.toThrow(
      /must not start with/,
    );
    expect(called).toBe(false);
  });
});
