/**
 * Best-effort detection of a project's web shape, to seed `init`'s prompts with
 * smarter defaults. Pure — callers read the files and pass the text in.
 */

/** Extract the first `EXPOSE <port>` from a Dockerfile (ignores `/tcp` etc.), or undefined. */
export function detectExposePort(dockerfile: string): number | undefined {
  for (const line of dockerfile.split("\n")) {
    const m = /^\s*EXPOSE\s+(\d{1,5})\b/i.exec(line);
    if (m) {
      const port = Number.parseInt(m[1]!, 10);
      if (port >= 1 && port <= 65535) return port;
    }
  }
  return undefined;
}

/** Known web frameworks and the port their starter templates conventionally listen on. */
const WEB_FRAMEWORKS: Array<{ dep: string; name: string; port: number }> = [
  { dep: "next", name: "Next.js", port: 3000 },
  { dep: "@nestjs/core", name: "NestJS", port: 3000 },
  { dep: "@remix-run/serve", name: "Remix", port: 3000 },
  { dep: "astro", name: "Astro", port: 4321 },
  { dep: "nuxt", name: "Nuxt", port: 3000 },
  { dep: "@sveltejs/kit", name: "SvelteKit", port: 3000 },
  { dep: "fastify", name: "Fastify", port: 3000 },
  { dep: "@hapi/hapi", name: "hapi", port: 3000 },
  { dep: "hono", name: "Hono", port: 3000 },
  { dep: "koa", name: "Koa", port: 3000 },
  { dep: "express", name: "Express", port: 3000 },
];

/** Detect a web framework from a package.json's dependencies/devDependencies. */
export function detectFramework(packageJsonText: string): { name: string; port: number } | undefined {
  let pkg: { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
  try {
    pkg = JSON.parse(packageJsonText) as typeof pkg;
  } catch {
    return undefined;
  }
  const deps = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
  // The list is ordered so a meta-framework (Next/Remix) wins over the server lib it bundles.
  const hit = WEB_FRAMEWORKS.find((f) => deps.has(f.dep));
  return hit ? { name: hit.name, port: hit.port } : undefined;
}

export interface ProjectHints {
  /** Suggested container port — a Dockerfile `EXPOSE` wins over a framework default. */
  port?: number;
  /** Detected framework name, for the prompt hint. */
  framework?: string;
  /** Signals (an `EXPOSE` or a known web framework) suggest this is a web service. */
  likelyWeb: boolean;
}

/** Combine Dockerfile + package.json signals into seed hints for `init`. */
export function projectHints(files: { dockerfile?: string; packageJson?: string }): ProjectHints {
  const exposePort = files.dockerfile ? detectExposePort(files.dockerfile) : undefined;
  const framework = files.packageJson ? detectFramework(files.packageJson) : undefined;
  return {
    port: exposePort ?? framework?.port,
    framework: framework?.name,
    likelyWeb: exposePort !== undefined || framework !== undefined,
  };
}
