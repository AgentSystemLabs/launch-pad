import { test, expect } from "@playwright/test";
import { acceptDialogs, resetFakeState } from "./_helpers";

test.beforeEach(() => resetFakeState());

test("lists seeded nodes for a cluster", async ({ page }) => {
  await page.goto("/clusters/prod/nodes");
  await expect(page.getByRole("heading", { name: "Nodes" })).toBeVisible();
  await expect(page.getByTestId("breadcrumbs")).toContainText("Nodes");
  await expect(page.getByTestId("node-name-web-1")).toBeVisible();
  await expect(page.getByTestId("node-name-edge-1")).toBeVisible();
});

test("breadcrumb navigates to clusters", async ({ page }) => {
  await page.goto("/clusters/prod/nodes");
  await page.getByTestId("breadcrumbs").getByRole("link", { name: "Clusters" }).click();
  await expect(page.getByRole("heading", { name: "Clusters" })).toBeVisible();
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

test("breadcrumb links show a focus ring on keyboard focus", async ({ page }) => {
  await page.goto("/clusters/prod/nodes");
  const link = page.getByTestId("breadcrumbs").getByRole("link", { name: "Clusters" });
  await link.focus();
  await expect(link).toHaveCSS("outline-style", "solid");
  await expect(link).not.toHaveCSS("outline-width", "0px");
});

test("monitor link exposes href", async ({ page }) => {
  await page.goto("/clusters/prod/nodes");
  await expect(page.getByTestId("node-row-web-1").getByRole("link", { name: "Monitor" })).toHaveAttribute(
    "href",
    "/clusters/prod/nodes/web-1/monitor",
  );
});

test("create a node", async ({ page }) => {
  await page.goto("/clusters/prod/nodes");
  await page.getByPlaceholder("web-2").fill("web-2");
  await page.getByRole("button", { name: "Create node" }).click();
  await expect(page.getByTestId("node-name-web-2")).toBeVisible();
  await expect(page.getByText('Created node "web-2"')).toBeVisible();
});

test("submit button shows loading spinner while action runs", async ({ page }) => {
  await page.goto("/clusters/prod/nodes");
  await page.getByPlaceholder("web-2").fill("web-2");
  const form = page.locator('form[p-action="nodes:create"]');
  const busy = page.waitForFunction(() => {
    const btn = document.querySelector('form[p-action="nodes:create"] button.btn');
    return btn instanceof HTMLButtonElement && btn.classList.contains("loading");
  });
  await form.evaluate((f: HTMLFormElement) => f.requestSubmit());
  await busy;
});

test("pause a running node flips it to resumable", async ({ page }) => {
  await page.goto("/clusters/prod/nodes");
  const row = page.getByTestId("node-row-web-1");
  await row.getByRole("button", { name: "Pause" }).click();
  await expect(row.getByRole("button", { name: "Resume" })).toBeVisible();
});

test("destroy a node", async ({ page }) => {
  acceptDialogs(page);
  await page.goto("/clusters/prod/nodes");
  await page.getByTestId("node-row-edge-1").getByRole("button", { name: "Destroy" }).click();
  await expect(page.getByTestId("node-name-edge-1")).toHaveCount(0);
});
