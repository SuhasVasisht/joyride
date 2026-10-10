// CP6 nudges: the rules fire at the right moments, the rate limits hold (one per card, five at L1, a
// daily budget per rule, dismiss and snooze), and in the daemon: a done task asks how it landed and a 👎
// becomes a feedback note plus a learning candidate; housekeeping's commit shows as Tidied and undoes;
// idea_brief is cached by the tasks' status-line signature and rewritten when a status line changes.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { sandboxDaemon } from "../sandbox.ts";
import { waitFor } from "../fixtures/fake-herdr.ts";
import { buildFirstmateHome, FIXTURE_TASKS as T } from "../e2e/crew-fixture.ts";
import { undoNotices } from "../../src/modules/nudges/undo.ts";
import { candidates, emptyState, limit, LIMITS, THRESHOLDS, type RuleInput } from "../../src/modules/nudges/rules.ts";
import { briefInput, briefSig, cleanBrief, fakeBrief, briefPrompt } from "../../src/modules/nudges/brief.ts";
import type { Ask } from "../../src/shared/asks.ts";
import type { Nudge } from "../../src/shared/nudges.ts";
import type { MissionsService } from "../../src/modules/missions/index.ts";
import type { FirstmateApi } from "../../src/modules/firstmate/index.ts";
import type { NudgesService } from "../../src/modules/nudges/index.ts";

