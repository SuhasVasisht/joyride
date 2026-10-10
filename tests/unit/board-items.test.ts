// Board items (shared/board.ts): one model for notes, lists, links and mixed cards, the compose rules that make
// them (shared/compose.ts), where a drag or Move to takes one on the map (map/regroup.ts), the places they live
// (components/notes/places.ts) and the Board page's filters (views/board/model.ts).
import { describe, it, expect } from "vitest";
import { blockLine, describeLink, itemKind, itemLabel, itemText, linkLine, linkTarget, parseBlock, parseBlocks, parseLink, todoCount } from "../../src/shared/board.ts";
import { noteLines, readCompose } from "../../src/shared/compose.ts";
import { noteScope, parseNoteScope } from "../../src/shared/notes.ts";
import { menuTargets, missionTarget, moveBody, noteScopeOf, regionTarget, dragHint, kindLabel, type DragItem } from "../../src/ui/views/map/regroup";
import { placesFrom } from "../../src/ui/components/notes/places";
import { boardCounts, filterBoard, groupBoard, hasOpenTodo, type BoardNote } from "../../src/ui/views/board/model";

describe("links", () => {
  it("knows a web page, a PDF, a Claude or Joyride artifact and a local file from its address", () => {
    expect(linkTarget("https://example.com/docs/setup")).toEqual({ href: "https://example.com/docs/setup", type: "url" });
    expect(linkTarget("www.example.com/a")).toEqual({ href: "https://www.example.com/a", type: "url" });
    expect(linkTarget("https://example.com/files/Q4.PDF")?.type).toBe("pdf");
    expect(linkTarget("https://claude.ai/artifact/abc-123")?.type).toBe("artifact");
    expect(linkTarget("https://claude.ai/code/artifact/0f2c")?.type).toBe("artifact");
    expect(linkTarget("artifact:rep-kb-1")).toEqual({ href: "#/artifacts/rep-kb-1", type: "artifact", artifact: "rep-kb-1" });
    expect(linkTarget("#/artifacts/rep-kb-1")?.artifact).toBe("rep-kb-1");
    expect(linkTarget("http://127.0.0.1:4317/#/artifacts/rep-kb-1")).toEqual({ href: "#/artifacts/rep-kb-1", type: "artifact", artifact: "rep-kb-1" });
    expect(linkTarget("~/Documents/specs/launch plan.pdf")).toBeNull(); // a space ends a path
    expect(linkTarget("~/Documents/specs/launch-plan.pdf")).toEqual({ href: "~/Documents/specs/launch-plan.pdf", type: "pdf" });
    expect(linkTarget("/tmp/report.csv")?.type).toBe("file");
    // Sentence punctuation after an address isn't part of it.
    expect(linkTarget("https://example.com/a.")?.href).toBe("https://example.com/a");
    expect(linkTarget("(https://example.com/a)")).toBeNull();
    for (const t of ["", "milk", "call Sam at 5", "example.com", "/", "javascript:alert(1)"]) expect(linkTarget(t), t).toBeNull();
  });

  it("names a link without a label readably: a file name, a forge's PR, a page's last words, else its site", () => {
    expect(describeLink("https://example.com/files/Q4-plan_v2.pdf", "pdf")).toEqual({ title: "Q4 plan v2", where: "example.com" });
    expect(describeLink("https://github.com/acme/joyride/pull/12", "url")).toEqual({ title: "acme/joyride PR #12", where: "github.com" });
    expect(describeLink("https://github.com/acme/joyride/issues/7", "url").title).toBe("acme/joyride issue #7");
    expect(describeLink("https://github.com/acme/joyride", "url").title).toBe("acme/joyride");
    expect(describeLink("https://www.example.com/blog/how-we-ship-fast.html", "url")).toEqual({ title: "How we ship fast", where: "example.com" });
    expect(describeLink("https://example.com/", "url")).toEqual({ title: "example.com", where: "example.com" });
    expect(describeLink("https://claude.ai/artifact/abc", "artifact").title).toBe("Claude artifact");
    expect(describeLink("#/artifacts/x", "artifact", "x")).toEqual({ title: "Artifact", where: "Joyride artifact" });
    expect(describeLink("~/Documents/specs/launch-plan.pdf", "pdf")).toEqual({ title: "Launch plan", where: "~/Documents/specs" });
  });

  it("reads a link line with a label, a bare address, or an address and a few words", () => {
    expect(parseLink("[Launch spec](https://example.com/s.pdf)")?.link).toMatchObject({ href: "https://example.com/s.pdf", type: "pdf", title: "Launch spec", derived: false });
    expect(parseLink("[Spec](https://example.com/s.pdf) - read before Friday")).toMatchObject({ note: "read before Friday" });
    expect(parseLink("https://example.com/s.pdf")?.link).toMatchObject({ title: "S", derived: true });
    expect(parseLink("Launch spec https://example.com/s.pdf")?.link).toMatchObject({ title: "Launch spec", derived: false });
    expect(parseLink("https://example.com/s.pdf Launch spec")?.link.title).toBe("Launch spec");
    // A sentence that mentions a link is text, and so is a link in the middle of words.
    expect(parseLink("we decided in https://example.com/a that the totals row should stay last because finance asked twice for it")).toBeNull();
    expect(parseLink("see https://example.com/a for more")).toBeNull();
    expect(parseLink("[](notalink)")).toBeNull();
  });
});

