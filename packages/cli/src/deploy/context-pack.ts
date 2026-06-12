/**
 * Packaging a docker build context into the tar.gz `deploy --remote-build` uploads
 * to S3 for CodeBuild. Honors the safe literal subset of .dockerignore (see
 * `parseDockerignore`) purely to shrink the upload — the full .dockerignore still
 * ships inside the tarball, so docker applies every pattern remotely.
 */

import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import { parseDockerignore, shouldExcludeFromContext } from "./remote-build";

export interface PackOptions {
  /**
   * Context-relative paths that ship no matter what .dockerignore says — the
   * dockerfile above all. Excluding `Dockerfile`/`.dockerignore` in .dockerignore
   * is legal and common because docker reads both out-of-band (never from the
   * context); the remote tarball IS the context CodeBuild builds from, so dropping
   * them there breaks the build.
   */
  alwaysInclude?: string[];
}

/** Create the context tarball in the OS tmpdir; the caller deletes it after upload. */
export async function packBuildContext(
  contextDir: string,
  options: PackOptions = {},
): Promise<{ file: string; bytes: number }> {
  let patterns: string[] = [];
  try {
    patterns = parseDockerignore(readFileSync(join(contextDir, ".dockerignore"), "utf8"));
  } catch {
    // No .dockerignore — pack everything (minus .git, which is never a build input).
  }
  const keep = new Set([".dockerignore", ...(options.alwaysInclude ?? [])]);

  const file = join(tmpdir(), `launch-pad-context-${randomBytes(6).toString("hex")}.tar.gz`);
  await tar.create(
    {
      gzip: true,
      file,
      cwd: contextDir,
      portable: true,
      filter: (path) => {
        const rel = path.replace(/^\.\/?/, "").replace(/\/+$/, "");
        if (rel === "") return true; // the context root itself
        if (keep.has(rel)) return true;
        // A kept file's parent directories must survive too, or tar never descends.
        for (const k of keep) {
          if (k.startsWith(`${rel}/`)) return true;
        }
        return !shouldExcludeFromContext(rel, patterns);
      },
    },
    ["."],
  );
  return { file, bytes: statSync(file).size };
}
