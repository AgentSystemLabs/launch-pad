import { test, expect } from "@playwright/test";
import { resetFakeState } from "./_helpers";

test.beforeEach(() => resetFakeState());

test("streams live host CPU/memory cards", async ({ page }) => {
  await page.goto("/clusters/prod/nodes/web-1/monitor");
  await expect(page.getByRole("heading", { name: /Monitor/ })).toBeVisible();
  await expect(page.getByTestId("breadcrumbs")).toContainText("Monitor");
  await expect(page.getByTestId("monitor-live")).toBeVisible();

  // The fake emits a sample every ~400ms; the SSE swap fills the cards shortly.
  await expect(page.getByText("Host CPU")).toBeVisible();
  await expect(page.getByText("Host Memory")).toBeVisible();
});

test("shows per-service stats from the stream", async ({ page }) => {
  await page.goto("/clusters/prod/nodes/web-1/monitor");
  await expect(page.getByTestId("monitor-svc-shop-api")).toBeVisible();
  await expect(page.getByTestId("monitor-svc-shop-worker")).toBeVisible();
});

test("breadcrumb navigates back to nodes", async ({ page }) => {
  await page.goto("/clusters/prod/nodes/web-1/monitor");
  await page.getByTestId("breadcrumbs").getByRole("link", { name: "Nodes" }).click();
  await expect(page.getByRole("heading", { name: "Nodes" })).toBeVisible();
});