describe("one item model", () => {
  it("reads each line as text, a todo or a link, and writes it back as the same line", () => {
    const lines = ["Rehearse the demo", "[ ] tell Sam", "[x] book the room", "[Brief](https://example.com/brief.pdf)", "https://example.com/files/q4.pdf", "artifact:rep-1"];
    const blocks = parseBlocks(lines);
    expect(blocks.map((b) => b.kind)).toEqual(["text", "todo", "todo", "link", "link", "link"]);
    expect(blocks[2]).toEqual({ kind: "todo", done: true, text: "book the room" });
    expect(blocks.map(blockLine)).toEqual(lines);
    expect(blockLine({ ...(parseBlock("[ ] tell Sam") as any), done: true })).toBe("[x] tell Sam");
    expect(linkLine("https://example.com/a", "A page")).toBe("[A page](https://example.com/a)");
    expect(linkLine("https://example.com/a")).toBe("https://example.com/a");
    expect(linkLine("https://example.com/a", "  ")).toBe("https://example.com/a");
  });

  it("says what an item is: a note, a list, a link card or a mixed card", () => {
    expect(itemKind(["just words", "more words"])).toBe("note");
    expect(itemKind(["[ ] a", "[x] b"])).toBe("list");
    expect(itemKind(["https://example.com/a", "[B](https://example.com/b.pdf)"])).toBe("link");
    expect(itemKind(["words", "[ ] a"])).toBe("mixed");
    expect(itemKind(["words", "https://example.com/a"])).toBe("mixed");
    expect(itemKind([])).toBe("note");
  });

  it("counts todos anywhere in an item, and names it in one line", () => {
    expect(todoCount(["words", "[ ] a", "[x] b", "[X] c"])).toEqual({ done: 2, total: 3 });
    expect(itemLabel({ title: "Demo day", bullets: ["[ ] a"] })).toBe("Demo day");
    expect(itemLabel({ title: "List", bullets: ["[ ] book the room", "[ ] send invites"] })).toBe("book the room, send invites");
    expect(itemLabel({ title: null, bullets: ["[Launch spec](https://example.com/s.pdf)"] })).toBe("Launch spec");
    expect(itemLabel({ title: "Reading", bullets: ["https://a.dev/x", "https://b.dev/y"] })).toBe("Reading");
    expect(itemLabel({ title: null, bullets: ["https://a.dev/x", "https://b.dev/y"] })).toBe("2 links");
    expect(itemLabel({ title: "whatever", bullets: ["https://example.com/q4.pdf", "Read before Friday"] })).toBe("Q4");
    expect(itemLabel({ title: "x", bullets: ["a".repeat(100)] }, 20)).toHaveLength(20);
    expect(itemText({ title: "T", bullets: ["[Spec](https://example.com/s.pdf)", "[ ] call Sam"] })).toContain("spec");
    expect(itemText({ title: "T", bullets: ["[Spec](https://example.com/s.pdf)"] })).toContain("example.com");
  });
});

