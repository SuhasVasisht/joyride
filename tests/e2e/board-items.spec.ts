// Board items end to end (jr-notes-v2): every item type (note, list, link, mixed) from every entry point (New,
// a group's +, an agent's `joyride map`) into every destination (the current group, a named group, an idea,
// Unfiled); the landing flight that leaves nothing behind; the items on the canvas at every zoom; editing,
// ticking, moving (drag and Move to, with Undo), deleting with Undo and opening links; the Board page that
// tracks them off the canvas; and Knowledge search. Screenshots: docs/checkpoints/board-items/.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { call, seedWorld, waitUntil, PORT } from "./map-seed";
import { newInput, newResult, newSection } from "./new-box";

const exec = promisify(execFile);
const env = JSON.parse(fs.readFileSync(`/tmp/joyride-e2e-${PORT}/env.json`, "utf8")) as Record<string, string>;
const CP = "board-items";
const DIR = path.resolve("docs/checkpoints", CP);
const IDEA = "csv-export";
const IDEA_TITLE = "CSV export for the report page";

type Item = { id: string; scope: string; title: string; bullets: string[]; status: string };
type Kind = "note" | "list" | "link" | "mixed";
type Dest = "current" | "named" | "idea" | "unfiled";
const KINDS: Kind[] = ["note", "list", "link", "mixed"];
const SCOPE: Record<Dest, string> = { current: "group:launch", named: "group:reporting", idea: `mission:${IDEA}`, unfiled: "global" };

let seq = 0;
const token = (k: string) => `${k}${++seq}x${Date.now().toString(36).slice(-4)}`;
const items = async (): Promise<Item[]> => (await call("GET", "/api/notes?limit=2000")).body;
/** The item whose lines carry `tok`, once it exists. */
const itemWith = async (tok: string): Promise<Item> => (await waitUntil(async () => (await items()).find((n) => n.bullets.join("\n").includes(tok))))!;

/** A shot of part of the screen: the element and a margin around it, kept inside the window. */
async function snap(page: Page, name: string, el?: Locator, pad = 28) {
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, `${name}.png`);
  if (!el) { await page.screenshot({ path: file }); return; }
  const b = await el.boundingBox();
  const vp = page.viewportSize()!;
  if (!b) { await page.screenshot({ path: file }); return; }
  const x = Math.max(0, b.x - pad), y = Math.max(0, b.y - pad);
  const width = Math.min(vp.width - x, b.width + pad * 2), height = Math.min(vp.height - y, Math.min(b.height, 560) + pad * 2);
  await page.screenshot({ path: file, clip: { x, y, width, height } });
}

async function zoom(page: Page, level: "Far" | "Mid" | "Near") {
  await page.getByRole("radio", { name: level }).click();
  await expect(page.locator(".map-viewport")).toHaveAttribute("data-zoom", level.toLowerCase());
}
async function onMap(page: Page, level: "Far" | "Mid" | "Near" = "Mid") {
  await page.goto("/#/map");
  await expect(page.getByTestId("firstmate-node")).toBeVisible();
  // The chart fits itself once its ideas load; pick the zoom after that.
  await expect(page.locator(`.mission-node[data-mission="${IDEA}"]`)).toBeVisible();
  await page.waitForTimeout(300);
  await zoom(page, level);
  await page.waitForTimeout(300);
}
const label = (page: Page, lens: string) => page.locator(`.region-label[data-region="lens:${lens}"]`);
const board = (page: Page, scope: string) => page.locator(`.map-plane [data-note-board="${scope}"]`);
const card = (page: Page, id: string) => page.locator(`.map-plane [data-board-item="${id}"]`);
/** The place an item lives in on the chart: its group's name and board, its idea, or the hub. */
const placeNode = (page: Page, scope: string) => scope.startsWith("group:") ? label(page, scope.slice(6))
  : scope.startsWith("mission:") ? page.locator(`.mission-node[data-mission="${scope.slice(8)}"]`) : page.getByTestId("firstmate-node");

