// Idea housekeeping end to end in the daemon: a captain moves a Firstmate task between ideas, placement
// files unfiled tasks (the backfill) as one commit with undo, the tidy pass applies only what the guardrails
// allow, the ledger records every run, undo restores exactly what a run changed, the captain's moves win,
// and a decided mission proposal can be reopened.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { sandboxDaemon } from "../sandbox.ts";
import { waitFor } from "../fixtures/fake-herdr.ts";
import { buildFirstmateHome, FIXTURE_TASKS as T } from "../e2e/crew-fixture.ts";
import { readLensDir, readMissionDir } from "../../src/modules/missions/store.ts";
import { registerLlmFake } from "../../src/core/fakes.ts";
import { LIMITS } from "../../src/modules/ideas/index.ts";

process.env.JOYRIDE_FIRSTMATE_POLL_MS = "200";

const C7 = "claude:77777777-7777-4777-8777-777777777777", C8 = "claude:88888888-8888-4888-8888-888888888888";
let d: Awaited<ReturnType<typeof sandboxDaemon>>;
let home: string;
const subjects = () => execFileSync("git", ["log", "--format=%s"], { cwd: home, encoding: "utf8" }).trim().split("\n");
const onDisk = (id: string) => readMissionDir(path.join(home, "missions")).missions.find((m) => m.id === id);
const taskMission = async (id: string) => (await d.req("GET", `/api/firstmate/tasks/${id}`)).body.mission;
const missions = () => d.ctx.service<any>("missions");
/** Seed an idea the way automation would (no captain pin): a plain commit message. */
const seed = (m: Record<string, unknown>) => missions().create(m, `seed ${m.id}`);

beforeAll(async () => {
  const fm = path.join(process.env.JOYRIDE_RUNTIME!, "firstmate");
  buildFirstmateHome(fm, "unused");
  // No task carries a marker here, so every one starts without an idea.
  for (const id of Object.values(T)) {
    const f = path.join(fm, "data", id, "brief.md");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/joyride-mission: .*\n\n/, ""));
  }
  d = await sandboxDaemon("ideas", ["sessions", "missions", "notes", "firstmate", "ideas"]);
  home = d.sb.env.JOYRIDE_HOME;
  await missions().settled();
  await d.start();
  expect((await d.req("POST", "/api/missions", { id: "csv-export", title: "CSV export with totals", goal: "Users export the report as CSV with a totals row." })).status).toBe(201);
  expect((await d.req("POST", "/api/missions", { id: "sync-job", title: "Idempotent sync" })).status).toBe(201);
  await waitFor(async () => (await d.req("GET", "/api/firstmate/tasks")).body.length === 4, 4000);
});
afterAll(async () => { await d?.stop(); });

describe("moving a task between ideas", () => {
  it("links the task through Mission.crews in one commit, and the authored link wins over a brief's marker", async () => {
    const r = await d.req("POST", "/api/missions/move", { task: T.done, to: { mission: "sync-job" } });
    expect(r.status).toBe(200);
    expect(r.body.message).toBe("Moved the task to Idempotent sync.");
    expect(subjects()[0]).toBe(`joyride: map move: task ${T.done} to sync-job`);
    await waitFor(async () => (await taskMission(T.done)) === "sync-job", 4000);

    const m2 = await d.req("POST", "/api/missions/move", { task: T.done, to: "csv-export" });
    expect(m2.status).toBe(200);
    expect(onDisk("sync-job")!.crews).not.toContain(T.done);
    expect(onDisk("csv-export")!.crews).toContain(T.done);
    await waitFor(async () => (await taskMission(T.done)) === "csv-export", 4000);
    expect((await d.req("POST", "/api/missions/move", { task: T.done, to: "csv-export" })).body).toEqual({ commit: null, message: "Already there." });

    // Undo restores both files exactly.
    const u = await d.req("POST", "/api/missions/move/undo", { commit: m2.body.commit });
    expect(u.status).toBe(200);
    expect(onDisk("sync-job")!.crews).toContain(T.done);
    expect(onDisk("csv-export")!.crews).not.toContain(T.done);
  });

  it("explains bad input: no Unfiled for tasks, unknown tasks and ideas", async () => {
    expect((await d.req("POST", "/api/missions/move", { task: T.done, to: { mission: null } })).body.error).toMatch(/always sits in an idea/);
    expect((await d.req("POST", "/api/missions/move", { task: "no-such-task", to: "sync-job" })).status).toBe(404);
    expect((await d.req("POST", "/api/missions/move", { task: T.done, to: "missing" })).status).toBe(404);
    expect((await d.req("POST", "/api/missions/move", { task: "bad id!", to: "sync-job" })).status).toBe(400);
  });
});

