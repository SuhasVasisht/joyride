// Notes and lists from New (the one box at the top of the rail), from the home page: "add a note: …" and
// "make a list: …" typed for Unfiled (the hub) and on an idea save a note or a checklist there, at once, without
// a word to Firstmate, and fly into their card, leaving nothing behind; the cards sit on the chart above the
// tasks, edited in place, ticked, deleted with Undo; Change on a task's card turns it into a note, and Edit in
// New's preview turns a note into a task; text that only mentions a note asks Jev, then the captain.
// Every type, entry point and destination is in board-items.spec.ts.
import fs from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { shot } from "./shot";
import { call, seedWorld, waitUntil, PORT } from "./map-seed";
import { buildFirstmateHome } from "./crew-fixture";
import { applyNew, newInput, newSection, newResult, openNew, planNew } from "./new-box";
import { trackFixtureNotes } from "./fixture-cleanup";
import { panTo } from "./chart-pan";

let cleanNotes: (() => Promise<void>) | undefined;

const env = JSON.parse(fs.readFileSync(`/tmp/joyride-e2e-${PORT}/env.json`, "utf8")) as Record<string, string>;
const IDEA = "csv-export";
const IDEA_TITLE = "CSV export for the report page";
const CP = "canvas-notes";

type NoteRec = { id: string; scope: string; title: string; bullets: string[]; status: string };
const notesOn = async (q: string): Promise<NoteRec[]> => (await call("GET", `/api/notes?${q}`)).body;
/** The first note on `q` that matches, once it exists. */
const noteWhere = async (q: string, ok: (n: NoteRec) => boolean): Promise<NoteRec> => (await waitUntil(async () => (await notesOn(q)).find(ok)))!;
/** Requests that reached Firstmate: new tasks and steers. */
const firstmateRequests = async () => ((await call("GET", "/api/intents?limit=200")).body as { kind: string }[]).filter((i) => i.kind === "create_task" || i.kind === "steer_task").length;
const landed = (page: Page) => page.waitForFunction(() => [...document.querySelectorAll(".ghost")].every((el) => el.getAnimations().every((a) => a.playState !== "running")));
/** A saved note or list's flight is over: no landing ghost left. */
const flown = (page: Page) => expect(page.locator(".landing-ghost")).toHaveCount(0, { timeout: 8000 });

async function zoom(page: Page, level: "Far" | "Mid" | "Near") {
  await page.getByRole("radio", { name: level }).click();
  await expect(page.locator(".map-viewport")).toHaveAttribute("data-zoom", level.toLowerCase());
}
/** Centre the chart on the Firstmate hub (focusing a node brings it into view). */
async function onHub(page: Page) {
  await page.getByTestId("firstmate-node").locator(".fm-title").focus();
  await page.waitForTimeout(400);
}
/** The home page at near zoom, centred on the idea. */
async function onIdea(page: Page) {
  await page.goto("/");
  const idea = page.locator(`.mission-node[data-mission="${IDEA}"]`);
  await expect(idea).toBeVisible();
  await idea.locator(".mn-title").focus();
  await zoom(page, "Near");
  return idea;
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  cleanNotes = await trackFixtureNotes();
  await seedWorld();
  const home = path.join(env.JOYRIDE_RUNTIME, "firstmate");
  if (!fs.existsSync(path.join(home, "data", "backlog.md"))) buildFirstmateHome(home, IDEA);
});

test.afterAll(async () => { await cleanNotes?.(); });

test("hub: “add a note: …” saves a note on the hub, and Firstmate hears nothing", async ({ page }) => {
  const before = await firstmateRequests();
  await page.goto("/");
  await expect(page.getByTestId("firstmate-node")).toBeVisible();
  await openNew(page);
  await expect(newSection(page).locator(".nb-hint")).toContainText("Notes, lists, links, moves, work or a change to this view.");
  await planNew(page, "add a note: check the PDF export before Friday");
  await shot(page, CP, "01-hub-note-composer");
  await applyNew(page);

  // The preview was the confirmation: the item saves at once and flies into its card; nothing stays behind.
  await shot(page, CP, "02-hub-note-ghost");
  await flown(page);
  await expect(newResult(page)).toHaveAttribute("data-state", "done");
  const n = await noteWhere("global=1", (x) => x.bullets[0] === "check the PDF export before Friday");
  expect(n).toMatchObject({ scope: "global", bullets: ["check the PDF export before Friday"] });
  expect(await firstmateRequests()).toBe(before);

  // On the chart, at mid zoom: a card on the hub, readable without opening anything.
  await zoom(page, "Mid");
  await onHub(page);
  const card = page.locator(`[data-note-board="global"] [data-note-card="${n.id}"]`);
  await expect(card).toBeVisible();
  await expect(card).toContainText("check the PDF export before Friday");
  await landed(page);
  await shot(page, CP, "03-hub-note-saved-mid");
});

