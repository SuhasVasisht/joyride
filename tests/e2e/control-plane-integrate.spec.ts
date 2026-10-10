// Control plane integration (after CP3a, CP3b, CP4b, CP5, CP6), from the home page: notes added on an idea
// in place, a task made from an idea's "+ Add to this idea" whose ghost lands on the idea and morphs into the
// task card Firstmate writes, a captain call answered on its card, "This looks moot" sending a crew decision
// back to Firstmate as a re-check, notes in the task sheet with the card kept highlighted underneath, an
// idea's "Still want this?" nudge on its island, the Tidied toast over the map, and one region per name.
// Runs on the e2e sandbox with a fixture FM_HOME (real vendored intake + tasks-axi) and fake models.
import fs from "node:fs";
import path from "node:path";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { buildFirstmateHome, FIXTURE_TASKS as T } from "./crew-fixture";
import { addAskFixtures, ASK_TASKS } from "./asks-fixture";
import { call, PORT, waitUntil, openIdea } from "./map-seed";
import { shot } from "./shot";
import { applyNew, composeTask, newInput, newResult, newSection, planNew } from "./new-box";
import { stopFixtureFirstmate, trackFixtureNotes } from "./fixture-cleanup";
import { panTo } from "./chart-pan";

let cleanNotes: (() => Promise<void>) | undefined;

const env: Record<string, string> = JSON.parse(fs.readFileSync(`/tmp/joyride-e2e-${PORT}/env.json`, "utf8"));
const home = path.join(env.JOYRIDE_RUNTIME, "firstmate");
const CP = "C12";
const IDEA = "cpi-export", QUIET = "cpi-quiet", OLD_TASK = "cpi-old-idea", LOOSE = "cpi-loose-task";
const FOLD_LENS = "fold-check", FOLD_REPO = "/tmp/joyride-fixture-repos/fold-check";
const backlog = () => fs.readFileSync(path.join(home, "data", "backlog.md"), "utf8");
const inboxNotes = () => {
  const out: string[] = [];
  for (const dir of [path.join(home, "state", "inbox"), path.join(home, "state", "inbox", "handled")]) {
    if (fs.existsSync(dir)) for (const n of fs.readdirSync(dir)) if (n.endsWith(".note")) out.push(fs.readFileSync(path.join(dir, n), "utf8"));
  }
  return out;
};
const lastIntent = async (kind: string) => (await call("GET", `/api/intents?kind=${kind}&limit=1`)).body[0];

