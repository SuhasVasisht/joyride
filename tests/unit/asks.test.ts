// Asks (control plane CP0): option parsing, hold decoding and buckets, the fold-aware task
// status, placement and escalation in the pure builder, and /api/asks over a fixture FM_HOME
// with the real Firstmate projection, attention, guard and live modules.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import path from "node:path";
import { sandboxDaemon } from "../sandbox.ts";
import { startFakeHerdr, waitFor, assertSandboxed, FIXTURE_REPOS, type FakeHerdr } from "../fixtures/fake-herdr.ts";
import { buildFirstmateHome, FIXTURE_CREW_PANES as PANES, FIXTURE_TASKS as T } from "../e2e/crew-fixture.ts";
import { addAskFixtures, ASK_TASKS, CALLS_REASON, DOCS_REASON, REQUEST_ID } from "../e2e/asks-fixture.ts";
import { parseCalls, parseOptions, recommendedAnswer } from "../../src/shared/asks.ts";
import { decodeHold } from "../../src/modules/firstmate/hold.ts";
import { foldOpenDecisions } from "../../src/modules/firstmate/fold.ts";
import { parseStatusLog, taskStatus, type TaskDetail } from "../../src/modules/firstmate/state.ts";
import { buildAsks, crosscheck, holdBucket, type BuildInput } from "../../src/modules/asks/build.ts";
import type { AttentionItem, GuardRequest, WorkerView } from "../../src/shared/schema.ts";

process.env.JOYRIDE_HERDR_POLL_MS = "300";
process.env.JOYRIDE_FIRSTMATE_POLL_MS = "200";

const REAL_REASON = "Control-plane design report: /x/report.md (section 13). Two calls: 1) What an idea is, and who keeps ideas tidy: (A, recommended) ideas are today's missions, renamed in the UI; (B) the same, but tidy changes wait for your OK in a tray; (C) keep missions as they are. 2) Which Codex login runs housekeeping (the model stays gpt-6.1-sol): (A, recommended) Joyride's own login; (B) Codex 2.";

describe("options", () => {
  it("splits numbered calls and marks the recommended option in each", () => {
    const p = parseCalls(REAL_REASON);
    expect(p.preamble).toBe("Control-plane design report: /x/report.md (section 13). Two calls:");
    expect(p.calls.map((c) => [c.n, c.question, c.options.map((o) => `${o.id}${o.recommended ? "*" : ""}`)])).toEqual([
      [1, "What an idea is, and who keeps ideas tidy", ["A*", "B", "C"]],
      [2, "Which Codex login runs housekeeping (the model stays gpt-6.1-sol)", ["A*", "B"]],
    ]);
    expect(p.calls[0].options[1].label).toBe("the same, but tidy changes wait for your OK in a tray");
    expect(p.calls[1].options[1].label).toBe("Codex 2");
    expect(recommendedAnswer(p.calls)).toBe("Go with your recommendations: 1 A, 2 A");
  });
  it("reads lower-case letters and a trailing (recommended) mark, and needs two options in order", () => {
    const o = parseOptions("Which cause first? (a) the timezone default (b) the download race (recommended)");
    expect(o).toEqual({ question: "Which cause first?", options: [
      { id: "A", label: "the timezone default", recommended: false },
      { id: "B", label: "the download race", recommended: true },
    ] });
    expect(recommendedAnswer([{ n: null, ...o }])).toBe("Go with your recommendation: B");
    expect(parseOptions("Delete the file(s) (a) now?").options).toEqual([]);
    expect(parseOptions("Only (A) one option").options).toEqual([]);
    expect(parseOptions("Out of order (B) first (A) second").options).toEqual([]);
    expect(parseCalls("pick which to fix first").calls).toEqual([{ n: null, question: "pick which to fix first", options: [] }]);
    expect(recommendedAnswer(parseCalls("1) x: (A) a; (B, recommended) b. 2) y: (A) a; (B) b.").calls)).toBeNull();
  });
});

