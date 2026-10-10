// The map as control plane (CP3a): tasks into ideas, crew into tasks, asks onto the card they block,
// the next-ask order, the composed answer, and dragging a task between ideas.
import { describe, expect, it } from "vitest";
import type { Ask } from "../../src/shared/asks";
import { askOrder, buildPlane, composeAnswer, placeReplies, readableAction, recommendedPicks, taskNow, whoRuns, type MapReply, type PlaneTask } from "../../src/ui/views/map/plane";
import { missionTarget, moveBody, regionTarget, type DragItem } from "../../src/ui/views/map/regroup";
import { buildRegions, layoutRegions } from "../../src/ui/views/map/layout";

const task = (id: string, over: Partial<PlaneTask> = {}): PlaneTask => ({
  id, title: id, status: "working", kind: "ship", harness: "claude", worktree: null, branch: null, last_event: "working: on it", updated: "2026-10-05T10:00:00Z",
  report: null, depends_on: [], mission: "idea-a", section: "in_flight", repo: null, mode: null, window: null, hold: null, inbox_pending: 0, workers: [], ...over,
});
const worker = (id: string, over: Record<string, unknown> = {}) => ({ id, crew: null as string | null, owner: null as any, ...over });
const ask = (id: string, over: Partial<Ask> = {}): Ask => ({
  id, kind: "captain_call", source: "backlog", title: id, question: "Pick one", preamble: "", calls: [], options_source: "none", recommended_answer: null,
  needs_you: true, owner: "captain", state: "Needs you", level: "L3", task: null, worker: null, session: null, mission: null,
  place: { on: "hub", id: null }, answer: { via: "none", target: null }, opened: "2026-10-05T09:00:00Z", read_only: null, ref: {}, ...over,
});
const missions = new Set(["idea-a", "idea-b"]);

describe("buildPlane", () => {
  it("puts a crewmate inside its task's card, and the task inside its idea", () => {
    const p = buildPlane({ tasks: [task("t1"), task("t2", { mission: "idea-b" })], workers: [worker("w1", { crew: "t1" }), worker("w2", { owner: { tier: "crew", task: "t2" } }), worker("w3")], asks: [], missions });
    expect(p.tasks.get("idea-a")!.map((t) => [t.id, t.crew.map((w) => w.id)])).toEqual([["t1", ["w1"]]]);
    expect(p.tasks.get("idea-b")!.map((t) => [t.id, t.crew.map((w) => w.id)])).toEqual([["t2", ["w2"]]]);
    expect(p.crewOf.get("w1")).toBe("t1");
    expect(p.crewOf.has("w3")).toBe(false);
  });

  it("never files Firstmate's own control pane as crew", () => {
    const p = buildPlane({ tasks: [task("t1")], workers: [worker("ctl", { crew: "t1", owner: { tier: "control" } })], asks: [], missions, controlId: "ctl" });
    expect(p.tasks.get("idea-a")![0].crew).toEqual([]);
  });

  it("keeps a task no idea names on the hub, and folds landed tasks into their idea", () => {
    const p = buildPlane({ tasks: [task("lost", { mission: null }), task("gone", { mission: "nowhere" }), task("old", { section: "done", status: "done" })], workers: [], asks: [], missions });
    expect(p.orphans.map((t) => t.id).sort()).toEqual(["gone", "lost"]);
    expect(p.landed.get("idea-a")!.map((t) => t.id)).toEqual(["old"]);
    expect(p.tasks.get("idea-a")).toBeUndefined();
  });

  it("keeps a done task as a card while a crewmate is still on it or an ask names it", () => {
    const p = buildPlane({ tasks: [task("live", { section: "done" }), task("asked", { section: "done" })], workers: [worker("w", { crew: "live" })], asks: [ask("a", { place: { on: "task", id: "asked" } })], missions });
    expect(p.tasks.get("idea-a")!.map((t) => t.id).sort()).toEqual(["asked", "live"]);
  });

  it("pins each ask where it belongs: its task, a crewmate's task, its idea, else the hub", () => {
    const p = buildPlane({
      tasks: [task("t1"), task("t2")], workers: [worker("w2", { crew: "t2" }), worker("loose")], missions,
      asks: [
        ask("on-task", { place: { on: "task", id: "t1" } }),
        ask("on-crew", { kind: "prompt", place: { on: "worker", id: "w2" }, worker: "w2" }),
        ask("on-loose", { kind: "prompt", place: { on: "worker", id: "loose" }, worker: "loose", mission: "idea-b" }),
        ask("on-idea", { kind: "review", place: { on: "idea", id: "idea-b" }, needs_you: false }),
        ask("nudge", { kind: "nudge", mission: "idea-a", needs_you: false }),
        ask("fm", {}),
        ask("unknown-task", { place: { on: "task", id: "nope" } }),
      ],
    });
    const byTask = new Map([...p.tasks.values()].flat().map((t) => [t.id, t.asks.map((a) => a.id)]));
    expect(byTask.get("t1")).toEqual(["on-task"]);
    expect(byTask.get("t2")).toEqual(["on-crew"]);
    expect(p.ideaAsks.get("idea-b")!.map((a) => a.id)).toEqual(["on-loose", "on-idea"]);
    expect(p.ideaAsks.get("idea-a")!.map((a) => a.id)).toEqual(["nudge"]);
    expect(p.hubAsks.map((a) => a.id)).toEqual(["fm", "unknown-task"]);
  });

  it("orders an idea's tasks: the captain's asks first, then other asks, then in flight, then queued", () => {
    const p = buildPlane({
      tasks: [task("queued", { section: "queued" }), task("flight"), task("deciding"), task("held")], workers: [], missions,
      asks: [ask("x", { place: { on: "task", id: "deciding" }, needs_you: false }), ask("y", { place: { on: "task", id: "held" } })],
    });
    expect(p.tasks.get("idea-a")!.map((t) => t.id)).toEqual(["held", "deciding", "flight", "queued"]);
  });
});

