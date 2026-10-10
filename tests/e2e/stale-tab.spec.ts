// An open tab notices a new UI build: it reloads itself when idle, and offers a quiet reload control
// when the captain is typing, without losing the draft. The build changes by rewriting the sandbox's
// built index.html, as `npm run build` does; the daemon is never restarted.
import fs from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { shot } from "./shot";
import { newInput } from "./new-box";

const base = `http://127.0.0.1:${process.env.E2E_PORT ?? 4399}`;
const index = path.resolve(process.env.E2E_UI_DIR ?? "dist/ui", "index.html");
let original = "";

const served = async () => (await (await fetch(base + "/api/health")).json()).build as string;
const own = (page: Page) => page.locator('meta[name="joyride-build"]').getAttribute("content");
/** Rebuild: a new index.html means a new build id. */
async function rebuild(n: number) {
  const before = await served();
  fs.writeFileSync(index, original.replace("</html>", `<!-- e2e rebuild ${n} -->\n</html>`));
  await expect.poll(served).not.toBe(before);
  return await served();
}
const mark = (page: Page) => page.evaluate(() => { (window as any).__sameDocument = true; });
const sameDocument = (page: Page) => page.evaluate(() => (window as any).__sameDocument === true);
/** What a tab does on focus coming back; the watcher also checks on reconnect and every minute. */
const nudge = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event("focus")));

test.describe.configure({ mode: "serial" });
test.beforeAll(() => { original = fs.readFileSync(index, "utf8"); });
test.afterAll(() => { fs.writeFileSync(index, original); });

test("an idle tab reloads itself onto the new build, once", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".conn.on")).toBeVisible();
  expect(await own(page)).toBe(await served());
  await mark(page);

  const next = await rebuild(1);
  await nudge(page);
  await expect.poll(() => own(page).catch(() => null)).toBe(next);
  expect(await sameDocument(page)).toBe(false);

  // Landed on the build it reloaded for: further checks leave it alone.
  await expect(page.locator(".conn.on")).toBeVisible();
  await mark(page);
  await nudge(page);
  await page.waitForTimeout(1500);
  expect(await sameDocument(page)).toBe(true);
  await expect(page.locator(".build-update")).toHaveCount(0);
});

test("a tab with a draft being typed offers the reload control and keeps the draft", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".conn.on")).toBeVisible();
  const box = newInput(page);
  await box.click();
  const draft = "Add a totals row to the CSV export";
  await box.pressSequentially(draft);
  await mark(page);

  const next = await rebuild(2);
  await nudge(page);
  const control = page.getByRole("button", { name: /Joyride updated/ });
  await expect(control).toBeVisible();
  await page.waitForTimeout(1000);
  expect(await sameDocument(page)).toBe(true);
  await expect(box).toHaveValue(draft);
  await shot(page, "stale-tab", "reload-control");
  await page.locator(".topbar").screenshot({ path: path.resolve("docs/checkpoints/stale-tab/reload-control-topbar.png") });

  // The captain cancels New: the control stays theirs to click, never an automatic reload.
  await box.fill("");
  await expect(box).toHaveValue("");
  await nudge(page);
  await page.waitForTimeout(1000);
  expect(await sameDocument(page)).toBe(true);
  await expect(control).toBeVisible();

  await control.click();
  await expect.poll(() => own(page).catch(() => null)).toBe(next);
  expect(await sameDocument(page)).toBe(false);
  await expect(page.locator(".conn.on")).toBeVisible();
  await expect(page.locator(".build-update")).toHaveCount(0);
});
