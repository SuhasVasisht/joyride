import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./devtools";
import { seedWorld, call, PORT, waitUntil } from "./map-seed";
import { buildFirstmateHome } from "./crew-fixture";
import { addAskFixtures, ASK_TASKS } from "./asks-fixture";
import { shot } from "./shot";

const env: Record<string, string> = JSON.parse(fs.readFileSync(`/tmp/joyride-e2e-${PORT}/env.json`, "utf8"));
const home = path.join(env.JOYRIDE_RUNTIME, "firstmate");
const directory = path.resolve("docs/checkpoints/jr-map-refine");

test.beforeAll(async () => {
  await seedWorld();
  buildFirstmateHome(home, "csv-export");
  addAskFixtures(home);
  await waitUntil(async () => (await call("GET", "/api/asks")).body.asks.some((a: { id: string }) => a.id === `hold:${ASK_TASKS.calls}`));
});

async function census(page: Page) {
  return page.evaluate(() => {
    const vp = document.querySelector<HTMLElement>(".map-viewport");
    if (!vp) throw new Error("No map viewport");
    const viewport = vp.getBoundingClientRect();
    const actors = [...document.querySelectorAll<HTMLElement>('.mission-node[data-mission="csv-export"], .ask-card[data-ask="hold:jr-csv-calls"], .ask-card[data-ask="hold:jr-csv-calls"] button, .ask-card[data-ask="hold:jr-csv-calls"] input')].map((el) => {
      const b = el.getBoundingClientRect();
      return { actor: `${el.tagName}.${el.className}:${el.textContent?.trim().slice(0, 40) ?? el.getAttribute("name")}`,
        x: b.x, y: b.y, w: b.width, h: b.height, worldX: el.style.getPropertyValue("--x"), worldY: el.style.getPropertyValue("--y"),
        inside: b.left >= viewport.left && b.right <= viewport.right && b.top >= viewport.top && b.bottom <= viewport.bottom,
        focused: el === document.activeElement };
    });
    return { camera: { s: vp.style.getPropertyValue("--s"), tx: vp.style.getPropertyValue("--tx"), ty: vp.style.getPropertyValue("--ty") },
      scroll: { x: vp.scrollLeft, y: vp.scrollTop }, viewport: { x: viewport.x, y: viewport.y, w: viewport.width, h: viewport.height }, actors };
  });
}

test("census the real collapse path and a measurement counterfactual", async ({ page, devtools }) => {
  test.setTimeout(180000);
  const record: unknown[] = [];
  const errors: string[] = [];
  const failures: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // Retain the measurement actors for the counterfactual; the original callbacks still run normally.
  await page.addInitScript(`window.mapMeasuredObservers = []; window.ResizeObserver = class extends ResizeObserver {
    constructor(fn) { super(fn); window.mapMeasuredObservers.push(this); }
  };`);
  for (const variant of ["near", "focus", "focus-frozen", "focus-clip"]) {
    await page.goto(variant === "near" ? "/" : "/#/map?focus=lens%3Areporting&idea=csv-export");
    await page.reload();
    const idea = page.locator('[data-mission="csv-export"]');
    await expect(idea).toBeVisible();
    if (variant === "near") {
      await idea.locator(".mn-title").focus();
      await page.getByRole("radio", { name: "Near", exact: true }).click();
    } else await expect(idea).toHaveClass(/d-full/);
    await page.waitForTimeout(1500);
    if (variant === "focus-frozen") await page.evaluate(`window.mapMeasuredObservers.forEach(observer => observer.disconnect())`);
    if (variant === "focus-clip") await page.locator(".map-viewport").evaluate((el) => { el.style.overflow = "clip"; });
    const card = idea.locator(`.ask-card[data-ask="hold:${ASK_TASKS.calls}"]`);
    const steps: unknown[] = [{ phase: "ready", data: await census(page) }];
    for (const [phase, action] of [
      ["expanded", () => card.getByRole("button", { name: "Answer", exact: true }).click({ timeout: 2000 })],
      ["radio-picked", () => card.getByRole("radio", { name: /the first row/ }).check({ timeout: 2000 })],
      ["collapsed", () => card.getByRole("button", { name: "Close", exact: true }).click({ timeout: 2000 })],
      ["reopened", () => card.getByRole("button", { name: "Answer", exact: true }).click({ timeout: 2000 })],
    ] as const) {
      let failure: string | null = null;
      try { await action(); } catch (e) { failure = e instanceof Error ? e.message : String(e); }
      if (failure) failures.push(`${variant}: ${phase}: ${failure}`);
      await page.waitForTimeout(400);
      steps.push({ phase, failure, data: await census(page) });
    }
    record.push({ variant, steps });
    await shot(page, "jr-map-refine", `diagnostic-${variant}`);
  }
  await devtools.command(page, "snapshot");
  fs.writeFileSync(path.join(directory, "collapse-census.json"), JSON.stringify({ record, errors }, null, 2));
  expect(errors).toEqual([]);
  expect(failures).toEqual([]);
});
