// Group focus, moving groups and the calmer idea card (jr-map-focus). Runs on its own sandbox port.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import { test, expect } from "./devtools";
import { buildFirstmateHome, FIXTURE_CREW_PANES } from "./crew-fixture";
import { addAskFixtures, ASK_TASKS } from "./asks-fixture";
import { call, herdr, PORT, seedWorld, waitUntil } from "./map-seed";
import { shot } from "./shot";
import { panTo } from "./chart-pan";

const env: Record<string, string> = JSON.parse(fs.readFileSync(`/tmp/joyride-e2e-${PORT}/env.json`, "utf8"));
const home = path.join(env.JOYRIDE_RUNTIME, "firstmate");
const IDEA = "csv-export";
const PHASE = process.env.MAP_FOCUS_PHASE ?? "after";
const CHECKPOINT = "jr-map-refine";
const exec = promisify(execFile);
const GROUP = "lens:reporting";
const label = (page: Page, id = GROUP) => page.locator(`.region-label[data-region="${id}"]`);
const viewOf = async (page: Page) => page.locator(".map-viewport").evaluate((el) => ({ s: el.style.getPropertyValue("--s"), tx: el.style.getPropertyValue("--tx"), ty: el.style.getPropertyValue("--ty") }));
const opacity = (page: Page, sel: string) => page.locator(sel).first().evaluate((el) => Number(getComputedStyle(el).opacity));
const hash = (page: Page) => page.evaluate(() => decodeURIComponent(location.hash));

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  expect(home.startsWith(`/tmp/joyride-e2e-${PORT}/`)).toBe(true);
  await seedWorld();
  buildFirstmateHome(home, IDEA);
  addAskFixtures(home);
  await waitUntil(async () => (await call("GET", "/api/asks")).body.asks.some((a: { id: string }) => a.id === `hold:${ASK_TASKS.calls}`));
  const st = await herdr("fake.state");
  if (!st.panes.some((p: any) => p.pane_id === FIXTURE_CREW_PANES.ship)) {
    const wt = (await call("GET", "/api/firstmate/tasks/jr-csv-export")).body.worktree;
    await herdr("fake.add_pane", { workspace_id: "w90", pane_id: FIXTURE_CREW_PANES.ship, cwd: path.join(wt, "src"), agent: "claude", agent_status: "working", title: "Review worker role contract", label: "alpha-worktrees" });
  }
});

// Later specs share this sandbox: put every group back in its usual spot.
test.afterAll(async () => {
  const placed = (await call<Record<string, unknown>>("GET", "/api/missions/map/layout")).body;
  for (const group of Object.keys(placed)) await call("POST", "/api/missions/map/layout", { group, reset: true });
});

async function zoom(page: Page, level: "Far" | "Mid" | "Near") {
  await page.getByRole("radio", { name: level }).click();
  await expect(page.locator(".map-viewport")).toHaveAttribute("data-zoom", level.toLowerCase());
}

test("the map at every zoom, for the before and after record", async ({ page }) => {
  if (PHASE === "before") {
    const directory = path.resolve("dist/ui-map-baseline");
    await page.route("**/*", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const file = path.resolve(directory, pathname === "/" ? "index.html" : `.${pathname}`);
      if (file.startsWith(directory + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) await route.fulfill({ path: file });
      else await route.continue();
    });
  }
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  const idea = page.locator(`[data-mission="${IDEA}"]`);
  await expect(idea).toBeVisible();
  await page.keyboard.press("0");
  await shot(page, CHECKPOINT, `${PHASE}-fit`);
  await idea.locator(".mn-title").focus();
  for (const level of ["Far", "Mid", "Near"] as const) {
    await zoom(page, level);
    await page.waitForTimeout(300);
    await shot(page, CHECKPOINT, `${PHASE}-${level.toLowerCase()}`);
  }
  await page.goto(`/#/map?focus=${encodeURIComponent(GROUP)}`);
  await expect(page.getByTestId("map-crumbs")).toBeVisible();
  await page.waitForTimeout(1400);
  await shot(page, CHECKPOINT, `${PHASE}-focus-group`);
  await page.goto(`/#/map?focus=${encodeURIComponent(GROUP)}&idea=${IDEA}`);
  await expect(idea).toHaveClass(/d-full/);
  await page.waitForTimeout(1400);
  await shot(page, CHECKPOINT, `${PHASE}-focus-idea`);
});

