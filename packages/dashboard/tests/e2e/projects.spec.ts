import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { resetFakeState } from "./_helpers";
import { HOME_PATH, ROOT } from "../paths";

const PROJ_DIR = join(ROOT, "test-results", "proj-demo");
const ATTACK_DIR = join(ROOT, "test-results", "proj-attack");

test.beforeEach(() => {
  resetFakeState();
  rmSync(PROJ_DIR, { recursive: true, force: true });
  rmSync(ATTACK_DIR, { recursive: true, force: true });
  mkdirSync(PROJ_DIR, { recursive: true });
  writeFileSync(join(PROJ_DIR, "Dockerfile"), "FROM node:24\n");
});

test("empty state before any project is registered", async ({ page }) => {
  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await expect(page.getByTestId("breadcrumbs")).toContainText("Projects");
  await expect(page.getByText("No projects registered")).toBeVisible();
});

test("breadcrumb navigates to clusters", async ({ page }) => {
  await page.goto("/projects");
  await page.getByTestId("breadcrumbs").getByRole("link", { name: "Clusters" }).click();
  await expect(page.getByRole("heading", { name: "Clusters" })).toBeVisible();
});

test("registering a non-existent dir is rejected", async ({ page }) => {
  await page.goto("/projects");
  await page.getByPlaceholder("name (e.g. shop)").fill("ghost");
  await page.getByPlaceholder("/abs/path/to/project").fill("/no/such/dir");
  await page.getByRole("button", { name: "Register" }).click();
  await expect(page.getByText(/Can't register/)).toBeVisible();
});

test("explains why deploy is disabled for a missing project directory", async ({ page }) => {
  mkdirSync(HOME_PATH, { recursive: true });
  writeFileSync(
    join(HOME_PATH, "config.json"),
    JSON.stringify({ projects: [{ name: "broken", dir: "/no/such/project/dir" }] }),
  );
  await page.goto("/projects");
  await expect(page.getByTestId("deploy-tip-broken")).toHaveAttribute(
    "data-tip",
    "directory does not exist",
  );
});

test("scaffold a project then edit + save env", async ({ page }) => {
  await page.goto("/projects");

  // Scaffold: writes launch-pad.toml into PROJ_DIR (which has a Dockerfile)
  await page.getByPlaceholder("name", { exact: true }).fill("demo");
  await page.getByPlaceholder("/abs/path/to/source (with Dockerfile)").fill(PROJ_DIR);
  await page.getByRole("button", { name: "Scaffold" }).click();

  await expect(page.getByTestId("project-name-demo")).toBeVisible();
  await expect(page.getByText(/Scaffolded "demo"/)).toBeVisible();

  // Open the env editor for the project
  await page.getByTestId("project-row-demo").getByRole("button", { name: "Env" }).click();
  const textarea = page.getByTestId("env-text-demo");
  await expect(textarea).toBeVisible();
  await expect(textarea).toHaveValue("NODE_ENV=production");

  // Edit + save → toml on disk is rewritten and the service redeploys
  await textarea.fill("NODE_ENV=production\nFEATURE_X=on");
  await page.getByTestId("env-editor").getByRole("button", { name: "Save & redeploy" }).click();
  await expect(page.getByText(/Saved env \+ redeployed/)).toBeVisible();

  const toml = readFileSync(join(PROJ_DIR, "launch-pad.toml"), "utf8");
  expect(toml).toContain("FEATURE_X");
});

test("env save ignores a tampered project directory", async ({ page }) => {
  mkdirSync(ATTACK_DIR, { recursive: true });
  writeFileSync(
    join(ATTACK_DIR, "launch-pad.toml"),
    'project = "attack"\n\n[[service]]\nname = "demo"\nenv = { SHOULD_STAY = "true" }\n',
  );

  await page.goto("/projects");
  await page.getByPlaceholder("name", { exact: true }).fill("demo");
  await page.getByPlaceholder("/abs/path/to/source (with Dockerfile)").fill(PROJ_DIR);
  await page.getByRole("button", { name: "Scaffold" }).click();
  await expect(page.getByTestId("project-name-demo")).toBeVisible();

  await page.getByTestId("project-row-demo").getByRole("button", { name: "Env" }).click();
  await page.locator('form[p-action="projects:env:save"]').evaluate((form, dir) => {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = "dir";
    input.value = dir;
    form.appendChild(input);
  }, ATTACK_DIR);
  await page.getByTestId("env-text-demo").fill("NODE_ENV=production\nFEATURE_SAFE=on");
  await page.getByTestId("env-editor").getByRole("button", { name: "Save & redeploy" }).click();
  await expect(page.getByText(/Saved env \+ redeployed/)).toBeVisible();

  expect(readFileSync(join(PROJ_DIR, "launch-pad.toml"), "utf8")).toContain("FEATURE_SAFE");
  expect(readFileSync(join(ATTACK_DIR, "launch-pad.toml"), "utf8")).not.toContain("FEATURE_SAFE");
});

test("click to copy project directory path", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/projects");
  await page.getByPlaceholder("name", { exact: true }).fill("demo");
  await page.getByPlaceholder("/abs/path/to/source (with Dockerfile)").fill(PROJ_DIR);
  await page.getByRole("button", { name: "Scaffold" }).click();
  await expect(page.getByTestId("project-name-demo")).toBeVisible();

  await page.getByTestId("project-dir-demo").click();
  await expect(page.getByTestId("project-dir-demo")).toHaveText("Copied!");
  await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toBe(PROJ_DIR);
});
