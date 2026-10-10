// The one "New task" box's intent rules (shared/compose.ts): a leading cue makes a note or a list for
// certain, a mention alone is unsure (Jev's kind question), anything else is a task; Change recasts the
// text; the ghost card's note and list helpers; lists as checkbox bullets (shared/notes.ts).
import { describe, it, expect } from "vitest";
import { listItems, readCompose, recast } from "../../src/shared/compose.ts";
import { LIST_TITLE, isListBullets, listItem, parseListItem, toBullets, bulletsBody, bulletsOf } from "../../src/shared/notes.ts";
import { ghostFrom, noteInput, notePlace, recastGhost } from "../../src/ui/components/compose/ghost.ts";

const read = (t: string) => readCompose(t);

describe("intent rules", () => {
  it("reads a leading note cue as a note, the cue stripped", () => {
    expect(read("add a note: check the PDF export before Friday")).toEqual({ kind: "note", sure: true, title: null, lines: ["check the PDF export before Friday"] });
    for (const [t, line] of [
      ["note: totals row goes last", "totals row goes last"],
      ["Note - totals row goes last", "totals row goes last"],
      ["Note that the API is slow", "the API is slow"],
      ["note to self: call Sam", "call Sam"],
      ["make a note of the key rotation", "the key rotation"],
      ["take a quick note: ship on Friday", "ship on Friday"],
      ["add a note on this idea: totals row last", "totals row last"],
      ["jot down: buy milk", "buy milk"],
      ["Please add a note — keep the old export", "keep the old export"],
    ]) expect(read(t), t).toMatchObject({ kind: "note", sure: true, lines: [line] });
  });

  it("keeps a multi-line note as one bullet per line", () => {
    expect(read("note:\n- first\n- second")).toMatchObject({ kind: "note", lines: ["first", "second"] });
    expect(read("note to self: call Sam\nbring the deck").lines).toEqual(["call Sam", "bring the deck"]);
  });

  it("reads a leading list cue as a list, with its items and an optional name", () => {
    expect(read("make a list: a, b, c")).toEqual({ kind: "list", sure: true, title: null, lines: ["a", "b", "c"] });
    expect(read("make a list: milk, eggs and bread").lines).toEqual(["milk", "eggs", "bread"]);
    expect(read("list: a; b; c").lines).toEqual(["a", "b", "c"]);
    expect(read("checklist:\n- one\n- two")).toMatchObject({ kind: "list", lines: ["one", "two"] });
    expect(read("add a todo list: x, y")).toMatchObject({ kind: "list", lines: ["x", "y"] });
    expect(read("make a grocery list: milk, eggs")).toMatchObject({ kind: "list", title: "Grocery list", lines: ["milk", "eggs"] });
    expect(read("make a list for the release: tag, notes, announce")).toMatchObject({ title: "The release", lines: ["tag", "notes", "announce"] });
    expect(read("start a new checklist called Launch: write post, ship")).toMatchObject({ title: "Launch", lines: ["write post", "ship"] });
    expect(read("make a list of milk, eggs and bread")).toMatchObject({ title: null, lines: ["milk", "eggs", "bread"] });
    // A name with no items yet: the composer asks for them.
    expect(read("make a list for the release")).toEqual({ kind: "list", sure: true, title: "The release", lines: [] });
  });

  it("reads a block of checkboxes as a list, a first line ending in a colon as its name", () => {
    expect(read("- [ ] a\n- [x] b")).toMatchObject({ kind: "list", sure: true, title: null, lines: ["a", "b"] });
    expect(read("Release:\n- [ ] tag\n- [ ] announce")).toMatchObject({ kind: "list", title: "Release", lines: ["tag", "announce"] });
  });

  it("leaves work as a task, and only a mention of notes or lists as unsure", () => {
    expect(read("Fix the flaky CSV test")).toEqual({ kind: "task", sure: true, title: null, lines: [] });
    expect(read("Add a totals row to the CSV export")).toMatchObject({ kind: "task", sure: true });
    for (const t of ["add a note field to the user model", "create a list view for the report page", "make the list endpoint faster", "remember the PDF export is flaky", "update the release notes"]) {
      expect(read(t), t).toMatchObject({ kind: "task", sure: false });
    }
    expect(read("   ")).toMatchObject({ kind: "task", sure: true, lines: [] });
  });

  it("splits list items on lines, commas and semicolons, and a final and", () => {
    expect(listItems("salt and pepper")).toEqual(["salt and pepper"]);
    expect(listItems("a, b & c.")).toEqual(["a", "b", "c"]);
    expect(listItems("1. one\n2) two\n* three")).toEqual(["one", "two", "three"]);
    expect(listItems("")).toEqual([]);
  });

  it("recasts the same words for Change on the card", () => {
    expect(recast("Fix the CSV test, then the PDF", "list").lines).toEqual(["Fix the CSV test", "then the PDF"]);
    expect(recast("Fix the CSV test", "note")).toEqual({ kind: "note", sure: true, title: null, lines: ["Fix the CSV test"] });
    expect(recast("make a grocery list: milk, eggs", "note").lines).toEqual(["Grocery list", "milk", "eggs"]);
    expect(recast("note:\n- a\n- b", "list").lines).toEqual(["a", "b"]);
    expect(recast("add a note: a, b", "list").lines).toEqual(["a", "b"]);
    expect(recast("note: anything", "task")).toMatchObject({ kind: "task", lines: [] });
  });
});

