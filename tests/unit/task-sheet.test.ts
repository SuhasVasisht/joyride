// Task sheet (control plane CP3b): the timeline merge (pure, then served by
// /api/timeline/task/:id against the crew fixture home), the brief route, which asks
// a sheet pins or shows under its report, the answer text, and the #/crew redirect.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { sandboxDaemon } from "../sandbox.ts";
import { buildFirstmateHome, FIXTURE_TASKS as T } from "../e2e/crew-fixture.ts";
import { addAskFixtures, ASK_TASKS } from "../e2e/asks-fixture.ts";
import { buildTimeline, inboxText } from "../../src/modules/timeline/build.ts";
import { composeAnswer, tasksForAsk, timelineLabel } from "../../src/ui/views/task/model.ts";
import { crewTarget } from "../../src/ui/views/crew/CrewRedirect.tsx";
import type { Ask } from "../../src/shared/asks.ts";

delete process.env.FM_HOME;

const iso = (minsAgo: number) => new Date(Date.now() - minsAgo * 6e4).toISOString();

describe("buildTimeline", () => {
  const base = { task: "t", brief: { at: iso(120) }, open_keys: [] as string[], inbox: [], notes: [], asks: [], report: null };

  it("orders every source by time and keeps unstamped status lines after the line before them", () => {
    const ev = buildTimeline({
      ...base,
      status: [
        { verb: "working", text: "setup done", at: iso(100), key: null },
        { verb: "working", text: "continuation line, no stamp", at: null, key: null },
        { verb: "done", text: "ready in branch", at: iso(10), key: null },
      ],
      inbox: [{ name: "001.msg", text: "Fix the race first", at: iso(50), handled: true }],
      notes: [{ id: "note-a", created: iso(70), bullets: ["Save first", "close later"], title: "Save first" }],
      report: { at: iso(5) },
    });
    expect(ev.map((e) => e.id)).toEqual(["brief", "status:0", "status:1", "note:note-a", "steer:001.msg", "status:2", "report"]);
    expect(ev.find((e) => e.kind === "note")!.text).toBe("Save first\nclose later");
    expect(ev.find((e) => e.kind === "steer")!.state).toBe("read");
  });

  it("marks only the latest opener of a key the fold still holds open", () => {
    const ev = buildTimeline({
      ...base,
      open_keys: ["flake-cause"],
      status: [
        { verb: "needs-decision", text: "first ask", at: iso(40), key: "old" },
        { verb: "resolved", text: "answered", at: iso(35), key: "old" },
        { verb: "needs-decision", text: "pick a cause", at: iso(30), key: "flake-cause" },
        { verb: "working", text: "reading logs while Firstmate decides", at: iso(20), key: null },
      ],
    });
    expect(ev.filter((e) => e.kind === "status").map((e) => e.state)).toEqual(["closed", null, "open", null]);
    expect(timelineLabel(ev.find((e) => e.state === "open")!).what).toBe("Asked for a decision (flake-cause) · still open");
  });

  it("strips Firstmate's envelope from inbox messages", () => {
    expect(inboxText("FIRSTMATE_OP: v1 steer: Fix the race first")).toBe("steer: Fix the race first");
    expect(inboxText("---\nfrom: captain\n---\nFix the race first\n")).toBe("Fix the race first");
    expect(inboxText("schema=fm-task-inbox.v1\nat=2026-10-05T15:44:57Z\n--\nPut the totals row in bold.\n")).toBe("Put the totals row in bold.");
  });
});

const ask = (o: Partial<Ask>): Ask => ({
  id: "x", kind: "task_decision", source: "status", title: "", question: "", preamble: "", calls: [], options_source: "none", recommended_answer: null,
  needs_you: false, owner: "firstmate", state: "", level: "L2", task: null, worker: null, session: null, mission: null,
  place: { on: "task", id: null }, answer: { via: "none", target: null }, opened: null, read_only: null, ref: {}, ...o,
} as Ask);

