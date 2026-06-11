import { test, expect } from "@playwright/test";
import { resetFakeState } from "./_helpers";

test.beforeEach(() => resetFakeState());

test("streams live host CPU/memory cards", async ({ page }) => {
  await page.goto("/clusters/prod/nodes/web-1/monitor");
  await expect(page.getByRole("heading", { name: /Monitor/ })).toBeVisible();
  await expect(page.getByTestId("breadcrumbs")).toContainText("Monitor");

  // The watch stream populates the host cards within a couple of samples.
  await expect(page.getByText("Host CPU")).toBeVisible();
  await expect(page.getByText("Host Memory")).toBeVisible();
});

test("breadcrumb navigates back to nodes", async ({ page }) => {
  await page.goto("/clusters/prod/nodes/web-1/monitor");
  await page.getByTestId("breadcrumbs").getByRole("link", { name: "Nodes" }).click();
  await expect(page.getByRole("heading", { name: /Nodes/ })).toBeVisible();
});

test("shows per-service stats from the stream", async ({ page }) => {
  await page.goto("/clusters/prod/nodes/web-1/monitor");
  await expect(page.getByTestId("monitor-svc-shop-api")).toBeVisible();
  await expect(page.getByTestId("monitor-svc-shop-worker")).toBeVisible();
});