async function zoom(page: Page, level: "Far" | "Mid" | "Near") {
  if (await page.locator(".map-viewport").getAttribute("data-focus")) await page.getByTestId("map-crumbs").getByRole("button", { name: "Map", exact: true }).click();
  await page.getByRole("radio", { name: level }).click();
  await expect(page.locator(".map-viewport")).toHaveAttribute("data-zoom", level.toLowerCase());
}
/** Bring a map node into view at near zoom: focus its title, which centres it. */
async function nearOn(page: Page, mission: string) {
  const node = page.locator(`.mission-node[data-mission="${mission}"]`);
  await expect(node).toBeVisible();
  await node.locator(".mn-title").focus();
  await zoom(page, "Near");
  await node.locator(".mn-title").focus();
  // Acting on an idea's tasks, crew and every ask happens on the idea opened in full.
  await openIdea(page, mission);
  return node;
}
/** The ghost sits just under one of these (its anchor on the chart), not docked in the tray. */
async function anchoredUnder(page: Page, ghost: Locator, anchors: Locator[]) {
  await expect(async () => {
    expect(await page.locator(".ghost-tray .ghost").count()).toBe(0);
    const g = (await ghost.boundingBox())!;
    const boxes = await Promise.all(anchors.map((a) => a.boundingBox()));
    const hit = boxes.some((b) => b && Math.abs(g.x - b.x) < 4 && g.y >= b.y + b.height && g.y - (b.y + b.height) < 20);
    expect(hit, `ghost at ${JSON.stringify(g)}; anchors ${JSON.stringify(boxes)}`).toBe(true);
  }).toPass({ timeout: 5000 });
}
const landed = (page: Page) => page.waitForFunction(() => [...document.querySelectorAll(".ghost")].every((el) => el.getAnimations().every((a) => a.playState !== "running")));

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  cleanNotes = await trackFixtureNotes();
  expect(home.startsWith(`/tmp/joyride-e2e-${PORT}/`)).toBe(true);
  for (const [id, title] of [[IDEA, "Ship the CSV export"], [QUIET, "Revisit the old dashboard"]]) {
    if ((await call("GET", `/api/missions/${id}`)).status === 404) expect((await call("POST", "/api/missions", { id, title, repos: ["/tmp/joyride-fixture-repos/alpha"] })).status).toBe(201);
    else await call("PUT", `/api/missions/${id}`, { archive: false, state: "open" });
  }
  buildFirstmateHome(home, IDEA);
  addAskFixtures(home);
  const file = path.join(home, "data", "backlog.md");
  // Its own hold stamp, so another spec's answer receipt for the same fixture call is a different lifecycle.
  let text = fs.readFileSync(file, "utf8").replace(/(  Captain hold set: )\S+/, "$1" + new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10));
  // A queued task on an idea nobody has touched in six days: housekeeping asks "Still want this?".
  text = text.replace("## Queued\n", `## Queued\n\n- [ ] ${OLD_TASK} - Rebuild the old dashboard charts (repo: alpha) (kind: ship)\n`);
  // A task no idea names, for housekeeping to place (and the Tidied toast's Undo to veto) without touching shared fixtures.
  text = text.replace("## Queued\n", `## Queued\n\n- [ ] ${LOOSE} - Tidy the export helper names (repo: alpha) (kind: ship)\n`);
  fs.writeFileSync(file, text);
  const brief = path.join(home, "data", OLD_TASK, "brief.md");
  fs.mkdirSync(path.dirname(brief), { recursive: true });
  fs.writeFileSync(brief, `# Rebuild the old dashboard charts\n\n## Captain's intent\n\njoyride-mission: ${QUIET}\n\nRedo the charts.\n`);
  const old = new Date(Date.now() - 6 * 864e5);
  fs.utimesSync(brief, old, old);
  await waitUntil(async () => {
    const asks: { id: string }[] = (await call("GET", "/api/asks")).body.asks;
    return asks.some((a) => a.id === `hold:${ASK_TASKS.calls}`) && asks.some((a) => a.id === `decision:${T.scout}:flake-cause`);
  });
  await waitUntil(async () => (await call("GET", `/api/firstmate/tasks/${T.ship}`)).body.mission === IDEA);
});

test.afterAll(async () => {
  await cleanNotes?.();
  await stopFixtureFirstmate();
  buildFirstmateHome(home, IDEA);
  for (const id of [IDEA, QUIET, "cpi-fold-a", "cpi-fold-b"]) await call("PUT", `/api/missions/${id}`, { archive: true }).catch(() => {});
  await call("DELETE", `/api/lenses/${FOLD_LENS}`).catch(() => {});
});

