// CP4b notes UI, from the home page: the quick-note composer and chips on an idea (Enter saves,
// Shift+Enter adds a bullet, ⌘Enter saves and tells Firstmate through a real captain inbox note),
// note entries in the idea timeline, delete (archive) with undo, and a note on a worker from its pane.
import fs from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { shot } from "./shot";
import { call, seedWorld, W } from "./map-seed";
import { buildFirstmateHome } from "./crew-fixture";

const PORT = Number(process.env.E2E_PORT ?? 4399);
if (PORT === 4317 || PORT === 3000) throw new Error("notes-ui e2e refuses to run against the real daemon port");
const env = JSON.parse(fs.readFileSync(`/tmp/joyride-e2e-${PORT}/env.json`, "utf8")) as Record<string, string>;
const IDEA = "csv-export";
const IDEA_TITLE = "CSV export for the report page";
const CP = "CP4b";

function inboxNote(intentId: string): string {
  const dir = path.join(env.JOYRIDE_RUNTIME, "firstmate", "state", "inbox");
  const body = fs.readdirSync(dir).filter((n) => n.endsWith(".note")).map((n) => fs.readFileSync(path.join(dir, n), "utf8")).find((b) => b.includes(`request_id=${intentId}`));
  if (!body) throw new Error(`no inbox note for ${intentId}`);
  return body;
}

async function openFromHome(page: Page, query: string, option: RegExp) {
  await page.goto("/#/");
  await expect(page.locator("main, #root").first()).toBeVisible();
  await page.keyboard.press("Meta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("textbox").fill(query);
  await palette.getByRole("option", { name: option }).first().click();
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await seedWorld();
  const home = path.join(env.JOYRIDE_RUNTIME, "firstmate");
  if (!fs.existsSync(path.join(home, "data", "backlog.md"))) buildFirstmateHome(home, IDEA);
});

