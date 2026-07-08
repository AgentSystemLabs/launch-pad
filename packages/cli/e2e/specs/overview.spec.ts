import { test, expect } from "@playwright/test";
import { resetFakeState, seedHome } from "./_helpers";

// The overview reads the DASHBOARD's nav cluster (home config defaultCluster or
// "default") — point it at "prod", where the fake's seeded nodes live.
test.beforeEach(() => {
  resetFakeState();
  seedHome({ defaultCluster: "prod" });
});

test("shows the health stat tiles", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByTestId("overview-stats")).toBeVisible();
  await expect(page.getByTestId("stat-nodes")).toContainText("2/2");
  await expect(page.getByTestId("stat-services")).toContainText("2/2");
  await expect(page.getByTestId("stat-stale")).toContainText("0");
  await expect(page.getByTestId("stat-envs")).toContainText("2");
});

test("attention section is clear when everything is healthy", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("attention")).toBeVisible();
  await expect(page.getByTestId("attention-clear")).toBeVisible();
  await expect(page.getByTestId("attention-clear")).toContainText("All healthy");
});

test("quick links point at the nav cluster", async ({ page }) => {
  await page.goto("/");
  const links = page.getByTestId("quick-links");
  await expect(links.getByRole("link", { name: "Clusters" })).toHaveAttribute("href", "/clusters");
  await expect(links.getByRole("link", { name: "Projects" })).toHaveAttribute("href", "/projects");
  await expect(links.getByRole("link", { name: "Nodes" })).toHaveAttribute("href", "/clusters/prod/nodes");
  await expect(links.getByRole("link", { name: "Services" })).toHaveAttribute("href", "/clusters/prod/services");
  await expect(links.getByRole("link", { name: "Environments" })).toHaveAttribute(
    "href",
    "/clusters/prod/environments",
  );
});