test("from the home page: a note on an idea, a task from the map composer that lands in its idea, and a call answered in place", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1600 }); // the idea's whole island fits at near zoom
  await page.goto("/");
  const idea = await nearOn(page, IDEA);

  // 1. A note on the idea, written on its island.
  await idea.getByRole("button", { name: "Add to this idea", exact: true }).click();
  await planNew(page, "add a note: Totals must match the on-screen report to the cent");
  await shot(page, CP, "cpi-01-idea-note-typing");
  await applyNew(page);
  await expect(idea.locator(`[data-note-board="mission:${IDEA}"] .note-card`, { hasText: "Totals must match the on-screen report" })).toBeVisible();
  await expect(page).not.toHaveURL(/#\/mission\//); // typing in the note never opened the idea page
  await expect(page).toHaveURL(new RegExp(`#/map\\?focus=.*&idea=${IDEA}$`)); // the idea stays open on the map
  const notes = (await call("GET", `/api/notes?idea=${IDEA}`)).body as { bullets: string[]; scope: string }[];
  expect(notes.find((n) => n.bullets[0] === "Totals must match the on-screen report to the cent")).toMatchObject({ scope: `mission:${IDEA}` });
  await shot(page, CP, "cpi-02-idea-note-saved");

  // 2. "+ Add to this idea" opens New on it: the ghost lands on the idea, sends itself, and morphs into the task Firstmate writes.
  // Focus brings the button into view first, so the ghost has room to land under it.
  await idea.getByRole("button", { name: "Add to this idea" }).focus();
  await page.waitForTimeout(400);
  await idea.getByRole("button", { name: "Add to this idea" }).click();
  await expect(newSection(page).locator(".nb-scope")).toContainText("Ship the CSV export");
  const ghost = await composeTask(page, "Add a grand total row to the CSV export");
  await expect(ghost).toContainText("Adding to Ship the CSV export");
  await newResult(page).getByRole("button", { name: "Show on map", exact: true }).click();
  await landed(page);
  // Anchored on the idea's island (under its title, or under "+ Add to this idea"), not docked in the tray.
  await anchoredUnder(page, ghost, [idea.locator(".mn-head"), idea.locator("[data-compose]")]);
  await shot(page, CP, "cpi-03-ghost-on-idea");
  await expect(ghost.getByRole("list", { name: "Progress" })).toBeVisible({ timeout: 30000 });
  const it = await waitUntil(async () => { const x = await lastIntent("create_task"); return x?.payload?.brief === "Add a grand total row to the CSV export" ? x : null; });
  expect(it).toMatchObject({ target: IDEA, status: "sent" });
  expect(inboxNotes().some((n) => n.includes(`request_id=${it.id}`) && n.includes(`joyride-mission: ${IDEA}`))).toBe(true);

  // The fixture's Firstmate writes the task with both markers: the card appears in the idea and the ghost morphs onto it.
  const id = "cpi-grand-total";
  fs.writeFileSync(path.join(home, "data", "backlog.md"), backlog().replace("## Queued\n", `## Queued\n\n- [ ] ${id} - Add a grand total row to the CSV export (repo: alpha) (kind: ship)\n`));
  fs.mkdirSync(path.join(home, "data", id), { recursive: true });
  fs.writeFileSync(path.join(home, "data", id, "brief.md"), `# Grand total\n\n## Captain's intent\n\njoyride-mission: ${IDEA}\njoyride-request: ${it.id}\n\nAdd a grand total row.\n`);
  const card = idea.locator(`.task-card[data-task="${id}"]`);
  await expect(card).toBeVisible({ timeout: 12000 });
  await expect(ghost).toHaveClass(/is-task/, { timeout: 12000 });
  await panTo(card);
  await landed(page);
  await anchoredUnder(page, ghost, [card]);
  await shot(page, CP, "cpi-04-ghost-became-task-card");
  await ghost.getByRole("button", { name: "Hide this request" }).click();

  // 3. The captain call pinned to the scout's card, answered in place with its recommendations.
  const call1 = idea.locator(`.ask-card[data-ask="hold:${ASK_TASKS.calls}"]`);
  await call1.getByRole("button", { name: "Answer", exact: true }).click();
  await expect(call1).toContainText("Needs you");
  await panTo(call1);
  await shot(page, CP, "cpi-05-call-on-card");
  await call1.getByRole("button", { name: "Send these choices" }).click();
  await waitUntil(async () => backlog().includes(`- [x] ${ASK_TASKS.calls}`));
  expect(backlog()).toContain("joyride-map");
  await expect(call1).toHaveCount(0, { timeout: 10000 });
  await shot(page, CP, "cpi-06-call-answered");
});

