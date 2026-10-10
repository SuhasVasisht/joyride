import { describe, expect, it } from "vitest";
import type { KnowledgeItem } from "../../src/shared/knowledge";
import { parse } from "../../src/ui/lib/router";
import {
  anchorOptions, applyFilters, groupByDate, legacyTarget, parseRef, parseSavedSession,
  parseTypes, projectOptions, typeCounts, viewOf, type Filters,
} from "../../src/ui/views/knowledge/model";

const redirect = (hash: string) => { const r = parse(hash); return legacyTarget(r.name, r.params, r.query); };
const item = (over: Partial<KnowledgeItem> & { key: string }): KnowledgeItem => {
  const [entity, ...rest] = over.key.split(":");
  return {
    ref: { entity: entity as KnowledgeItem["ref"]["entity"], id: rest.join(":") }, type: "ideas", kind: "idea", title: over.key,
    summary: "", state: "active", created: "2026-10-01T00:00:00Z", updated: "2026-10-01T00:00:00Z", anchors: [], score: 0,
    review: [], delivery: [], href: "", url: null, ...over,
  };
};
const none: Filters = { types: [], idea: "", task: "", session: "" };

describe("legacy redirects", () => {
  it("sends retired memory views to Search and preserves artifact links", () => {
    expect(redirect("#/memory/entries/old")).toBe("knowledge");
    expect(redirect("#/artifacts/art-1")).toContain("open=artifact%3Aart-1");
    expect(redirect("#/artifacts?register=1")).toContain("register=1");
  });
});

describe("refs and views", () => {
  it("keep colons inside session keys and reject unknown entities", () => {
    expect(parseRef("session:codex:abc")).toEqual({ entity: "session", id: "codex:abc" });
    expect(parseRef("artifact:x")).toEqual({ entity: "artifact", id: "x" });
    expect(parseRef("task:x")).toEqual({ entity: "task", id: "x" });
    expect(parseRef("note:")).toBeNull();
    expect(parseRef(null)).toBeNull();
    expect(parseTypes("ideas,bogus,notes")).toEqual(["ideas", "notes"]);
    expect(viewOf("review")).toBe("all");
    expect(viewOf("nope")).toBe("all");
  });
});

describe("filters", () => {
  const items = [
    item({ key: "note:a", type: "ideas", anchors: [{ kind: "idea", id: "fleet", title: "One fleet", direct: true }] }),
    item({ key: "note:n", type: "notes", kind: "note", anchors: [{ kind: "task", id: "t1", title: "Task one", direct: true }, { kind: "idea", id: "fleet", title: "fleet", direct: false }] }),
    item({ key: "artifact:r", type: "reports", kind: "report", anchors: [{ kind: "idea", id: "kb", title: "Knowledge home", direct: true }] }),
    item({ key: "artifact:s", type: "sessions", kind: "session", anchors: [{ kind: "session", id: "codex:x", title: "Triage", direct: true }] }),
    item({ key: "note:d", type: "tasks", kind: "task", delivery: ["task:t1"] }),
  ];
  it("combine type with idea, task and session anchors", () => {
    expect(applyFilters(items, { ...none, idea: "fleet" }).map((i) => i.key)).toEqual(["note:a", "note:n"]);
    expect(applyFilters(items, { ...none, idea: "fleet", types: ["notes"] }).map((i) => i.key)).toEqual(["note:n"]);
    expect(applyFilters(items, { ...none, session: "codex:x" }).map((i) => i.key)).toEqual(["artifact:s"]);
    expect(applyFilters(items, { ...none, types: ["reports", "sessions"] }).map((i) => i.key)).toEqual(["artifact:r", "artifact:s"]);
  });
  it("match a task filter through delivery as well as anchors", () => {
    expect(applyFilters(items, { ...none, task: "t1" }).map((i) => i.key)).toEqual(["note:n", "note:d"]);
  });
  it("count types after anchor filters but before the type filter", () => {
    const counts = typeCounts(items, { ...none, idea: "fleet", types: ["notes"] });
    expect(Object.fromEntries(counts)).toEqual({ ideas: 1, notes: 1 });
  });
  it("filter by project through repo anchors, by name or full path", () => {
    const repoItems = [
      item({ key: "artifact:p", anchors: [{ kind: "repo", id: "alpha", title: "alpha", direct: true }] }),
      item({ key: "note:q", anchors: [{ kind: "repo", id: "/tmp/repos/alpha", title: "alpha", direct: true }] }),
      item({ key: "note:r", anchors: [{ kind: "repo", id: "/tmp/repos/beta", title: "beta", direct: true }] }),
    ];
    expect(applyFilters(repoItems, { ...none, project: "alpha" }).map((i) => i.key)).toEqual(["artifact:p", "note:q"]);
    expect(projectOptions(repoItems)).toEqual([{ id: "alpha", title: "alpha", n: 2 }, { id: "beta", title: "beta", n: 1 }]);
  });
  it("offer anchor choices by frequency with the best title", () => {
    expect(anchorOptions(items, "idea")).toEqual([
      { id: "fleet", title: "One fleet", n: 2 }, { id: "kb", title: "Knowledge home", n: 1 },
    ]);
  });
});

describe("grouping", () => {
  const now = new Date("2026-10-05T12:00:00");
  it("buckets by date newest first, or keeps rank order for a search", () => {
    const list = [
      item({ key: "note:old", updated: "2026-08-01T00:00:00" }),
      item({ key: "note:today", updated: "2026-10-05T09:00:00" }),
      item({ key: "note:week", updated: "2026-10-01T09:00:00" }),
    ];
    expect(groupByDate(list, false, now).map((g) => [g.label, g.items.map((i) => i.key)])).toEqual([
      ["Today", ["note:today"]], ["This week", ["note:week"]], ["Earlier", ["note:old"]],
    ]);
    expect(groupByDate(list, true, now)).toEqual([{ label: "Best matches", items: list }]);
    expect(groupByDate([], true, now)).toEqual([]);
  });

});

describe("saved session records", () => {
  it("read the resume command from fleet's JSON record", () => {
    const saved = parseSavedSession(JSON.stringify({
      summary: "Triage", work_done: "Fixed it", resume_context: "Read the handoff", saved_at: "2026-10-05T00:00:00Z",
      resume: { command: "cd '/r' && CODEX_HOME='/h' codex resume 'abc'", cwd: "/r" },
    }));
    expect(saved).toMatchObject({ summary: "Triage", command: "cd '/r' && CODEX_HOME='/h' codex resume 'abc'", cwd: "/r" });
  });
  it("read a Resume: line from a markdown record, and nothing from a record without one", () => {
    expect(parseSavedSession("# Saved\n\nDone: x\nResume: codex resume recorded-session\n").command).toBe("codex resume recorded-session");
    expect(parseSavedSession("- **Resume:** `claude --resume abc`").command).toBe("claude --resume abc");
    expect(parseSavedSession("# Nothing here").command).toBeNull();
    expect(parseSavedSession("{\"summary\":\"x\"}").command).toBeNull();
  });
});
