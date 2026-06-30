import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { resetFakeState } from "./_helpers";
import { HOME_PATH, ROOT } from "../paths";

const PROJ_DIR = join(ROOT, "test-results", "proj-demo");
const OTHER_DIR = join(ROOT, "test-results", "proj-other");

test.beforeEach(() => {
  resetFakeState();
  rmSync(PROJ_DIR, { recursive: true, force: true });
  rmSync(OTHER_DIR, { recursive: true, force: true });
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

test("env save ignores tampered project directory form data", async ({ page }) => {
  mkdirSync(OTHER_DIR, { recursive: true });
  writeFileSync(
    join(OTHER_DIR, "launch-pad.toml"),
    'project = "other"\n\n[[service]]\nname = "demo"\nenv = { UNCHANGED = "yes" }\n',
  );

  await page.goto("/projects");
  await page.getByPlaceholder("name", { exact: true }).fill("demo");
  await page.getByPlaceholder("/abs/path/to/source (with Dockerfile)").fill(PROJ_DIR);
  await page.getByRole("button", { name: "Scaffold" }).click();
  await expect(page.getByTestId("project-name-demo")).toBeVisible();

  await page.getByTestId("project-row-demo").getByRole("button", { name: "Env" }).click();
  await page.getByTestId("env-text-demo").fill("NODE_ENV=production\nSAFE_KEY=ok");
  await page.evaluate((dir) => {
    const form = document.querySelector('[data-testid="env-editor"] form[p-action="projects:env:save"]');
    if (!(form instanceof HTMLFormElement)) throw new Error("env form not found");
    const forged = document.createElement("input");
    forged.type = "hidden";
    forged.name = "dir";
    forged.value = dir;
    form.appendChild(forged);
  }, OTHER_DIR);
  await page.getByTestId("env-editor").getByRole("button", { name: "Save & redeploy" }).click();
  await expect(page.getByText(/Saved env \+ redeployed/)).toBeVisible();

  expect(readFileSync(join(PROJ_DIR, "launch-pad.toml"), "utf8")).toContain("SAFE_KEY");
  expect(readFileSync(join(OTHER_DIR, "launch-pad.toml"), "utf8")).not.toContain("SAFE_KEY");
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
