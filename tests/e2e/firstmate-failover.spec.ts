import { test, expect } from "@playwright/test";
import { call, herdr, seedWorld, waitUntil } from "./map-seed";
import { allLiveStdout } from "../fixtures/quota";
import { shot } from "./shot";

test.afterEach(async () => {
  await waitUntil(async () => !["starting", "handoff", "stopping"].includes((await call("GET", "/api/firstmate/status")).body.primary.phase), 30000);
  const last = (await call("GET", "/api/firstmate/status")).body;
  if (last.pane) await herdr("fake.close_pane", { pane_id: last.pane.pane_id });
  await waitUntil(async () => !(await call("GET", "/api/firstmate/status")).body.running);
});

test("Firstmate switches accounts from the rail and shows the handoff in its hub", async ({ page }) => {
  await seedWorld();
  await call("POST", "/api/usage/test-fake", { result: { kind: "ok", stdout: allLiveStdout(Date.now()) } });
  await waitUntil(async () => (await call("GET", "/api/usage")).body.providers.some((p: { account: string; state: string }) => p.account === "codex" && p.state === "live"));
  const started = await call("POST", "/api/firstmate/start");
  expect(["sent", "acked"]).toContain(started.body.status);
  await waitUntil(async () => { const s = (await call("GET", "/api/firstmate/status")).body; return s.running && s.primary.phase === "ready"; });
  const before = (await call("GET", "/api/firstmate/status")).body;
  await herdr("fake.set_status", { pane_id: before.pane.pane_id, status: "idle" });
  await page.goto("/");
  const rail = page.locator('[data-rail="firstmate"]');
  await expect(rail.getByTestId("firstmate-account")).toContainText("Claude Code");
  await rail.getByLabel("Switch Firstmate to").selectOption("codex");
  await expect(rail.getByTestId("firstmate-account")).toContainText("Codex · codex · gpt-6.1-sol", { timeout: 20000 });
  await expect(rail.getByTestId("firstmate-switch-reason")).toHaveText("Switched manually.");
  await waitUntil(async () => (await call("GET", "/api/firstmate/status")).body.primary.phase === "ready", 30000);
  const switched = (await call("GET", "/api/firstmate/status")).body;
  expect(switched.primary.phase).toBe("ready");
  expect(switched.primary.lastSwitch.note).toBeTruthy();
  expect(switched.pane.pane_id).not.toBe(before.pane.pane_id);
  const hub = page.getByTestId("firstmate-node");
  await hub.locator(".fm-title").focus();
  await page.getByRole("radio", { name: "Near", exact: true }).click();
  await expect(hub.getByTestId("firstmate-account")).toContainText("gpt-6.1-sol");
  await expect(hub.getByTestId("firstmate-switch-reason")).toHaveText("Switched manually.");
  await expect(hub.getByTestId("firstmate-account")).toBeInViewport();
  await rail.scrollIntoViewIfNeeded();
  await shot(page, "C7", "firstmate-codex-handoff");
  // Claude's fresh reading is offered while the successor works, then enabled at idle.
  await herdr("fake.set_status", { pane_id: switched.pane.pane_id, status: "working" });
  await expect(rail.getByLabel("Switch Firstmate to").locator('option[value="claude-code"]')).toHaveAttribute("disabled", "");
  const busyReturn = await call("POST", "/api/firstmate/switch", { account: "claude-code" });
  expect(busyReturn.body.status).toBe("failed");
  expect(busyReturn.body.error).toContain("idle");
  await herdr("fake.set_status", { pane_id: switched.pane.pane_id, status: "done" });
  await expect(rail.getByLabel("Switch Firstmate to").locator('option[value="claude-code"]')).not.toHaveAttribute("disabled");
  await rail.getByLabel("Switch Firstmate to").selectOption("claude-code");
  await expect(rail.getByTestId("firstmate-account")).toContainText("Claude Code", { timeout: 20000 });
  await waitUntil(async () => (await call("GET", "/api/firstmate/status")).body.primary.phase === "ready");
  await rail.scrollIntoViewIfNeeded();
  await shot(page, "C7", "firstmate-return-to-claude");
});