test("clicking a group opens it in place; breadcrumbs, Esc and back step out to the same camera", async ({ page }) => {
  test.skip(PHASE !== "after");
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await expect(label(page)).toBeVisible();
  await page.keyboard.press("0");
  await page.getByRole("radio", { name: "Far" }).click();
  await page.keyboard.press("0");
  await page.waitForTimeout(200);
  const start = await viewOf(page);

  // A click on the group's name opens it in place: Near detail inside, the rest of the chart steps back.
  await label(page).getByTestId("region-title").click();
  await expect.poll(() => hash(page)).toBe(`#/map?focus=${GROUP}`);
  const crumbs = page.getByTestId("map-crumbs");
  await expect(crumbs).toContainText("Map");
  await expect(crumbs).toContainText("Reporting");
  await expect(page.locator(".map-viewport")).toHaveAttribute("data-focus", GROUP);
  const idea = page.locator(`[data-mission="${IDEA}"]`);
  await expect(idea).toHaveAttribute("data-lv", "near");
  await expect(idea.locator('.mn-sec[data-bucket="needs-you"]')).toBeVisible();
  await expect.poll(() => opacity(page, '.region-label[data-region="repo:/tmp/joyride-fixture-repos/beta"]')).toBeLessThan(0.4);
  await expect.poll(() => opacity(page, `.region-label[data-region="${GROUP}"]`)).toBe(1);
  await page.waitForTimeout(1400);
  await expect(page.locator(".map-focus-bar .zc-focus")).toHaveText("Focus");
  await expect(page.getByTestId("regroup-tip")).toHaveCount(0);
  await expect(page.locator(".map-legend")).toHaveCount(0);
  for (const sel of [".map-crumbs", ".next-ask", ".zoom-controls"]) {
    const control = (await page.locator(sel).boundingBox())!;
    const canvas = (await page.locator(".map-viewport").boundingBox())!;
    expect(control.y + control.height).toBeLessThanOrEqual(canvas.y);
  }
  const canvas = (await page.locator(".map-viewport").boundingBox())!;
  for (const node of await page.locator(`.map-plane > [data-group="${GROUP}"], .region-label[data-region="${GROUP}"]`).all()) {
    const box = (await node.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(canvas.x);
    expect(box.x + box.width).toBeLessThanOrEqual(canvas.x + canvas.width);
    expect(box.y).toBeGreaterThanOrEqual(canvas.y);
    expect(box.y + box.height).toBeLessThanOrEqual(canvas.y + canvas.height);
  }
  await shot(page, CHECKPOINT, "after-focus-group");

  // A click on an idea's card opens it in full, still on the canvas.
  await idea.locator(".mn-why, .mn-k").first().click();
  await expect.poll(() => hash(page)).toBe(`#/map?focus=${GROUP}&idea=${IDEA}`);
  await expect(crumbs.locator(".mc-here")).toContainText("CSV export");
  await expect(idea).toHaveClass(/d-full/);
  await expect(idea.locator('.task-card[data-task="jr-csv-export"] .tc-who')).toContainText("claude-opus-5-5, high · claude-2");
  await page.waitForTimeout(1400);
  await expect(idea.locator(".ask-card input, .ask-card textarea")).toHaveCount(0);
  await expect(idea.locator("[data-compose]")).toHaveCount(1);
  await expect(idea.locator(".mn-idea .note-composer")).toHaveCount(0);
  await shot(page, CHECKPOINT, "after-focus-idea");

  // Esc steps out one level at a time; the whole map comes back to the camera it had.
  await page.keyboard.press("Escape");
  await expect.poll(() => hash(page)).toBe(`#/map?focus=${GROUP}`);
  await expect(idea).not.toHaveClass(/d-full/);
  await page.keyboard.press("Escape");
  await expect.poll(() => hash(page)).toBe("#/map");
  await expect(crumbs).toHaveCount(0);
  await expect(page.locator(".map-viewport")).not.toHaveAttribute("data-focus", /./);
  await expect.poll(async () => { const v = await viewOf(page); return Math.abs(Number(v.tx) - Number(start.tx)) + Math.abs(Number(v.ty) - Number(start.ty)) + Math.abs(Number(v.s) - Number(start.s)) * 1000; }).toBeLessThan(2);

  // Back and forward walk the same steps; the breadcrumb root also leads out.
  await page.goBack();
  await expect.poll(() => hash(page)).toBe(`#/map?focus=${GROUP}`);
  await expect(crumbs).toBeVisible();
  await page.goForward();
  await expect.poll(() => hash(page)).toBe("#/map");
  await expect(crumbs).toHaveCount(0);
  await page.goBack();
  await expect(crumbs).toBeVisible();
  await crumbs.getByRole("button", { name: "Map" }).click();
  await expect.poll(() => hash(page)).toBe("#/map");

  // A deep link opens the idea directly.
  await page.goto(`/#/map?focus=${encodeURIComponent(GROUP)}&idea=${IDEA}`);
  await expect(page.locator(`[data-mission="${IDEA}"]`)).toHaveClass(/d-full/);
  await expect(page.getByTestId("map-crumbs")).toContainText("CSV export");
});

test("dragging a group by its name moves it, keeps it clear of others, and Undo puts it back", async ({ page }) => {
  test.skip(PHASE !== "after");
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await expect(label(page)).toBeVisible();
  await page.getByRole("radio", { name: "Far" }).click();
  await page.keyboard.press("0");
  await page.waitForTimeout(200);
  const title = label(page).getByTestId("region-title");
  const before = (await title.boundingBox())!;
  await shot(page, CHECKPOINT, "after-move-before");
  await page.mouse.move(before.x + 20, before.y + 8);
  await page.mouse.down();
  await page.mouse.move(before.x + 40, before.y + 20, { steps: 3 });
  await page.mouse.move(before.x + 420, before.y + 260, { steps: 14 });
  await expect(label(page)).toHaveAttribute("data-lifted", "");
  await shot(page, CHECKPOINT, "after-move-carrying");
  await page.mouse.up();
  const toast = page.getByTestId("map-toast");
  await expect(toast).toContainText("Moved Reporting.");
  await expect.poll(async () => (await call("GET", "/api/missions/map/layout")).body[GROUP]).toBeTruthy();
  await expect(page.locator(".map-viewport")).not.toHaveAttribute("data-focus", /./);
  await page.waitForTimeout(600);
  // It lands where it was let go, or on the nearest free spot if another group was there.
  const after = (await title.boundingBox())!;
  expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(200);
  // No two groups overlap after the drop.
  const boxes = await page.locator(".map-svg g[data-group] .c-inner").evaluateAll((els) => els.map((e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }));
  expect(boxes.length).toBeGreaterThan(2);
  for (const [i, a] of boxes.entries()) for (const b of boxes.slice(i + 1)) {
    const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    expect(ox <= 0 || oy <= 0, `groups overlap by ${ox}x${oy}`).toBe(true);
  }
  await shot(page, CHECKPOINT, "after-move-dropped");
  // The arrangement survives a reload.
  await page.reload();
  await expect(label(page)).toBeVisible();
  await expect.poll(async () => (await call("GET", "/api/missions/map/layout")).body[GROUP]).toBeTruthy();
  await page.getByRole("radio", { name: "Far" }).click();
  await page.keyboard.press("0");
  const again = (await title.boundingBox())!;
  await page.mouse.move(again.x + 20, again.y + 8);
  await page.mouse.down();
  await page.mouse.move(again.x + 60, again.y + 60, { steps: 6 });
  await page.mouse.up();
  await expect(toast).toContainText("Moved Reporting.");
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(toast).toContainText("Move undone.");
  await expect.poll(async () => (await call("GET", "/api/missions/map/layout")).body[GROUP]).toBeTruthy();
  // Its menu puts it back in its usual spot.
  await label(page).getByRole("button", { name: "More for Reporting" }).click();
  await page.getByTestId("group-menu").getByRole("menuitem", { name: "Back to its usual spot" }).click();
  await expect(toast).toContainText("Reporting is back in its usual spot.");
  await expect.poll(async () => (await call("GET", "/api/missions/map/layout")).body[GROUP]).toBeUndefined();
});

test("an agent moves a group with the CLI; the map follows live and its toast undoes it", async ({ page }) => {
  test.skip(PHASE !== "after");
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await expect(label(page)).toBeVisible();
  await page.getByRole("radio", { name: "Far" }).click();
  await page.keyboard.press("0");
  await expect(page.locator('[data-rail="nudges"]')).toBeVisible();
  const title = label(page).getByTestId("region-title");
  const before = (await title.boundingBox())!;
  const cli = { ...process.env, ...env, JOYRIDE_URL: `http://127.0.0.1:${PORT}`, FM_TASK_ID: "jr-map-focus-e2e" };
  const moved = JSON.parse((await exec(path.resolve("bin/joyride"), ["map", "move-group", "reporting", "--x", "-1600", "--y", "2400"], { env: cli })).stdout);
  expect(moved).toMatchObject({ group: GROUP, message: "Moved Reporting.", commit: expect.stringMatching(/^[0-9a-f]{40}$/) });
  await page.keyboard.press("0");
  await expect.poll(async () => { const b = (await title.boundingBox())!; return Math.abs(b.x - before.x) + Math.abs(b.y - before.y); }).toBeGreaterThan(40);
  const toast = page.locator(`[data-toast="tidied:${moved.commit}"]`);
  await expect(toast).toContainText("Map edit by jr-map-focus-e2e");
  await shot(page, CHECKPOINT, "after-agent-moved");
  await title.click();
  await expect(page.getByTestId("map-crumbs")).toBeVisible();
  await expect(page.locator(`.map-focus-feedback [data-toast="tidied:${moved.commit}"]`)).toBeVisible();
  const feedback = (await toast.boundingBox())!;
  const canvas = (await page.locator(".map-viewport").boundingBox())!;
  expect(feedback.y + feedback.height).toBeLessThanOrEqual(canvas.y);
  await shot(page, CHECKPOINT, "after-focus-undo");
  await toast.hover();
  await toast.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(toast).toContainText("Move undone.");
  await expect.poll(async () => (await call("GET", "/api/missions/map/layout")).body[GROUP]).toBeUndefined();
  const history = (await call("GET", "/api/missions/move/history")).body;
  expect(history.find((h: { commit: string }) => h.commit === moved.commit)).toMatchObject({ actor: { id: "jr-map-focus-e2e", via: "cli" }, undone: true });
});

test("a keyboard move in focus puts focus on Undo above the canvas", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`/#/map?focus=${encodeURIComponent(GROUP)}&idea=${IDEA}`);
  const idea = page.locator(`[data-mission="${IDEA}"]`);
  await expect(idea).toHaveClass(/d-full/);
  await page.waitForTimeout(1400);
  const grip = idea.locator('[data-task="jr-csv-export"] .drag-handle').first();
  await grip.focus();
  await page.keyboard.press("Enter");
  const target = page.getByTestId("move-menu").getByRole("button", { name: "Move to Scaffold the report page" });
  await target.focus();
  await page.keyboard.press("Enter");
  const toast = page.locator(".map-focus-feedback").getByTestId("map-toast");
  await expect(toast).toContainText("Moved the task to Scaffold the report page.");
  await expect(toast.getByRole("button", { name: "Undo" })).toBeFocused();
  const feedback = (await toast.boundingBox())!;
  const canvas = (await page.locator(".map-viewport").boundingBox())!;
  expect(feedback.y + feedback.height).toBeLessThanOrEqual(canvas.y);
  await page.keyboard.press("Enter");
  await expect(toast).toContainText("Move undone.");
  await expect.poll(async () => (await call("GET", "/api/firstmate/tasks/jr-csv-export")).body.mission).toBe(IDEA);
});

