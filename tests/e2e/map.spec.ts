import { test, expect } from "@playwright/test";
import { shot } from "./shot";
import { herdr, raise, seedWorld } from "./map-seed";

let docsPane = "";

test.beforeAll(async () => {
  await seedWorld();
  // One live worker outside any mission, so the unfiled gamma region has a vessel.
  docsPane = (await herdr("fake.add_pane", { cwd: "/tmp/joyride-fixture-repos/gamma", agent: "claude", agent_status: "working", title: "Docs pass", label: "gamma" })).pane.pane_id;
  await raise({ level: "L2", kind: "review", title: "Ready to review: scaffold", why: "The report page renders with an empty state; evidence attached.", mission: "report-scaffold" });
});

test.afterAll(async () => {
  if (docsPane) await herdr("fake.close_pane", { pane_id: docsPane });
});

test("map charts missions by lens and repo, with live workers", async ({ page }) => {
  await page.goto("/#/map");
  const vp = page.locator(".map-viewport");
  await expect(page.locator('[data-mission="csv-export"]')).toBeVisible();
  await expect(page.locator(".region-label .rl-title", { hasText: "Reporting" })).toBeVisible();
  await expect(page.locator(".region-label.k-repo .rl-title", { hasText: "beta" })).toBeVisible();
  await expect(page.locator(".region-label.k-unfiled", { hasText: "gamma" }).locator(".rl-kicker")).toHaveText("Unfiled");
  await expect(page.locator('[data-worker]', { hasText: "Docs pass" })).toBeVisible();
  // The blocked worker makes its mission blocked, with a signal attention count.
  await expect(page.locator('[data-mission="csv-export"] .health-mark.h-blocked')).toBeVisible();
  await expect(page.locator('[data-mission="csv-export"] .mn-count.signal')).toBeVisible();
  // Archive is hidden by default.
  await expect(page.locator('[data-mission="archive-gamma"]')).toHaveCount(0);
  await expect(page.locator('[data-metric="open-l3l4"]')).toContainText("on you");
});

test("semantic zoom: far shows titles, mid adds vessels and progress, near adds actions", async ({ page }) => {
  await page.goto("/#/map");
  const vp = page.locator(".map-viewport");
  const csv = page.locator('[data-mission="csv-export"]');
  await expect(csv).toBeVisible();
  await csv.locator(".mn-title").focus(); // presets centre the last focused mission

  await page.getByRole("radio", { name: "Far" }).click();
  await expect(vp).toHaveAttribute("data-zoom", "far");
  await expect(csv.locator(".mn-title")).toBeVisible();
  await expect(csv.locator(".fleet")).toHaveCount(0);
  await expect(csv.locator(".progress")).toHaveCount(0);
  await shot(page, "C2", "map-far");

  await page.getByRole("radio", { name: "Mid" }).click();
  await expect(vp).toHaveAttribute("data-zoom", "mid");
  // Mid sorts the idea's work by what it asks of the captain: the blocked worker is stuck, the other moving.
  await expect(csv.locator('.mn-sec[data-bucket="stuck"] .wl .v-blocked')).toBeVisible();
  await expect(csv.locator('.mn-sec[data-bucket="stuck"] > .mn-k')).toContainText("Stuck");
  await expect(csv.locator(".progress")).toContainText("3 criteria");
  await expect(csv.locator(".wl-action")).toHaveCount(0);
  await shot(page, "C2", "map-mid");

  await page.getByRole("radio", { name: "Near" }).click();
  await expect(vp).toHaveAttribute("data-zoom", "near");
  // Near adds each live worker's action; idle ones fold into a count.
  await expect(csv.locator(".wl.s-blocked .wl-action")).toContainText("Waiting at a prompt");
  await shot(page, "C2", "map-near");

  // Keyboard: - zooms out, + zooms in, 0 fits.
  await vp.focus();
  const scale = async () => Number(await vp.getAttribute("data-scale"));
  const before = await scale();
  await page.keyboard.press("-");
  expect(await scale()).toBeLessThan(before);
  await page.keyboard.press("+");
  await page.keyboard.press("+");
  expect(await scale()).toBeGreaterThan(before);
  // Scrolling pans and leaves the zoom alone; a pinch (ctrl+wheel) or cmd+wheel zooms around the cursor.
  const box = (await vp.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // Continuous zoom commits its layout after input settles; measure pan from that committed view.
  await expect.poll(() => page.locator(".map-layer").evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a)).toBeCloseTo(1, 3);
  const s1 = await scale();
  const ty = async () => Number(await vp.evaluate((el) => (el as HTMLElement).style.getPropertyValue("--ty")));
  const tx0 = async () => Number(await vp.evaluate((el) => (el as HTMLElement).style.getPropertyValue("--tx")));
  type Wheel = { deltaX?: number; deltaY?: number; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean };
  const wheel = (init: Wheel) => vp.evaluate((el, init) => {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new WheelEvent("wheel", { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true, ...init }));
  }, init);
  const y0 = await ty();
  await wheel({ deltaY: 120 });
  await expect.poll(ty).toBeCloseTo(y0 - 120, 0);
  expect(await scale()).toBe(s1);
  const x0 = await tx0();
  await wheel({ deltaX: 80 });
  await expect.poll(tx0).toBeCloseTo(x0 - 80, 0);
  await wheel({ deltaY: 60, shiftKey: true });
  await expect.poll(tx0).toBeCloseTo(x0 - 140, 0);
  expect(await scale()).toBe(s1);
  await wheel({ deltaY: 40, ctrlKey: true });
  await expect.poll(scale).toBeLessThan(s1);
  const s2 = await scale();
  await wheel({ deltaY: -120, metaKey: true });
  await expect.poll(scale).toBeGreaterThan(s2);
  // Drag pans without opening anything.
  await page.keyboard.press("0");
  const tx = async () => Number(await vp.evaluate((el) => (el as HTMLElement).style.getPropertyValue("--tx")));
  const t0 = await tx();
  await page.mouse.move(box.x + 30, box.y + box.height - 120);
  await page.mouse.down();
  await page.mouse.move(box.x + 230, box.y + box.height - 100, { steps: 6 });
  await page.mouse.up();
  expect(await tx()).toBeGreaterThan(t0 + 150);
  await expect(page).toHaveURL(/#\/map$/);
});