describe("hold reasons and buckets", () => {
  it("decodes fm-hold-v1 reasons and keeps anything malformed as stored", () => {
    const enc = (s: string) => `fm-hold-v1:${Buffer.from(s).toString("base64")}`;
    expect(decodeHold(enc("Pick (a) or (b).\nThen ship."))).toBe("Pick (a) or (b).\nThen ship.");
    expect(decodeHold("waiting on keys")).toBe("waiting on keys");
    expect(decodeHold("fm-hold-v1:not*base64")).toBe("fm-hold-v1:not*base64");
    expect(decodeHold(`fm-hold-v1:${Buffer.from([0xff, 0xfe]).toString("base64")}`)).toMatch(/^fm-hold-v1:/);
    expect(decodeHold(null)).toBeNull();
  });
  it("buckets captain holds the way Firstmate's snapshot does", () => {
    const now = Date.parse("2026-10-05T12:00:00Z");
    const row = { section: "queued", hold_kind: "captain", hold_reason: "q", hold_until: null, hold_set: "2026-10-04", since: null, blocked_by: [] as string[] };
    const done = () => true;
    expect(holdBucket(row, done, now)).toBe("live");
    expect(holdBucket({ ...row, hold_kind: null }, done, now)).toBeNull();
    expect(holdBucket({ ...row, section: "done" }, done, now)).toBeNull();
    expect(holdBucket({ ...row, blocked_by: ["x"] }, () => false, now)).toBe("blocked");
    expect(holdBucket({ ...row, hold_until: "2026-10-06" }, done, now)).toBe("dated");
    expect(holdBucket({ ...row, hold_until: "2026-10-05" }, done, now)).toBe("live");
    expect(holdBucket({ ...row, hold_set: "2026-09-20" }, done, now)).toBe("aged");
    expect(holdBucket({ ...row, hold_set: null, since: "2026-09-01" }, done, now)).toBe("aged");
  });
});

describe("task status follows the fold", () => {
  const status = (text: string) => taskStatus(null, parseStatusLog(text), foldOpenDecisions(text, "ship"));
  it("keeps an open decision over a later working line", () => {
    expect(status("needs-decision [key=k]: pick\nworking: carrying on\n")).toBe("needs-decision");
    expect(status("blocked [key=keys]: need keys\nnote: fyi\npaused: waiting\n")).toBe("blocked");
  });
  it("reads a closed decision as working, a transfer as held, and done as done", () => {
    expect(status("needs-decision [key=k]: pick\nresolved [key=k]: A\n")).toBe("working");
    expect(status("needs-decision [key=k]: pick\ncaptain-held [key=k]: moved\n")).toBe("held");
    expect(status("needs-decision [key=k]: pick\ndone: shipped\n")).toBe("done");
    expect(status("working: a\npaused: waiting on CI\n")).toBe("paused");
  });
});

// ---------- pure builder ----------
const NOW = Date.parse("2026-10-05T12:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60e3).toISOString();
function task(id: string, over: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id, title: id, status: "working", kind: "ship", harness: "claude", worktree: null, branch: null, last_event: "", updated: ago(1), report: null, depends_on: [], mission: "m1",
    section: "in_flight", repo: "alpha", project: null, mode: null, window: null, pid: null, backend: null, pane: null, herdr_session: null,
    hold: null, hold_reason: null, hold_kind: null, hold_until: null, hold_set: null, hold_origin: null, since: null, model: null, effort: null, account: null, request: null,
    decisions: [], turn_ended: null, inbox_pending: 0, brief: null, mission_source: null, secondmate: null, ...over,
  };
}
const worker = (id: string, over: Partial<WorkerView> = {}): WorkerView => ({
  id, machine: "local", agent: "claude", status: "blocked", pane: id.split(":").slice(1).join(":"), pid: null, cwd: "/tmp", repo: null, session: `claude:${id}`, title: "", current_action: "", last_message: "",
  controllable: true, updated: ago(0), mission: null, crew: null, owner: { tier: "watched", task: null, via: null }, helm: null, ...over,
} as WorkerView);
const item = (id: string, over: Partial<AttentionItem>): AttentionItem => ({
  id, level: "L3", floor: "L3", kind: "question", title: id, why: "why", session: null, worker: null, mission: null, opened: ago(2), resolved: null, resolution: null, snoozed_until: null, jev: null, ref: {}, ...over,
} as AttentionItem);
const decision = (key: string, at: string | null, keyed = true) => ({ key, verb: "needs-decision" as const, note: `decide ${key}`, at, keyed, line: 0 });
const input = (over: Partial<BuildInput>): BuildInput => ({ tasks: [], attention: [], guard: [], workers: [], firstmate: { running: true, wake_oldest: null }, now: NOW, ...over });

