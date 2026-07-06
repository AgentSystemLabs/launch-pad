import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { resetFakeState } from "./_helpers";
import { HOME_PATH, ROOT } from "../paths";

const PROJ_DIR = join(ROOT, "test-results", "proj-demo");
const OTHER_PROJ_DIR = join(ROOT, "test-results", "proj-other");
const FORGED_DIR = join(ROOT, "test-results", "proj-forged");
const TAMPER_DIR = join(ROOT, "test-results", "proj-tamper");

test.beforeEach(() => {
  resetFakeState();
  rmSync(PROJ_DIR, { recursive: true, force: true });
  rmSync(TAMPER_DIR, { recursive: true, force: true });
  rmSync(OTHER_PROJ_DIR, { recursive: true, force: true });
  rmSync(FORGED_DIR, { recursive: true, force: true });
  mkdirSync(PROJ_DIR, { recursive: true });
  mkdirSync(OTHER_PROJ_DIR, { recursive: true });
  writeFileSync(join(PROJ_DIR, "Dockerfile"), "FROM node:24\n");
  writeFileSync(join(OTHER_PROJ_DIR, "Dockerfile"), "FROM node:24\n");
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

  mkdirSync(OTHER_PROJ_DIR, { recursive: true });
  writeFileSync(
    join(OTHER_PROJ_DIR, "launch-pad.toml"),
    'project = "other"\n\n[[service]]\nname = "demo"\nenv = { NODE_ENV = "production" }\n',
  );

  // A forged form field must not redirect the save to a different local path.
  await page
    .getByTestId("env-editor")
    .locator('form[p-action="projects:env:save"]')
    .evaluate((form, dir) => {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = "dir";
      input.value = dir;
      form.appendChild(input);
    }, OTHER_PROJ_DIR);

  // Edit + save → only the registered project's toml is rewritten and the service redeploys
  await textarea.fill("NODE_ENV=production\nFEATURE_X=on");
  await page.getByTestId("env-editor").getByRole("button", { name: "Save & redeploy" }).click();
  await expect(page.getByText(/Saved env \+ redeployed/)).toBeVisible();

  const toml = readFileSync(join(PROJ_DIR, "launch-pad.toml"), "utf8");
  expect(toml).toContain("FEATURE_X");
  const otherToml = readFileSync(join(OTHER_PROJ_DIR, "launch-pad.toml"), "utf8");
  expect(otherToml).not.toContain("FEATURE_X");
});

test("env save ignores a tampered project directory field", async ({ page }) => {
  writeFileSync(
    join(OTHER_PROJ_DIR, "launch-pad.toml"),
    'project = "other"\n\n[[service]]\nname = "demo"\nenv = { NODE_ENV = "safe" }\n',
  );

  await page.goto("/projects");
  await page.getByPlaceholder("name", { exact: true }).fill("demo");
  await page.getByPlaceholder("/abs/path/to/source (with Dockerfile)").fill(PROJ_DIR);
  await page.getByRole("button", { name: "Scaffold" }).click();
  await expect(page.getByTestId("project-name-demo")).toBeVisible();

  await page.getByTestId("project-row-demo").getByRole("button", { name: "Env" }).click();
  const textarea = page.getByTestId("env-text-demo");
  await expect(textarea).toBeVisible();
  await textarea.fill("NODE_ENV=production\nFEATURE_X=on");

  await page.evaluate((otherDir) => {
    const form = document.querySelector('[data-testid="env-editor"] form[p-action="projects:env:save"]');
    if (!(form instanceof HTMLFormElement)) throw new Error("env save form not found");
    let dir = form.querySelector('input[name="dir"]');
    if (!(dir instanceof HTMLInputElement)) {
      dir = document.createElement("input");
      dir.type = "hidden";
      dir.name = "dir";
      form.appendChild(dir);
    }
    dir.value = otherDir;
  }, OTHER_PROJ_DIR);

  await page.getByTestId("env-editor").getByRole("button", { name: "Save & redeploy" }).click();
  await expect(page.getByText(/Saved env \+ redeployed/)).toBeVisible();

  expect(readFileSync(join(PROJ_DIR, "launch-pad.toml"), "utf8")).toContain("FEATURE_X");
  expect(readFileSync(join(OTHER_PROJ_DIR, "launch-pad.toml"), "utf8")).not.toContain("FEATURE_X");
});