describe("ghost card: notes and lists", () => {
  const base = { id: "g1", created: 1 };
  it("a sure note or list waits to be saved; a task is placed; unsure text asks Jev", () => {
    expect(ghostFrom("note: x", base)).toMatchObject({ phase: "placed", as: "note", lines: ["x"] });
    expect(ghostFrom("list: a, b", { ...base, idea: "i", ideaTitle: "Idea" })).toMatchObject({ phase: "placed", as: "list", lines: ["a", "b"], idea: "i" });
    expect(ghostFrom("Fix it", base)).toMatchObject({ phase: "placing", as: "task" });
    expect(ghostFrom("Fix it", base).unsure).toBeUndefined();
    expect(ghostFrom("remember to fix it", base)).toMatchObject({ phase: "placing", as: "task", unsure: true });
  });

  it("saves on the idea it was typed into, else on the hub", () => {
    expect(notePlace({ idea: "csv", ideaTitle: "CSV export" })).toEqual({ anchor: { kind: "mission", id: "csv" }, name: "CSV export", place: { kind: "idea", id: "csv", title: "CSV export" } });
    expect(notePlace({})).toEqual({ anchor: { kind: "global" }, name: "Unfiled", place: { kind: "unfiled" } });
    // Without an idea, the group the captain is on.
    expect(notePlace({}, { id: "launch", title: "Launch" })).toEqual({ anchor: { kind: "group", id: "launch" }, name: "Launch", place: { kind: "group", id: "launch", title: "Launch" } });
    expect(notePlace({ idea: "csv" }, { id: "launch", title: "Launch" }).anchor).toEqual({ kind: "mission", id: "csv" });
  });

  it("saves a note's bullets, and a list's items as checkboxes under its name", () => {
    expect(noteInput({ as: "note", lines: ["a", " ", "b"] })).toEqual({ bullets: ["a", "b"] });
    expect(noteInput({ as: "list", lines: ["milk", "eggs"], title: "Groceries" })).toEqual({ bullets: ["[ ] milk", "[ ] eggs"], title: "Groceries" });
    expect(noteInput({ as: "list", lines: ["milk"], title: null })).toEqual({ bullets: ["[ ] milk"], title: LIST_TITLE });
  });

  it("recasts a ghost for Change", () => {
    const g = ghostFrom("make a list: a, b", base);
    expect(recastGhost(g, "note")).toEqual({ as: "note", unsure: false, lines: ["a", "b"], title: null });
    expect(recastGhost(g, "task")).toMatchObject({ as: "task", lines: [] });
  });
});

describe("lists as notes", () => {
  it("is a list when every bullet is a checkbox, and survives the note body round trip", () => {
    const bullets = [listItem("milk"), listItem("eggs", true)];
    expect(bullets).toEqual(["[ ] milk", "[x] eggs"]);
    expect(isListBullets(bullets)).toBe(true);
    expect(isListBullets(["[ ] milk", "plain"])).toBe(false);
    expect(isListBullets([])).toBe(false);
    expect(bulletsOf(bulletsBody(bullets))).toEqual(bullets);
    expect(toBullets("- [ ] milk\n- [X] eggs")).toEqual(["[ ] milk", "[X] eggs"]);
    expect(parseListItem("[X] eggs")).toEqual({ done: true, text: "eggs" });
    expect(parseListItem("[ ] milk")).toEqual({ done: false, text: "milk" });
    expect(parseListItem("plain")).toEqual({ done: false, text: "plain" });
  });
});
