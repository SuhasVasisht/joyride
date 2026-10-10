// The Agents page as data: one row per agent (crew tasks with their crewmates, the captain's own
// sessions, closed sessions), grouped by the map's groups and ideas with "Not in an idea yet" by
// project; the filters and their counts; saved views as filters; and where each old route lands.
import { describe, expect, it } from "vitest";
import {
  agentRows, facetCounts, filterPath, groupRows, legacyTarget, matches, parseFilter, recentRows, taskState, workerState,
  DEFAULT_FILTER, UNFILED, type AgentFilter,
} from "../../src/ui/views/agents/model";
import { buildRegions } from "../../src/ui/views/map/layout";

const at = (minsAgo: number) => new Date(Date.now() - minsAgo * 6e4).toISOString();
const worker = (id: string, over: Record<string, unknown> = {}): any => ({
  id, machine: "local", agent: "claude", status: "idle", pane: id.split(":")[1], pid: null, cwd: "/tmp/repos/alpha", repo: "/tmp/repos/alpha",
  session: `claude:${id}`, title: id, current_action: "", last_message: "", controllable: true, updated: at(5), mission: null, crew: null,
  owner: { tier: "watched", task: null, via: null }, helm: { by: "firstmate", since: null, until: null, via: null }, ...over,
});
const crew = (id: string, task: string, over: Record<string, unknown> = {}) => worker(id, { crew: task, owner: { tier: "crew", task, via: "pane" }, ...over });
const task = (id: string, over: Record<string, unknown> = {}): any => ({
  id, title: id, status: "working", kind: "ship", harness: "claude", worktree: `/tmp/wt/${id}`, branch: `fm/${id}`, last_event: "", updated: at(10), depends_on: [],
  mission: null, section: "in_flight", repo: "alpha", mode: "local-only", window: null, hold: null, inbox_pending: 0, workers: [], report: null, ...over,
});
const session = (key: string, over: Record<string, unknown> = {}): any => ({
  key, source: "claude", id: key.split(":")[1], title: key, cwd: "/tmp/repos/gamma", repo: "/tmp/repos/gamma", branch: null, first_prompt: "",
  started: at(600), updated: at(120), turns: 3, tokens: 0, model: null, transcript: "/x", mission: null, archived: false, ...over,
});
const mission = (id: string, over: Record<string, unknown> = {}): any => ({
  id, title: `Idea ${id}`, goal: "", repos: ["/tmp/repos/alpha"], lenses: [], sessions: [], crews: [], health: "active", archive: false, updated: at(1), ...over,
});
const ask = (id: string, over: Record<string, unknown> = {}): any => ({
  id, kind: "prompt", source: "attention", title: `Ask ${id}`, question: "?", preamble: "", calls: [], options_source: "none", recommended_answer: null,
  needs_you: true, owner: "captain", state: "Needs you", level: "L3", task: null, worker: null, session: null, mission: null,
  place: { on: "worker", id: null }, answer: { via: "answer_prompt", target: "" }, opened: at(2), read_only: null, ref: {}, ...over,
});

const missions = [
  mission("csv", { crews: ["jr-ship"], lenses: ["joyride"] }),
  mission("docs", { repos: ["/tmp/repos/gamma"], sessions: [{ source: "claude", id: "done-docs" }] }),
];
const lenses: any[] = [{ id: "joyride", title: "Joyride", description: "", missions: [], rule: {} }];
const input = () => ({
  workers: [
    worker("local:w1", { status: "working", mission: "csv", helm: { by: "captain", since: at(3), until: null, via: "pane" } }),
    worker("local:w2", { status: "blocked", cwd: "/tmp/repos/gamma", repo: "/tmp/repos/gamma" }),
    worker("local:w3", { owner: { tier: "excluded", task: null, via: null }, cwd: "/tmp/repos/beta", repo: "/tmp/repos/beta" }),
    crew("local:c1", "jr-ship", { status: "working" }),
    crew("local:c9", "jr-gone", { status: "idle" }),
    worker("local:fm", { owner: { tier: "control", task: null, via: null } }),
  ],
  tasks: [task("jr-ship", { mission: "csv" }), task("jr-queued", { status: "queued", section: "queued", worktree: null }), task("jr-old", { status: "done", section: "done" })],
  sessions: [
    session("claude:done-docs"),
    session("claude:loose", { updated: at(30) }),
    session("claude:local:w2"),
    session("claude:fm-own", { cwd: "/tmp/fm/vendor" }),
    session("claude:crew-old", { cwd: "/tmp/wt/jr-ship/src" }),
  ],
  missions, attention: [] as any[],
  asks: [ask("a1", { task: "jr-ship", place: { on: "task", id: "jr-ship" }, kind: "task_decision", answer: { via: "fm-send", target: "jr-ship" } }), ask("nudge", { kind: "nudge", worker: "local:w1" })],
  proposals: [
    { id: "p1", title: "Loose ends", sessions: [{ source: "claude", id: "loose" }, { source: "claude", id: "x" }], merge_into: null, status: "pending" },
    { id: "p2", title: "Old", sessions: [{ source: "claude", id: "done-docs" }], merge_into: "docs", status: "pending" },
    { id: "p3", title: "Gone", sessions: [{ source: "claude", id: "local:w2" }], merge_into: "csv", status: "rejected" },
  ] as any[],
  controlId: "local:fm", firstmateDir: "/tmp/fm/vendor/",
});

