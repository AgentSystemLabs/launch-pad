import { test, expect } from "@playwright/test";

test("dashboard responses deny frame embedding", async ({ page }) => {
  const response = await page.goto("/");

  expect(response?.headers()["x-frame-options"]).toBe("DENY");
  expect(response?.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
});