const H = 36e5, D = 24 * H, NOW = Date.parse("2026-10-05T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const base = (o: Partial<RuleInput> = {}): RuleInput => ({ now: NOW, tasks: [], ideas: [], prunes: [], firstmate: null, feedback: new Set(), ...o });
const task = (id: string, section: string, updatedAgo: number, mission: string | null = null) => ({ id, title: `Task ${id}`, section, status: section === "done" ? "done" : "working", updated: ago(updatedAgo), mission, last_event: "working: on it" });

describe("nudge rules", () => {
  it("asks how a done task landed only between 2 hours and 7 days after it finished, and never after feedback", () => {
    const tasks = [task("fresh", "done", H), task("ripe", "done", 3 * H), task("old", "done", 8 * D), task("flying", "in_flight", 3 * H), task("rated", "done", 3 * H)];
    const ns = candidates(base({ tasks, feedback: new Set(["rated"]) }));
    expect(ns.map((n) => n.id)).toEqual(["task_done:ripe"]);
    expect(ns[0]).toMatchObject({ rule: "task_done", level: "L2", title: "Done: how did it land?", place: { on: "task", id: "ripe" } });
    expect(ns[0].actions.filter((a) => a.words).map((a) => a.id)).toEqual(["up", "down"]);
  });

  it("asks whether a quiet idea is still wanted only when it has open tasks and 5 days without activity", () => {
    const ideas = [
      { id: "quiet", title: "Quiet idea", state: "open", archive: false, last_activity: ago(6 * D) },
      { id: "busy", title: "Busy idea", state: "open", archive: false, last_activity: ago(D) },
      { id: "empty", title: "No open tasks", state: "open", archive: false, last_activity: ago(9 * D) },
      { id: "paused", title: "Paused", state: "paused", archive: false, last_activity: ago(9 * D) },
    ];
    const tasks = [task("q1", "queued", 6 * D, "quiet"), task("b1", "in_flight", 6 * D, "busy"), task("e1", "done", 9 * D, "empty"), task("p1", "queued", 9 * D, "paused")];
    const ns = candidates(base({ ideas, tasks })).filter((n) => n.rule === "idea_quiet");
    expect(ns.map((n) => n.id)).toEqual(["idea_quiet:quiet"]);
    expect(ns[0].why).toBe("Quiet idea has been quiet for 6 days with 1 open task.");
    expect(ns[0].actions.map((a) => a.id)).toEqual(["keep", "pause", "drop"]);
  });

  it("keeps committed edits in the undo feed, outside nudge candidates", () => {
    const runs = [
      { id: "hk-1", kind: "tidy", at: ago(H), summary: "Merged Usage panel into Usage", commit: "abc1234", undone: null, dry_run: false },
      { id: "hk-2", kind: "tidy", at: ago(H), summary: "dry", commit: null, undone: null, dry_run: true },
      { id: "hk-3", kind: "place", at: ago(H), summary: "undone", commit: "def", undone: { at: ago(1) }, dry_run: false },
      { id: "hk-4", kind: "place", at: ago(2 * D), summary: "old", commit: "fed", undone: null, dry_run: false },
    ];
    expect(candidates(base())).toEqual([]);
    const ns = undoNotices(runs, NOW);
    expect(ns.map((n) => n.id)).toEqual(["tidied:hk-1"]);
    expect(ns[0]).toMatchObject({ title: "Tidied: Merged Usage panel into Usage", ref: { run: "hk-1", commit: "abc1234" } });
    expect(ns[0]).not.toHaveProperty("rule");
  });

  it("surfaces fleet prune proposals as nudges on their worker, and a blocked Firstmate on the hub", () => {
    const prune = { id: "prune-1", title: "Retire old pane", question: "Idle for 3 days", preamble: "", worker: "w1", task: null, mission: "m", opened: ago(H), ref: { prune: "prune-1" } } as unknown as Ask;
    const ns = candidates(base({ prunes: [prune], firstmate: { worker: "fm", title: "Firstmate", since: ago(60e3) } }));
    expect(ns.find((n) => n.rule === "prune")).toMatchObject({ id: "prune:prune-1", place: { on: "worker", id: "w1" }, ref: { ask: "prune-1" } });
    expect(ns.find((n) => n.rule === "prune")!.actions.map((a) => a.id)).toEqual(["preserve", "keep_open"]);
    expect(ns.find((n) => n.rule === "firstmate_waiting")).toMatchObject({ level: "L3", place: { on: "hub" }, actions: [{ id: "open", href: "#/worker/fm" }, { id: "dismiss" }] });
  });
});

describe("rate limits", () => {
  const n = (id: string, level: Nudge["level"], on: Nudge["place"]["on"], placeId: string | null, opened = ago(H)): Nudge =>
    ({ id, rule: id.split(":")[0] as Nudge["rule"], level, title: id, why: "", place: { on, id: placeId }, task: null, mission: null, worker: null, opened, actions: [], ref: {} });

  it("shows at most one nudge per card, the most urgent", () => {
    const r = limit([n("idea_quiet:a", "L1", "idea", "a"), n("task_done:t", "L2", "task", "t"), n("prune:x", "L2", "task", "t")], emptyState(), NOW);
    expect(r.nudges.map((x) => x.id)).toContain("idea_quiet:a");
    expect(r.nudges.filter((x) => x.place.id === "t")).toHaveLength(1);
    expect(r.overflow).toHaveLength(1);
  });

  it("shows at most five L1 nudges; the rest overflow", () => {
    const all = Array.from({ length: 8 }, (_, i) => n(`idea_quiet:i${i}`, "L1", "idea", `i${i}`, ago(i * 60e3)));
    // All already shown today, so the daily budget does not hold any back: only the L1 cap does.
    const r = limit(all, { ...emptyState(), shown: Object.fromEntries(all.map((x) => [x.id, ago(H)])) }, NOW);
    expect(r.nudges).toHaveLength(LIMITS.maxVisibleL1);
    expect(r.overflow).toHaveLength(3);
    expect(LIMITS.maxVisibleL1).toBe(5);
  });

  it("spends a rule's daily budget only on new nudges, and keeps what is already showing", () => {
    const cap = LIMITS.perRulePerDay.task_done;
    const shown: Record<string, string> = {};
    for (let i = 0; i < cap; i++) shown[`task_done:old${i}`] = ago(H);
    const r = limit([n("task_done:new", "L2", "task", "new"), n("task_done:old0", "L2", "task", "old0")], { ...emptyState(), shown }, NOW);
    expect(r.nudges.map((x) => x.id)).toEqual(["task_done:old0"]);
    expect(r.overflow.map((x) => x.id)).toEqual(["task_done:new"]);
    // A day later the budget is free again.
    const later = limit([n("task_done:new", "L2", "task", "new")], { ...emptyState(), shown }, NOW + D + 1);
    expect(later.nudges.map((x) => x.id)).toEqual(["task_done:new"]);
    expect(later.shown["task_done:new"]).toBeTruthy();
  });

  it("drops dismissed nudges for good and snoozed ones until the snooze ends", () => {
    const all = [n("idea_quiet:a", "L1", "idea", "a"), n("idea_quiet:b", "L1", "idea", "b")];
    const st = { ...emptyState(), dismissed: { "idea_quiet:a": ago(D) }, snoozed: { "idea_quiet:b": new Date(NOW + H).toISOString() } };
    expect(limit(all, st, NOW).nudges).toEqual([]);
    expect(limit(all, st, NOW + 2 * H).nudges.map((x) => x.id)).toEqual(["idea_quiet:b"]);
  });

  it("uses the design's thresholds", () => {
    expect(THRESHOLDS).toMatchObject({ doneAfterMs: 2 * H, quietMs: 5 * D });
  });
});

describe("idea_brief", () => {
  const idea = { id: "csv", title: "CSV export", goal: "Export with totals" };
  const ts = [
    { id: "b", title: "Docs", status: "queued", section: "queued", last_event: "" },
    { id: "a", title: "Button", status: "working", section: "in_flight", last_event: "working: wiring the button" },
  ];
  it("is keyed by the tasks' status lines: same input, same signature; a new status line, a new one", () => {
    const one = briefInput(idea, ts);
    expect(one.tasks.map((t) => t.id)).toEqual(["a", "b"]);
    expect(briefSig(briefInput(idea, [...ts].reverse()))).toBe(briefSig(one));
    expect(briefSig(briefInput(idea, [{ ...ts[1], last_event: "working: e2e green" }, ts[0]]))).not.toBe(briefSig(one));
  });
  it("clamps the model's lines and needs a headline", () => {
    expect(cleanBrief({ headline: "x".repeat(200), now: "n", next: "m" })!.headline.length).toBe(90);
    expect(cleanBrief({ headline: "  ", now: "n", next: "m" })).toBeNull();
    expect(fakeBrief(briefPrompt(briefInput(idea, ts)))).toEqual({ headline: "1 in flight, 1 queued, 0 done", now: "Button: working: wiring the button", next: "Docs" });
  });
});

// ---------------------------------------------------------------- daemon
let d: Awaited<ReturnType<typeof sandboxDaemon>>;
let fm: string;
const req = (m: string, u: string, b?: unknown) => d.req(m, u, b);
const nudges = async () => (await req("GET", "/api/nudges")).body as { nudges: Nudge[]; overflow: Nudge[] };

process.env.JOYRIDE_FIRSTMATE_POLL_MS = "200";
process.env.JOYRIDE_HOUSEKEEPING = "0"; // the test starts housekeeping runs itself

beforeAll(async () => {
  fm = path.join(process.env.JOYRIDE_RUNTIME!, "firstmate");
  buildFirstmateHome(fm, "csv-export");
  // The done task finished three hours ago.
  const old = new Date(Date.now() - 3 * H);
  for (const f of fs.readdirSync(path.join(fm, "state"))) if (f.startsWith(`${T.done}.`)) fs.utimesSync(path.join(fm, "state", f), old, old);
  const brief = path.join(fm, "data", T.done, "brief.md");
  if (fs.existsSync(brief)) fs.utimesSync(brief, old, old);
  d = await sandboxDaemon("nudges", ["sessions", "missions", "notes", "firstmate", "ideas", "nudges"]);
  await d.ctx.service<any>("missions").settled();
  await d.start();
  expect((await req("POST", "/api/missions", { id: "csv-export", title: "CSV export with totals", goal: "Users export the report as CSV with a totals row." })).status).toBe(201);
  await waitFor(async () => (await req("GET", "/api/firstmate/tasks")).body.length === 4, 4000);
});
afterAll(async () => { await d?.stop(); });

describe("nudges in the daemon", () => {
  it("asks how the done task landed, and a 👎 saves a feedback note, raises a learning and clears the nudge", async () => {
    await waitFor(async () => (await nudges()).nudges.some((n) => n.id === `task_done:${T.done}`), 4000);
    const bad = await req("POST", `/api/nudges/task_done:${T.done}/act`, { action: "pause" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/not an action of this nudge/);
    expect((await req("POST", `/api/nudges/task_done:${T.done}/act`, { action: "down", origin: "firstmate" })).status).toBe(403);

    const r = await req("POST", `/api/nudges/task_done:${T.done}/act`, { action: "down", words: "The sync still double-writes on retry" });
    expect(r.status).toBe(200);
    const fb = r.body.result;
    expect(fb.note).toMatch(/^note-/);
    const note = (await req("GET", `/api/notes/${fb.note}`)).body;
    expect(note).toMatchObject({ kind: "note", scope: `task:${T.done}`, status: "active", tags: ["feedback", "missed"] });
    expect(note.bullets).toEqual(["Feedback: didn't land well", "The sync still double-writes on retry"]);
    expect(fb.learning).toBeNull();
    // The fixture has no vendored Firstmate, so the inbox note fails, and says so, without losing the feedback.
    expect(typeof fb.told_firstmate).toBe("boolean");
    if (!fb.told_firstmate) expect(fb.firstmate_error).toMatch(/^Couldn't tell Firstmate/);
    expect((await nudges()).nudges.some((n) => n.id === `task_done:${T.done}`)).toBe(false);
  });

  it("writes an idea brief once per status-line signature, and rewrites it when a status line changes", async () => {
    const first = (await req("GET", "/api/nudges/briefs/csv-export")).body;
    expect(["pending", "ok"]).toContain(first.status);
    await d.ctx.service<any>("nudges").idle();
    const ok = (await req("GET", "/api/nudges/briefs/csv-export")).body;
    expect(ok).toMatchObject({ status: "ok", headline: "2 in flight, 1 queued, 0 done", next: "Document the CSV export" });
    expect((await req("GET", "/api/nudges/briefs/csv-export")).body.at).toBe(ok.at); // cached

    fs.appendFileSync(path.join(fm, "state", `${T.ship}.status`), `working [at=${Math.floor(Date.now() / 1000)}]: totals row passes on CI\n`);
    await waitFor(async () => (await req("GET", "/api/nudges/briefs/csv-export")).body.sig !== ok.sig, 4000);
    await d.ctx.service<any>("nudges").idle();
    const next = (await req("GET", "/api/nudges/briefs/csv-export")).body;
    expect(next.status).toBe("ok");
    expect(next.now).toContain("totals row passes on CI");
    expect((await req("GET", "/api/nudges/briefs")).body["csv-export"].sig).toBe(next.sig);
  });

  it("bounds world reads when polling cached briefs across many ideas", async () => {
    for (let i = 0; i < 10; i++) {
      expect((await req("POST", "/api/missions", { id: `brief-cost-${i}`, title: `Quiet idea ${i}` })).status).toBe(201);
    }
    const service = d.ctx.service<NudgesService>("nudges");
    await req("GET", "/api/nudges/briefs");
    await service.idle();
    const cached = (await req("GET", "/api/nudges/briefs")).body;
    const missions = vi.spyOn(d.ctx.service<MissionsService>("missions"), "list");
    const tasks = vi.spyOn(d.ctx.service<FirstmateApi>("firstmate"), "tasks");
    try {
      const all = await req("GET", "/api/nudges/briefs");
      expect(all.status).toBe(200);
      expect(all.body).toEqual(cached);
      console.log(JSON.stringify({ operation: "cached bulk briefs", worldReads: missions.mock.calls.length, taskReads: tasks.mock.calls.length }));
      expect(missions).toHaveBeenCalledTimes(1);
      expect(tasks).toHaveBeenCalledTimes(1);
      missions.mockClear(); tasks.mockClear();
      expect((await req("GET", "/api/nudges/briefs/csv-export")).body).toEqual(cached["csv-export"]);
      expect(missions).not.toHaveBeenCalled();
      expect(tasks).toHaveBeenCalledTimes(1);
    } finally {
      missions.mockRestore(); tasks.mockRestore();
    }
  });

  it("shows housekeeping's commit as Tidied, and its Undo restores the files", async () => {
    const run = (await req("POST", "/api/ideas/place", {})).body;
    expect(run.commit).toBeTruthy();
    const id = `tidied:${run.id}`;
    expect((await nudges()).nudges.some((n) => n.id === id)).toBe(false);
    expect((await req("GET", "/api/nudges/undo-toasts")).body.some((n: { id: string }) => n.id === id)).toBe(true);
    const r = await req("POST", `/api/nudges/undo-toasts/${id}/undo`, {});
    expect(r.status).toBe(200);
    expect(r.body.result.commit).toBeTruthy();
    const log = (await req("GET", "/api/ideas/log")).body;
    expect(log.find((x: any) => x.id === run.id).undone).toBeTruthy();
    expect((await nudges()).nudges.some((n) => n.id === id)).toBe(false);
    expect((await req("POST", `/api/nudges/undo-toasts/${id}/undo`, {})).status).toBe(404);
  });
});
