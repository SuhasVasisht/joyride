import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { test, expect } from "./devtools";
import { buildFirstmateHome } from "./crew-fixture";
import { call, PORT, seedWorld } from "./map-seed";
import { newInput } from "./new-box";

const env = z.object({ FM_HOME: z.string() }).parse(JSON.parse(fs.readFileSync(`/tmp/joyride-e2e-${PORT}/env.json`, "utf8")));
const directory = path.resolve("docs/checkpoints/new-standalone");

test.beforeAll(async () => {
  await seedWorld();
  buildFirstmateHome(env.FM_HOME, "csv-export");
  await expect.poll(async () => (await call<{ asks: { id: string }[] }>("GET", "/api/asks")).body.asks.length).toBeGreaterThan(0);
  fs.mkdirSync(directory, { recursive: true });
});

test("N keeps New focused with open map asks, through reload and while typing", async ({ page, devtools }) => {
  await devtools.command(page, "open", `http://127.0.0.1:${PORT}/#/map`);
  const viewport = page.locator(".map-viewport");
  const nextAsk = page.getByTestId("next-ask");
  for (const from of ["map", "body"] as const) {
    if (from === "body") await devtools.command(page, "press", "Meta+Shift+R");
    await expect(viewport).toBeVisible();
    await expect(nextAsk).toBeVisible();
    await devtools.run(page, 'await page.eval(() => [...document.querySelectorAll(".zoom-controls [role=radio]")].find(el => el.textContent === "Far").click());');
    await expect(viewport).toHaveAttribute("data-zoom", "far");
    await devtools.run(page, from === "map"
      ? 'await page.eval(() => document.querySelector(".map-viewport").focus());'
      : 'await page.eval(() => document.activeElement.blur());');
    await devtools.command(page, "press", "n");
    await devtools.command(page, "screenshot", path.join(directory, `shortcut-${from}.png`));
    await expect(newInput(page)).toBeFocused();
    await expect(viewport).toHaveAttribute("data-zoom", "far");
  }
  await devtools.command(page, "press", "n");
  await expect(newInput(page)).toHaveValue("n");
  await expect(viewport).toHaveAttribute("data-zoom", "far");
  await devtools.command(page, "press", "Backspace");
  await expect(newInput(page)).toHaveValue("");
  const opensAttention = (await nextAsk.getAttribute("class"))?.includes("needs-you");
  await devtools.run(page, 'await page.click("[data-testid=next-ask]");');
  if (opensAttention) await expect(page.locator('[data-rail="attention"]')).toBeFocused();
  else {
    await expect(viewport).toHaveAttribute("data-zoom", "near");
    await expect(page.locator('.map-plane [data-ask] :focus')).toHaveCount(1);
  }
  await devtools.command(page, "screenshot", path.join(directory, "shortcut-ask-control.png"));
});