test("hub: “make a list: …” becomes a checklist on the hub that the captain ticks", async ({ page }) => {
  const before = await firstmateRequests();
  await page.goto("/");
  await expect(page.getByTestId("firstmate-node")).toBeVisible();
  await zoom(page, "Mid");
  await onHub(page);
  await openNew(page);
  await planNew(page, "make a list: milk, eggs, bread");
  await applyNew(page);
  const ghost = page.locator(".landing-ghost");
  await shot(page, CP, "04-hub-list-ghost");
  await flown(page);
  const n = await noteWhere("global=1", (x) => x.bullets.join() === "[ ] milk,[ ] eggs,[ ] bread");
  expect(n.title).toBe("List");
  expect(await firstmateRequests()).toBe(before);

  await zoom(page, "Mid");
  await onHub(page);
  const card = page.locator(`[data-note-card="${n.id}"]`);
  const more = page.locator('[data-note-board="global"]').getByRole("button", { name: /^Show \d+ more$/ });
  if (await more.count()) await more.click();
  await expect(card).toHaveAttribute("data-kind", "list");
  await expect(card.locator(".nk-progress")).toHaveText("0 of 3 done");
  // The hub grew a card: centre on it again, through the checkbox itself.
  const eggs = card.getByRole("checkbox", { name: "eggs" });
  await panTo(eggs);
  await expect(eggs).toBeInViewport();
  await eggs.check();
  await expect(card.locator(".nk-progress")).toHaveText("1 of 3 done");
  await waitUntil(async () => (await call("GET", `/api/notes/${n.id}`)).body.bullets.join() === "[ ] milk,[x] eggs,[ ] bread");
  await shot(page, CP, "05-hub-list-ticked-mid");
});

test("idea: a note and a list typed into “+ Add to this idea” land on that idea, above its tasks", async ({ page }) => {
  const before = await firstmateRequests();
  const idea = await onIdea(page);

  await idea.locator(`[data-compose="${IDEA}"]`).click();
  await expect(newInput(page)).toBeFocused();
  await expect(newSection(page).locator(".nb-scope")).toContainText(IDEA_TITLE);
  await planNew(page, "add a note: totals go on the last row");
  await applyNew(page);
  await flown(page);
  await expect(newResult(page)).toHaveAttribute("data-state", "done");
  const n = await noteWhere(`idea=${IDEA}`, (x) => x.bullets[0] === "totals go on the last row");
  expect(n.scope).toBe(`mission:${IDEA}`);

  await idea.locator(`[data-compose="${IDEA}"]`).click();
  await planNew(page, "make a list for the release: tag the build, write the notes, tell support");
  await applyNew(page);
  await flown(page);
  const l = await noteWhere(`idea=${IDEA}`, (x) => x.title === "The release");
  expect(l.bullets).toEqual(["[ ] tag the build", "[ ] write the notes", "[ ] tell support"]);
  expect(await firstmateRequests()).toBe(before);

  // Both cards sit on the idea's board, before its first task card.
  const board = idea.locator(`[data-note-board="mission:${IDEA}"]`);
  await expect(board.locator(`[data-note-card="${n.id}"]`)).toBeVisible();
  await expect(board.locator(`[data-note-card="${l.id}"]`)).toBeVisible();
  const order = await idea.evaluate((el) => {
    const b = el.querySelector("[data-note-board]"), t = el.querySelector("[data-task]");
    return !!b && (!t || !!(b.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING));
  });
  expect(order).toBe(true);
  await idea.locator(".mn-title").focus();
  await page.waitForTimeout(400);
  await shot(page, CP, "06-idea-note-and-list-near");
});

test("on the chart: edit a note in place, tick, rename, add and remove list items, delete with Undo", async ({ page }) => {
  const idea = await onIdea(page);
  const board = idea.locator(`[data-note-board="mission:${IDEA}"]`);
  const n = (await notesOn(`idea=${IDEA}`)).find((x) => x.bullets[0] === "totals go on the last row")!;
  const l = (await notesOn(`idea=${IDEA}`)).find((x) => x.title === "The release")!;

  await test.step("edit a note: click its text, Shift+Enter for a second line, Enter saves", async () => {
    const card = board.locator(`[data-note-card="${n.id}"]`);
    await card.getByRole("button", { name: "Edit this note" }).click();
    const area = card.getByRole("textbox", { name: "Note text, one line per bullet" });
    await expect(area).toBeFocused();
    await area.press("Shift+Enter");
    await area.pressSequentially("use the server's rounding");
    await shot(page, CP, "07-note-editing");
    await area.press("Enter");
    await expect(card.locator(".nk-blocks li")).toHaveText(["totals go on the last row", "use the server's rounding"]);
    await waitUntil(async () => (await call("GET", `/api/notes/${n.id}`)).body.bullets.length === 2);
  });

  await test.step("tick, rename, add and remove list items", async () => {
    const card = board.locator(`[data-note-card="${l.id}"]`);
    await card.getByRole("checkbox", { name: "tag the build" }).check();
    await card.getByRole("button", { name: "Rename “write the notes”" }).click();
    const item = card.getByRole("textbox", { name: "Item text" });
    await item.fill("write the release notes");
    await item.press("Enter");
    await card.getByRole("textbox", { name: "Add an item" }).fill("update the changelog");
    await card.getByRole("textbox", { name: "Add an item" }).press("Enter");
    await card.getByRole("button", { name: "Remove “tell support”" }).click();
    await expect(card.locator(".nk-progress")).toHaveText("1 of 3 done");
    await waitUntil(async () => (await call("GET", `/api/notes/${l.id}`)).body.bullets.join("|") === "[x] tag the build|[ ] write the release notes|[ ] update the changelog");
    await card.scrollIntoViewIfNeeded();
    await shot(page, CP, "08-list-edited");
  });

  await test.step("delete a list, then Undo", async () => {
    const card = board.locator(`[data-note-card="${l.id}"]`);
    await card.getByRole("button", { name: "Delete this list" }).click();
    await expect(card).toHaveCount(0);
    expect((await call("GET", `/api/notes/${l.id}`)).body.status).toBe("archived");
    const undo = board.locator(`[data-note-deleted="${l.id}"]`);
    await expect(undo).toContainText("Deleted “The release”");
    await shot(page, CP, "09-list-deleted-undo");
    await undo.getByRole("button", { name: "Undo" }).click();
    await expect(board.locator(`[data-note-card="${l.id}"]`)).toBeVisible();
    expect((await call("GET", `/api/notes/${l.id}`)).body.status).toBe("active");
  });
});