describe("agentRows", () => {
  const rows = agentRows(input());
  const row = (k: string) => rows.find((r) => r.key === k)!;

  it("gives every agent one row: crewmates on their task, Firstmate's pane and its own sessions left out", () => {
    expect(rows.map((r) => r.key).sort()).toEqual([
      "s:claude:crew-old", "s:claude:done-docs", "s:claude:loose", "t:jr-old", "t:jr-queued", "t:jr-ship",
      "w:local:c9", "w:local:w1", "w:local:w2", "w:local:w3",
    ]);
    expect(row("t:jr-ship").crew!.map((w) => w.id)).toEqual(["local:c1"]);
    // A crewmate whose task Firstmate no longer lists keeps its own row, still crew.
    expect(row("w:local:c9").owner).toBe("crew");
  });

  it("owners: crew for tasks, crewmates and sessions in a task's worktree; yours for watched and kept sessions", () => {
    expect(row("w:local:w2").owner).toBe("yours");
    expect(row("w:local:w3").owner).toBe("yours");
    expect(row("t:jr-queued").owner).toBe("crew");
    expect(row("s:claude:crew-old").owner).toBe("crew");
    expect(row("s:claude:loose").owner).toBe("yours");
  });

  it("states: live work runs, finished tasks and closed sessions are done, the rest idle", () => {
    expect(row("w:local:w1").state).toBe("running");
    expect(row("w:local:w2").state).toBe("running");
    expect(row("w:local:w3").state).toBe("idle");
    expect(row("t:jr-ship").state).toBe("running");
    expect(row("t:jr-queued").state).toBe("idle");
    expect(row("t:jr-old").state).toBe("done");
    expect(row("s:claude:loose").state).toBe("done");
  });

  it("needs you: a blocked prompt, or a call on the task that is the captain's; nudges never count", () => {
    expect(row("w:local:w2").needs).toBe("Waiting at a prompt");
    expect(row("t:jr-ship").needs).toBe("Ask a1");
    expect(row("t:jr-ship").asks.map((a) => a.id)).toEqual(["a1"]);
    expect(row("w:local:w1").needs).toBeNull();
    expect(row("w:local:w1").asks).toEqual([]);
  });

  it("ideas: a session's idea, a crew task's idea (from the idea's crews too), else not in an idea", () => {
    expect(row("w:local:w1").mission).toBe("csv");
    expect(row("t:jr-ship").mission).toBe("csv");
    expect(row("s:claude:done-docs").mission).toBe("docs");
    expect(row("s:claude:crew-old").mission).toBe("csv");
    expect(row("s:claude:loose").mission).toBeNull();
    expect(row("w:local:w1").yourHelm).toBe(true);
  });

  it("a pending proposal shows only on sessions not in an idea yet", () => {
    expect(row("s:claude:loose").suggestion).toEqual({ id: "p1", title: "Loose ends", merge_into: null, sessions: 2 });
    expect(row("s:claude:done-docs").suggestion).toBeNull();
    expect(row("w:local:w2").suggestion).toBeNull(); // its proposal was rejected
  });
});

describe("states follow the shared status helpers", () => {
  it("maps worker and task statuses", () => {
    expect(["working", "blocked", "idle", "unknown", "done", "exited"].map(workerState)).toEqual(["running", "running", "idle", "idle", "done", "done"]);
    expect(taskState({ status: "needs-decision", section: "in_flight" })).toBe("running");
    expect(taskState({ status: "queued", section: "queued" })).toBe("idle");
    // A crewmate waiting on its own run is active work, per the shared helper.
    expect(taskState({ status: "paused", section: "in_flight", last_event: "paused [at=1]: waiting on the e2e run" })).toBe("running");
    expect(taskState({ status: "queued", section: "queued" }, [{ status: "working" }])).toBe("running");
    expect(taskState({ status: "failed", section: "in_flight" })).toBe("done");
    expect(taskState({ status: "done", section: "done" }, [{ status: "idle" }])).toBe("idle");
    expect(taskState({ status: "done", section: "done" }, [{ status: "done" }])).toBe("done");
  });
});