describe("buildAsks", () => {
  it("excludes Firstmate chat replies and high-level progress while retaining real prompts", () => {
    const control = worker("local:wH:p1", { owner: { tier: "control", task: null, via: null } });
    const otherControl = worker("local:pid:123", { owner: { tier: "control", task: null, via: null } });
    const watched = worker("local:pid:20558");
    const asks = buildAsks(input({ workers: [control, otherControl, watched], attention: [
      item("fm-chat", { level: "L3", kind: "progress", worker: control.id, why: "I'm leaving that one to you as you said." }),
      item("fm-question", { worker: otherControl.id, why: "Tell me when Chrome's free?" }),
      item("fm-pane", { worker: control.id }),
      item("orbit", { level: "L4", kind: "progress", worker: watched.id }),
      item("permission", { kind: "approval", worker: watched.id }),
      item("resolved", { worker: watched.id, resolved: ago(0) }),
    ] }));
    expect(asks.map((a) => [a.id, a.needs_you, a.answer.via])).toEqual([["attention:permission", true, "answer_prompt"]]);
    expect(buildAsks(input({ workers: [{ ...watched, status: "idle" }], attention: [item("old-permission", { kind: "approval", worker: watched.id })] }))).toEqual([]);
  });

  it("pins a captain call to the work it gates, else to its origin task, else to itself", () => {
    const hold = { hold_kind: "captain", hold_reason: "Go? (A) yes; (B) no", hold_set: "2026-10-05" };
    const asks = buildAsks(input({ tasks: [
      task("work", { ...hold, section: "in_flight" }), // a held work item
      task("gate", { ...hold, kind: "captain", section: "queued" }),
      task("next", { section: "queued", depends_on: ["gate"], mission: "m2" }),
      task("origin-call", { ...hold, kind: "captain", section: "queued", hold_origin: "scout" }),
      task("scout", { kind: "scout", mission: "m3" }),
      task("orphan-call", { ...hold, kind: "captain", section: "queued", hold_origin: "gone" }),
      task("closed", { ...hold, kind: "captain", section: "done" }),
    ] }));
    const by = Object.fromEntries(asks.map((a) => [a.id, a]));
    expect(Object.keys(by).sort()).toEqual(["hold:gate", "hold:origin-call", "hold:orphan-call", "hold:work"]);
    expect(by["hold:work"]).toMatchObject({ kind: "captain_call", needs_you: true, owner: "captain", place: { on: "task", id: "work" }, answer: { via: "fm-captain-hold", target: "work", modes: ["release", "done"] } });
    expect(by["hold:gate"]).toMatchObject({ place: { on: "task", id: "next" }, mission: "m2", answer: { modes: ["done", "release"] }, ref: { gates: "next" } });
    expect(by["hold:origin-call"]).toMatchObject({ place: { on: "task", id: "scout" }, mission: "m3" });
    expect(by["hold:orphan-call"].place).toEqual({ on: "task", id: "orphan-call" });
    expect(by["hold:work"]).toMatchObject({ options_source: "parsed", calls: [{ options: [{ id: "A" }, { id: "B" }] }] });
  });

  it("leaves a crewmate's decision with Firstmate until it has waited on a stopped or undrained Firstmate", () => {
    const tasks = [task("t", { decisions: [decision("k", ago(25)), decision("default", ago(25), false), decision("pending-reply-1", ago(25))] }), task("fresh", { decisions: [decision("k", ago(5))] })];
    const deciding = buildAsks(input({ tasks }));
    // The plumbing key Firstmate's own libraries own is never an ask; the oldest wait comes first.
    expect(deciding.map((a) => [a.id, a.needs_you, a.owner, a.state])).toEqual([
      ["decision:t:default", false, "firstmate", "Firstmate is deciding"],
      ["decision:t:k", false, "firstmate", "Firstmate is deciding"],
      ["decision:fresh:k", false, "firstmate", "Firstmate is deciding"],
    ]);
    expect(deciding.find((a) => a.id === "decision:t:k")!.answer).toEqual({ via: "fm-send-resolve-key", target: "t", key: "k" });
    expect(deciding.find((a) => a.id === "decision:t:default")!.answer).toEqual({ via: "fm-send", target: "t" });
    const stopped = buildAsks(input({ tasks, firstmate: { running: false, wake_oldest: null } }));
    expect(stopped.filter((a) => a.needs_you).map((a) => [a.id, a.state])).toEqual([["decision:t:default", "Firstmate is stopped"], ["decision:t:k", "Firstmate is stopped"]]);
    const undrained = buildAsks(input({ tasks, firstmate: { running: true, wake_oldest: ago(30) } }));
    expect(undrained.filter((a) => a.needs_you).map((a) => a.state)).toEqual(["Firstmate hasn't picked this up", "Firstmate hasn't picked this up"]);
    expect(buildAsks(input({ tasks: [task("d", { section: "done", decisions: [decision("k", ago(60))] })], firstmate: { running: false, wake_oldest: null } }))).toEqual([]);
  });

  it("puts prompts on the worker line inside its task, reviews on the task, nudges on the idea, and joins guard requests", () => {
    const crew = worker("local:w90:p1", { owner: { tier: "crew", task: "t", via: "pane" }, crew: "t", mission: "m1" });
    const loose = worker("local:w1:p1", { mission: "m9" });
    const g: GuardRequest = { id: "gr_1", rule: "push", title: "git push", tool: "Bash", summary: "git push origin main", input: {}, session: loose.session, agent: "claude", cwd: "/tmp", created: ago(1), deadline: ago(-4), decision: "pending", decided_at: null, reason: "" };
    const asks = buildAsks(input({
      tasks: [task("t")], workers: [crew, loose], guard: [g],
      attention: [
        item("a1", { level: "L4", kind: "approval", worker: crew.id, title: "Allow Bash?" }),
        item("a2", { level: "L2", kind: "review", worker: crew.id, title: "Done with evidence" }),
        item("a3", { level: "L1", kind: "nudge", mission: "m5", title: "Still want this?" }),
        item("a4", { level: "L4", kind: "guard", worker: loose.id, ref: { request: "gr_1" } }),
        item("a5", { level: "L1", kind: "progress" }),
        item("a6", { level: "L3", kind: "question", session: "claude:nobody" }),
      ],
    }));
    const by = Object.fromEntries(asks.map((a) => [a.id, a]));
    expect(Object.keys(by).sort()).toEqual(["attention:a1", "attention:a2", "attention:a3", "attention:a6", "guard:gr_1"]);
    expect(by["attention:a1"]).toMatchObject({ kind: "prompt", needs_you: true, task: "t", worker: crew.id, place: { on: "worker", id: crew.id }, answer: { via: "answer_prompt", target: crew.id } });
    expect(by["attention:a2"]).toMatchObject({ kind: "review", needs_you: false, place: { on: "task", id: "t" }, answer: { via: "ack", target: "a2" } });
    expect(by["attention:a3"]).toMatchObject({ kind: "nudge", needs_you: false, place: { on: "idea", id: "m5" } });
    expect(by["attention:a6"]).toMatchObject({ place: { on: "hub", id: null }, read_only: expect.stringMatching(/No live worker/) });
    expect(by["guard:gr_1"]).toMatchObject({ kind: "approval", level: "L4", needs_you: true, worker: loose.id, mission: "m9", place: { on: "worker", id: loose.id }, answer: { via: "approve_deny", target: "gr_1" }, ref: { attention: "a4" } });
    // Orange first, then by level.
    expect(asks.map((a) => a.needs_you)).toEqual([true, true, true, false, false]);
    expect(asks.slice(0, 2).map((a) => a.level)).toEqual(["L4", "L4"]);
  });

  it("shows a secondmate's captain hold read-only on the secondmate's task", () => {
    const asks = buildAsks(input({
      tasks: [task("sm-infra", { kind: "secondmate", mission: "infra" })],
      secondmates: [{ id: "sm-infra", rows: [{ id: "sm-call", title: "Pick a region", section: "queued", checked: false, repo: null, kind: "captain", priority: null, hold: "Which region? (A) us; (B) eu", hold_kind: "captain", hold_until: null, hold_set: null, hold_origin: null, blocked_by: [], since: null, completed: null, report_path: null, links: [], notes: [] }] }],
    }));
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ id: "sm-hold:sm-infra:sm-call", needs_you: true, place: { on: "task", id: "sm-infra" }, mission: "infra", answer: { via: "none" }, read_only: expect.stringMatching(/Answer it in Firstmate/) });
  });

  it("asks for suggested options only where the text has none", () => {
    const seen: string[] = [];
    const suggest = (t: string) => { seen.push(t); return t.includes("ready") ? { status: "ok" as const, calls: [{ n: null, question: t, options: [{ id: "A", label: "Fix the race", recommended: false }, { id: "B", label: "Fix the timezone", recommended: false }] }] } : { status: "pending" as const }; };
    const asks = buildAsks(input({ suggest, tasks: [task("t", { decisions: [{ ...decision("a", ago(1)), note: "ready: pick a fix" }, { ...decision("b", ago(1)), note: "which?" }, { ...decision("c", ago(1)), note: "Go? (A) yes; (B) no" }] })] }));
    expect(seen.sort()).toEqual(["ready: pick a fix", "which?"]);
    expect(Object.fromEntries(asks.map((a) => [a.decision!.key, a.options_source]))).toEqual({ a: "suggested", b: "pending", c: "parsed" });
  });

  it("cross-checks against Firstmate's own summary only when it is valid", () => {
    const asks = buildAsks(input({ tasks: [task("t", { decisions: [decision("k", ago(1))] }), task("h", { hold_kind: "captain", hold_reason: "q", section: "queued", kind: "captain" })] }));
    expect(crosscheck(asks, { valid: false, generated: null }, [])).toMatchObject({ valid: false, agree: true });
    expect(crosscheck(asks, { valid: true, generated: "g" }, [{ id: "t", key: "k", verb: "needs-decision" }, { id: "h", key: "h", verb: "captain-hold" }])).toMatchObject({ valid: true, agree: true });
    expect(crosscheck(asks, { valid: true, generated: "g" }, [{ id: "x", key: "y", verb: "needs-decision" }])).toEqual({ valid: true, generated: "g", agree: false, only_joyride: ["h|h", "t|k"], only_firstmate: ["x|y"] });
  });
});