describe("next ask and answers", () => {
  it("walks the captain's calls first, oldest first, and skips nudges", () => {
    const list = askOrder([ask("late", { opened: "2026-10-05T11:00:00Z" }), ask("navy", { needs_you: false, opened: "2026-10-01T00:00:00Z" }), ask("early"), ask("n", { kind: "nudge" })]);
    expect(list.map((a) => a.id)).toEqual(["early", "late", "navy"]);
  });

  const calls = { calls: [
    { n: 1, question: "Totals row", options: [{ id: "A", label: "the last row", recommended: true }, { id: "B", label: "the first row", recommended: false }] },
    { n: 2, question: "Format", options: [{ id: "A", label: "CSV only", recommended: false }, { id: "B", label: "CSV and XLSX", recommended: true }] },
  ] };
  it("preselects the recommendations and writes the captain's picks and words as the answer", () => {
    expect(recommendedPicks(calls)).toEqual({ 0: "A", 1: "B" });
    expect(composeAnswer(calls, { 0: "B", 1: "B" }, "Keep the rounding.")).toBe("1 B (the first row); 2 B (CSV and XLSX). Keep the rounding.");
    expect(composeAnswer({ calls: [calls.calls[0]] }, { 0: "A" }, "")).toBe("A (the last row)");
    expect(composeAnswer({ calls: [] }, {}, "  just words ")).toBe("just words");
  });

  it("says who runs a task and what it is doing now", () => {
    expect(whoRuns({ harness: "claude", model: "claude-opus-5-5", effort: "high", account: "claude-2" })).toBe("Claude Code · claude-opus-5-5, high · claude-2");
    expect(whoRuns({ harness: "codex", model: "default", effort: null, account: null })).toBe("Codex · default model");
    expect(whoRuns({ harness: null, model: null, effort: null, account: null })).toBe("Not started yet");
    expect(taskNow({ last_event: "working [key=impl] [at=1]: wiring the button", status: "working" })).toBe("wiring the button");
    expect(taskNow({ last_event: "x", status: "working" }, { action: "Running tests" })).toBe("Running tests");
  });
});

