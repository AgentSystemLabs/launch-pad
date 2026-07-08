import { test, expect } from "@playwright/test";
import { resetFakeState } from "./_helpers";

test.beforeEach(() => resetFakeState());

test("lists seeded nodes for a cluster", async ({ page }) => {
  await page.goto("/clusters/prod/nodes");
  await expect(page.getByRole("heading", { name: "Nodes" })).toBeVisible();
  await expect(page.getByTestId("breadcrumbs")).toContainText("Nodes");
  await expect(page.getByTestId("nodes-table")).toBeVisible();
  await expect(page.getByTestId("node-name-web-1")).toBeVisible();
  await expect(page.getByTestId("node-name-edge-1")).toBeVisible();
});

test("shows role, type, state, and address per node", async ({ page }) => {
  await page.goto("/clusters/prod/nodes");
  const web = page.getByTestId("node-row-web-1");
  await expect(web).toContainText("app");
  await expect(web).toContainText("t3.small");
  await expect(web).toContainText("running");
  await expect(web).toContainText("VPC-private"); // app nodes have no public address
  const edge = page.getByTestId("node-row-edge-1");
  await expect(edge).toContainText("edge");
  await expect(edge).toContainText("203.0.113.10");
});

test("shows node state badge legend", async ({ page }) => {
  await page.goto("/clusters/prod/nodes");
  const legend = page.getByTestId("node-state-legend");
  await expect(legend).toBeVisible();
  await expect(legend.getByText("running")).toBeVisible();
  await expect(legend.getByText("stopped")).toBeVisible();
  await expect(legend.getByText("provisioning")).toBeVisible();
  await expect(legend.getByText("terminated")).toBeVisible();
});

test("monitor link exposes href", async ({ page }) => {
  await page.goto("/clusters/prod/nodes");
  await expect(page.getByTestId("node-row-web-1").getByRole("link", { name: "Monitor" })).toHaveAttribute(
    "href",
    "/clusters/prod/nodes/web-1/monitor",
  );
});

test("breadcrumb navigates to clusters", async ({ page }) => {
  await page.goto("/clusters/prod/nodes");
  await page.getByTestId("breadcrumbs").getByRole("link", { name: "Clusters" }).click();
  await expect(page.getByRole("heading", { name: "Clusters" })).toBeVisible();
});
