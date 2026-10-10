// Regrouping on the map, from the captain's side: the tip and the grips that say what can be moved, every
// drag (a task to another idea, from a row or from anywhere on its card, a session onto an idea and back to
// Unfiled, an idea onto a group) with the target naming the move before the drop, Undo after each, and the
// Move to menu on every grip as the keyboard path to the same moves. Sandbox daemon, fixture FM_HOME, fake Herdr.
import fs from "node:fs";
import path from "node:path";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { shot } from "./shot";
import { panTo } from "./chart-pan";
import { buildFirstmateHome, FIXTURE_CREW_PANES, FIXTURE_TASKS as T } from "./crew-fixture";
import { call, herdr, openIdea, PORT, seedWorld, waitUntil } from "./map-seed";

const env = JSON.parse(fs.readFileSync(`/tmp/joyride-e2e-${PORT}/env.json`, "utf8")) as Record<string, string>;
const CP = "jr-map-dnd";
const DRILL = "Regroup drill";
const IDEA = "csv-export", OTHER = "report-scaffold", OTHER_TITLE = "Scaffold the report page", LOOSE = "oauth-login";
let drill: string | null = null;
let key = "";

test.describe.configure({ mode: "serial" });

const missionOf = async (task: string) => (await call("GET", `/api/firstmate/tasks/${task}`)).body.mission as string | null;
const sessionsOf = async (id: string) => ((await call("GET", `/api/missions/${id}`)).body.sessions as any[]).map((r) => `${r.source}:${r.id}`);
const lensesOf = async (id: string) => (await call("GET", `/api/missions/${id}`)).body.lenses as string[];

/** Open the map and wait for its first data: the map fits itself once when data arrives, which would undo an earlier zoom. */
async function openMap(page: Page) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await expect(page.locator(`[data-mission="${IDEA}"]`)).toBeVisible();
}

async function zoom(page: Page, level: "Far" | "Mid" | "Near") {
  await page.getByRole("radio", { name: level }).click();
  await expect(page.locator(".map-viewport")).toHaveAttribute("data-zoom", level.toLowerCase());
}

/** Press on `from`, carry it in small steps (so the map sees a drag, not a click) to `to`, and hold it there. */
async function carryTo(page: Page, from: Locator, to: Locator) {
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  const ax = a.x + Math.min(a.width / 2, 40), ay = a.y + Math.min(a.height / 2, 10);
  await page.mouse.move(ax, ay);
  await page.mouse.down();
  await page.mouse.move(ax + 12, ay + 8, { steps: 3 });
  await page.mouse.move(b.x + Math.min(b.width / 2, 120), b.y + Math.min(b.height / 2, 32), { steps: 14 });
}

/** Walk the open Move to menu with the arrow keys to the option named `name`, then press Enter. */
async function pickWithKeys(page: Page, name: string) {
  const menu = page.getByTestId("move-menu");
  await expect(menu.getByRole("button", { name })).toBeVisible();
  for (let i = 0; i < 30; i++) {
    if (await menu.getByRole("button", { name }).evaluate((el) => el === document.activeElement)) break;
    await page.keyboard.press("ArrowDown");
  }
  await expect(menu.getByRole("button", { name })).toBeFocused();
  await page.keyboard.press("Enter");
}