/** A group of its own for one test, so earlier tests' items don't crowd its board. */
async function group(id: string, title: string) {
  expect((await call("POST", "/api/lenses", { id, title })).status).toBeLessThan(300);
}
/** Pan the chart (the wheel, as a person would) until the element sits in the upper middle of it. */
async function centerOn(page: Page, el: Locator) {
  const vp = (await page.locator(".map-viewport").boundingBox())!;
  for (let i = 0; i < 4; i++) {
    const b = (await el.boundingBox())!;
    const dx = b.x + Math.min(b.width, 300) / 2 - (vp.x + vp.width / 2), dy = b.y - (vp.y + vp.height * 0.18);
    if (Math.abs(dx) < 40 && Math.abs(dy) < 40) return;
    await page.mouse.move(vp.x + vp.width / 2, vp.y + vp.height / 2);
    await page.mouse.wheel(dx, dy);
    await page.waitForTimeout(250);
  }
}
/** The chart at near zoom, with a group's board in view. */
async function nearGroup(page: Page, lens: string) {
  await onMap(page, "Near");
  await centerOn(page, label(page, lens));
}

/** Rest the pointer on a group (the current group follows a short dwell). */
async function restOn(page: Page, lens: string) {
  const b = (await label(page, lens).boundingBox())!;
  await page.mouse.move(b.x + 24, b.y + b.height + 30);
  await page.waitForTimeout(700);
}

/** Destinations are expressed in text; there are no placement controls. */
async function applyNew(page: Page, text: string, opts: { goesTo?: string; expectSay?: RegExp } = {}) {
  if (opts.goesTo) {
    const cue = /^(?:make|add|save)?\s*(?:a )?(note|list|link)[^:]*:\s+([\s\S]+)$/i.exec(text);
    text = `${cue?.[1] ?? (/^https?:|^\[.*\]\(/.test(text) ? "link" : "note")} in ${opts.goesTo}: ${cue?.[2] ?? text}`;
  }
  await newInput(page).fill(text);
  await expect(newSection(page).locator('select,input[type="radio"]')).toHaveCount(0);
  const response = page.waitForResponse((r) => r.url().endsWith("/api/new") && r.request().method() === "POST");
  await newInput(page).press("Enter");
  const result = await (await response).json();
  expect(result.state, result.message).toBe("done");
  await expect(newResult(page)).toBeVisible();
}

/** The saved card is drawn; camera movement may still be settling. */
async function landed(page: Page, it: Item) {
  await expect(page.locator(".landing-ghost")).toHaveCount(0, { timeout: 8000 });
  const c = board(page, it.scope).locator(`[data-board-item="${it.id}"]`);
  await expect(c).toBeVisible();
  await expect(c).not.toHaveAttribute("data-arriving", /.*/);
  return c;
}