test("double-click renames a group without opening focus or moving the camera", async ({ page }) => {
  await page.goto("/");
  await expect(label(page)).toBeVisible();
  await zoom(page, "Far");
  await page.keyboard.press("0");
  await page.waitForTimeout(300);
  const before = await viewOf(page);
  await label(page).getByTestId("region-title").dblclick({ delay: 200 });
  await expect(label(page).getByRole("textbox", { name: "New name for Reporting" })).toBeVisible();
  await page.waitForTimeout(500);
  expect(await hash(page)).not.toContain("focus=");
  expect(await viewOf(page)).toEqual(before);
  await page.keyboard.press("Escape");
  await expect(label(page).getByRole("textbox")).toHaveCount(0);
});

test("asks read as one line, expand in place, retain choices on collapse and clear counts when answered", async ({ page, devtools }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`/#/map?focus=${encodeURIComponent(GROUP)}&idea=${IDEA}`);
  const idea = page.locator(`[data-mission="${IDEA}"]`);
  const card = idea.locator(`.ask-card[data-ask="hold:${ASK_TASKS.calls}"]`);
  await expect(idea).toHaveClass(/d-full/);
  await page.waitForTimeout(1400);
  await expect(card.locator(".ak-summary")).toHaveAttribute("title", /Where the totals row goes → the last row.*Which file format → CSV and XLSX/);
  await expect(card.getByRole("radio")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Answer", exact: true })).toHaveAttribute("aria-expanded", "false");
  const count = Number(await page.getByTestId("next-ask").locator(".na-n").textContent());
  await card.getByRole("button", { name: "Answer", exact: true }).click();
  await expect(card.getByRole("radio", { name: /the last row/ })).toBeChecked();
  await expect(card.getByRole("radio", { name: /CSV and XLSX/ })).toBeChecked();
  await card.getByRole("radio", { name: /the first row/ }).check();
  await card.getByRole("button", { name: "Close", exact: true }).click();
  await expect(card.getByRole("radio")).toHaveCount(0);
  await card.getByRole("button", { name: "Answer", exact: true }).click();
  await expect(card.getByRole("radio", { name: /the first row/ })).toBeChecked();
  await card.getByRole("button", { name: "Add your own words" }).click();
  await card.getByRole("textbox", { name: "Your answer" }).fill("Keep the exported values exact.");
  await shot(page, CHECKPOINT, "after-answer-expanded");
  await devtools.command(page, "snapshot");
  await card.getByRole("button", { name: "Send these choices" }).click();
  await expect(card).toHaveCount(0, { timeout: 10000 });
  expect(fs.readFileSync(path.join(home, "data", "backlog.md"), "utf8")).toContain("1 B (the first row); 2 B (CSV and XLSX). Keep the exported values exact.");
  await expect(page.getByTestId("next-ask").locator(".na-n")).toHaveText(String(count - 1));
  await expect(page.locator('[data-count="needs-you"]')).toHaveAttribute("data-n", String(count - 1));
  await shot(page, CHECKPOINT, "after-answered");
});

