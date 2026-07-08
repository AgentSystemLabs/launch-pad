/**
 * Token auth: spawn a SECOND dashboard server with LAUNCH_PAD_DASHBOARD_TOKEN set
 * and hit it with the request fixture (no browser). The main webServer stays
 * tokenless for every other spec.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { FAKE_CLI, HOME_PATH, ROOT, STATE_PATH } from "../paths";

const AUTH_PORT = 4601;
const AUTH_URL = `http://127.0.0.1:${AUTH_PORT}`;
const TOKEN = "testtoken";

let child: ChildProcess;

test.beforeAll(async ({ request }) => {
  child = spawn(process.execPath, [join(ROOT, "dist", "index.js"), "dashboard", "--no-open", "--port", String(AUTH_PORT)], {
    cwd: ROOT,
    env: {
      ...process.env,
      LAUNCH_PAD_BIN: FAKE_CLI,
      FAKE_LP_STATE: STATE_PATH,
      LAUNCH_PAD_DASHBOARD_HOME: HOME_PATH,
      LAUNCH_PAD_DASHBOARD_HOST: "127.0.0.1",
      LAUNCH_PAD_DASHBOARD_TOKEN: TOKEN,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  // Wait for readiness via the unauthenticated health endpoint.
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await request.get(`${AUTH_URL}/healthz`);
      if (res.ok()) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("token-auth dashboard never became ready");
    await new Promise((r) => setTimeout(r, 250));
  }
});

test.afterAll(() => {
  child?.kill();
});

test("requests without a token get 401", async ({ playwright }) => {
  const ctx = await playwright.request.newContext();
  const res = await ctx.get(`${AUTH_URL}/`);
  expect(res.status()).toBe(401);
  await ctx.dispose();
});

test("?token= sets the cookie, redirects, then serves pages", async ({ playwright }) => {
  const ctx = await playwright.request.newContext();

  const redirect = await ctx.get(`${AUTH_URL}/?token=${TOKEN}`, { maxRedirects: 0 });
  expect(redirect.status()).toBe(302);
  expect(redirect.headers()["set-cookie"]).toContain("lp_dashboard_token");

  // The context kept the cookie — a plain request is now authorized.
  const page = await ctx.get(`${AUTH_URL}/clusters`);
  expect(page.status()).toBe(200);
  expect(await page.text()).toContain("Clusters");

  await ctx.dispose();
});

test("a wrong token stays unauthorized", async ({ playwright }) => {
  const ctx = await playwright.request.newContext();
  const res = await ctx.get(`${AUTH_URL}/?token=wrong`, { maxRedirects: 0 });
  expect(res.status()).toBe(401);
  await ctx.dispose();
});
