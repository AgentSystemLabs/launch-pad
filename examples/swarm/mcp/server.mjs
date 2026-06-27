#!/usr/bin/env node
/**
 * Stdio MCP server: WAL, file locks, GitHub issue comments/labels.
 * Workers invoke via cursor-agent MCP config.
 */
import readline from "node:readline";

const WAL_URL = (process.env.WAL_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const GITHUB_REPO = process.env.GITHUB_REPO ?? "";
const AGENT_ID = process.env.AGENT_ID ?? `agent-${process.pid}`;
const TRACKING_ISSUE = process.env.TRACKING_ISSUE ?? "";

const tools = [
  {
    name: "wal_append",
    description:
      "Append to the shared WAL (shown in operator UI). Use event=working when starting, event=done when finished with a one-paragraph report field.",
    inputSchema: {
      type: "object",
      properties: {
        event: { type: "string", enum: ["working", "done", "boot", "status"] },
        loop: { type: "string" },
        summary: { type: "string", description: "Short line shown in the timeline" },
        report: { type: "string", description: "Required for done — one paragraph of what you accomplished" },
        extra: { type: "object" },
      },
      required: ["event", "summary"],
    },
  },
  {
    name: "wal_read",
    description: "Read recent WAL entries (re-read after failures).",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "string", description: "ISO timestamp" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "lock_acquire",
    description: "Acquire an exclusive lock on a repo-relative file path before editing.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        ttl_ms: { type: "number" },
      },
      required: ["path"],
    },
  },
  {
    name: "lock_release",
    description: "Release a file lock you hold.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "lock_heartbeat",
    description: "Extend a file lock TTL while still working.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        ttl_ms: { type: "number" },
      },
      required: ["path"],
    },
  },
  {
    name: "github_comment",
    description: "Comment on a GitHub issue or PR (same API).",
    inputSchema: {
      type: "object",
      properties: {
        issue_number: { type: "number" },
        body: { type: "string" },
      },
      required: ["body"],
    },
  },
  {
    name: "github_add_labels",
    description: "Add labels to a GitHub issue or PR.",
    inputSchema: {
      type: "object",
      properties: {
        issue_number: { type: "number" },
        labels: { type: "array", items: { type: "string" } },
      },
      required: ["issue_number", "labels"],
    },
  },
  {
    name: "agent_status",
    description:
      "Heartbeat your live status to the operator grid (status=working|idle|done) with a one-line summary. Call this when you start and whenever your focus changes.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["working", "idle", "done", "sleeping"] },
        summary: { type: "string" },
        loop: { type: "string" },
      },
      required: ["summary"],
    },
  },
  {
    name: "stdout_append",
    description:
      "Stream a line (or lines) of your working output to the operator UI so a human can watch your progress live. Use for notable steps, not every token.",
    inputSchema: {
      type: "object",
      properties: {
        line: { type: "string" },
        lines: { type: "array", items: { type: "string" } },
      },
    },
  },
];

async function walFetch(path, init) {
  const res = await fetch(`${WAL_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`WAL ${path} ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function githubApi(path, init = {}) {
  if (!GITHUB_TOKEN) throw new Error("GITHUB_TOKEN not set");
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`GitHub ${path} ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function runTool(name, args) {
  switch (name) {
    case "wal_append": {
      if (args.event === "done" && !String(args.report ?? "").trim()) {
        throw new Error(
          "event=done requires a one-paragraph `report` describing what you accomplished",
        );
      }
      const entry = await walFetch("/wal/append", {
        method: "POST",
        body: JSON.stringify({
          agent: AGENT_ID,
          event: args.event,
          loop: args.loop,
          summary: args.summary,
          report: args.report,
          extra: args.extra,
        }),
      });
      return entry;
    }
    case "wal_read": {
      const q = new URLSearchParams();
      if (args.since) q.set("since", args.since);
      if (args.limit) q.set("limit", String(args.limit));
      return walFetch(`/wal?${q}`);
    }
    case "lock_acquire":
      return walFetch("/locks/acquire", {
        method: "POST",
        body: JSON.stringify({
          path: args.path,
          holder: AGENT_ID,
          ttlMs: args.ttl_ms,
        }),
      });
    case "lock_release":
      return walFetch("/locks/release", {
        method: "POST",
        body: JSON.stringify({ path: args.path, holder: AGENT_ID }),
      });
    case "lock_heartbeat":
      return walFetch("/locks/heartbeat", {
        method: "POST",
        body: JSON.stringify({
          path: args.path,
          holder: AGENT_ID,
          ttlMs: args.ttl_ms,
        }),
      });
    case "github_comment": {
      const num = args.issue_number ?? Number(TRACKING_ISSUE);
      return githubApi(`/issues/${num}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: `**${AGENT_ID}:** ${args.body}` }),
      });
    }
    case "github_add_labels":
      return githubApi(`/issues/${args.issue_number}/labels`, {
        method: "POST",
        body: JSON.stringify({ labels: args.labels }),
      });
    case "agent_status": {
      const status = args.status ?? "working";
      await walFetch("/agents/heartbeat", {
        method: "POST",
        body: JSON.stringify({
          agent: AGENT_ID,
          status,
          summary: args.summary,
          loop: args.loop,
        }),
      });
      return { ok: true };
    }
    case "stdout_append": {
      const lines = Array.isArray(args.lines)
        ? args.lines
        : typeof args.line === "string"
          ? [args.line]
          : [];
      if (lines.length === 0) throw new Error("stdout_append requires `line` or `lines`");
      return walFetch(`/agents/${encodeURIComponent(AGENT_ID)}/stdout`, {
        method: "POST",
        body: JSON.stringify({ lines }),
      });
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", async (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params } = req;

  try {
    if (method === "initialize") {
      return send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "swarm-mcp", version: "0.1.0" },
        },
      });
    }

    if (method === "notifications/initialized") return;

    if (method === "tools/list") {
      return send({ jsonrpc: "2.0", id, result: { tools } });
    }

    if (method === "tools/call") {
      const result = await runTool(params.name, params.arguments ?? {});
      return send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        },
      });
    }

    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (err) {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
    });
  }
});
