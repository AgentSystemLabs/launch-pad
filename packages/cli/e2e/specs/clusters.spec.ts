import { test, expect } from "@playwright/test";
import { resetFakeState } from "./_helpers";

test.beforeEach(() => resetFakeState());

test("lists seeded clusters", async ({ page }) => {
  await page.goto("/clusters");
  await expect(page.getByRole("heading", { name: "Clusters" })).toBeVisible();
  await expect(page.getByTestId("clusters-table")).toBeVisible();
  await expect(page.getByTestId("cluster-row-prod")).toBeVisible();
  await expect(page.getByTestId("cluster-row-default")).toBeVisible();
});

test("marks the default cluster with a badge", async ({ page }) => {
  await page.goto("/clusters");
  await expect(page.getByTestId("cluster-row-prod").getByText("default", { exact: true })).toBeVisible();
  await expect(page.getByTestId("cluster-row-default").getByText("default", { exact: true })).toHaveCount(1); // only the id cell, no badge
});

test("cluster rows expose Nodes/Services/Environments links", async ({ page }) => {
  await page.goto("/clusters");
  const prodRow = page.getByTestId("cluster-row-prod");
  await expect(prodRow.getByRole("link", { name: "Nodes" })).toHaveAttribute("href", "/clusters/prod/nodes");
  await expect(prodRow.getByRole("link", { name: "Services" })).toHaveAttribute("href", "/clusters/prod/services");
  await expect(prodRow.getByRole("link", { name: "Environments" })).toHaveAttribute(
    "href",
    "/clusters/prod/environments",
  );
});

test("row links navigate (plain full-page navigation)", async ({ page }) => {
  await page.goto("/clusters");
  await page.getByTestId("cluster-row-prod").getByRole("link", { name: "Nodes" }).click();
  await expect(page.getByRole("heading", { name: "Nodes" })).toBeVisible();
  await expect(page).toHaveURL(/\/clusters\/prod\/nodes$/);
});