describe("task sheet asks", () => {
  it("pins the asks placed on the task, needs-you first, and lists calls its report raised under Report", () => {
    const asks = [
      ask({ id: "decision:s:k", task: "s", place: { on: "task", id: "s" } }),
      ask({ id: "attention:1", task: null, worker: "w", place: { on: "task", id: "s" }, needs_you: true }),
      ask({ id: "hold:calls", kind: "captain_call", task: "calls", place: { on: "task", id: "calls" }, hold: { kind: "captain", bucket: "live", until: null, set: null, origin: "s", secondmate: null } }),
      ask({ id: "decision:other:k", task: "other", place: { on: "task", id: "other" } }),
    ];
    const { pinned, fromReport } = tasksForAsk(asks, "s");
    expect(pinned.map((a) => a.id)).toEqual(["attention:1", "decision:s:k"]);
    expect(fromReport.map((a) => a.id)).toEqual(["hold:calls"]);
    // The asks module places a call on the task its origin names: then it is pinned and listed under Report.
    const placed = tasksForAsk([{ ...asks[2], place: { on: "task", id: "s" } }], "s");
    expect([placed.pinned.map((a) => a.id), placed.fromReport.map((a) => a.id)]).toEqual([["hold:calls"], ["hold:calls"]]);
  });

  it("composes the captain's picks and words, one line for held tasks", () => {
    const calls = [
      { n: 1, question: "Where the totals go", options: [{ id: "A", label: "the last row", recommended: true }, { id: "B", label: "the first row", recommended: false }] },
      { n: 2, question: "Which format", options: [{ id: "A", label: "CSV only", recommended: false }, { id: "B", label: "CSV and XLSX", recommended: true }] },
    ];
    expect(composeAnswer({ kind: "captain_call", calls }, { 0: "A", 1: "B" }, "Keep the\nrounding.", true)).toBe("1 A: the last row; 2 B: CSV and XLSX; Keep the rounding.");
    const one = [{ n: null, question: "Which cause first?", options: [{ id: "A", label: "Fix the race", recommended: false }, { id: "B", label: "Fix the timezone", recommended: false }] }];
    expect(composeAnswer({ kind: "task_decision", calls: one }, { 0: "A" }, "then rerun CI", false)).toBe("Fix the race\n\nthen rerun CI");
    expect(composeAnswer({ kind: "task_decision", calls: [] }, {}, "  just do it ", false)).toBe("just do it");
  });
});

describe("#/crew redirect", () => {
  it("sends the crew page to the crew on the Agents page and a crew task to its sheet, keeping the query", () => {
    expect(crewTarget({ params: [], query: new URLSearchParams() })).toBe("#/agents?owner=crew");
    expect(crewTarget({ params: ["jr-csv-export"], query: new URLSearchParams("tab=report") })).toBe("#/task/jr-csv-export?tab=report");
  });
});

describe("/api/timeline/task/:id", () => {
  let d: Awaited<ReturnType<typeof sandboxDaemon>>;
  let home: string;
  const MISSION = "csv-totals";
  beforeAll(async () => {
    home = path.join(process.env.JOYRIDE_RUNTIME!, "firstmate");
    buildFirstmateHome(home, MISSION);
    addAskFixtures(home);
    d = await sandboxDaemon("task-sheet", ["sessions", "missions", "live", "firstmate", "notes", "attention", "guard", "asks", "timeline"]);
    await d.req("POST", "/api/missions", { id: MISSION, title: "CSV export with totals", repos: [] });
  });
  afterAll(async () => { await d?.stop?.(); });

  it("merges the brief, status log, inbox steers, notes and asks for the scout task", async () => {
    const inbox = path.join(home, "state", `${T.scout}.inbox`);
    fs.mkdirSync(path.join(inbox, "handled"), { recursive: true });
    fs.writeFileSync(path.join(inbox, "handled", "001.msg"), "Look at the CI logs first\n");
    fs.writeFileSync(path.join(inbox, "002.msg"), "Fix the race first\n");
    const n = await d.req("POST", "/api/notes", { task: T.scout, bullets: ["The race is the real bug"] });
    expect(n.status, JSON.stringify(n.body)).toBe(201);

    const r = await d.req("GET", `/api/timeline/task/${T.scout}`);
    expect(r.status).toBe(200);
    const kinds = r.body.events.map((e: any) => e.kind);
    expect(kinds[0]).toBe("brief");
    for (const k of ["status", "steer", "note", "ask", "report"]) expect(kinds).toContain(k);
    const decision = r.body.events.find((e: any) => e.kind === "status" && e.verb === "needs-decision");
    expect(decision).toMatchObject({ key: "flake-cause", state: "open" });
    expect(r.body.events.filter((e: any) => e.kind === "steer").map((e: any) => [e.text, e.state])).toEqual([["Look at the CI logs first", "read"], ["Fix the race first", "pending"]]);
    expect(r.body.events.find((e: any) => e.kind === "note").text).toBe("The race is the real bug");
    // The scout's open decision, and the captain call its report raised (placed on the scout).
    expect(r.body.events.filter((e: any) => e.kind === "ask").map((e: any) => e.ref).sort()).toEqual([`decision:${T.scout}:flake-cause`, `hold:${ASK_TASKS.calls}`]);
    expect(r.body.errors).toEqual([]);
  });

  it("serves the brief and refuses unknown or unsafe ids", async () => {
    const b = await d.req("GET", `/api/timeline/task/${T.ship}/brief`);
    expect(b.status).toBe(200);
    expect(b.body.text).toContain("Add an Export CSV button");
    expect((await d.req("GET", "/api/timeline/task/no-such-task")).status).toBe(404);
    expect((await d.req("GET", "/api/timeline/task/..%2Fsecrets")).status).toBe(404);
    expect((await d.req("GET", `/api/timeline/task/${ASK_TASKS.calls}/brief`)).status).toBe(404);
  });
});