describe("groupRows", () => {
  const rows = agentRows(input());
  const groups = groupRows(rows, missions, lenses, null);

  it("puts each idea in the group the map draws it in, and the rest last, in 'Not in an idea yet' by project", () => {
    const regions = buildRegions(missions, lenses, null, []);
    const mapGroupOf = (id: string) => regions.find((r) => r.missions.some((m) => m.id === id))!.id;
    for (const g of groups.filter((g) => g.id !== UNFILED)) for (const b of g.ideas) expect(g.id).toBe(mapGroupOf(b.mission!));
    expect(groups.map((g) => g.title)).toEqual(["Joyride", "gamma", "Not in an idea yet"]);
    const unfiled = groups.at(-1)!;
    expect(unfiled.ideas.map((b) => b.title).sort()).toEqual(["alpha", "beta", "gamma"]);
    expect(unfiled.count).toBe(rows.filter((r) => !r.mission).length);
  });

  it("orders rows needs-you first, then running, idle and done", () => {
    const gamma = groups.at(-1)!.ideas.find((b) => b.title === "gamma")!;
    expect(gamma.rows.map((r) => r.key)).toEqual(["w:local:w2", "s:claude:loose"]);
    const csv = groups[0].ideas[0];
    expect(csv.rows.map((r) => r.key)).toEqual(["t:jr-ship", "w:local:w1", "s:claude:crew-old"]);
  });

  it("follows the spec's grouping, as the map does", () => {
    const byRepo = groupRows(rows, missions, lenses, { home: { group_by: "repo" } });
    expect(byRepo.map((g) => g.title)).toEqual(["alpha", "gamma", "Not in an idea yet"]);
  });

  it("most recent is one list, newest first", () => {
    const r = recentRows(rows);
    expect(r[0].updated >= r[1].updated && r[1].updated >= r.at(-1)!.updated).toBe(true);
  });
});

describe("filters", () => {
  const rows = agentRows(input());
  const keys = (f: Partial<AgentFilter>) => rows.filter((r) => matches(r, { ...DEFAULT_FILTER, ...f })).map((r) => r.key).sort();

  it("needs you, your helm, crew or yours, and running, idle or done", () => {
    expect(keys({ show: "needs-you" })).toEqual(["t:jr-ship", "w:local:w2"]);
    expect(keys({ show: "your-helm" })).toEqual(["w:local:w1"]);
    expect(keys({ owner: "crew" })).toEqual(["s:claude:crew-old", "t:jr-old", "t:jr-queued", "t:jr-ship", "w:local:c9"]);
    expect(keys({ owner: "yours" })).toEqual(["s:claude:done-docs", "s:claude:loose", "w:local:w1", "w:local:w2", "w:local:w3"]);
    expect(keys({ state: "running" })).toEqual(["t:jr-ship", "w:local:w1", "w:local:w2"]);
    expect(keys({ state: "idle" })).toEqual(["t:jr-queued", "w:local:c9", "w:local:w3"]);
    expect(keys({ state: "done" })).toEqual(["s:claude:crew-old", "s:claude:done-docs", "s:claude:loose", "t:jr-old"]);
    expect(keys({ owner: "crew", state: "running" })).toEqual(["t:jr-ship"]);
  });

  it("counts each choice with the other choices kept", () => {
    const c = facetCounts(rows, { ...DEFAULT_FILTER, owner: "crew" });
    expect(c.state).toEqual({ all: 5, running: 1, idle: 2, done: 2 });
    expect(c.owner).toEqual({ all: 10, crew: 5, yours: 5 });
    expect(c.show["needs-you"]).toBe(1);
  });

  it("round-trips through the URL, leaving defaults out", () => {
    expect(filterPath({})).toBe("agents");
    expect(filterPath({ show: "needs-you", owner: "crew" })).toBe("agents?show=needs-you&owner=crew");
    const f = parseFilter(new URLSearchParams("show=your-helm&state=idle&order=recent&view=needs-me"));
    expect(f).toEqual({ show: "your-helm", owner: "all", state: "idle", order: "recent" });
    expect(parseFilter(new URLSearchParams("show=bogus&owner=nobody"))).toEqual(DEFAULT_FILTER);
  });
});

describe("old routes land on the matching filter", () => {
  const r = (raw: string) => {
    const [p, qs] = raw.split("?");
    const parts = p.split("/");
    return { name: parts[0], params: parts.slice(1), query: new URLSearchParams(qs ?? "") };
  };
  it("redirects fleet tabs, the crew list, proposals and views; a task keeps its sheet", () => {
    expect(legacyTarget(r("fleet"))).toBe("agents");
    expect(legacyTarget(r("fleet?show=crew"))).toBe("agents?owner=crew");
    expect(legacyTarget(r("fleet?show=watched"))).toBe("agents?owner=yours");
    expect(legacyTarget(r("fleet?show=yours-only"))).toBe("agents?owner=yours");
    expect(legacyTarget(r("fleet?show=needs-you"))).toBe("agents?show=needs-you");
    expect(legacyTarget(r("fleet?show=your-helm"))).toBe("agents?show=your-helm");
    expect(legacyTarget(r("task"))).toBe("agents?owner=crew");
    expect(legacyTarget(r("crew"))).toBe("agents?owner=crew");
    expect(legacyTarget(r("task/jr-ship"))).toBeNull();
    expect(legacyTarget(r("proposals"))).toBe("agents?show=suggested");
    expect(legacyTarget(r("view"))).toBe("agents");
    expect(legacyTarget(r("view/needs-me"))).toBe("agents");
    expect(legacyTarget(r("map"))).toBeNull();
  });
});