test.beforeAll(async () => {
  await seedWorld();
  buildFirstmateHome(path.join(env.JOYRIDE_RUNTIME, "firstmate"), IDEA);
  await waitUntil(async () => (await call("GET", "/api/firstmate/tasks")).body.length === 4);
  const wt = (await call("GET", `/api/firstmate/tasks/${T.ship}`)).body.worktree;
  const st = await herdr("fake.state");
  if (!st.panes.some((p: any) => p.pane_id === FIXTURE_CREW_PANES.ship)) {
    await herdr("fake.add_pane", { workspace_id: "w90", pane_id: FIXTURE_CREW_PANES.ship, cwd: path.join(wt, "src"), agent: "claude", agent_status: "working", title: "CSV crewmate", label: "alpha-worktrees" });
  }
  await waitUntil(async () => (await call("GET", `/api/firstmate/tasks/${T.ship}`)).body.workers.length === 1);
  // A live worker on a session outside every idea: it sits unfiled under gamma, ready to be sorted.
  const live = new Set((await call<any[]>("GET", "/api/workers")).body.map((w) => w.session));
  const free = (await call<any[]>("GET", "/api/sessions?mission=none&limit=200")).body.find((s) => s.source === "claude" && !s.cwd.includes(".joyride") && !live.has(s.key));
  expect(free, "a fixture session outside every idea").toBeTruthy();
  key = free.key;
  drill = (await herdr("fake.add_pane", {
    cwd: "/tmp/joyride-fixture-repos/gamma", agent: "claude", agent_status: "working", title: DRILL, label: "gamma",
    agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: free.id },
  })).pane.pane_id;
  await waitUntil(async () => (await call<any[]>("GET", "/api/workers")).body.some((w) => w.session === key));
});

test.afterAll(async () => {
  // Leave everything where the spec found it, for later specs in the run.
  if (drill) await herdr("fake.close_pane", { pane_id: drill }).catch(() => {});
  await herdr("fake.close_pane", { pane_id: FIXTURE_CREW_PANES.ship }).catch(() => {});
  if (key) await call("POST", "/api/missions/move", { session: key, to: { mission: null } }).catch(() => {});
  if ((await missionOf(T.ship).catch(() => IDEA)) !== IDEA) await call("POST", "/api/missions/move", { task: T.ship, to: { mission: IDEA } }).catch(() => {});
});

test("the map says what can be moved: a tip, a legend entry, and a grip on each movable card", async ({ page }) => {
  await openMap(page);
  const tip = page.getByTestId("regroup-tip");
  await expect(tip).toContainText("Regroup by dragging");
  await expect(page.locator(".map-legend")).toContainText("Drag to regroup");
  const idea = page.locator(`[data-mission="${IDEA}"]`);
  await idea.locator(".mn-title").focus();
  await zoom(page, "Mid");
  // Grips stay out of the way until the pointer is on the card.
  const row = idea.locator(`.task-row[data-task="${T.ship}"]`);
  const grip = row.locator(".drag-handle");
  await expect(grip).toHaveAttribute("aria-label", "Move Add a CSV export button with totals to…");
  await expect(grip).toHaveCSS("opacity", "0");
  await panTo(row);
  // The chart may still re-lay out under the pointer once the camera settles: hover until the grip holds.
  await expect(async () => {
    await row.hover();
    await expect(grip).toHaveCSS("opacity", "1", { timeout: 1000 });
  }).toPass({ timeout: 10000 });
  await expect(idea.locator(":scope > .mn-head > .drag-handle")).toHaveCSS("opacity", "1");
  await expect(row).toHaveCSS("cursor", "grab");
  await shot(page, CP, "affordance-grips-mid");
  await page.keyboard.press("0");
  const worker = page.locator(`[data-worker][data-drag="s:${key}"]`);
  await worker.locator(".wn-title").hover();
  await expect(worker.locator(".drag-handle")).toHaveCSS("opacity", "1");
  await tip.getByRole("button", { name: "Got it" }).click();
  await expect(tip).toHaveCount(0);
  await page.reload();
  await expect(page.locator(`[data-mission="${IDEA}"]`)).toBeVisible();
  await expect(page.getByTestId("regroup-tip")).toHaveCount(0);
});

