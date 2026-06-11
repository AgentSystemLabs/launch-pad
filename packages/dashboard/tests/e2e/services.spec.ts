import { test, expect } from "@playwright/test";
import { resetFakeState } from "./_helpers";

test.beforeEach(() => resetFakeState());

test("lists running services aggregated from node status", async ({ page }) => {
  await page.goto("/clusters/prod/services");
  await expect(page.getByRole("heading", { name: "Services" })).toBeVisible();
  await expect(page.getByTestId("breadcrumbs")).toContainText("Services");
  await expect(page.getByTestId("svc-row-shop-api")).toBeVisible();
  await expect(page.getByTestId("svc-row-shop-worker")).toBeVisible();
  // running/desired replica counts are shown
  await expect(page.getByTestId("svc-row-shop-api").getByText("2/2")).toBeVisible();
});

test("shows replica health legend", async ({ page }) => {
  await page.goto("/clusters/prod/services");
  const legend = page.getByTestId("replica-legend");
  await expect(legend).toBeVisible();
  await expect(legend).toContainText("Healthy");
  await expect(legend).toContainText("Transitioning");
  await expect(legend).toContainText("Error");
});

test("shows service state badge legend", async ({ page }) => {
  await page.goto("/clusters/prod/services");
  const legend = page.getByTestId("state-legend");
  await expect(legend).toBeVisible();
  await expect(legend.getByText("running")).toBeVisible();
  await expect(legend.getByText("starting")).toBeVisible();
  await expect(legend.getByText("error")).toBeVisible();
  await expect(legend.getByText("stopped")).toBeVisible();
});

test("breadcrumb navigates to clusters", async ({ page }) => {
  await page.goto("/clusters/prod/services");
  await page.getByTestId("breadcrumbs").getByRole("link", { name: "Clusters" }).click();
  await expect(page.getByRole("heading", { name: "Clusters" })).toBeVisible();
});

test("redeploy is disabled until the project is registered", async ({ page }) => {
  await page.goto("/clusters/prod/services");
  await expect(
    page.getByTestId("svc-row-shop-api").getByRole("button", { name: "Redeploy" }),
  ).toBeDisabled();
});

test("explains why redeploy is disabled", async ({ page }) => {
  await page.goto("/clusters/prod/services");
  const tip = page.getByTestId("svc-row-shop-api").getByTestId("redeploy-tip-shop-api");
  await expect(tip).toHaveAttribute("data-tip", /Register this project on the Projects page first/);
});