test("a tall group opens with every idea framed at readable size", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const ids = Array.from({ length: 8 }, (_, i) => `jr-map-refine-${i}`);
  for (const [i, id] of ids.entries()) {
    const created = await call("POST", "/api/missions", { id, title: `Report chapter ${i + 1}`, goal: "Read the whole reporting plan together.", repos: [], sessions: [], done_when: [] });
    expect(created.status).toBe(201);
  }
  expect((await call("POST", "/api/lenses", { id: "jr-map-refine-tall", title: "Reporting plan", missions: ids })).status).toBe(200);
  try {
    await page.goto("/#/map?focus=lens%3Ajr-map-refine-tall");
    const nodes = page.locator('.map-plane > [data-group="lens:jr-map-refine-tall"]');
    await expect(nodes).toHaveCount(8);
    await page.waitForTimeout(1400);
    const canvas = (await page.locator(".map-viewport").boundingBox())!;
    const columns = new Set<number>();
    for (const node of await nodes.all()) {
      const box = (await node.boundingBox())!;
      columns.add(Math.round(box.x));
      expect(box.width).toBeGreaterThanOrEqual(240);
      expect(box.x).toBeGreaterThanOrEqual(canvas.x);
      expect(box.y).toBeGreaterThanOrEqual(canvas.y);
      expect(box.x + box.width).toBeLessThanOrEqual(canvas.x + canvas.width);
      expect(box.y + box.height).toBeLessThanOrEqual(canvas.y + canvas.height);
    }
    expect(columns.size).toBeGreaterThan(1);
    await shot(page, CHECKPOINT, "after-focus-tall-group");
  } finally {
    for (const id of ids) await call("PUT", `/api/missions/${id}`, { archive: true });
    await call("POST", "/api/lenses/delete", { lens: "jr-map-refine-tall" });
  }
});