test("This looks moot sends a crew decision back to Firstmate as a re-check, not an answer", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  const idea = await nearOn(page, IDEA);
  const dec = idea.locator(`.ask-card[data-ask="decision:${T.scout}:flake-cause"]`);
  await dec.getByRole("button", { name: "Answer", exact: true }).click();
  await expect(dec).toContainText("Firstmate is deciding");
  const status = fs.readFileSync(path.join(home, "state", `${T.scout}.status`), "utf8");
  await dec.getByRole("button", { name: "This looks moot" }).click();
  await expect(dec).toContainText("Asked Firstmate to re-check this");
  const it = await waitUntil(async () => { const x = await lastIntent("recheck_ask"); return x?.target === `decision:${T.scout}:flake-cause` ? x : null; });
  expect(it).toMatchObject({ status: "sent", origin: "captain" });
  const note = inboxNotes().find((n) => n.includes(`request_id=${it.id}`))!;
  expect(note).toContain("may be moot");
  expect(note).toContain(`joyride-request: ${it.id}`);
  // Not an answer: no resolved line, no worker inbox message, and the card stays until Firstmate closes it.
  expect(fs.readFileSync(path.join(home, "state", `${T.scout}.status`), "utf8")).toBe(status);
  expect(fs.existsSync(path.join(home, "state", `${T.scout}.inbox`)) && fs.readdirSync(path.join(home, "state", `${T.scout}.inbox`)).some((n) => n.endsWith(".msg"))).toBe(false);
  await panTo(dec);
  await shot(page, CP, "cpi-07-moot-recheck");
  expect((await call("GET", `/api/asks/${encodeURIComponent(`decision:${T.scout}:flake-cause`)}`)).status).toBe(200);
  await page.reload();
  await expect((await nearOn(page, IDEA)).locator(`.ask-card[data-ask="decision:${T.scout}:flake-cause"]`)).toBeVisible();
});

test("the task sheet holds the task's notes, and the card stays highlighted underneath while it is open", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  const idea = await nearOn(page, IDEA);
  const card = idea.locator(`.task-card[data-task="${T.ship}"]`);
  await expect(card).not.toHaveClass(/selected/);
  await card.locator(".tc-title").click();
  await expect(page).toHaveURL(new RegExp(`#/task/${T.ship}`));
  const sheet = page.locator(`[data-task-sheet="${T.ship}"]`);
  await expect(sheet).toBeVisible();
  await expect(card).toHaveClass(/selected/);
  await expect(card).toHaveAttribute("aria-current", "true");

  const notes = sheet.locator(".ts-notes");
  await notes.getByRole("button", { name: "Add a note on this task" }).click();
  await notes.getByRole("textbox", { name: "Note" }).fill("Keep the button label short: Export CSV");
  await notes.getByRole("textbox", { name: "Note" }).press("Enter");
  // Other specs may leave notes on this task in the shared sandbox: look for this one.
  await expect(notes).toContainText("Keep the button label short");
  // The idea's notes show too, read-only, so the sheet carries what the crewmate is briefed with.
  await expect(notes.locator(`[data-notes-also="mission:${IDEA}"]`)).toContainText("Totals must match");
  // The card underneath counts it at once.
  await expect(card.locator(".note-chip", { hasText: "Keep the button label short" })).toBeVisible();
  expect((await call("GET", `/api/notes?task=${T.ship}`)).body.some((n: { scope: string; bullets: string[] }) => n.scope === `task:${T.ship}` && n.bullets[0].startsWith("Keep the button label"))).toBe(true);
  await shot(page, CP, "cpi-08-task-sheet-notes-selected-card");

  await page.keyboard.press("Escape"); // folds the note field first
  await expect(notes.getByRole("textbox", { name: "Note" })).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(card).not.toHaveClass(/selected/);
});

