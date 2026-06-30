import { existsSync } from "node:fs";
import type { Station } from "@orbital-js/station";
import { z } from "zod";
import type { AppCtx } from "../index";
import { runLaunchPad } from "../lib/run-launch-pad";
import {
  listProjects,
  getProject,
  upsertProject,
  removeProject,
  checkProjectDir,
  hasDockerfile,
} from "../lib/app-config";
import { readServices, parseEnvText, envToText, writeServiceEnv } from "../lib/toml-env";
import { flash } from "../lib/ui";
import { confirmSubmit } from "../lib/confirm";
import { EmptyState, errorMessage, DisabledTip } from "../components/feedback";
import { Breadcrumbs } from "../components/breadcrumbs";

const NAME_RULES = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, numbers and hyphens");

export function registerProjects(station: Station<AppCtx>) {
  // ── page shell ────────────────────────────────────────────────────────────
  station.template("projects", () => (
    <div p-load="room:reset" class="space-y-6">
      <Breadcrumbs
        items={[
          { label: "Clusters", href: "/", swap: "clusters" },
          { label: "Projects" },
        ]}
      />
      <h1 class="text-2xl font-bold">Projects</h1>

      <div class="grid md:grid-cols-2 gap-4">
        <form p-action="projects:register" class="card bg-base-200">
          <div class="card-body p-4 gap-2">
            <h2 class="font-semibold">Register an existing project</h2>
            <p class="text-sm opacity-70">Point at a directory that already has a launch-pad.toml.</p>
            <input
              required
              name="name"
              placeholder="name (e.g. shop)"
              pattern="[a-z0-9][a-z0-9-]*"
              class="input input-bordered input-sm"
            />
            <input
              required
              name="dir"
              placeholder="/abs/path/to/project"
              class="input input-bordered input-sm font-mono"
            />
            <input name="cluster" placeholder="cluster (optional)" class="input input-bordered input-sm" />
            <button class="btn btn-primary btn-sm self-start">Register</button>
          </div>
        </form>

        <form p-action="projects:scaffold" class="card bg-base-200">
          <div class="card-body p-4 gap-2">
            <h2 class="font-semibold">Scaffold a new project</h2>
            <p class="text-sm opacity-70">
              Generates launch-pad.toml in a directory that has a Dockerfile, then you can deploy.
            </p>
            <div class="flex gap-2">
              <input
                required
                name="name"
                placeholder="name"
                pattern="[a-z0-9][a-z0-9-]*"
                class="input input-bordered input-sm flex-1"
              />
              <input name="port" type="number" placeholder="port" value="3000" class="input input-bordered input-sm w-24" />
            </div>
            <input
              required
              name="dir"
              placeholder="/abs/path/to/source (with Dockerfile)"
              class="input input-bordered input-sm font-mono"
            />
            <input name="domain" placeholder="domain (optional, e.g. api.example.com)" class="input input-bordered input-sm" />
            <div class="flex gap-2">
              <input name="cpu" type="number" placeholder="cpu" value="512" class="input input-bordered input-sm w-24" />
              <input name="memory" type="number" placeholder="memory MB" value="512" class="input input-bordered input-sm w-28" />
              <input name="node" placeholder="node (optional)" class="input input-bordered input-sm flex-1" />
            </div>
            <input name="cluster" placeholder="cluster (optional)" class="input input-bordered input-sm" />
            <button class="btn btn-primary btn-sm self-start">Scaffold</button>
          </div>
        </form>
      </div>

      <div p-template="projects:list"></div>
      <div p-template="projects:env"></div>
    </div>
  ));

  // ── list ──────────────────────────────────────────────────────────────────
  station.template("projects:list", () => {
    const projects = listProjects();
    if (projects.length === 0) {
      return (
        <EmptyState
          title="No projects registered"
          message="Register an existing project or scaffold a new one above to deploy and edit env."
        />
      );
    }
    return (
      <div class="overflow-x-auto">
        <table class="table">
          <thead>
            <tr>
              <th>Project</th>
              <th>Directory</th>
              <th>Cluster</th>
              <th class="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => {
              const dir = checkProjectDir(p.dir);
              return (
                <tr data-testid={`project-row-${p.name}`}>
                  <td>
                    <span data-testid={`project-name-${p.name}`} class="font-mono font-semibold">
                      {p.name}
                    </span>
                    {dir.ok ? (
                      <></>
                    ) : (
                      <span class="badge badge-warning badge-sm ml-2" title={dir.reason}>
                        {dir.reason}
                      </span>
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      data-copy-path={p.dir}
                      data-testid={`project-dir-${p.name}`}
                      class="font-mono text-xs opacity-70 hover:opacity-100 text-left break-all cursor-copy hover:underline underline-offset-2 rounded px-0.5 -mx-0.5"
                      title="Click to copy path"
                    >
                      {p.dir}
                    </button>
                  </td>
                  <td class="opacity-80">{p.cluster ?? "—"}</td>
                  <td>
                    <div class="flex gap-1 justify-end flex-wrap">
                      <form p-action="projects:deploy">
                        <input type="hidden" name="name" value={p.name} />
                        {dir.ok ? (
                          <button class="btn btn-primary btn-xs">Deploy</button>
                        ) : (
                          <DisabledTip reason={dir.reason ?? "Unavailable"} testId={`deploy-tip-${p.name}`}>
                            <button type="button" class="btn btn-primary btn-xs" disabled tabIndex={-1}>
                              Deploy
                            </button>
                          </DisabledTip>
                        )}
                      </form>
                      <form p-action="projects:env:open">
                        <input type="hidden" name="name" value={p.name} />
                        {dir.ok ? (
                          <button class="btn btn-ghost btn-xs">Env</button>
                        ) : (
                          <DisabledTip reason={dir.reason ?? "Unavailable"} testId={`env-tip-${p.name}`}>
                            <button type="button" class="btn btn-ghost btn-xs" disabled tabIndex={-1}>
                              Env
                            </button>
                          </DisabledTip>
                        )}
                      </form>
                      <form
                        p-action="projects:remove"
                        onsubmit={confirmSubmit(`Remove project ${p.name} from the dashboard? (does not touch AWS)`)}
                      >
                        <input type="hidden" name="name" value={p.name} />
                        <button class="btn btn-ghost btn-xs">Remove</button>
                      </form>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  });

  // ── env editor (inline) ──────────────────────────────────────────────────────
  station.template("projects:env", ({ ctx }) => {
    const editing = ctx.editing;
    if (!editing) return <></>;
    let services: ReturnType<typeof readServices>;
    try {
      services = readServices(editing.dir);
    } catch (err) {
      return (
        <div class="alert alert-error">
          <span>Couldn't read launch-pad.toml: {errorMessage(err)}</span>
        </div>
      );
    }
    return (
      <div data-testid="env-editor" class="card bg-base-200 border border-primary/40">
        <div class="card-body p-4 gap-3">
          <div class="flex items-center justify-between">
            <h2 class="font-semibold">
              Env · <span class="font-mono">{editing.project}</span>
            </h2>
            <form p-action="projects:env:close">
              <button class="btn btn-ghost btn-xs">Close</button>
            </form>
          </div>
          <p class="text-sm opacity-70">
            One KEY=value per line. Saving rewrites launch-pad.toml and redeploys the service.
          </p>
          {services.map((svc) => (
            <form p-action="projects:env:save" class="space-y-2 border-t border-base-content/10 pt-3">
              <input type="hidden" name="project" value={editing.project} />
              <input type="hidden" name="dir" value={editing.dir} />
              <input type="hidden" name="service" value={svc.name} />
              <div class="flex items-center justify-between">
                <span class="font-mono text-sm">{svc.name}</span>
                <button class="btn btn-primary btn-xs">Save &amp; redeploy</button>
              </div>
              <textarea
                name="env"
                rows={Math.max(3, Object.keys(svc.env).length + 1)}
                data-testid={`env-text-${svc.name}`}
                class="textarea textarea-bordered w-full font-mono text-sm"
              >{envToText(svc.env)}</textarea>
            </form>
          ))}
        </div>
      </div>
    );
  });

  // ── actions ─────────────────────────────────────────────────────────────────
  station.defineAction("projects:register", {
    input: z.object({ name: NAME_RULES, dir: z.string().min(1), cluster: z.string().optional() }),
    handler: ({ data, ctx, broadcast, invalidate, reply }) => {
      const check = checkProjectDir(data.dir);
      if (!check.ok) {
        flash(ctx, invalidate, "error", `Can't register: ${check.reason}`);
        reply({ ok: false });
        return;
      }
      upsertProject({ name: data.name, dir: data.dir, cluster: data.cluster?.trim() || undefined });
      flash(ctx, invalidate, "success", `Registered project "${data.name}"`);
      broadcast("projects:list");
      reply({ ok: true });
    },
  });

  station.defineAction("projects:scaffold", {
    input: z.object({
      name: NAME_RULES,
      dir: z.string().min(1),
      port: z.string().optional(),
      domain: z.string().optional(),
      cpu: z.string().optional(),
      memory: z.string().optional(),
      node: z.string().optional(),
      cluster: z.string().optional(),
    }),
    handler: async ({ data, ctx, broadcast, invalidate, reply }) => {
      if (!existsSync(data.dir)) {
        flash(ctx, invalidate, "error", `Directory does not exist: ${data.dir}`);
        reply({ ok: false });
        return;
      }
      if (!hasDockerfile(data.dir)) {
        flash(ctx, invalidate, "error", `No Dockerfile in ${data.dir}`);
        reply({ ok: false });
        return;
      }
      const args = ["init", "--name", data.name, "--dockerfile", "Dockerfile", "--force"];
      if (data.port) args.push("--port", data.port);
      if (data.domain && data.domain.trim()) args.push("--domain", data.domain.trim());
      if (data.cpu) args.push("--cpu", data.cpu);
      if (data.memory) args.push("--memory", data.memory);
      if (data.node && data.node.trim()) args.push("--node", data.node.trim());
      try {
        await runLaunchPad(args, { cwd: data.dir, profile: ctx.profile, region: ctx.region });
        upsertProject({ name: data.name, dir: data.dir, cluster: data.cluster?.trim() || undefined });
        flash(ctx, invalidate, "success", `Scaffolded "${data.name}" — review env, then deploy`);
        broadcast("projects:list");
        reply({ ok: true });
      } catch (err) {
        flash(ctx, invalidate, "error", `Scaffold failed: ${errorMessage(err)}`);
        reply({ ok: false, error: errorMessage(err) });
      }
    },
  });

  station.defineAction("projects:deploy", {
    input: z.object({ name: z.string().min(1) }),
    handler: async ({ data, ctx, invalidate, reply }) => {
      const project = getProject(data.name);
      if (!project) {
        flash(ctx, invalidate, "error", `Unknown project "${data.name}"`);
        reply({ ok: false });
        return;
      }
      try {
        await runLaunchPad(["deploy", "--yes"], {
          cwd: project.dir,
          cluster: project.cluster ?? ctx.cluster,
          profile: ctx.profile,
          region: ctx.region,
        });
        flash(ctx, invalidate, "success", `Deployed "${data.name}"`);
        reply({ ok: true });
      } catch (err) {
        flash(ctx, invalidate, "error", `Deploy failed: ${errorMessage(err)}`);
        reply({ ok: false, error: errorMessage(err) });
      }
    },
  });

  station.defineAction("projects:remove", {
    input: z.object({ name: z.string().min(1) }),
    handler: ({ data, ctx, broadcast, invalidate, reply }) => {
      removeProject(data.name);
      if (ctx.editing?.project === data.name) ctx.editing = null;
      flash(ctx, invalidate, "success", `Removed "${data.name}"`);
      broadcast("projects:list");
      invalidate("projects:env");
      reply({ ok: true });
    },
  });

  station.defineAction("projects:env:open", {
    input: z.object({ name: z.string().min(1) }),
    handler: ({ data, ctx, invalidate, reply }) => {
      const project = getProject(data.name);
      if (!project) {
        flash(ctx, invalidate, "error", `Unknown project "${data.name}"`);
        reply({ ok: false });
        return;
      }
      ctx.editing = { project: project.name, dir: project.dir };
      invalidate("projects:env");
      reply({ ok: true });
    },
  });

  station.defineAction("projects:env:close", {
    handler: ({ ctx, invalidate }) => {
      ctx.editing = null;
      invalidate("projects:env");
    },
  });

  station.defineAction("projects:env:save", {
    input: z.object({
      project: z.string().min(1),
      dir: z.string().min(1),
      service: z.string().min(1),
      env: z.string().optional(),
    }),
    handler: async ({ data, ctx, invalidate, reply }) => {
      try {
        writeServiceEnv(data.dir, data.service, parseEnvText(data.env ?? ""));
        await runLaunchPad(["deploy", "--service", data.service, "--yes"], {
          cwd: data.dir,
          cluster: getProject(data.project)?.cluster ?? ctx.cluster,
          profile: ctx.profile,
          region: ctx.region,
        });
        flash(ctx, invalidate, "success", `Saved env + redeployed ${data.project}/${data.service}`);
        invalidate("projects:env");
        reply({ ok: true });
      } catch (err) {
        flash(ctx, invalidate, "error", `Save failed: ${errorMessage(err)}`);
        reply({ ok: false, error: errorMessage(err) });
      }
    },
  });
}