test("env save ignores forged project directory fields", async ({ page }) => {
  mkdirSync(HOME_PATH, { recursive: true });
  mkdirSync(FORGED_DIR, { recursive: true });
  writeFileSync(
    join(PROJ_DIR, "launch-pad.toml"),
    'project = "demo"\n\n[[service]]\nname = "demo"\nenv = { SAFE = "yes" }\n',
  );
  writeFileSync(
    join(FORGED_DIR, "launch-pad.toml"),
    'project = "demo"\n\n[[service]]\nname = "demo"\nenv = { SHOULD_STAY = "yes" }\n',
  );
  writeFileSync(
    join(HOME_PATH, "config.json"),
    JSON.stringify({ projects: [{ name: "demo", dir: PROJ_DIR }] }),
  );

  await page.goto("/projects");
  await page.getByTestId("project-row-demo").getByRole("button", { name: "Env" }).click();
  await page.getByTestId("env-text-demo").fill("SAFE=yes\nPWNED=true");
  await page.locator('form[p-action="projects:env:save"]').evaluate((form, forgedDir) => {
    for (const [name, value] of [
      ["project", "demo"],
      ["dir", forgedDir],
    ]) {
      let input = form.querySelector<HTMLInputElement>(`input[name="${name}"]`);
      if (!input) {
        input = document.createElement("input");
        input.type = "hidden";
        input.name = name;
        form.append(input);
      }
      input.value = value;
    }
  }, FORGED_DIR);

  await page.getByTestId("env-editor").getByRole("button", { name: "Save & redeploy" }).click();
  await expect(page.getByText(/Saved env \+ redeployed demo\/demo/)).toBeVisible();

  const registeredToml = readFileSync(join(PROJ_DIR, "launch-pad.toml"), "utf8");
  const forgedToml = readFileSync(join(FORGED_DIR, "launch-pad.toml"), "utf8");
  expect(registeredToml).toContain("PWNED");
  expect(forgedToml).not.toContain("PWNED");
  expect(forgedToml).toContain("SHOULD_STAY");
});

test("env save ignores tampered project directory fields", async ({ page }) => {
  mkdirSync(TAMPER_DIR, { recursive: true });
  writeFileSync(
    join(TAMPER_DIR, "launch-pad.toml"),
    'project = "tamper"\n\n[[service]]\nname = "demo"\nenv = { NODE_ENV = "staging" }\n',
  );

  await page.goto("/projects");
  await page.getByPlaceholder("name", { exact: true }).fill("demo");
  await page.getByPlaceholder("/abs/path/to/source (with Dockerfile)").fill(PROJ_DIR);
  await page.getByRole("button", { name: "Scaffold" }).click();
  await expect(page.getByTestId("project-name-demo")).toBeVisible();

  await page.getByTestId("project-row-demo").getByRole("button", { name: "Env" }).click();
  const editor = page.getByTestId("env-editor");
  await expect(editor).toBeVisible();
  await editor.evaluate((el, dir) => {
    let input = el.querySelector<HTMLInputElement>('input[name="dir"]');
    if (!input) {
      input = document.createElement("input");
      input.type = "hidden";
      input.name = "dir";
      el.querySelector("form")?.appendChild(input);
    }
    input.value = dir;
  }, TAMPER_DIR);

  await page.getByTestId("env-text-demo").fill("NODE_ENV=production\nFEATURE_X=on");
  await editor.getByRole("button", { name: "Save & redeploy" }).click();
  await expect(page.getByText(/Saved env \+ redeployed/)).toBeVisible();

  expect(readFileSync(join(PROJ_DIR, "launch-pad.toml"), "utf8")).toContain("FEATURE_X");
  expect(readFileSync(join(TAMPER_DIR, "launch-pad.toml"), "utf8")).not.toContain("FEATURE_X");
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
