// CP4b notes UI helpers: bullet cleaning, multi-line paste into bullets, the list query per
// anchor, and the timeline entries a note becomes.
import { describe, it, expect } from "vitest";
import { anchorScope, cleanBullets, noteTimelineEntries, notesPath, pasteLines, type Note } from "../../src/ui/components/notes/notes.ts";
import { toBullets } from "../../src/shared/notes.ts";
import { panelRank } from "../../src/ui/views/mission/panelOrder.ts";

const note = (id: string, bullets: string[], created = "2026-10-05T10:00:00.000Z"): Note => ({
  id, kind: "note", title: bullets[0], body: bullets.map((b) => `- ${b}`).join("\n"), scope: "mission:x", status: "active",
  created, updated: created, anchor: { kind: "mission", id: "x" }, bullets,
});

describe("notes UI helpers", () => {
  it("cleans bullets the way the daemon does", () => {
    const raw = ["  - Save first ", "", "2) close later", "•  only   captain calls\nturn orange", "   "];
    expect(cleanBullets(raw)).toEqual(["Save first", "close later", "only captain calls", "turn orange"]);
    expect(cleanBullets(raw)).toEqual(toBullets(raw));
  });

  it("splits a multi-line paste into bullets around the caret", () => {
    const r = pasteLines(["first", "ab"], 1, "a", "b", "- one\n- two\n- three\n");
    expect(r).toEqual({ lines: ["first", "aone", "two", "threeb"], focus: 3 });
    expect(pasteLines([""], 0, "", "", "just one line")).toBeNull();
    expect(pasteLines([""], 0, "", "", "x\r\ny")?.lines).toEqual(["x", "y"]);
  });

  it("lists one anchor's notes", () => {
    expect(notesPath({ kind: "mission", id: "one fleet" })).toBe("/api/notes?idea=one%20fleet");
    expect(notesPath({ kind: "task", id: "cp4b-notes-ui" })).toBe("/api/notes?task=cp4b-notes-ui");
    expect(notesPath({ kind: "session", id: "claude:abc" })).toBe("/api/notes?session=claude%3Aabc");
    expect(notesPath({ kind: "global" })).toBe("/api/notes?global=1");
    expect(anchorScope({ kind: "session", id: "codex:1" })).toBe("session:codex:1");
    expect(anchorScope({ kind: "global" })).toBe("global");
  });

  it("turns notes into timeline entries", () => {
    const long = "x".repeat(200);
    const e = noteTimelineEntries([note("n1", ["Save first", "close later", "never orange"]), note("n2", [long])]);
    expect(e[0]).toEqual({ ts: "2026-10-05T10:00:00.000Z", kind: "note", noteId: "n1", text: "You noted: “Save first”", detail: "and 2 more bullets" });
    expect(e[1].detail).toBeUndefined();
    expect(e[1].text.length).toBeLessThan(140);
    expect(noteTimelineEntries(null)).toEqual([]);
  });
});

describe("the notes panel on the idea page", () => {
  it("sits after done-when even when the workspace's panel list predates it", () => {
    const listed = ["done_when", "workers", "crew", "evidence", "sessions", "decisions", "artifacts", "timeline"];
    const ids = ["timeline", "workers", "notes", "done_when", "dependencies"];
    expect([...ids].sort((a, b) => panelRank(listed, a) - panelRank(listed, b))).toEqual(["done_when", "notes", "workers", "timeline", "dependencies"]);
    expect(panelRank(["notes", "done_when"], "notes")).toBe(0);
    expect(panelRank(["workers"], "done_when")).toBe(-0.5);
    expect(panelRank(listed, "made-up")).toBe(100);
  });
});