// ---------- daemon: /api/asks over a fixture FM_HOME ----------
const MISSION = "csv-export";
let d: Awaited<ReturnType<typeof sandboxDaemon>>;
let fake: FakeHerdr;

describe("/api/asks", () => {
  beforeAll(async () => {
    const home = path.join(process.env.JOYRIDE_RUNTIME!, "firstmate");
    buildFirstmateHome(home, MISSION);
    addAskFixtures(home);
    d = await sandboxDaemon("asks", ["sessions", "missions", "live", "firstmate", "attention", "guard", "asks"]);
    // No scenario panes: the only live worker is the crewmate a test adds.
    fake = await startFakeHerdr(d.sb.env.JOYRIDE_HERDR_SOCKET, { scenario: "empty" });
    await assertSandboxed(d.sb.env);
    await d.start();
    expect((await d.req("POST", "/api/missions", { id: MISSION, title: "CSV export with totals", repos: [FIXTURE_REPOS.alpha] })).status).toBe(201);
    await waitFor(async () => (await d.req("GET", "/api/herdr/status")).body.connected, 5000);
    await waitFor(async () => (await d.req("GET", `/api/firstmate/tasks/${T.ship}`)).body?.mission === MISSION, 4000);
  });
  afterAll(async () => { await d?.stop(); await fake?.stop(); });
  afterEach(() => { delete process.env.JOYRIDE_ASKS_ESCALATE_MS; });

  it("serves who runs a task, its decoded hold, its request marker and its open decisions", async () => {
    const ship = (await d.req("GET", `/api/firstmate/tasks/${T.ship}`)).body;
    expect(ship).toMatchObject({ model: "claude-opus-5-5", effort: "high", account: "claude-2", request: REQUEST_ID, decisions: [] });
    const docs = (await d.req("GET", `/api/firstmate/tasks/${T.queued}`)).body;
    expect(docs).toMatchObject({ hold: DOCS_REASON, hold_reason: DOCS_REASON, hold_kind: "captain", depends_on: [T.ship] });
    const scout = (await d.req("GET", `/api/firstmate/tasks/${T.scout}`)).body;
    // The later working line does not close the keyed decision.
    expect(scout.status).toBe("needs-decision");
    expect(scout.last_event).toMatch(/^working: reading CI logs/);
    expect(scout.decisions).toEqual([expect.objectContaining({ key: "flake-cause", verb: "needs-decision", keyed: true })]);
    expect((await d.req("GET", `/api/firstmate/tasks/${ASK_TASKS.calls}`)).body).toMatchObject({ status: "held", hold_reason: CALLS_REASON, hold_origin: T.scout, kind: "captain" });
  });

  it("lists every ask with its placement, options and answer route", async () => {
    const r = (await d.req("GET", "/api/asks")).body;
    const by = Object.fromEntries(r.asks.map((a: any) => [a.id, a]));
    expect(Object.keys(by).sort()).toEqual([`decision:${T.scout}:flake-cause`, `hold:${ASK_TASKS.calls}`, `hold:${T.queued}`, `hold:${ASK_TASKS.later}`]);
    expect(by[`hold:${ASK_TASKS.calls}`]).toMatchObject({
      kind: "captain_call", needs_you: true, owner: "captain", state: "Needs you", mission: MISSION, place: { on: "task", id: T.scout },
      options_source: "parsed", recommended_answer: "Go with your recommendations: 1 A, 2 B",
      answer: { via: "fm-captain-hold", target: ASK_TASKS.calls, modes: ["done", "release"] },
      hold: { bucket: "live", origin: T.scout },
    });
    expect(by[`hold:${ASK_TASKS.calls}`].calls.map((c: any) => c.question)).toEqual(["Where the totals row goes", "Which file format"]);
    expect(by[`hold:${T.queued}`]).toMatchObject({ needs_you: false, state: "Waiting on another task first", hold: { bucket: "blocked" }, place: { on: "task", id: T.queued }, answer: { modes: ["release", "done"] } });
    expect(by[`hold:${ASK_TASKS.later}`]).toMatchObject({ needs_you: false, hold: { bucket: "dated" }, state: expect.stringMatching(/^Deferred until \d{4}-/) });
    expect(by[`decision:${T.scout}:flake-cause`]).toMatchObject({ kind: "task_decision", needs_you: false, owner: "firstmate", state: "Firstmate is deciding", mission: MISSION, place: { on: "task", id: T.scout }, answer: { via: "fm-send-resolve-key", target: T.scout, key: "flake-cause" } });
    expect(r.counts).toMatchObject({ total: 4, needs_you: 1, by_kind: { captain_call: 3, task_decision: 1 } });
    expect(r.firstmate).toMatchObject({ running: false });
    // Firstmate's fixture summary is valid and lists the scout decision but not the new hold.
    expect(r.crosscheck).toMatchObject({ valid: true, agree: false, only_joyride: [`${ASK_TASKS.calls}|${ASK_TASKS.calls}`], only_firstmate: [] });
    expect((await d.req("GET", `/api/asks?needs_you=1`)).body.asks.map((a: any) => a.id)).toEqual([`hold:${ASK_TASKS.calls}`]);
    expect((await d.req("GET", `/api/asks?task=${T.scout}`)).body.asks.map((a: any) => a.id).sort()).toEqual([`decision:${T.scout}:flake-cause`, `hold:${ASK_TASKS.calls}`]);
    expect((await d.req("GET", `/api/asks/${encodeURIComponent(`hold:${ASK_TASKS.calls}`)}`)).body.id).toBe(`hold:${ASK_TASKS.calls}`);
    expect((await d.req("GET", "/api/asks/nope")).status).toBe(404);
  });

  it("suggests options for a decision with none, through the cached ask_options task", async () => {
    await waitFor(async () => (await d.req("GET", `/api/asks/${encodeURIComponent(`decision:${T.scout}:flake-cause`)}`)).body.options_source === "suggested", 5000);
    const a = (await d.req("GET", `/api/asks/${encodeURIComponent(`decision:${T.scout}:flake-cause`)}`)).body;
    expect(a.calls[0].options.map((o: any) => o.label)).toEqual(["Go ahead as proposed", "Hold off for now"]);
    expect(a.recommended_answer).toBeNull();
  });

  it("hands a decision to the captain once it has waited past the threshold on a stopped Firstmate", async () => {
    process.env.JOYRIDE_ASKS_ESCALATE_MS = String(60e3); // the fixture decision opened 15 minutes ago
    const a = (await d.req("GET", `/api/asks/${encodeURIComponent(`decision:${T.scout}:flake-cause`)}`)).body;
    expect(a).toMatchObject({ needs_you: true, owner: "captain", state: "Firstmate is stopped", level: "L3" });
  });

  it("joins attention prompts and guard requests, placed on the crew worker's line in its task", async () => {
    fake.addPane({ workspace_id: "w90", pane_id: PANES.ship, cwd: "/tmp", agent: "claude", agent_status: "blocked", title: "CSV crewmate", label: "alpha-wt" });
    const wid = `local:${PANES.ship}`;
    await waitFor(async () => ((await d.req("GET", "/api/workers")).body as any[]).some((w) => w.id === wid && w.owner?.tier === "crew"), 5000);
    const it = (await d.req("POST", "/api/attention", { level: "L4", kind: "approval", title: "Allow Bash: rm -rf build?", why: "Bash: rm -rf build", worker: wid })).body;
    const g = (await d.req("POST", "/api/guard/requests", { rule: "push", title: "git push", tool: "Bash", input: { command: "git push origin main" }, session: "loose-session", agent: "claude", cwd: "/tmp" })).body;
    await waitFor(async () => (await d.req("GET", "/api/asks")).body.asks.some((a: any) => a.id === `guard:${g.id}`), 5000);
    const r = (await d.req("GET", "/api/asks?needs_you=1")).body;
    const by = Object.fromEntries(r.asks.map((a: any) => [a.id, a]));
    expect(by[`attention:${it.id}`]).toMatchObject({ kind: "prompt", task: T.ship, worker: wid, mission: MISSION, place: { on: "worker", id: wid }, answer: { via: "answer_prompt", target: wid } });
    expect(by[`guard:${g.id}`]).toMatchObject({ kind: "approval", level: "L4", place: { on: "hub", id: null }, answer: { via: "approve_deny", target: g.id } });
    expect(r.asks.slice(0, 2).map((a: any) => a.level)).toEqual(["L4", "L4"]); // L4 first, oldest first
    // Attention also raised its own "waiting on you" for the blocked pane; both sit on that worker's line.
    const onWorker = (await d.req("GET", `/api/asks?worker=${encodeURIComponent(wid)}`)).body.asks;
    expect(onWorker.map((a: any) => a.id)).toContain(`attention:${it.id}`);
    expect(onWorker.every((a: any) => a.kind === "prompt" && a.task === T.ship && a.place.id === wid)).toBe(true);
  });
});