describe("placement (the backfill)", () => {
  it("a dry run proposes without writing; a real run files every unfiled task in one commit", async () => {
    const before = subjects().length;
    const dry = await d.req("POST", "/api/ideas/place", { dry_run: true });
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ kind: "place", dry_run: true, commit: null });
    expect(dry.body.ops.length).toBeGreaterThan(0);
    expect(dry.body.ops.every((o: any) => o.status === "proposed")).toBe(true);
    expect(subjects().length).toBe(before);

    const r = await d.req("POST", "/api/ideas/place", { trigger: "backfill" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ kind: "place", trigger: "backfill", error: null });
    // The done task sits in sync-job already (the captain put it there); the other three get ideas.
    const applied = r.body.ops.filter((o: any) => o.status === "applied");
    expect(applied.map((o: any) => o.text).join(" | ")).toMatch(new RegExp(`Filed ${T.ship} in "CSV export with totals"`));
    expect(applied.some((o: any) => o.op.op === "create")).toBe(true);
    expect(subjects()[0]).toMatch(/^joyride: housekeeping: file 3 Firstmate tasks into ideas: /);
    expect(subjects().length).toBe(before + 1);
    for (const id of [T.ship, T.scout, T.queued]) await waitFor(async () => Boolean(await taskMission(id)), 4000);
    expect(await taskMission(T.ship)).toBe("csv-export");
    // Placement used Jev, then the heavy model where Jev was unsure (the fake Jev never passes 0.75).
    expect(applied.every((o: any) => o.via === "idea_naming")).toBe(true);
    expect(r.body.models).toEqual({ place: "jev", naming: "gpt-6.1-sol (medium) on codex" });

    const log = (await d.req("GET", "/api/ideas/log")).body;
    expect(log[0].id).toBe(r.body.id);
    expect(log.some((x: any) => x.id === dry.body.id)).toBe(true);
  });

  it("undo puts the tasks back, and housekeeping never files them again on its own", async () => {
    const run = (await d.req("GET", "/api/ideas/log")).body.find((x: any) => x.kind === "place" && x.commit);
    const u = await d.req("POST", "/api/ideas/undo", { run: run.id });
    expect(u.status).toBe(200);
    expect(u.body.message).toBe("Housekeeping undone.");
    expect(subjects()[0]).toBe(`joyride: undo housekeeping ${run.commit.slice(0, 8)}`);
    await waitFor(async () => (await taskMission(T.ship)) === null, 4000);
    expect((await d.req("POST", "/api/ideas/undo", { run: run.id })).status).toBe(409);
    const again = await d.req("POST", "/api/ideas/place", {});
    expect(again.body.commit).toBeNull();
    expect(again.body.summary).toBe("no unfiled tasks");
  });

  it("a captain move made while the model is thinking wins over the placement", async () => {
    // Clear the veto by filing the ship task by hand, then let placement consider only the scout.
    await d.req("POST", "/api/missions/move", { task: T.ship, to: "csv-export" });
    const fm = path.join(process.env.JOYRIDE_RUNTIME!, "firstmate");
    fs.appendFileSync(path.join(fm, "data", "backlog.md"), "");
    // A fresh task nobody has placed before.
    fs.writeFileSync(path.join(fm, "data", "backlog.md"), fs.readFileSync(path.join(fm, "data", "backlog.md"), "utf8").replace("## Queued", "- [ ] jr-race - Ship the race fix (repo: alpha) (kind: ship)\n\n## Queued"));
    await waitFor(async () => (await d.req("GET", "/api/firstmate/tasks/jr-race")).status === 200, 4000);
    registerLlmFake("idea_naming", () => {
      missions().move({ task: "jr-race", to: { mission: "sync-job" } }); // the captain drags it meanwhile
      return { existing: "csv-export", title: "CSV export with totals", goal: "", group: "" };
    });
    const r = await d.req("POST", "/api/ideas/place", { tasks: ["jr-race"] });
    expect(r.body.ops).toEqual([expect.objectContaining({ status: "rejected", reason: expect.stringMatching(/^the captain put task jr-race where it is/) })]);
    expect(r.body.commit).toBeNull();
    expect(onDisk("sync-job")!.crews).toContain("jr-race");
  });
});

describe("placement only", () => {
  it("offers no tidy operation or endpoint", async () => {
    expect(d.ctx.service("ideas").tidy).toBeUndefined();
    expect((await d.req("POST", "/api/ideas/tidy", {})).status).toBe(404);
  });
});

