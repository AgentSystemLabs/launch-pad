import { test, expect } from "@playwright/test";
import { resetFakeState } from "./_helpers";

test.beforeEach(() => resetFakeState());

test("lists the seeded env markers", async ({ page }) => {
  await page.goto("/clusters/prod/environments");
  await expect(page.getByRole("heading", { name: "Environments" })).toBeVisible();
  await expect(page.getByTestId("breadcrumbs")).toContainText("Environments");
  await expect(page.getByTestId("environments-table")).toBeVisible();
  await expect(page.getByTestId("env-row-shop-staging")).toBeVisible();
  await expect(page.getByTestId("env-row-shop-pr-42")).toBeVisible();
});

test("shows env, project, domains, and TTL state per marker", async ({ page }) => {
  await page.goto("/clusters/prod/environments");
  const staging = page.getByTestId("env-row-shop-staging");
  await expect(staging).toContainText("staging");
  await expect(staging).toContainText("shop");
  await expect(staging).toContainText("no TTL");
  await expect(staging).toContainText("staging.shop.example.com");
});

test("expired marker gets an expired badge", async ({ page }) => {
  await page.goto("/clusters/prod/environments");
  await expect(page.getByTestId("env-row-shop-pr-42").getByText("expired")).toBeVisible();
});

test("breadcrumb navigates to clusters", async ({ page }) => {
  await page.goto("/clusters/prod/environments");
  await page.getByTestId("breadcrumbs").getByRole("link", { name: "Clusters" }).click();
  await expect(page.getByRole("heading", { name: "Clusters" })).toBeVisible();
});