test("drag a task row onto another idea: the target names the move, and Undo puts it back", async ({ page }) => {
  await openMap(page);
  const idea = page.locator(`[data-mission="${IDEA}"]`), other = page.locator(`[data-mission="${OTHER}"]`);
  await idea.locator(".mn-title").focus();
  await zoom(page, "Mid");
  await expect(other).toBeVisible();
  await shot(page, CP, "task-row-before");
  await carryTo(page, idea.locator(`.task-row[data-task="${T.ship}"] .tr-head`), other.locator(".mn-head"));
  await expect(page.locator(".carry-ghost .cg-kind")).toHaveText("Task");
  await expect(other).toHaveClass(/drop-hover/);
  await expect(other).toHaveAttribute("data-drop-label", `Move to ${OTHER_TITLE}`);
  await expect(page.locator(".carry-ghost .cg-target")).toHaveText(`Move to ${OTHER_TITLE}`);
  // Ideas that can't take it step back; the source idea is one of them.
  await expect(idea).toHaveCSS("opacity", "0.5");
  await shot(page, CP, "task-row-carrying");
  await page.mouse.up();
  const toast = page.getByTestId("map-toast");
  await expect(toast).toContainText(`Moved the task to ${OTHER_TITLE}.`);
  await waitUntil(async () => (await missionOf(T.ship)) === OTHER);
  await expect(other.locator(`[data-task="${T.ship}"]`)).toHaveCount(1);
  await shot(page, CP, "task-row-after");
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByTestId("map-toast")).toContainText("Move undone.");
  await waitUntil(async () => (await missionOf(T.ship)) === IDEA);
  await expect(idea.locator(`[data-task="${T.ship}"]`)).toHaveCount(1);
  await shot(page, CP, "task-row-undone");
});

test("on an open idea, pressing anywhere on a task card (even its crewmate line) carries the task, not its idea", async ({ page }) => {
  await openMap(page);
  const idea = page.locator(`[data-mission="${IDEA}"]`);
  await idea.locator(".mn-title").focus();
  await zoom(page, "Near");
  // Crew lines show on an idea opened in full.
  await openIdea(page, IDEA);
  const card = idea.locator(`.task-card[data-task="${T.ship}"]`);
  await expect(card).toBeVisible();
  // However much earlier specs charted, bring the card on screen (the chart turns the scroll into a pan).
  await card.locator(".tc-now").evaluate((el) => el.scrollIntoView({ block: "center" }));
  await expect(card.locator(".tc-now")).toBeInViewport();
  await card.hover();
  await expect(card.locator(".tc-head .drag-handle")).toHaveCSS("opacity", "1");
  const crew = card.locator(".tc-crew .wl").first();
  await expect(crew).toBeVisible();
  await expect(crew).not.toHaveAttribute("data-drag", /.*/);
  for (const from of [card.locator(".tc-now"), crew]) {
    await carryTo(page, from, card.locator(".tc-head"));
    await expect(page.locator(".carry-ghost .cg-kind")).toHaveText("Task");
    await expect(page.locator(".carry-ghost .cg-label")).toHaveText("Add a CSV export button with totals");
    await expect(card).toHaveClass(/carried/);
    await expect(idea).not.toHaveClass(/carried/);
    // Over its own idea there is nowhere to drop: the ghost says so.
    await expect(page.locator(".carry-ghost .cg-none")).toContainText("Let go to cancel");
    await shot(page, CP, "task-card-carrying-near");
    await page.keyboard.press("Escape");
    await expect(page.locator(".carry-ghost")).toHaveCount(0);
    await page.mouse.up();
  }
  expect(await missionOf(T.ship)).toBe(IDEA);
});

test("drag a session onto an idea and back out to Unfiled, with Undo", async ({ page }) => {
  await openMap(page);
  await zoom(page, "Mid");
  await page.keyboard.press("0");
  const worker = page.locator(`[data-worker][data-drag="s:${key}"]`), other = page.locator(`[data-mission="${OTHER}"]`);
  await expect(worker).toBeVisible();
  await shot(page, CP, "session-before");
  await carryTo(page, worker, other);
  await expect(page.locator(".carry-ghost .cg-kind")).toHaveText("Session");
  await expect(other).toHaveAttribute("data-drop-label", `Move to ${OTHER_TITLE}`);
  await shot(page, CP, "session-carrying");
  await page.mouse.up();
  const toast = page.getByTestId("map-toast");
  await expect(toast).toContainText(`Moved the session to ${OTHER_TITLE}.`);
  await waitUntil(async () => (await sessionsOf(OTHER)).includes(key));
  await expect(worker).toHaveCount(0);
  await shot(page, CP, "session-after");
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByTestId("map-toast")).toContainText("Move undone.");
  await waitUntil(async () => !(await sessionsOf(OTHER)).includes(key));
  await expect(page.locator(`[data-worker][data-drag="s:${key}"]`)).toBeVisible();
  await shot(page, CP, "session-undone");
});