test("idea page: quick notes, chips, timeline and tell Firstmate", async ({ page }) => {
  await openFromHome(page, IDEA_TITLE, new RegExp(IDEA_TITLE));
  await expect(page).toHaveURL(new RegExp(`#/mission/${IDEA}`));
  const panel = page.locator('[data-panel="notes"]');
  await panel.scrollIntoViewIfNeeded();
  await expect(panel.getByRole("heading", { name: "Notes" })).toBeVisible();
  // Right after done-when, though the workspace's panel list predates notes.
  expect(await page.locator("[data-panel]").evaluateAll((els) => els.slice(0, 2).map((e) => e.getAttribute("data-panel")))).toEqual(["done_when", "notes"]);
  const first = panel.getByRole("textbox", { name: "Note" });
  await expect(first).toHaveAttribute("placeholder", "Note on this idea…");
  await shot(page, CP, "idea-notes-empty");

  await test.step("Shift+Enter adds a bullet, Enter saves", async () => {
    await first.fill("Totals row goes last");
    await first.press("Shift+Enter");
    const second = panel.getByRole("textbox", { name: "Bullet 2" });
    await expect(second).toBeFocused();
    await second.fill("Use the server's rounding");
    await shot(page, CP, "idea-notes-compose");
    await second.press("Enter");
    await expect(panel.locator('[data-note-outcome="saved"]')).toContainText("Saved on this idea");
    const notes = (await call("GET", `/api/notes?idea=${IDEA}`)).body;
    const n = notes.find((x: any) => x.bullets[0] === "Totals row goes last");
    expect(n).toMatchObject({ kind: "note", scope: `mission:${IDEA}`, bullets: ["Totals row goes last", "Use the server's rounding"], provenance: { type: "human", ref: "map" } });
    const chip = panel.locator(`[data-note="${n.id}"]`);
    await expect(chip).toContainText("Totals row goes last");
    await expect(chip).toContainText("2");
    // The field is empty and ready for the next note.
    await expect(panel.getByRole("textbox", { name: "Note" })).toHaveValue("");
  });

  let tellId = "";
  await test.step("⌘Enter saves and tells Firstmate", async () => {
    const f = panel.getByRole("textbox", { name: "Note" });
    await f.fill("Ask before touching the PDF export");
    await f.press("Meta+Enter");
    await expect(panel.locator('[data-note-outcome="told"]')).toContainText("Firstmate has it in its inbox");
    const it = (await call("GET", "/api/intents?kind=tell_note&limit=1")).body[0];
    expect(it).toMatchObject({ kind: "tell_note", status: "sent", origin: "captain" });
    tellId = it.id;
    const text = inboxNote(tellId);
    expect(text).toContain("- Ask before touching the PDF export");
    expect(text).toContain(`joyride-mission: ${IDEA}`);
    expect(text).toContain(`joyride-request: ${tellId}`);
    await shot(page, CP, "idea-notes-told");
  });

  await test.step("a chip opens the note; the timeline lists it", async () => {
    const chip = panel.locator(".note-chip", { hasText: "Totals row goes last" });
    await chip.click();
    const card = panel.locator("[data-note-card]");
    await expect(card.getByRole("listitem")).toHaveText(["Totals row goes last", "Use the server's rounding"]);
    await shot(page, CP, "idea-note-open");
    const timeline = page.locator('[data-panel="timeline"]');
    await timeline.scrollIntoViewIfNeeded();
    await expect(timeline.locator('li[data-kind="note"]', { hasText: "You noted: “Totals row goes last”" })).toContainText("and 1 more bullet");
    await expect(timeline.locator('li[data-kind="note"]', { hasText: "Ask before touching the PDF export" })).toBeVisible();
    await shot(page, CP, "idea-timeline-notes");
  });

  await test.step("delete (archives) with undo", async () => {
    await panel.scrollIntoViewIfNeeded();
    const card = panel.locator("[data-note-card]");
    const id = await card.getAttribute("data-note-card");
    await card.getByRole("button", { name: "Delete this note" }).click();
    await expect(panel.locator(`[data-note="${id}"]`)).toHaveCount(0);
    expect((await call("GET", `/api/notes/${id}`)).body.status).toBe("archived");
    await panel.getByRole("button", { name: "Undo" }).click();
    await expect(panel.locator(`[data-note="${id}"]`)).toBeVisible();
    expect((await call("GET", `/api/notes/${id}`)).body.status).toBe("active");
  });
});

test("worker pane: a note on the agent from its sheet", async ({ page }) => {
  await openFromHome(page, "Flaky export test", /Flaky export test.*blocked worker/);
  await expect(page).toHaveURL(new RegExp(`#/worker/${encodeURIComponent(W.blocked)}`));
  const sheet = page.getByRole("dialog", { name: /Worker/ });
  const w = (await call("GET", `/api/workers/${encodeURIComponent(W.blocked)}`)).body;
  expect(w.session, "the fixture worker has a session").toBeTruthy();
  const strip = sheet.locator(".wp-notes");
  await strip.getByRole("button", { name: "Add a note on this agent" }).click();
  const f = strip.getByRole("textbox", { name: "Note" });
  await expect(f).toBeFocused();
  await f.fill("This agent is on the old branch");
  await shot(page, CP, "worker-note-compose");
  await f.press("Enter");
  await expect(strip.locator('[data-note-outcome="saved"]')).toContainText("Saved on this agent");
  const notes = (await call("GET", `/api/notes?session=${encodeURIComponent(w.session)}`)).body;
  expect(notes.map((n: any) => n.bullets)).toContainEqual(["This agent is on the old branch"]);
  await expect(strip.locator(".note-chip", { hasText: "This agent is on the old branch" })).toBeVisible();
  // Esc folds the composer without closing the sheet.
  await strip.getByRole("textbox", { name: "Note" }).press("Escape");
  await expect(sheet).toBeVisible();
  await expect(strip.getByRole("button", { name: "Add a note on this agent" })).toBeVisible();
  await shot(page, CP, "worker-notes");
});