test("archive toggle reveals archived missions", async ({ page }) => {
  await page.goto("/#/map");
  await expect(page.locator('[data-mission="csv-export"]')).toBeVisible();
  await page.getByLabel(/Show archive/).check();
  await expect(page.locator('[data-mission="archive-gamma"]')).toBeVisible();
  await page.getByLabel(/Show archive/).uncheck();
  await expect(page.locator('[data-mission="archive-gamma"]')).toHaveCount(0);
});

test("clicking a mission opens its pane over the map; Esc returns", async ({ page }) => {
  await page.goto("/#/map");
  await page.locator('[data-mission="idempotent-sync"] .mn-title').click();
  await expect(page).toHaveURL(/#\/mission\/idempotent-sync/);
  const sheet = page.getByRole("dialog", { name: /Idea/ });
  await expect(sheet.getByRole("heading", { level: 1 })).toHaveText("Make the nightly sync idempotent");
  await expect(page.locator('[data-mission="idempotent-sync"]')).toHaveClass(/selected/);
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/#\/map$/);
  await expect(sheet).toHaveCount(0);
});

test("the chart holds up from 1280 to 1920 wide", async ({ page }) => {
  for (const [w, h] of [[1280, 800], [1920, 1080]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto("/#/map");
    await expect(page.locator('[data-mission="csv-export"]')).toBeVisible();
    await page.keyboard.press("0");
    // Every mission title is inside the viewport after fitting.
    await expect(async () => {
      const vp = (await page.locator(".map-viewport").boundingBox())!;
      for (const id of ["csv-export", "report-scaffold", "idempotent-sync", "oauth-login"]) {
        const b = (await page.locator(`[data-mission="${id}"] .mn-title`).boundingBox())!;
        expect(b.x).toBeGreaterThanOrEqual(vp.x);
        expect(b.x + b.width).toBeLessThanOrEqual(vp.x + vp.width + 1);
        expect(b.y + b.height).toBeLessThanOrEqual(vp.y + vp.height + 1);
      }
    }).toPass({ timeout: 5000 });
    await shot(page, "C2", `map-${w}`);
  }
});