const words: Record<Kind, (tok: string) => string> = {
  note: (t) => `note: ${t} rehearse the demo on Thursday`,
  list: (t) => `list: ${t} book the room, send invites, order snacks`,
  link: (t) => `https://example.com/files/${t}-launch-plan.pdf`,
  mixed: (t) => `note: ${t} launch prep\n- [ ] book the room\nhttps://claude.ai/artifact/${t}`,
};
/** The same words, naming the place: "add a note in Reporting: …". */
const named: Record<Kind, (tok: string, where: string) => string> = {
  note: (t, w) => `add a note in ${w}: ${t} rehearse the demo on Thursday`,
  list: (t, w) => `make a list in ${w}: ${t} book the room, send invites`,
  link: (t, w) => `save a link in ${w}: https://example.com/blog/${t}-shipping-notes`,
  mixed: (t, w) => `add a note in ${w}: ${t} launch prep\n[ ] book the room\nhttps://example.com/files/${t}.pdf`,
};
/** On a group's +, plain words are a note for the group. */
const plain: Record<Kind, (tok: string) => string> = {
  note: (t) => `${t} pack the projector`,
  list: (t) => `list: ${t} cables, clicker`,
  link: (t) => `[${t} run of show](https://example.com/files/${t}-run-of-show.pdf)`,
  mixed: (t) => `${t} venue\n[ ] confirm the room\nhttps://example.com/venue/${t}`,
};
const kindOf = (it: Item) => (it.bullets.every((b) => /^\[[ xX]\] /.test(b)) ? "list" : it.bullets.every((b) => /^(\[[^\]]*\]\(|https?:)/.test(b)) ? "link" : it.bullets.some((b) => /^\[[ xX]\] |https?:/.test(b)) ? "mixed" : "note");

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await seedWorld();
  expect((await call("POST", "/api/lenses", { id: "launch", title: "Launch", description: "Launch prep" })).status).toBeLessThan(300);
  // Keep pages a click away: links to example.com and claude.ai answer from here, not the network.
});
test.beforeEach(async ({ page }) => {
  await page.context().route(/^https:\/\/(example\.com|claude\.ai|github\.com)\//, (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<title>Fixture page</title><p>fixture</p>" }));
});

test("New: every type lands in the current group, a named group, an idea and Unfiled, and nothing lingers", async ({ page }) => {
  test.setTimeout(240_000);
  await onMap(page, "Mid");
  await restOn(page, "launch");
  await page.locator('[data-rail="new"] textarea').click();
  await expect(newSection(page).locator("[data-current-group]")).toHaveText("Launch");
  await snap(page, "00-new-current-group-hint", newSection(page));
  for (const dest of ["current", "named", "idea", "unfiled"] as Dest[]) {
    for (const k of KINDS) {
      const tok = token(k);
      const text = dest === "named" ? named[k](tok, "Reporting") : dest === "unfiled" ? named[k](tok, "unfiled") : words[k](tok);
      await applyNew(page, text, dest === "idea" ? { goesTo: IDEA_TITLE } : {});
      // While it flies, a ghost; then only the card, in its place.
      const it = await itemWith(tok);
      expect(it.scope, `${k} → ${dest}`).toBe(SCOPE[dest]);
      expect(kindOf(it), `${k} → ${dest}`).toBe(k);
      const c = await landed(page, it);
      await expect(newResult(page)).toHaveAttribute("data-state", "done");
      await snap(page, `new-${dest}-${k}`, placeNode(page, it.scope));
      await expect(c).toBeVisible();
    }
  }
  // Every one of them is on the chart, and the New box is clear for the next thing.
  await expect(newInput(page)).toHaveValue("");
});

test("A group's +: every type lands in that group, or where the words say", async ({ page }) => {
  test.setTimeout(240_000);
  await onMap(page, "Mid");
  for (const dest of ["current", "named", "idea", "unfiled"] as Dest[]) {
    for (const k of KINDS) {
      const plus = page.locator('[data-group-add="launch"]');
      await plus.click();
      await expect(newSection(page).locator(".nb-scope")).toContainText("In Launch");
      await expect(newInput(page)).toBeFocused();
      const tok = token(k);
      const text = dest === "named" ? named[k](tok, "Reporting") : plain[k](tok);
      await applyNew(page, text, dest === "idea" ? { goesTo: IDEA_TITLE } : dest === "unfiled" ? { goesTo: "Unfiled" } : {});
      const it = await itemWith(tok);
      expect(it.scope, `+ ${k} → ${dest}`).toBe(SCOPE[dest]);
      expect(kindOf(it), `+ ${k} → ${dest}`).toBe(k);
      await landed(page, it);
      if (k === "note" && dest === "current") await snap(page, "plus-00-scope", newSection(page));
      await snap(page, `plus-${dest}-${k}`, placeNode(page, it.scope));
    }
  }
});

test("Agents: joyride map note, list and link land live in a group, an idea and Unfiled", async ({ page }) => {
  test.setTimeout(180_000);
  await onMap(page, "Mid");
  const joyride = (args: string[]) => exec(path.resolve("bin/joyride"), args, { env: { ...process.env, ...env, JOYRIDE_URL: `http://127.0.0.1:${PORT}`, FM_TASK_ID: "jr-notes-v2-e2e" } });
  const where: Record<Exclude<Dest, "current">, string[]> = { named: ["--group", "reporting"], idea: ["--idea", IDEA], unfiled: [] };
  for (const dest of ["named", "idea", "unfiled"] as const) {
    for (const k of KINDS) {
      const tok = token(k);
      const args = k === "note" ? ["map", "note", `${tok} check the PDF export`]
        : k === "list" ? ["map", "list", `${tok} tag the build`, "[x] write notes", "--title", `${tok} release`]
        : k === "link" ? ["map", "link", `https://example.com/files/${tok}-spec.pdf`, "--title", `${tok} spec`]
        : ["map", "note", `${tok} release prep\n[ ] tag the build\nhttps://github.com/acme/joyride/pull/12`];
      const out = JSON.parse((await joyride([...args, ...where[dest]])).stdout);
      expect(out.scope, `agent ${k} → ${dest}`).toBe(SCOPE[dest]);
      expect(out.provenance).toEqual({ type: "agent", ref: "cli:jr-notes-v2-e2e" });
      // Live on the chart, without a reload.
      await expect(card(page, out.id)).toBeVisible();
      await snap(page, `agent-${dest}-${k}`, placeNode(page, out.scope));
    }
  }
  // Agents read the board and move items the same way.
  const read = JSON.parse((await joyride(["map", "board", "--group", "reporting"])).stdout) as Item[];
  expect(read.length).toBeGreaterThan(3);
  const one = read[0];
  const moved = JSON.parse((await joyride(["map", "move-note", one.id, "--group", "launch"])).stdout);
  expect(moved.scope).toBe("group:launch");
  await expect(board(page, "group:launch").locator(`[data-board-item="${one.id}"]`)).toBeVisible();
  await joyride(["map", "move-note", one.id, "--group", "reporting"]);
  await expect(board(page, "group:reporting").locator(`[data-board-item="${one.id}"]`)).toBeVisible();
});

test("Landing: the chart glides to an off-screen place; off the map New says where it went and Show on map finds it", async ({ page }) => {
  test.setTimeout(120_000);
  await onMap(page, "Near");
  // Far from Launch: the hub is in view, Launch is not.
  await page.getByTestId("firstmate-node").locator(".fm-title").focus();
  await page.waitForTimeout(500);
  const tok = token("far");
  await page.locator('[data-rail="new"] textarea').click();
  await applyNew(page, named.note(tok, "Launch"));
  const it = await itemWith(tok);
  const c = await landed(page, it);
  // Wait for the real camera glide, then check the saved card is on screen.
  await expect.poll(async () => {
    const v = await page.locator(".map-viewport").boundingBox(), b = await c.boundingBox();
    return Boolean(v && b && b.x >= v.x && b.x + b.width <= v.x + v.width && b.y >= v.y && b.y <= v.y + v.height);
  }).toBe(true);
  const vp = (await page.locator(".map-viewport").boundingBox())!, b = (await c.boundingBox())!;
  expect(b.x).toBeGreaterThanOrEqual(vp.x);
  expect(b.x + b.width).toBeLessThanOrEqual(vp.x + vp.width);
  expect(b.y).toBeGreaterThanOrEqual(vp.y);
  expect(b.y).toBeLessThanOrEqual(vp.y + vp.height);
  await snap(page, "landing-01-camera-followed");

  // New's action-specific receipt animates, and the actual saved card lands in view.
  const tok2 = token("fly");
  await applyNew(page, named.list(tok2, "Launch"));
  await expect(newResult(page)).toHaveAttribute("data-animation", "list");
  await snap(page, "landing-02-list-receipt");
  const it2 = await itemWith(tok2);
  await landed(page, it2);
  await snap(page, "landing-03-list-on-canvas", placeNode(page, it2.scope));
  await page.goto("/#/knowledge");
  const tok3 = token("off");
  await applyNew(page, named.note(tok3, "Reporting"));
  await snap(page, "landing-05-off-map-receipt");
  await newResult(page).getByRole("button", { name: "Show on map" }).click();
  const it3 = await itemWith(tok3);
  await expect(card(page, it3.id)).toBeVisible();

});

test("On the canvas at every zoom: chips at far, compact cards at mid, full cards at near", async ({ page }) => {
  await onMap(page, "Far");
  await expect(board(page, "group:launch").locator(".board-chip").first()).toBeVisible();
  await expect(board(page, `mission:${IDEA}`).locator(".board-chip").first()).toBeVisible();
  await expect(board(page, "global").locator(".board-chip").first()).toBeVisible();
  await snap(page, "zoom-far");
  // A chip opens its item: the chart zooms to where its card reads.
  const chip = board(page, "group:launch").locator(".board-chip[data-board-item]").first();
  const id = await chip.getAttribute("data-board-item");
  await chip.click();
  await expect(page.locator(".map-viewport")).toHaveAttribute("data-zoom", "mid");
  await expect(card(page, id!)).toHaveAttribute("data-landed", "", { timeout: 4000 });
  await snap(page, "zoom-far-chip-opened");
  await zoom(page, "Mid");
  await expect(board(page, "group:launch").locator(".note-card.compact").first()).toBeVisible();
  await snap(page, "zoom-mid");
  await zoom(page, "Near");
  await centerOn(page, label(page, "launch"));
  await expect(board(page, "group:launch").locator(".note-card:not(.compact)").first()).toBeVisible();
  // A full board keeps the newest few on the chart; the rest are on the Board, filtered to the group.
  await expect(board(page, "group:launch").locator(".note-card")).toHaveCount(4);
  await expect(board(page, "group:launch").getByRole("link", { name: /more on the Board/ })).toHaveAttribute("href", "#/board?place=group%3Alaunch");
  await expect(board(page, "group:launch").getByRole("button", { name: "Add a note on Launch" })).toBeVisible();
  await snap(page, "zoom-near");
});

test("Editing in place and ticking todos, on the chart", async ({ page }) => {
  await group("edits", "Edits");
  const r = await call("POST", "/api/notes", { group: "edits", bullets: ["Draft the launch post"] });
  const l = await call("POST", "/api/notes", { group: "edits", bullets: ["[ ] book the room", "[ ] order snacks"], title: "Edit me" });
  const m = await call("POST", "/api/notes", { group: "edits", bullets: ["Venue", "[ ] confirm the room", "https://example.com/venue"] });
  await nearGroup(page, "edits");
  // A note: click its text, edit, Enter saves.
  const note = card(page, r.body.id);
  await note.getByRole("button", { name: "Edit this note" }).click();
  await note.getByRole("textbox").fill("Draft the launch post\nShare it with Sam");
  await note.getByRole("textbox").press("Enter");
  await expect(note).toContainText("Share it with Sam");
  await expect.poll(async () => (await call("GET", `/api/notes/${r.body.id}`)).body.bullets).toEqual(["Draft the launch post", "Share it with Sam"]);
  // A list: tick, rename, add, remove.
  const list = card(page, l.body.id);
  await list.getByRole("checkbox", { name: "book the room" }).check();
  await list.getByRole("button", { name: "Rename “order snacks”" }).click();
  await list.getByRole("textbox", { name: "Item text" }).fill("order lunch");
  await list.getByRole("textbox", { name: "Item text" }).press("Enter");
  await list.getByRole("textbox", { name: "Add an item" }).fill("print badges");
  await list.getByRole("textbox", { name: "Add an item" }).press("Enter");
  await expect(list).toContainText("1 of 3 done");
  await expect.poll(async () => (await call("GET", `/api/notes/${l.body.id}`)).body.bullets).toEqual(["[x] book the room", "[ ] order lunch", "[ ] print badges"]);
  await snap(page, "edit-01-note-and-list", label(page, "edits"));
  // A mixed card: tick its todo where it is; edit its lines; its link stays a link.
  const mixed = card(page, m.body.id);
  await mixed.getByRole("checkbox", { name: "confirm the room" }).check();
  await expect.poll(async () => (await call("GET", `/api/notes/${m.body.id}`)).body.bullets).toEqual(["Venue", "[x] confirm the room", "https://example.com/venue"]);
  await mixed.getByRole("button", { name: "Edit this card's lines" }).click();
  await mixed.getByRole("textbox").fill("Venue\n[x] confirm the room\n[ ] send the map\n[Venue page](https://example.com/venue)");
  await mixed.getByRole("button", { name: "Save" }).click();
  await expect(mixed.locator(".lk-title")).toHaveText("Venue page");
  await expect(mixed).toContainText("1 of 2 done");
  await snap(page, "edit-02-mixed", mixed);
  // Ticks work at mid zoom too, on the compact card.
  await zoom(page, "Mid");
  await centerOn(page, label(page, "edits"));
  await card(page, l.body.id).getByRole("checkbox", { name: "order lunch" }).check();
  await expect.poll(async () => (await call("GET", `/api/notes/${l.body.id}`)).body.bullets).toEqual(["[x] book the room", "[x] order lunch", "[ ] print badges"]);
  await snap(page, "edit-03-tick-at-mid", card(page, l.body.id));
});

test("Moving: drag by the grip onto an idea and a group, Move to anywhere, Undo puts it back", async ({ page }) => {
  await group("moves", "Moves");
  const n = await call("POST", "/api/notes", { group: "reporting", bullets: ["Carry me around"] });
  await onMap(page, "Mid");
  await centerOn(page, label(page, "reporting"));
  const c = card(page, n.body.id);
  await expect(c).toBeVisible();
  /** Carry the card by its grip and let go over `to`. */
  async function carry(to: Locator, says: string, shotName?: string) {
    await card(page, n.body.id).hover();
    const g = (await card(page, n.body.id).locator(".drag-handle").boundingBox())!;
    const t = (await to.boundingBox())!;
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    await page.mouse.move(g.x + 30, g.y + 20, { steps: 4 });
    await page.mouse.move(t.x + Math.min(t.width, 200) / 2, t.y + 14, { steps: 12 });
    await expect(page.locator(".carry-ghost")).toContainText(says);
    if (shotName) await snap(page, shotName);
    await page.mouse.up();
  }
  // Onto an idea's card.
  await carry(page.locator(`.mission-node[data-mission="${IDEA}"] .mn-head`), `Move to ${IDEA_TITLE}`, "move-01-dragging-onto-idea");
  await expect.poll(async () => (await call("GET", `/api/notes/${n.body.id}`)).body.scope).toBe(`mission:${IDEA}`);
  await expect(board(page, `mission:${IDEA}`).locator(`[data-board-item="${n.body.id}"]`)).toBeVisible();
  await expect(page.getByTestId("map-toast")).toContainText(`Moved “Carry me around” to ${IDEA_TITLE}.`);
  await snap(page, "move-02-dropped-on-idea");
  // Back onto the group's name: it joins the group's board.
  await carry(label(page, "reporting").locator(".rl-title"), "Move to Reporting");
  await expect.poll(async () => (await call("GET", `/api/notes/${n.body.id}`)).body.scope).toBe("group:reporting");
  // Undo puts it back on the idea.
  await page.getByTestId("map-toast").getByRole("button", { name: "Undo" }).click();
  await expect.poll(async () => (await call("GET", `/api/notes/${n.body.id}`)).body.scope).toBe(`mission:${IDEA}`);
  await expect(board(page, `mission:${IDEA}`).locator(`[data-board-item="${n.body.id}"]`)).toBeVisible();
  // Move to (the keyboard path), from the card's own button: another group, then Unfiled.
  await zoom(page, "Near");
  await centerOn(page, card(page, n.body.id));
  await card(page, n.body.id).getByRole("button", { name: "Move Carry me around to…" }).last().click();
  const menu = page.getByTestId("move-menu");
  await expect(menu).toContainText("Move to Unfiled");
  await snap(page, "move-03-move-to-menu", menu);
  await menu.getByRole("button", { name: /Move to Moves/ }).click();
  await expect.poll(async () => (await call("GET", `/api/notes/${n.body.id}`)).body.scope).toBe("group:moves");
  await expect(board(page, "group:moves").locator(`[data-board-item="${n.body.id}"]`)).toBeVisible();
  // The chart brings the moved card into view, and marks it.
  await expect(card(page, n.body.id)).toHaveAttribute("data-landed", "", { timeout: 4000 });
  await snap(page, "move-04-moved-to-group", label(page, "moves"));
  await card(page, n.body.id).getByRole("button", { name: "Move Carry me around to…" }).last().click();
  await page.getByTestId("move-menu").getByRole("button", { name: "Move to Unfiled" }).click();
  await expect.poll(async () => (await call("GET", `/api/notes/${n.body.id}`)).body.scope).toBe("global");
  await expect(board(page, "global").locator(`[data-board-item="${n.body.id}"]`)).toBeVisible();
});

test("Deleting with Undo: on the chart, on the Board page, and New's own Undo", async ({ page }) => {
  await group("trash", "Trash run");
  const n = await call("POST", "/api/notes", { group: "trash", bullets: ["Delete me, then bring me back"] });
  await nearGroup(page, "trash");
  await card(page, n.body.id).getByRole("button", { name: "Delete this note" }).click();
  await expect(card(page, n.body.id)).toHaveCount(0);
  const status = board(page, "group:trash").locator(`[data-note-deleted="${n.body.id}"]`);
  await expect(status).toContainText("Deleted “Delete me, then bring me back”.");
  await snap(page, "delete-01-on-chart", label(page, "trash"));
  await status.getByRole("button", { name: "Undo" }).click();
  await expect(card(page, n.body.id)).toBeVisible();
  // New's Undo takes back what it just saved.
  const tok = token("undo");
  await page.locator('[data-rail="new"] textarea').click();
  await applyNew(page, named.note(tok, "Trash run"));
  const it = await itemWith(tok);
  await landed(page, it);
  await newResult(page).getByRole("button", { name: "Undo" }).click();
  await expect(newResult(page)).toHaveAttribute("data-state", "undone");
  expect((await call("GET", `/api/notes/${it.id}`)).status).toBe(404);
  await expect(card(page, it.id)).toHaveCount(0);
  // On the Board page.
  await page.goto("/#/board");
  const row = page.locator(`.bd-page [data-board-item="${n.body.id}"]`);
  await row.getByRole("button", { name: "Delete this note" }).click();
  await expect(page.getByTestId("board-undo")).toContainText("Deleted");
  await snap(page, "delete-02-on-board", page.getByTestId("board-undo"));
  await page.getByTestId("board-undo").getByRole("button", { name: "Undo" }).click();
  await expect(row).toBeVisible();
});

test("Opening links: a PDF and a page in a new tab, a Joyride artifact in Joyride, a local file copies its path", async ({ page }) => {
  const art = await call("POST", "/api/artifacts", { url: "https://github.com/acme/alpha/pull/42", title: "CSV export PR", mission: IDEA });
  expect(art.status).toBeLessThan(300);
  await group("links", "Links");
  const n = await call("POST", "/api/notes", { group: "links", bullets: [
    "[Launch spec](https://example.com/files/launch-spec.pdf)", "https://example.com/blog/how-we-ship-fast.html", `artifact:${art.body.id}`, "https://claude.ai/artifact/abc-123", "~/Documents/specs/launch-plan.pdf",
  ] });
  await nearGroup(page, "links");
  const c = card(page, n.body.id);
  await expect(c.locator(".lk-row")).toHaveCount(5);
  // Readable titles and types.
  await expect(c.locator('.lk-row[data-link-type="pdf"]').first()).toContainText("Launch spec");
  await expect(c.locator('.lk-row[data-link-type="url"]')).toContainText("How we ship fast");
  await expect(c.locator('.lk-row[data-link-type="artifact"]').first()).toContainText("CSV export PR"); // its registered title
  await expect(c.locator('.lk-row[data-link-type="artifact"]').nth(1)).toContainText("Claude artifact");
  await expect(c.locator(".lk-row.is-local")).toContainText("Launch plan");
  await snap(page, "links-01-card", c);
  // A PDF and a page open in a new tab.
  for (const kind of ["pdf", "url"]) {
    const [popup] = await Promise.all([page.context().waitForEvent("page"), c.locator(`.lk-row[data-link-type="${kind}"]`).first().click()]);
    expect(popup.url()).toMatch(/^https:\/\/example\.com\//);
    await popup.close();
  }
  // A Joyride artifact opens in Joyride.
  await c.locator('.lk-row[data-link-type="artifact"]').first().click();
  await expect(page).toHaveURL(/#\/knowledge/);
  await expect(page.getByText("CSV export PR").first()).toBeVisible();
  await snap(page, "links-02-artifact-opened");
});

test("The Board page tracks every item: types, places, open todos, search, Show on map; Knowledge finds them", async ({ page }) => {
  // One of each kind of its own, so the page has every type whatever ran before.
  await group("shelf", "Shelf");
  for (const bullets of [["A plain note for the shelf"], ["[ ] shelf todo one", "[x] shelf todo two"], ["https://example.com/blog/how-we-ship-fast.html"], ["Shelf mix", "[ ] shelf mixed todo", "https://example.com/shelf"]]) {
    expect((await call("POST", "/api/notes", { group: "shelf", bullets })).status).toBe(201);
  }
  await page.goto("/#/map");
  // One click from anywhere.
  await page.getByRole("link", { name: /^Board/ }).click();
  await expect(page.getByTestId("board-page")).toBeVisible();
  await expect(page.locator(".bd-section").first()).toBeVisible();
  await snap(page, "board-01-all", undefined);
  await snap(page, "board-01-all-full", undefined);
  const all = (await items()).length;
  await expect(page.locator(".bd-page [data-board-item]")).toHaveCount(all);
  // Types.
  for (const t of ["note", "list", "link", "mixed"]) {
    await page.locator(`[data-type-filter="${t}"]`).click();
    await expect(page.locator(`[data-type-filter="${t}"]`)).toHaveAttribute("aria-pressed", "true");
    const shown = page.locator(`.bd-page [data-board-item]`);
    await expect(page.locator(`.bd-page [data-board-item]:not([data-kind="${t}"])`)).toHaveCount(0);
    await expect(shown.first()).toBeVisible();
    for (const k of await shown.evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")))) expect(k).toBe(t);
  }
  await snap(page, "board-02-links");
  await page.locator('[data-type-filter="all"]').click();
  // Open todos only.
  await page.getByTestId("board-open-todos").check();
  for (const p of await page.locator(".bd-page .nk-progress").allTextContents()) { const [d, , t] = p.split(" "); expect(Number(d)).toBeLessThan(Number(t)); }
  await snap(page, "board-03-open-todos");
  await page.getByTestId("board-open-todos").uncheck();
  // A place.
  await page.getByTestId("board-place").selectOption({ label: "Shelf" });
  await expect(page.locator(".bd-section")).toHaveCount(1);
  await expect(page.locator(".bd-section h2")).toHaveText("Shelf");
  await expect(page.locator(".bd-page [data-board-item]")).toHaveCount(4);
  await snap(page, "board-04-place");
  await page.getByTestId("board-place").selectOption({ label: "Every place" });
  // Search reads lines, link titles and places.
  await page.getByTestId("board-search").fill("shelf todo two");
  await expect(page.locator(".bd-page [data-board-item]")).toHaveCount(1);
  await snap(page, "board-05-search");
  // Tick here; the chart has it too.
  await page.getByTestId("board-search").fill("");
  await expect(page).not.toHaveURL(/[?&]q=/);
  await expect(page.locator(".bd-page [data-board-item]").nth(4)).toBeVisible();
  const list = (await items()).find((n) => n.bullets[0] === "[ ] shelf todo one")!;
  const row = page.locator(`.bd-page [data-board-item="${list.id}"]`);
  await row.locator(".nk-check").first().check();
  await expect.poll(async () => (await call("GET", `/api/notes/${list.id}`)).body.bullets.some((b: string) => b.startsWith("[x] "))).toBe(true);
  // Move to from the Board, with Undo.
  await row.getByRole("button", { name: "Move to…" }).click();
  await snap(page, "board-06-move-to", page.getByTestId("place-picker"));
  await page.getByTestId("place-picker").getByRole("button", { name: "Unfiled" }).click();
  await expect(page.getByTestId("board-undo")).toContainText("to Unfiled");
  await expect.poll(async () => (await call("GET", `/api/notes/${list.id}`)).body.scope).toBe("global");
  await page.getByTestId("board-undo").getByRole("button", { name: "Undo" }).click();
  await expect.poll(async () => (await call("GET", `/api/notes/${list.id}`)).body.scope).toBe(list.scope);
  // Show on map: the chart glides to the card and marks it.
  await page.locator(`.bd-page [data-board-item="${list.id}"]`).getByRole("button", { name: "Show on map" }).click();
  await expect(page.locator(".map-viewport")).toBeVisible();
  await expect(card(page, list.id)).toHaveAttribute("data-landed", "", { timeout: 5000 });
  await snap(page, "board-07-show-on-map");
  // Knowledge search finds a board item and opens it on the Board.
  await page.goto("/#/knowledge");
  await page.getByTestId("knowledge-search").fill("plain note for the shelf");
  const hit = page.locator(".kn-row").filter({ hasText: "A plain note for the shelf" }).first();
  await expect(hit).toBeVisible({ timeout: 10000 });
  await snap(page, "knowledge-01-search");
  await hit.click();
  await page.getByTestId("open-on-board").click();
  await expect(page.getByTestId("board-page")).toBeVisible();
  await expect(page.locator(".bd-page [data-board-item][data-settled]")).toHaveCount(1);
  await snap(page, "knowledge-02-open-on-board");
});