describe("making items from words", () => {
  it("keeps a note's checkboxes and links line by line (a mixed card)", () => {
    expect(readCompose("note: launch prep\n- [ ] book the room\n* [x] send invites\nhttps://example.com/brief.pdf")).toEqual({
      kind: "note", sure: true, title: null, lines: ["launch prep", "[ ] book the room", "[x] send invites", "https://example.com/brief.pdf"],
    });
    expect(noteLines("- [ ]\n- a")).toEqual(["a"]);
  });

  it("makes a link card from addresses alone, or a link cue", () => {
    for (const [t, lines] of [
      ["https://example.com/files/q4.pdf", ["https://example.com/files/q4.pdf"]],
      ["https://a.dev/x https://b.dev/y", ["https://a.dev/x", "https://b.dev/y"]],
      ["https://a.dev/x\nhttps://b.dev/y", ["https://a.dev/x", "https://b.dev/y"]],
      ["- [Spec](https://example.com/s.pdf)\n- https://claude.ai/artifact/abc", ["[Spec](https://example.com/s.pdf)", "https://claude.ai/artifact/abc"]],
      ["link: https://example.com/a", ["https://example.com/a"]],
      ["pdf: Launch spec https://example.com/s.pdf", ["Launch spec https://example.com/s.pdf"]],
      ["bookmark - artifact:rep-1", ["artifact:rep-1"]],
      ["save this link https://example.com/a", ["https://example.com/a"]],
      ["Save the PDF: https://example.com/s.pdf", ["https://example.com/s.pdf"]],
    ] as const) expect(readCompose(t), t).toEqual({ kind: "note", sure: true, title: null, lines });
    // Work that mentions an address is still work.
    expect(readCompose("Fix the 404 on https://example.com/a")).toMatchObject({ kind: "task" });
  });
});

describe("places", () => {
  it("parses a group scope, and takes one place from group, idea, task, session or global", () => {
    expect(parseNoteScope("group:launch")).toEqual({ kind: "group", id: "launch" });
    expect(parseNoteScope("group:../x")).toBeNull();
    expect(noteScope({ group: "launch" })).toBe("group:launch");
    expect(() => noteScope({ group: "launch", idea: "x" })).toThrow(/one place/);
    expect(() => noteScope({ scope: "lens:launch" })).toThrow(/group:<group>/);
  });

  it("names places for the board and Move to, and shows a deleted group's items in Unfiled", () => {
    const p = placesFrom([{ id: "launch", title: "Launch" }], [
      { id: "csv", title: "CSV export", state: "active" }, { id: "old", title: "Old", state: "done" }, { id: "arch", title: "Archived", state: "active", archive: true },
    ] as any);
    expect(p.options.map((o) => `${o.kind}:${o.title}`)).toEqual(["unfiled:Unfiled", "group:Launch", "idea:CSV export"]);
    expect(p.label("global")).toBe("Unfiled");
    expect(p.label("group:launch")).toBe("Launch");
    expect(p.label("mission:old")).toBe("Old");
    expect(p.label("task:jr-1")).toBe("Task jr-1");
    expect(p.shownIn("group:launch")).toBe("group:launch");
    expect(p.shownIn("group:gone")).toBe("global");
    expect(p.label("group:gone")).toBe("Unfiled");
  });
});

describe("moving an item on the map", () => {
  const item = (from: string): DragItem => ({ kind: "note", id: "note-a", label: "Demo day", from });
  const mission = (id: string, over: any = {}) => ({ id, title: id.toUpperCase(), ...over });
  it("drops on a group, an idea or the hub (Unfiled), never where it already is and never a new group", () => {
    expect(regionTarget(item("global"), { id: "lens:launch", kind: "lens", title: "Launch", lens: "launch" })).toEqual({ kind: "lens", id: "launch", title: "Launch", region: "lens:launch" });
    expect(regionTarget(item("group:launch"), { id: "lens:launch", kind: "lens", title: "Launch", lens: "launch" })).toBeNull();
    expect(regionTarget(item("group:launch"), { id: "firstmate", kind: "firstmate", title: "Firstmate" })).toEqual({ kind: "unfiled" });
    expect(regionTarget(item("global"), { id: "firstmate", kind: "firstmate", title: "Firstmate" })).toBeNull();
    expect(regionTarget(item("global"), { id: "repo:/r", kind: "repo", title: "r" })).toBeNull();
    expect(missionTarget(item("global"), mission("csv"))).toEqual({ kind: "mission", id: "csv", title: "CSV" });
    expect(missionTarget(item("mission:csv"), mission("csv"))).toBeNull();
    expect(missionTarget(item("global"), mission("csv", { archive: true }))).toBeNull();
    expect(noteScopeOf({ kind: "lens", id: "launch", title: "Launch", region: "lens:launch" })).toBe("group:launch");
    expect(noteScopeOf({ kind: "mission", id: "csv", title: "CSV" })).toBe("mission:csv");
    expect(noteScopeOf({ kind: "unfiled" })).toBe("global");
    expect(noteScopeOf({ kind: "new-group" })).toBeNull();
    expect(moveBody(item("global"), { kind: "unfiled" })).toBeNull();
    expect(kindLabel(item("global"))).toBe("Board item");
    expect(dragHint(item("global"))).toMatch(/group or an idea/);
  });

  it("offers Unfiled, every other group and every open idea in Move to", () => {
    const t = menuTargets(item("group:launch"), [mission("csv"), mission("arch", { archive: true })], [{ id: "launch", title: "Launch" }, { id: "later", title: "Later" }], () => "Reporting");
    expect(t).toEqual([
      { target: { kind: "unfiled" } },
      { target: { kind: "lens", id: "later", title: "Later", region: "lens:later" }, where: "Group" },
      { target: { kind: "mission", id: "csv", title: "CSV" }, where: "Reporting" },
    ]);
    expect(menuTargets(item("global"), [], [{ id: "launch", title: "Launch" }]).map((x) => x.target.kind)).toEqual(["lens"]);
  });
});