test("drag an idea onto a group: the group names the move, and Undo takes it back out", async ({ page }) => {
  await openMap(page);
  await zoom(page, "Mid");
  await page.keyboard.press("0");
  const other = page.locator(`[data-mission="${LOOSE}"]`);
  const label = page.locator('.region-label[data-region="lens:reporting"]');
  await expect(label).toBeVisible();
  await shot(page, CP, "idea-before");
  await carryTo(page, other.locator(".mn-head .health-mark"), page.locator(`[data-mission="report-scaffold"]`));
  await expect(page.locator(".carry-ghost .cg-kind")).toHaveText("Idea");
  await expect(page.locator(".carry-ghost .cg-target")).toHaveText("Move to Reporting");
  await expect(label).toHaveAttribute("data-drop-label", "Move to Reporting");
  await shot(page, CP, "idea-carrying");
  await page.mouse.up();
  const toast = page.getByTestId("map-toast");
  await expect(toast).toContainText("Moved OAuth login flow to Reporting.");
  await waitUntil(async () => (await lensesOf(LOOSE)).includes("reporting"));
  await expect(page.locator(`.contour`).first()).toBeAttached();
  await shot(page, CP, "idea-after");
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByTestId("map-toast")).toContainText("Move undone.");
  await waitUntil(async () => !(await lensesOf(LOOSE)).includes("reporting"));
  await shot(page, CP, "idea-undone");
});

test("holding a carried card at the chart's edge keeps the chart drifting, so far ideas come into reach", async ({ page }) => {
  await openMap(page);
  await zoom(page, "Mid");
  await page.keyboard.press("0");
  const worker = page.locator(`[data-worker][data-drag="s:${key}"]`);
  const vp = page.locator(".map-viewport");
  const box = (await vp.boundingBox())!;
  const a = (await worker.boundingBox())!;
  await page.mouse.move(a.x + 24, a.y + 8);
  await page.mouse.down();
  await page.mouse.move(a.x + 40, a.y + 20, { steps: 3 });
  await page.mouse.move(box.x + 12, box.y + box.height / 2, { steps: 10 });
  const tx = async () => Number(await vp.evaluate((el) => (el as HTMLElement).style.getPropertyValue("--tx")));
  const t0 = await tx();
  await page.waitForTimeout(400); // the pointer rests; only the drift moves the chart
  expect(await tx()).toBeGreaterThan(t0 + 40);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.locator(".carry-ghost")).toHaveCount(0);
});

test("Move to from the keyboard: a task, then Undo from the focused toast", async ({ page }) => {
  await openMap(page);
  const idea = page.locator(`[data-mission="${IDEA}"]`);
  await idea.locator(".mn-title").focus();
  await zoom(page, "Mid");
  const grip = idea.locator(`.task-row[data-task="${T.ship}"] .drag-handle`);
  await grip.focus();
  await expect(grip).toHaveCSS("opacity", "1");
  await page.keyboard.press("Enter");
  const menu = page.getByTestId("move-menu");
  await expect(menu).toBeVisible();
  await expect(menu).toContainText("Move task");
  await expect(menu.getByRole("button", { name: /Move to CSV export for the report page/ })).toHaveCount(0);
  await expect(menu.getByRole("button", { name: /Move to Unfiled/ })).toHaveCount(0);
  await shot(page, CP, "menu-task");
  // Esc closes it and gives focus back to the grip.
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(grip).toBeFocused();
  await page.keyboard.press("Enter");
  await pickWithKeys(page, `Move to ${OTHER_TITLE}`);
  await expect(page.getByTestId("map-toast")).toContainText(`Moved the task to ${OTHER_TITLE}.`);
  await waitUntil(async () => (await missionOf(T.ship)) === OTHER);
  const undo = page.getByTestId("map-toast").getByRole("button", { name: "Undo" });
  await expect(undo).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("map-toast")).toContainText("Move undone.");
  await waitUntil(async () => (await missionOf(T.ship)) === IDEA);
});

