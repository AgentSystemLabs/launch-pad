import { relative, resolve } from "node:path";
import { execa } from "execa";

/**
 * `deploy --changed <ref>` (monorepo "deploy only what changed"): from a git diff
 * against `<ref>`, derive the set of services whose BUILD INPUTS changed, and deploy
 * only those. "Build inputs" are a service's docker build context directory and its
 * Dockerfile — the exact bytes that go into its image — so the selection matches what
 * a rebuild would actually produce. Config-only edits (cpu/replicas/env in
 * launch-pad.toml) are NOT build inputs; use `scale` / `config set` or a full `deploy`
 * for those.
 *
 * The logic splits into two pure, unit-tested halves (path math) and one thin git
 * shell (`collectChangedPaths`), so the mapping is verifiable without a repo.
 */

/** A service's build inputs as repo-root-relative, forward-slash paths. */
export interface ServiceBuildPaths {
  name: string;
  /** Build context directory relative to the repo root; "" means the repo root itself. */
  contextDir: string;
  /** Dockerfile path relative to the repo root. */
  dockerfile: string;
}

/** Normalize a path to forward slashes (defensive against Windows git output). */
function toSlash(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Make an absolute path repo-root-relative with forward slashes. The repo root
 * itself maps to "" (so {@link isWithin} treats a whole-repo context as matching
 * every change).
 */
function toRepoRel(repoRoot: string, abs: string): string {
  const rel = relative(repoRoot, abs);
  return rel === "." ? "" : toSlash(rel);
}

/**
 * True when repo-relative `path` is the directory `dir` or sits inside it. A "" dir
 * is the whole repo (always within). The trailing-slash guard stops a sibling that
 * merely shares a prefix (`apps/api-internal` vs context `apps/api`) from matching.
 */
function isWithin(path: string, dir: string): boolean {
  if (dir === "") return true;
  return path === dir || path.startsWith(`${dir}/`);
}

/**
 * Resolve each service's declared `context`/`dockerfile` (relative to the
 * launch-pad.toml directory) into repo-root-relative paths git diff output can be
 * compared against.
 */
export function buildServiceBuildPaths(
  services: Array<{ name: string; context: string; dockerfile: string }>,
  configDir: string,
  repoRoot: string,
): ServiceBuildPaths[] {
  return services.map((s) => ({
    name: s.name,
    contextDir: toRepoRel(repoRoot, resolve(configDir, s.context)),
    dockerfile: toRepoRel(repoRoot, resolve(configDir, s.dockerfile)),
  }));
}

/**
 * Names of services whose build context or Dockerfile intersects the changed path
 * set, in the order the services were given. Empty path entries (trailing-newline
 * artifacts) are ignored.
 */
export function selectChangedServices(
  services: ServiceBuildPaths[],
  changedPaths: string[],
): string[] {
  const paths = changedPaths.map(toSlash).filter((p) => p.length > 0);
  return services
    .filter((s) => paths.some((p) => p === s.dockerfile || isWithin(p, s.contextDir)))
    .map((s) => s.name);
}

/** Git runner (returns stdout). Injectable so the union logic is unit-testable. */
export type GitRunner = (args: string[]) => Promise<string>;

/** Default runner: `git <args>` executed in the repo root. */
function makeGitRunner(repoRoot: string): GitRunner {
  return async (args) => {
    const { stdout } = await execa("git", args, { cwd: repoRoot });
    return stdout;
  };
}

/** Split git's NUL-free, newline-delimited path output into trimmed entries. */
function splitLines(out: string): string[] {
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** A resolved git object id: 40 hex (sha1) or 64 hex (sha256). */
const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * The repo-root-relative paths that differ between `<ref>` and the current working
 * tree — committed changes since `<ref>` AND uncommitted edits AND untracked files —
 * because all three end up in the image a rebuild would push.
 *
 * Hardening: `<ref>` is resolved to a concrete commit SHA up front, and ONLY that SHA
 * is used as the diff base. The user-supplied `<ref>` therefore never reaches `git
 * diff` directly, so it can't be a flag (`--output=…`) or a gitrevision expression
 * (`HEAD:path`, `@{upstream}`, `ref^{/regex}`) that would silently shift the diff base
 * — relevant when CI interpolates an untrusted value (`--changed ${{ github.head_ref }}`).
 */
export async function collectChangedPaths(
  repoRoot: string,
  ref: string,
  deps: { git?: GitRunner } = {},
): Promise<Set<string>> {
  const git = deps.git ?? makeGitRunner(repoRoot);

  // First line of defense: a valid ref never starts with "-"; reject one that could be
  // read as a git OPTION before it ever reaches git. (execa passes argv with no shell,
  // so there's no shell-injection — this only closes the flag-injection surface.)
  if (ref.startsWith("-")) {
    throw new Error(`git ref "${ref}" must not start with "-" (refusing a possible git option)`);
  }

  const unresolved = (): Error =>
    new Error(
      `git ref "${ref}" did not resolve — pass a branch, tag, or commit to compare against ` +
        `(e.g. --changed origin/main or --changed HEAD~1)`,
    );

  // Resolve `<ref>` to a commit SHA. `rev-parse --verify` prints the object id; we then
  // diff against THAT, never the raw ref, so the diff base is always a plain SHA.
  let sha: string;
  try {
    sha = (await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).trim();
  } catch {
    throw unresolved();
  }
  if (!SHA_RE.test(sha)) throw unresolved();

  // `git diff <sha>` (no second tree) compares <sha> against the working tree, so it
  // captures both committed-since-<sha> and uncommitted changes — exactly what a
  // rebuild from the current checkout would include.
  const diff = splitLines(await git(["diff", "--name-only", sha, "--"]));
  // Untracked files aren't in `git diff`, but a brand-new source file IS a build input.
  const untracked = splitLines(await git(["ls-files", "--others", "--exclude-standard", "--"]));

  return new Set([...diff, ...untracked].map(toSlash));
}

/** Resolve the absolute path of the enclosing git repo's root, or throw. */
export async function resolveRepoRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await execa("git", ["rev-parse", "--show-toplevel"], { cwd });
    return stdout.trim();
  } catch {
    throw new Error(
      "`deploy --changed` requires a git repository — run it inside one, or drop --changed",
    );
  }
}
