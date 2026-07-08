import { test, expect } from "@playwright/test";
import { resetFakeState, seedHome, seedShopProject, PROJ_DIR } from "./_helpers";

test.beforeEach(() => resetFakeState());

test("empty state before any project is registered", async ({ page }) => {
  await page.goto("/projects");
  await expect(page.getByText("No projects registered")).toBeVisible();
  await expect(page.getByText(/launchpad dashboard --project <dir>/)).toBeVisible();
});

test("lists a registered project with dir health + links", async ({ page }) => {
  seedShopProject({ defaultCluster: "prod" });
  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await expect(page.getByTestId("breadcrumbs")).toContainText("Projects");
  await expect(page.getByTestId("projects-table")).toBeVisible();

  const row = page.getByTestId("project-row-shop");
  await expect(row).toBeVisible();
  await expect(page.getByTestId("project-dir-ok-shop")).toBeVisible();
  await expect(row.getByRole("link", { name: "History" })).toHaveAttribute("href", "/projects/shop/history");
  // Per-service logs links come from the on-disk launch-pad.toml ([[service]] api).
  await expect(page.getByTestId("project-logs-shop-api")).toHaveAttribute("href", "/clusters/prod/logs/shop/api");
});

test("flags a registered project whose directory is missing", async ({ page }) => {
  seedHome({ projects: [{ name: "broken", dir: "/no/such/project/dir" }] });
  await page.goto("/projects");
  await expect(page.getByTestId("project-dir-error-broken")).toBeVisible();
  await expect(page.getByTestId("project-dir-error-broken")).toContainText("directory does not exist");
});

test("click to copy the project directory path", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  seedShopProject();
  await page.goto("/projects");
  const copy = page.getByTestId("project-row-shop").locator("[data-copy-path]");
  await copy.click();
  await expect(copy).toHaveText("Copied!");
  await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toBe(PROJ_DIR);
});
