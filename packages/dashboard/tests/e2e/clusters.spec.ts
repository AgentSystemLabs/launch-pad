import { test, expect } from "@playwright/test";
import { acceptDialogs, resetFakeState } from "./_helpers";

test.beforeEach(() => resetFakeState());

test("lists seeded clusters", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Clusters" })).toBeVisible();
  await expect(page.getByTestId("cluster-name-prod")).toBeVisible();
  await expect(page.getByTestId("cluster-name-default")).toBeVisible();
  await expect(page.getByTestId("connection-status")).toBeHidden();
});

test("cluster row links expose href for navigation", async ({ page }) => {
  await page.goto("/");
  const prodRow = page.getByTestId("cluster-row-prod");
  await expect(prodRow.getByRole("link", { name: "Nodes" })).toHaveAttribute(
    "href",
    "/clusters/prod/nodes",
  );
  await expect(prodRow.getByRole("link", { name: "Services" })).toHaveAttribute(
    "href",
    "/clusters/prod/services",
  );
});

test("connection banner surfaces reconnect state", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("connection-status")).toBeHidden();
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("station:state", { detail: { state: "reconnecting" } }));
  });
  await expect(page.getByTestId("connection-status")).toBeVisible();
  await expect(page.getByTestId("connection-status")).toContainText("Reconnecting");
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("station:state", { detail: { state: "open" } }));
  });
  await expect(page.getByTestId("connection-status")).toBeHidden();
});

test("create then destroy a cluster", async ({ page }) => {
  acceptDialogs(page);
  await page.goto("/");

  await page.getByPlaceholder("prod").fill("staging");
  await page.getByPlaceholder("us-east-1").fill("us-west-2");
  await page.getByRole("button", { name: "Create cluster" }).click();

  await expect(page.getByTestId("cluster-name-staging")).toBeVisible();
  await expect(page.getByText('Created cluster "staging"')).toBeVisible();

  await page.getByTestId("cluster-row-staging").getByRole("button", { name: "Destroy" }).click();
  await expect(page.getByTestId("cluster-name-staging")).toHaveCount(0);
});

test("success notice can be dismissed manually", async ({ page }) => {
  await page.goto("/");
  await page.getByPlaceholder("prod").fill("staging");
  await page.getByRole("button", { name: "Create cluster" }).click();
  await expect(page.getByText('Created cluster "staging"')).toBeVisible();
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByText('Created cluster "staging"')).toHaveCount(0);
});

test("success notice auto-dismisses after a few seconds", async ({ page }) => {
  await page.goto("/");
  await page.getByPlaceholder("prod").fill("staging");
  await page.getByRole("button", { name: "Create cluster" }).click();
  await expect(page.getByText('Created cluster "staging"')).toBeVisible();
  await expect(page.getByText('Created cluster "staging"')).toHaveCount(0, { timeout: 8000 });
});

test("use sets the active cluster", async ({ page }) => {
  await page.goto("/");
  // Default active cluster is "default" (fresh dashboard home), so "prod" is selectable.
  const prodRow = page.getByTestId("cluster-row-prod");
  await prodRow.getByRole("button", { name: "Use" }).click();
  await expect(page.getByText("Active cluster set")).toBeVisible();
  await expect(prodRow.getByText("active")).toBeVisible();
});

test("highlights the active nav link for the current page", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Clusters" })).toBeVisible();
  await expect(page.locator('[data-nav="clusters"]')).toHaveClass(/btn-active/);

  await page.locator('[data-nav="projects"]').click();
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await expect(page.locator('[data-nav="projects"]')).toHaveClass(/btn-active/);
  await expect(page.locator('[data-nav="clusters"]')).not.toHaveClass(/btn-active/);

  await page.locator('[data-nav="nodes"]').click();
  await expect(page.getByRole("heading", { name: /Nodes/ })).toBeVisible();
  await expect(page.locator('[data-nav="nodes"]')).toHaveClass(/btn-active/);
});

test("nav links show a focus ring on keyboard focus", async ({ page }) => {
  await page.goto("/");
  const projects = page.locator('[data-nav="projects"]');
  await projects.focus();
  await expect(projects).toHaveCSS("outline-style", "solid");
  await expect(projects).not.toHaveCSS("outline-width", "0px");
});