test("the hub carries notes, and New sits at the top of the rail; a quiet idea asks Still want this? on its island", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  const hub = page.getByTestId("firstmate-node");
  // Firstmate is stopped here: its Start button is the hub's focusable control, and focusing it centres the hub.
  await hub.getByRole("button", { name: "Start Firstmate" }).focus();
  await zoom(page, "Near");
  await hub.getByRole("button", { name: "Start Firstmate" }).focus();
  await expect(hub.getByRole("button", { name: "Add a note on the hub" })).toBeVisible();
  await expect(hub.getByRole("button", { name: /New task/ })).toHaveCount(0);
  await expect(newInput(page)).toBeVisible();
  await shot(page, CP, "cpi-09a-hub-notes-and-new-task");

  const quiet = await nearOn(page, QUIET);
  const nudge = quiet.locator(`[data-nudge="idea_quiet:${QUIET}"]`);
  await expect(nudge).toBeVisible({ timeout: 15000 });
  await expect(nudge).toContainText("Still want this?");
  await shot(page, CP, "cpi-09b-idea-nudge");
  await nudge.getByRole("button", { name: "Pause" }).click();
  await waitUntil(async () => (await call("GET", `/api/missions/${QUIET}`)).body.state === "paused");
  await expect(quiet.locator(`[data-nudge="idea_quiet:${QUIET}"]`)).toHaveCount(0);
});

test("housekeeping's Tidied toast shows once over the map, rail open or not", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await expect(page.locator(".map-viewport")).toBeVisible();
  // Hide the rail: the toast comes from the map's own overlay.
  if (await page.locator('[data-rail="nudges"]').isVisible()) await page.keyboard.press("\\");
  await expect(page.locator('[data-rail="nudges"]')).toBeHidden();
  await page.waitForTimeout(800); // what was there at mount is not news
  // Only this spec's own loose task: an Undo vetoes re-placing what it moved, and later specs place the shared fixtures.
  const run = (await call("POST", "/api/ideas/place", { tasks: [LOOSE] })).body;
  expect(run.commit, JSON.stringify(run)).toBeTruthy();
  const toast = page.locator(`[data-toast="tidied:${run.id}"]`);
  await expect(toast).toBeVisible({ timeout: 10000 });
  await expect(toast).toHaveCount(1);
  await shot(page, CP, "cpi-10-tidied-toast-on-map");
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(toast).toContainText("Undone");
});

test("an idea no group claims joins the group that bears its repo's name: one region, not two", async ({ page }) => {
  expect((await call("POST", "/api/lenses", { id: FOLD_LENS, title: "Fold check" })).status).toBe(200);
  for (const [id, extra] of [["cpi-fold-a", { lenses: [FOLD_LENS] }], ["cpi-fold-b", { repos: [FOLD_REPO] }]] as const) {
    if ((await call("GET", `/api/missions/${id}`)).status === 404) expect((await call("POST", "/api/missions", { id, title: `Fold ${id.slice(-1)}`, ...extra })).status).toBe(201);
    else await call("PUT", `/api/missions/${id}`, { archive: false, ...extra });
  }
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await expect(page.locator('.mission-node[data-mission="cpi-fold-b"]')).toBeVisible();
  await page.locator('.mission-node[data-mission="cpi-fold-b"] .mn-title').focus();
  await zoom(page, "Mid");
  const labels = page.locator(".region-label .rl-title");
  await expect(labels.filter({ hasText: /^Fold check$/ })).toHaveCount(1);
  await expect(labels.filter({ hasText: /^fold-check$/ })).toHaveCount(0);
  for (const id of ["cpi-fold-a", "cpi-fold-b"]) await expect(page.locator(`.mission-node[data-mission="${id}"]`)).toBeVisible();
  const a = (await page.locator('.mission-node[data-mission="cpi-fold-b"] .mn-title').boundingBox())!;
  const region = page.locator(`.region-label[data-region="lens:${FOLD_LENS}"]`);
  await expect(region).toContainText("2 ideas");
  await page.locator('.mission-node[data-mission="cpi-fold-b"] .mn-title').focus();
  await shot(page, CP, "cpi-11-one-region-per-name");
  expect(a.width).toBeGreaterThan(0);
});
