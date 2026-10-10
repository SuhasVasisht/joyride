import fs from "node:fs";
import path from "node:path";
import { test, expect, type Locator } from "@playwright/test";
import { shot } from "./shot";
import { call, PORT, seedWorld, herdr, waitUntil, W } from "./map-seed";
import { buildFirstmateHome, FIXTURE_TASKS } from "./crew-fixture";

let firstmate = "";
test.beforeAll(async () => {
  await seedWorld();
  const env = JSON.parse(fs.readFileSync(`/tmp/joyride-e2e-${PORT}/env.json`, "utf8"));
  buildFirstmateHome(path.join(env.JOYRIDE_RUNTIME, "firstmate"), "csv-export");
  await waitUntil(async () => (await call("GET", `/api/firstmate/tasks/${FIXTURE_TASKS.ship}`)).status === 200);
  await herdr("fake.add_pane", { cwd: "/tmp/joyride-fixture-firstmate", agent: "claude", agent_status: "idle", name: "firstmate", title: "Firstmate", label: "firstmate" });
  firstmate = await waitUntil(async () => (await call("GET", "/api/firstmate/status")).body?.pane?.worker);
});

async function separate(a: Locator, b: Locator) {
  const first = await a.boundingBox();
  const second = await b.boundingBox();
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  if (!first || !second) throw new Error("Header controls must have visible bounds");
  expect(first.x + first.width <= second.x || second.x + second.width <= first.x || first.y + first.height <= second.y || second.y + second.height <= first.y).toBe(true);
}

for (const width of [1920, 1440, 1024]) {
  test(`sheet close control clears breadcrumbs and title at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const cases = [
      { name: "firstmate", route: `worker/${encodeURIComponent(firstmate)}` },
      { name: "worker", route: `worker/${encodeURIComponent(W.working)}` },
      { name: "task", route: `task/${FIXTURE_TASKS.ship}` },
      { name: "idea", route: "mission/csv-export" },
    ];
    for (const item of cases) {
      await page.goto("/#/map");
      if (item.name === "firstmate") {
        const node = page.getByTestId("firstmate-node");
        await expect(node.locator(".fm-title")).toHaveAttribute("href", `#/worker/${encodeURIComponent(firstmate)}`);
        await node.locator(".fm-title").click();
        await expect(page).toHaveURL(new RegExp(`#/worker/${encodeURIComponent(firstmate)}$`));
      } else await page.goto(`/#/${item.route}`);
      const sheet = page.getByRole("dialog");
      const close = sheet.getByRole("button", { name: "Close and return", exact: true });
      await expect(sheet.locator(".mp-crumbs")).toBeVisible();
      await expect(sheet.getByRole("heading", { level: 1 })).toBeVisible();
      if (item.name === "firstmate") await expect(sheet.locator(".mp-crumbs")).toHaveText("Map/Firstmate/Worker");
      await expect(close.locator("kbd")).toHaveText("Esc");
      await separate(close, sheet.locator(".mp-crumbs"));
      await separate(close, sheet.getByRole("heading", { level: 1 }));
      await separate(close.locator("kbd"), sheet.locator(".mp-crumbs"));
      await shot(page, "C12", `sheet-header-${item.name}-${width}`);
      if (item.name === "task") {
        const widen = sheet.getByRole("button", { name: "Widen", exact: true });
        await expect(widen).toHaveCSS("flex-direction", "row");
        await expect(widen).toHaveCSS("box-shadow", "none");
        await widen.click();
        await separate(close, sheet.locator(".mp-crumbs"));
        await separate(close, sheet.getByRole("heading", { level: 1 }));
      }
      if (item.name === "worker") await page.keyboard.press("Escape");
      else await close.click();
      await expect(sheet).toHaveCount(0);
    }
  });
}