test("Move to by click: a session to an idea and to Unfiled, and an idea to a group and to a new group", async ({ page }) => {
  await openMap(page);
  await zoom(page, "Mid");
  await page.keyboard.press("0");
  const menu = page.getByTestId("move-menu");
  // Session: unfiled, so the menu offers ideas only.
  const worker = page.locator(`[data-worker][data-drag="s:${key}"]`);
  await worker.hover();
  await worker.locator(".drag-handle").click();
  await expect(menu).toContainText("Move session");
  await expect(menu.getByRole("button", { name: /Move to Unfiled/ })).toHaveCount(0);
  await shot(page, CP, "menu-session");
  await menu.getByRole("button", { name: `Move to ${OTHER_TITLE}` }).click();
  await expect(page.getByTestId("map-toast")).toContainText(`Moved the session to ${OTHER_TITLE}.`);
  await waitUntil(async () => (await sessionsOf(OTHER)).includes(key));
  // Filed now: at Near its line in the idea offers Unfiled.
  await page.locator(`[data-mission="${OTHER}"] .mn-title`).focus();
  await zoom(page, "Near");
  const line = page.locator(`[data-mission="${OTHER}"] .wl[data-drag="s:${key}"]`);
  await line.hover();
  await line.locator(".drag-handle").click();
  await menu.getByRole("button", { name: "Move to Unfiled" }).click();
  await expect(page.getByTestId("map-toast")).toContainText("to Unfiled");
  await waitUntil(async () => !(await sessionsOf(OTHER)).includes(key));

  // Idea: groups, then New group, which asks for a name.
  await zoom(page, "Mid");
  await page.keyboard.press("0");
  const other = page.locator(`[data-mission="${LOOSE}"]`);
  await other.hover();
  await other.locator(":scope > .mn-head > .drag-handle").click();
  await expect(menu).toContainText("Move idea");
  await expect(menu.getByRole("button", { name: "New group…" })).toBeVisible();
  await shot(page, CP, "menu-idea");
  await menu.getByRole("button", { name: /Move to Reporting/ }).click();
  await expect(page.getByTestId("map-toast")).toContainText("Moved OAuth login flow to Reporting.");
  await waitUntil(async () => (await lensesOf(LOOSE)).includes("reporting"));
  await page.getByTestId("map-toast").getByRole("button", { name: "Undo" }).click();
  await waitUntil(async () => !(await lensesOf(LOOSE)).includes("reporting"));

  await other.hover();
  await other.locator(":scope > .mn-head > .drag-handle").click();
  await menu.getByRole("button", { name: "New group…" }).click();
  const dialog = page.getByRole("dialog", { name: "Name the new group" });
  await dialog.getByLabel("Group name").fill("Sign-in");
  await dialog.getByRole("button", { name: "Create group" }).click();
  await expect(page.getByTestId("map-toast")).toContainText("Moved OAuth login flow to the new group Sign-in.");
  await expect(page.locator('.region-label[data-region="lens:sign-in"]')).toBeVisible();
  await shot(page, CP, "menu-new-group");
  await page.getByTestId("map-toast").getByRole("button", { name: "Undo" }).click();
  await expect(page.locator('.region-label[data-region="lens:sign-in"]')).toHaveCount(0);
  expect((await call<any[]>("GET", "/api/lenses")).body.map((l) => l.id)).not.toContain("sign-in");
});
