import { test, expect } from "@playwright/test";
import { resetFakeState, seedShopProject } from "./_helpers";

// Register the "shop" project so the logs page has a cwd to run the CLI in.
test.beforeEach(() => {
  resetFakeState();
  seedShopProject();
});

test("tails live log lines", async ({ page }) => {
  await page.goto("/clusters/prod/logs/shop/api");
  await expect(page.getByRole("heading", { name: /Logs/ })).toBeVisible();
  await expect(page.getByTestId("breadcrumbs")).toContainText("Logs");
  await expect(page.getByTestId("logs-panel")).toBeVisible();
  await expect(page.getByTestId("logs-output")).toContainText("request");
  await expect(page.getByTestId("logs-output")).toContainText("[api]");
});

test("breadcrumb navigates back to services", async ({ page }) => {
  await page.goto("/clusters/prod/logs/shop/api");
  await page.getByTestId("breadcrumbs").getByRole("link", { name: "Services" }).click();
  await expect(page.getByRole("heading", { name: /Services/ })).toBeVisible();
});

test("auto-scrolls to the latest lines while tailing", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 400 });
  await page.goto("/clusters/prod/logs/shop/api");
  const output = page.getByTestId("logs-output");
  await expect(output).toContainText("request");
  await expect
    .poll(async () => output.evaluate((el) => el.scrollHeight > el.clientHeight))
    .toBe(true);
  await expect
    .poll(async () =>
      output.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight <= 48),
    )
    .toBe(true);
});

test("shows jump to latest after scrolling up", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 400 });
  await page.goto("/clusters/prod/logs/shop/api");
  const output = page.getByTestId("logs-output");
  await expect
    .poll(async () => output.evaluate((el) => el.scrollHeight > el.clientHeight))
    .toBe(true);

  await expect
    .poll(async () => {
      await output.evaluate((el) => {
        el.scrollTop = 0;
        el.dispatchEvent(new Event("scroll"));
      });
      return page.getByTestId("logs-jump").isVisible();
    })
    .toBe(true);

  const jump = page.getByTestId("logs-jump");
  await jump.click({ force: true });
  await expect
    .poll(async () =>
      output.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight <= 48),
    )
    .toBe(true);
  await expect(jump).toBeHidden();
});

test("unregistered project shows a hint instead of crashing", async ({ page }) => {
  await page.goto("/clusters/prod/logs/ghost/api");
  await expect(page.getByTestId("logs-output")).toContainText("isn't registered");
});
