import { test, expect } from "@playwright/test";
import { call, herdr, waitUntil } from "./map-seed";
import { shot } from "./shot";

// Real UI and daemon against the fake runtime. Counts must open the same answerable list,
// even with the rail closed or its Needs you section below the viewport.
test("every needs-you count opens the actionable items and dismissal clears every count", async ({ page }) => {
  const pane = (await herdr("fake.add_pane", { cwd: "/tmp/joyride-fixture-repos/gamma", agent: "claude", agent_status: "blocked", title: "Permission to remove reviewed file" })).pane.pane_id;
  await herdr("fake.set_menu", { pane_id: pane, menu: [
    "Bash command", "rm reviewed.txt", "Do you want to proceed?", "❯ 1. Yes",
    "2. Yes, and don't ask again for rm commands in gamma", "3. No, and tell Claude what to do differently (esc)",
  ] });
  const worker = `local:${pane}`;
  await waitUntil(async () => (await call("GET", "/api/workers")).body.some((w: { id: string }) => w.id === worker));
  const attention = (await call("POST", "/api/attention", { level: "L3", kind: "approval", worker, title: "Remove the reviewed file?", why: "Bash: rm reviewed.txt" })).body;
  // These exact false alarms must never join the list, even when the classifier raises their level.
  await call("POST", "/api/attention", { level: "L4", kind: "progress", title: "Made progress in orbit", why: "Finished the work." });
  await call("POST", "/api/attention", { level: "L3", kind: "question", worker: "local:wH:p1", title: "Made progress in firstmate", why: "Tell me when Chrome's free?" });
  await page.goto("/");
  const items = page.locator('[data-rail="attention"]');
  const target = items.locator(`[data-needs-you="attention:${attention.id}"]`);
  const wanted = (await call("GET", "/api/asks?needs_you=1")).body.asks.length;
  await expect(items.locator("[data-needs-you]")).toHaveCount(wanted);
  await expect(items).not.toContainText("Made progress in orbit");
  await expect(items).not.toContainText("Made progress in firstmate");

  const metric = page.locator('[data-metric="open-l3l4"]');
  const bridge = page.locator('[data-count="needs-you"]');
  await expect(metric).toContainText(`${wanted} waiting on you`);
  await expect(bridge).toHaveAttribute("data-n", String(wanted));
  await page.getByRole("button", { name: "Rail", exact: true }).click();
  await expect(items).toHaveCount(0);
  await metric.click();
  await expect(target).toBeVisible();
  await expect(items).toBeFocused();
  await expect(target).toHaveAttribute("data-attention", attention.id);
  await expect(target.locator(".pa-screen")).toContainText("rm reviewed.txt");
  await expect(target.getByRole("button", { name: "Dismiss", exact: true })).toBeVisible();
  await expect(target.getByRole("button", { name: "Allow", exact: true })).toBeVisible();
  await expect(target.getByRole("button", { name: "Deny", exact: true })).toBeVisible();
  await expect(target).toBeInViewport();
  await shot(page, "C3", "needs-you-count-to-permission");

  await page.locator(".rail").evaluate((rail) => { rail.scrollTop = rail.scrollHeight; });
  await bridge.click();
  await expect(items).toBeFocused();
  await expect(target).toBeVisible();
  await page.getByTestId("next-ask").click();
  await expect(items).toBeFocused();
  await expect(target).toBeInViewport();
  await expect(page.getByTestId("next-ask").locator(".na-n")).toHaveText(String(wanted));
  await target.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(target).toHaveCount(0);
  await page.goto("/");
  await expect(metric).toContainText(`${wanted - 1} waiting on you`);
  await expect(bridge).toHaveAttribute("data-n", String(wanted - 1));
  await herdr("fake.close_pane", { pane_id: pane });
});


test("counts stay hidden when their actionable list cannot load", async ({ page }) => {
  // 503 means the daemon is restarting and retries silently; a 500 is an asks-source failure.
  await page.route("**/api/asks", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Asks unavailable" }) }));
  await page.goto("/");
  await expect(page.locator('[data-rail="attention"]')).toContainText("Asks unavailable");
  await expect(page.locator('[data-metric="open-l3l4"]')).toHaveCount(0);
  await expect(page.locator('[data-count="needs-you"]')).toHaveCount(0);
  await expect(page.locator('#rail-needs .count')).toHaveCount(0);
  await expect(page.getByTestId("next-ask")).toHaveCount(0);
});
