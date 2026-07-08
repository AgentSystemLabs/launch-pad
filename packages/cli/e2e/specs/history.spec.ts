import { test, expect } from "@playwright/test";
import { resetFakeState, seedShopProject } from "./_helpers";

test.beforeEach(() => resetFakeState());

test("shows a registered project's deploy events, newest first", async ({ page }) => {
  seedShopProject();
  await page.goto("/projects/shop/history");
  await expect(page.getByRole("heading", { name: /History/ })).toBeVisible();
  await expect(page.getByTestId("breadcrumbs")).toContainText("History");
  await expect(page.getByTestId("history-table")).toBeVisible();
  await expect(page.getByTestId("history-row-0")).toBeVisible();
  await expect(page.getByTestId("history-row-1")).toBeVisible();
  await expect(page.getByTestId("history-row-2")).toBeVisible();
  // Newest event is the restart, older ones are builds (kind badges).
  await expect(page.getByTestId("history-row-0").getByText("restart")).toBeVisible();
  await expect(page.getByTestId("history-row-1").getByText("build")).toBeVisible();
  await expect(page.getByTestId("history-row-1")).toContainText("api");
  await expect(page.getByTestId("history-row-1")).toContainText("worker");
  await expect(page.getByTestId("history-row-1")).toContainText("abc123");
});

test("unregistered project shows an error card instead of crashing", async ({ page }) => {
  await page.goto("/projects/nope/history");
  await expect(page.getByText('Project "nope" isn\'t registered')).toBeVisible();
  await expect(page.getByText(/launchpad dashboard --project/)).toBeVisible();
});

test("breadcrumb navigates back to projects", async ({ page }) => {
  seedShopProject();
  await page.goto("/projects/shop/history");
  await page.getByTestId("breadcrumbs").getByRole("link", { name: "Projects" }).click();
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
});