describe("activity lines never show a raw tool call", () => {
  it("drops a tool name with JSON arguments, and bare JSON", () => {
    expect(readableAction('ScheduleWakeup: {"stop":true}')).toBeNull();
    expect(readableAction('mcp__joyride-memory__memory_search: {"query":"x"}')).toBeNull();
    expect(readableAction('TodoWrite: [{"content":"a"}]')).toBeNull();
    expect(readableAction('{"stop":true}')).toBeNull();
    expect(readableAction("")).toBeNull();
    expect(readableAction(null)).toBeNull();
  });
  it("keeps readable lines, including a tool with a plain detail", () => {
    expect(readableAction("Bash: npm test")).toBe("Bash: npm test");
    expect(readableAction("Read: src/ui/views/map/plane.ts")).toBe("Read: src/ui/views/map/plane.ts");
    expect(readableAction("wiring the reply note")).toBe("wiring the reply note");
  });
  it("a permission wait on a raw call keeps only the wait", () => {
    expect(readableAction('Waiting for permission: ScheduleWakeup: {"stop":true}')).toBe("Waiting for permission");
    expect(readableAction("Waiting for permission: Bash: git push")).toBe("Waiting for permission: Bash: git push");
  });
  it("the task's Now falls back to the last readable line, else its status", () => {
    expect(taskNow({ last_event: "working: wiring the button", status: "working" }, { action: 'ScheduleWakeup: {"stop":true}' })).toBe("wiring the button");
    expect(taskNow({ last_event: 'ScheduleWakeup: {"stop":true}', status: "paused" }, { action: 'ScheduleWakeup: {"stop":true}', goal: null })).toBe("Waiting on its own run");
    expect(taskNow({ last_event: "", status: "working" }, { action: 'Agent: {"x":1}', goal: "Ship the reply note" })).toBe("Ship the reply note");
  });
  it("keeps a readable paused reason", () => {
    expect(taskNow({ last_event: "paused [at=1]: waiting for the unit tests to finish", status: "paused" })).toBe("waiting for the unit tests to finish");
  });
});

describe("Firstmate's replies on the chart", () => {
  const reply = (request: string, over: Partial<MapReply> = {}): MapReply => ({ request, text: "Smoke: reply pong", mission: "idea-a", task: null, created_idea: false, reply: { at: "2026-10-05T10:00:00Z", body: "pong" }, ...over });
  it("sits on the task card it became, else its idea, else the hub", () => {
    const p = placeReplies([
      reply("r1", { task: { id: "t1", title: "T1" } }),
      reply("r2", { task: { id: "t-landed", title: "Landed" } }),
      reply("r3"),
      reply("r4", { mission: "dropped-idea" }),
      reply("r5", { mission: null }),
    ], new Set(["t1"]), new Set(["idea-a"]));
    expect(p.byTask.get("t1")!.map((r) => r.request)).toEqual(["r1"]);
    expect(p.byIdea.get("idea-a")!.map((r) => r.request)).toEqual(["r2", "r3"]);
    expect(p.hub.map((r) => r.request)).toEqual(["r4", "r5"]);
  });
});

describe("dragging a task between ideas", () => {
  const item: DragItem = { kind: "task", id: "t1", label: "T1", from: "idea-a" };
  it("drops on another idea, never its own or a group", () => {
    expect(missionTarget(item, { id: "idea-b", title: "B" })).toEqual({ kind: "mission", id: "idea-b", title: "B" });
    expect(missionTarget(item, { id: "idea-a", title: "A" })).toBeNull();
    expect(regionTarget(item, { id: "lens:x", kind: "lens", title: "X", lens: "x" })).toBeNull();
  });
  it("posts {task, to: {mission}} to the landed move route", () => {
    expect(moveBody(item, { kind: "mission", id: "idea-b", title: "B" })).toEqual({ task: "t1", to: { mission: "idea-b" } });
    expect(moveBody(item, { kind: "unfiled" })).toBeNull();
  });
});

describe("layout with task cards", () => {
  it("charts orphan tasks beside the hub without overlapping it", () => {
    const fm: any = { status: null, error: null, worker: null, fleet: { crew: 0, watched: 0, yoursOnly: 0, needsYou: 0, yourHelm: 0 }, inFlight: 1, calls: 0, log: [], asks: [], needsYou: 0,
      orphans: [{ ...task("lost", { mission: null }), crew: [], asks: [], artifacts: [] }] };
    const regions = buildRegions([], [], null, [], fm);
    for (const level of ["far", "mid", "near"] as const) {
      const l = layoutRegions(regions, level);
      const hub = l.items.get("firstmate")!, orphans = l.items.get("firstmate:orphans")!;
      expect(orphans).toBeTruthy();
      const overlap = hub.x < orphans.x + orphans.w && orphans.x < hub.x + hub.w && hub.y < orphans.y + orphans.h && orphans.y < hub.y + hub.h;
      expect(overlap).toBe(false);
    }
  });
});
