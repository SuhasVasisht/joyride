import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test, expect } from "@playwright/test";
import { call, herdr, PORT, seedWorld, waitUntil } from "./map-seed";
import { allLiveStdout } from "../fixtures/quota";
import { shot } from "./shot";
import type { FirstmateStatus } from "../../src/modules/firstmate/index";
import type { NewReceipt, ScreenContext } from "../../src/shared/freeform";

const exec = promisify(execFile);
const accounts = [
  { provider: "claude", label: "Claude Code", id: "claude-code" },
  { provider: "codex", label: "Codex", id: "codex" },
  { provider: "codex", label: "Codex 2", id: "codex-2", home: `/tmp/joyride-e2e-${PORT}/codex-2` },
  { provider: "cursor", label: "Cursor", id: "cursor" },
];
const context: ScreenContext = { route: "map", view: null, place: null, focused: null, hovered: null, selected: null, visible: [] };
const status = async () => (await call<FirstmateStatus>("GET", "/api/firstmate/status")).body;
const idle = async () => { const s = await status(); if (s.pane) await herdr("fake.set_status", { pane_id: s.pane.pane_id, status: "idle" }); };
const ready = async () => waitUntil(async () => { const s = await status(); return s.running && s.primary.phase === "ready"; }, 30000);
const proofs: { from: string; to: string; route: string; note: string | null; worker: string | undefined; continuation: string }[] = [];

test.beforeAll(async () => {
  await seedWorld();
  expect((await call("PUT", "/api/system/config", { usage: { accounts }, firstmate: { enabled: true, primaries: accounts.map((a) => ({ account: a.id })) } })).status).toBe(200);
  await call("POST", "/api/usage/test-fake", { result: { kind: "ok", stdout: allLiveStdout(Date.now()) } });
  await call("POST", "/api/firstmate/start");
  await ready();
  await waitUntil(async () => (await status()).primary.choices.length === 4 && (await status()).primary.choices.every((p) => p.available), 30000);
});

test.afterAll(async () => {
  fs.mkdirSync("docs/reports/handoff-matrix", { recursive: true });
  fs.writeFileSync("docs/reports/handoff-matrix/adapter-browser.json", JSON.stringify(proofs, null, 2) + "\n");
  const s = await status();
  if (s.pane) await herdr("fake.close_pane", { pane_id: s.pane.pane_id });
});

for (const route of ["ui-selector", "direct-request"] as const) {
  test(`all twelve ordered account transitions through ${route}`, async ({ page }) => {
    test.setTimeout(240000);
    await page.goto("/#/map");
    const rail = page.locator('[data-rail="firstmate"]');
    for (const from of accounts) for (const to of accounts) {
      if (from.id === to.id) continue;
      await idle();
      if ((await status()).primary.current?.account !== from.id) {
        await call("POST", "/api/firstmate/switch", { account: from.id });
        await ready();
        await idle();
      }
      const before = await status();
      const peers = (await herdr("fake.state")).panes.filter((p: { pane_id: string }) => p.pane_id !== before.pane?.pane_id).map((p: { pane_id: string }) => p.pane_id);
      if (route === "ui-selector") {
        await expect(rail.getByTestId("firstmate-account")).toContainText(`${from.label} ·`);
        await rail.getByLabel("Switch Firstmate to").selectOption(to.id);
        await expect(rail.getByTestId("firstmate-account")).toContainText(`${to.label} ·`, { timeout: 30000 });
      } else {
        const payload = { request: `matrix-${from.id}-${to.id}`, text: `Switch Firstmate to ${to.label}`, context };
        const result = await exec(path.resolve("bin/joyride"), ["api", "POST", "/api/new", JSON.stringify(payload)], { env: { ...process.env, JOYRIDE_URL: `http://127.0.0.1:${PORT}` }, timeout: 45000 });
        const receipt: NewReceipt = JSON.parse(result.stdout);
        expect(receipt.state, receipt.message).toBe("done");
        expect(receipt.route).toBe("deterministic");
        const replay = await exec(path.resolve("bin/joyride"), ["api", "POST", "/api/new", JSON.stringify(payload)], { env: { ...process.env, JOYRIDE_URL: `http://127.0.0.1:${PORT}` }, timeout: 45000 });
        expect(JSON.parse(replay.stdout).id).toBe(receipt.id);
      }
      await ready();
      const after = await status();
      expect(after.primary.current?.account).toBe(to.id);
      expect(after.pane?.pane_id).not.toBe(before.pane?.pane_id);
      expect(after.primary.lastSwitch?.note).toBeTruthy();
      const currentPeers = (await herdr("fake.state")).panes.map((p: { pane_id: string }) => p.pane_id);
      for (const peer of peers) expect(currentPeers).toContain(peer);
      proofs.push({ from: from.id, to: to.id, route, note: after.primary.lastSwitch?.note ?? null, worker: after.pane?.worker, continuation: "Fake adapter only. No native target model turn." });
    }
    await rail.scrollIntoViewIfNeeded();
    await shot(page, "C7", `handoff-matrix-${route}`);
  });
}

test("quota refusal keeps the working source and gives an actionable request result", async ({ page }) => {
  await idle();
  if ((await status()).primary.current?.account !== "codex") {
    await call("POST", "/api/firstmate/switch", { account: "codex" });
    await ready();
  }
  const before = await status();
  const { claudeLive, codexLive, cursorLive, report } = await import("../fixtures/quota");
  await call("POST", "/api/usage/test-fake", { result: { kind: "ok", stdout: report(Date.now(), [claudeLive(Date.now(), { fiveUsed: 100 }), codexLive(Date.now()), cursorLive(Date.now())]) }, accounts });
  await waitUntil(async () => (await status()).primary.choices.find((p) => p.account === "claude-code")?.available === false);
  await herdr("fake.set_status", { pane_id: before.pane!.pane_id, status: "working" });
  await page.goto("/#/compose");
  const box = page.locator('[data-rail="new"]').getByRole("textbox", { name: "New", exact: true });
  await box.fill("Switch Firstmate to Claude Code");
  const response = page.waitForResponse((r) => r.url().endsWith("/api/new") && r.request().method() === "POST");
  await box.press("Enter");
  const receipt: NewReceipt = await (await response).json();
  expect(receipt.state).toBe("failed");
  expect(receipt.message).toContain("capacity");
  await expect(page.locator('[data-new-result]')).toContainText("Refresh usage limits");
  expect((await status()).pane?.pane_id).toBe(before.pane?.pane_id);
  await shot(page, "C7", "handoff-quota-refusal-preserves-source");
});
