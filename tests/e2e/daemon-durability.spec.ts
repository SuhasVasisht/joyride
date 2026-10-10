import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { test, expect } from "@playwright/test";
import { buildSandbox } from "../sandbox";
import { startFakeHerdr, waitFor, type FakeHerdr } from "../fixtures/fake-herdr";
import { shot } from "./shot";

const port = Number(process.env.E2E_DURABILITY_PORT ?? 4328);
if (!Number.isInteger(port) || port < 4320 || port > 4329) throw new Error("Daemon durability requires an assigned preview port from 4320 through 4329.");
const url = `http://127.0.0.1:${port}`;
let sb: ReturnType<typeof buildSandbox>;
let fake: FakeHerdr;
const cli = (command: string): Promise<string> => new Promise((resolve, reject) => {
  execFile(process.execPath, ["--import", "tsx", "src/cli/joyride.ts", command], { env: { ...process.env, ...sb.env }, timeout: 20000 }, (e, out, err) => e ? reject(new Error(`${command}: ${out} ${err}`)) : resolve(out));
});
async function health() { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(500) })).json(); }

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  sb = buildSandbox(path.resolve(".joyride/durability-e2e"), { port, knowledgePipeline: "off" });
  fake = await startFakeHerdr(sb.env.JOYRIDE_HERDR_SOCKET, { scenario: "default" });
  await cli("up");
  await waitFor(async () => (await (await fetch(url + "/api/workers")).json()).length >= 3);
});
test.afterAll(async () => {
  if (sb) await cli("down");
  await fake?.stop();
});

test("health includes loop lag and background refresh ages; Agents and fleet remain visible", async ({ page }) => {
  const h = await health();
  expect(h.ok).toBe(true);
  expect(h.root).toBe(sb.env.JOYRIDE_HOME);
  expect(h.event_loop.p99_ms).toBeGreaterThanOrEqual(0);
  expect(h.refreshers["herdr local"].age_ms).toBeGreaterThanOrEqual(0);
  await page.goto(url + "/#/agents");
  await expect(page.getByTestId("agents-page")).toBeVisible();
  await expect(page.locator('[data-agent="w:local:w1:p1"]')).toBeVisible();
  const fleet = await (await fetch(url + "/api/fleet")).json();
  expect(fleet.members.length).toBeGreaterThanOrEqual(3);
  await shot(page, "C3", "durable-agents-live");
});

test("an open Agents page preserves its rows and quietly reconnects after the daemon returns", async ({ page }) => {
  await page.goto(url + "/#/agents");
  const row = page.locator('[data-agent="w:local:w1:p1"]');
  await expect(row).toBeVisible();
  await expect(page.locator(".conn")).toHaveText("Live");
  const pid = (await health()).pid;
  await cli("down");
  await expect(page.locator(".conn")).toHaveText("Reconnecting…");
  await expect(row).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: /Agents can't load|fetch|HTTP 503/ })).toHaveCount(0);
  await shot(page, "C3", "durable-agents-reconnecting");
  await cli("up");
  await expect(page.locator(".conn")).toHaveText("Live", { timeout: 10000 });
  await expect(row).toBeVisible();
  expect((await health()).pid).not.toBe(pid);
  await shot(page, "C3", "durable-agents-recovered");
});

test("CLI restart recovers health within two seconds without a blank Agents page", async ({ page }) => {
  await page.goto(url + "/#/agents");
  const row = page.locator('[data-agent="w:local:w1:p1"]');
  await expect(row).toBeVisible();
  const oldPid = (await health()).pid;
  let sampling = true;
  let firstFailure: number | null = null;
  let recovered: number | null = null;
  const sample = (async () => {
    while (sampling) {
      try {
        const h = await health();
        if (h.pid !== oldPid) { recovered = Date.now(); break; }
      } catch { firstFailure ??= Date.now(); }
      await new Promise((r) => setTimeout(r, 20));
    }
  })();
  try { await cli("restart"); await sample; }
  finally { sampling = false; }
  expect(recovered).not.toBeNull();
  const downtime = (recovered ?? 0) - (firstFailure ?? recovered ?? 0);
  console.log(`private restart downtime: ${downtime} ms`);
  expect(downtime).toBeLessThan(2000);
  await expect(row).toBeVisible();
  await expect(page.locator(".conn")).toHaveText("Live");
  await shot(page, "C3", "durable-agents-restarted");
  const info = JSON.parse(fs.readFileSync(path.join(sb.env.JOYRIDE_RUNTIME, "daemon.json"), "utf8"));
  expect(info.port).toBe(port);
});