describe("rate limits", () => {
  it("files at most placeBatch tasks per run, and waits when the naming budget is used up", async () => {
    const fm = path.join(process.env.JOYRIDE_RUNTIME!, "firstmate");
    const backlog = path.join(fm, "data", "backlog.md");
    fs.writeFileSync(backlog, fs.readFileSync(backlog, "utf8").replace("## Queued", "- [ ] jr-rate-a - Rate limited alpha (kind: ship)\n- [ ] jr-rate-b - Rate limited beta (kind: ship)\n\n## Queued"));
    await waitFor(async () => (await d.req("GET", "/api/firstmate/tasks/jr-rate-b")).status === 200, 4000);
    registerLlmFake("idea_naming", () => ({ existing: "sync-job", title: "Idempotent sync", goal: "", group: "" }));
    const saved = { ...LIMITS };
    try {
      LIMITS.namingPerHour = 0;
      const none = await d.req("POST", "/api/ideas/place", { dry_run: true });
      expect(none.body.ops).toEqual([]);
      LIMITS.namingPerHour = saved.namingPerHour;
      LIMITS.placeBatch = 1;
      const one = await d.req("POST", "/api/ideas/place", {});
      expect(one.body.ops.filter((o: any) => o.status === "applied")).toHaveLength(1);
      expect(subjects()[0]).toMatch(/^joyride: housekeeping: file 1 Firstmate task into ideas: /);
    } finally { Object.assign(LIMITS, saved); }
  });
});

describe("reopening a mission proposal", () => {
  const dir = () => path.join(d.sb.env.JOYRIDE_RUNTIME, "proposals", "missions");
  const write = (id: string, sessions: string[]) => {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(path.join(dir(), `${id}.json`), JSON.stringify({
      id, title: `Proposal ${id}`, goal: "", repos: [], branches: [],
      sessions: sessions.map((k) => ({ source: "claude", id: k.slice(7) })), first_ts: "2026-10-01T00:00:00Z", last_ts: "2026-10-02T00:00:00Z", status: "pending", reason: "", merge_into: null,
    }));
  };

  it("puts an accepted proposal back in the queue and gives its sessions back; an emptied mission is archived", async () => {
    write("mp-reopen-1", [C7]);
    const a = await d.req("POST", "/api/missions/proposals/mp-reopen-1/accept", {});
    expect(a.status).toBe(200);
    const mid = a.body.mission.id;
    expect(missions().missionOfSession(C7)).toBe(mid);
    const r = await d.req("POST", "/api/missions/proposals/mp-reopen-1/reopen", {});
    expect(r.status).toBe(200);
    expect(r.body.proposal).toMatchObject({ status: "pending", mission: null, decided_at: null });
    expect(r.body.proposal.history).toEqual([expect.objectContaining({ status: "accepted", mission: mid })]);
    expect(r.body.message).toMatch(/had nothing else in it, so it is archived/);
    expect(subjects()[0]).toMatch(new RegExp(`^joyride: reopen proposal mp-reopen-1: take 1 session back from ${mid} and archive it$`));
    expect(missions().missionOfSession(C7)).toBeNull();
    expect(onDisk(mid)).toMatchObject({ archive: true, state: "dropped", sessions: [] });
    expect((await d.req("GET", "/api/missions/proposals")).body.map((p: any) => p.id)).toContain("mp-reopen-1");
    expect((await d.req("POST", "/api/missions/proposals/mp-reopen-1/reopen", {})).status).toBe(409);
  });

  it("reopens a rejected proposal and keeps the decision in its history; restore false leaves the mission alone", async () => {
    write("mp-reopen-2", [C8]);
    await d.req("POST", "/api/missions/proposals/mp-reopen-2/reject", { reason: "one-off" });
    const r = await d.req("POST", "/api/missions/proposals/mp-reopen-2/reopen", {});
    expect(r.body.proposal.history).toEqual([expect.objectContaining({ status: "rejected", reason: "one-off" })]);
    expect(r.body.commit).toBeNull();
    const a = await d.req("POST", "/api/missions/proposals/mp-reopen-2/accept", { edits: { merge_into: "sync-job" } });
    expect(a.body.mission.id).toBe("sync-job");
    const keep = await d.req("POST", "/api/missions/proposals/mp-reopen-2/reopen", { restore: false });
    expect(keep.body.commit).toBeNull();
    expect(missions().missionOfSession(C8)).toBe("sync-job");
    expect(keep.body.proposal.history.map((h: any) => h.status)).toEqual(["rejected", "accepted"]);
  });
});
