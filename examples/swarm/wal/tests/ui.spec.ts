import { expect, test } from "@playwright/test";

/**
 * Real-browser smoke for the orbital-js operator UI: set a mission, Run, see a
 * simulated agent appear live (WebSocket morph, no reload), then Pause.
 */
test("operator sets a mission, runs, sees live agent updates, and pauses", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Mission" })).toBeVisible();

  // Status starts idle.
  await expect(page.locator("#control-bar")).toContainText(/idle/i);

  // Set a mission and arm it.
  await page.getByPlaceholder(/Describe the mission/i).fill("Fix one UX papercut — small PR only");
  await page.getByRole("button", { name: "Set mission" }).click();
  await page.getByRole("button", { name: "Run ▶" }).click();

  // Status pill flips to running, and the armed mission renders.
  await expect(page.locator("#control-bar")).toContainText(/running/i);
  await expect(page.locator("#mission-panel")).toContainText("Fix one UX papercut");

  // Simulate an agent checking in via the REST API — the grid must update live
  // (no page reload), proving the WebSocket broadcast path end-to-end.
  // (Grid anchors use p-href for orbital client-nav, so they are not role=link.)
  await request.post("/agents/heartbeat", {
    data: { agent: "engineer_5", status: "working", summary: "browser e2e", loop: "create-pr", replicaIndex: 5 },
  });
  await expect(page.locator("#agents-grid").getByText("engineer_5")).toBeVisible();

  // Stream a stdout line, open the agent detail, and see it live.
  await request.post("/agents/engineer_5/stdout", { data: { lines: ["BROWSER_E2E_STDOUT"] } });
  await page.locator("#agents-grid").getByText("engineer_5").click();
  await expect(page.getByText("BROWSER_E2E_STDOUT")).toBeVisible();

  // Pause from the header and confirm the pill reflects it.
  await page.goto("/");
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.locator("#control-bar")).toContainText(/paused/i);
});