describe("the Board page", () => {
  const n = (id: string, scope: string, bullets: string[], updated = "2026-10-05T10:00:00Z", title = ""): BoardNote => ({ id, scope, bullets, title, created: updated, updated });
  const places = placesFrom([{ id: "launch", title: "Launch" }], [{ id: "csv", title: "CSV export", state: "active" }] as any);
  const notes = [
    n("a", "group:launch", ["[ ] book the room", "[x] send invites"], "2026-10-05T12:00:00Z", "Demo day"),
    n("b", "global", ["Rotate the staging keys"], "2026-10-05T11:00:00Z"),
    n("c", "mission:csv", ["[Spec](https://example.com/spec.pdf)"], "2026-10-05T09:00:00Z"),
    n("d", "group:gone", ["Mixed", "[ ] call Sam", "https://example.com/x"], "2026-10-05T08:00:00Z"),
    n("e", "task:jr-1", ["Keep the hook fast"], "2026-10-04T08:00:00Z"),
    n("f", "group:launch", ["[x] done item"], "2026-10-05T07:00:00Z"),
  ];
  const ids = (xs: BoardNote[]) => xs.map((x) => x.id);
  it("filters by type, open todos, place and words in any line, link title or place", () => {
    const f = (o: Partial<Parameters<typeof filterBoard>[1]>) => ids(filterBoard(notes, { q: "", type: "all", place: "all", open: false, ...o }, places));
    expect(f({})).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(f({ type: "list" })).toEqual(["a", "f"]);
    expect(f({ type: "link" })).toEqual(["c"]);
    expect(f({ type: "mixed" })).toEqual(["d"]);
    expect(f({ open: true })).toEqual(["a", "d"]);
    expect(f({ place: "group:launch" })).toEqual(["a", "f"]);
    expect(f({ place: "global" })).toEqual(["b", "d"]); // a deleted group's item shows in Unfiled
    expect(f({ place: "other" })).toEqual(["e"]);
    expect(f({ q: "spec" })).toEqual(["c"]);
    expect(f({ q: "example.com" })).toEqual(["c", "d"]);
    expect(f({ q: "launch room" })).toEqual(["a"]); // the place's name counts
    expect(f({ q: "csv export" })).toEqual(["c"]);
    expect(f({ q: "nothing-like-this" })).toEqual([]);
    expect(hasOpenTodo(notes[0])).toBe(true);
    expect(hasOpenTodo(notes[5])).toBe(false);
  });
  it("groups by place, Unfiled first, then groups, ideas, tasks and agents, newest first", () => {
    const s = groupBoard(notes, places);
    expect(s.map((x) => [x.kind, x.title, ids(x.items)])).toEqual([
      ["unfiled", "Unfiled", ["b", "d"]], ["group", "Launch", ["a", "f"]], ["idea", "CSV export", ["c"]], ["other", "Task jr-1", ["e"]],
    ]);
    expect(boardCounts(notes)).toEqual({ types: { all: 6, note: 2, list: 2, link: 1, mixed: 1 }, open: 2 });
  });
});
