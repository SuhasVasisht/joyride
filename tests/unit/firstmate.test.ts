// Firstmate module: FM_HOME parsing into tasks, mission mapping (marker and
// crews), crew identity by recorded pane and FM_TASK_ID, the watcher, Start Firstmate in its own
// Herdr pane, create_task as a captain inbox note through the real bin/fm-inbox.sh, and steer_task
// through the real bin/fm-send.sh.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { sandboxDaemon } from "../sandbox.ts";
import { pngDataUrl } from "../fixtures/images.ts";
import { startFakeHerdr, waitFor, assertSandboxed, FIXTURE_REPOS, type FakeHerdr } from "../fixtures/fake-herdr.ts";
import { buildFirstmateHome, FIXTURE_CREW_PANES as PANES, FIXTURE_TASKS as T } from "../e2e/crew-fixture.ts";
import { parseBacklog, parseMeta, parseStatusLog, parseProjects, parseSecondmates, taskStatus } from "../../src/modules/firstmate/state.ts";

process.env.JOYRIDE_HERDR_POLL_MS = "300";
process.env.JOYRIDE_FIRSTMATE_POLL_MS = "200";

const MISSION = "csv-export";
let d: Awaited<ReturnType<typeof sandboxDaemon>>;
let fake: FakeHerdr;
let home: string;

beforeAll(async () => {
  home = path.join(process.env.JOYRIDE_RUNTIME!, "firstmate");
  buildFirstmateHome(home, MISSION);
  d = await sandboxDaemon("firstmate", ["sessions", "missions", "live", "firstmate", "uploads"]);
  fake = await startFakeHerdr(d.sb.env.JOYRIDE_HERDR_SOCKET, { scenario: "default" });
  await assertSandboxed(d.sb.env);
  await d.start();
  await waitFor(async () => (await d.req("GET", "/api/firstmate/status")).body.vendor.present, 5000);
  const r = await d.req("POST", "/api/missions", {
    id: MISSION, title: "CSV export with totals", goal: "Users can export the report as CSV, including a totals row.",
    done_when: ["The export button downloads a CSV with a totals row", "e2e test covers the export"], repos: [FIXTURE_REPOS.alpha],
  });
  expect(r.status).toBe(201);
  // A second mission that owns the done task through its authored crews list (no marker in that brief).
  await d.req("POST", "/api/missions", { id: "sync-job", title: "Idempotent sync", crews: [T.done], repos: [FIXTURE_REPOS.beta] });
  await waitFor(async () => (await d.req("GET", "/api/herdr/status")).body.connected, 5000);
  // Mission changes re-map tasks after a short debounce.
  await waitFor(async () => (await d.req("GET", `/api/firstmate/tasks/${T.done}`)).body.mission === "sync-job", 4000);
});
afterAll(async () => {
  await d?.stop();
  await fake?.stop();
});

describe("parsers", () => {
  it("reads tasks-axi backlog rows, sections, metadata and dependencies", () => {
    const rows = parseBacklog(fs.readFileSync(path.join(home, "data", "backlog.md"), "utf8"));
    expect(rows.map((r) => [r.id, r.section])).toEqual([[T.ship, "in_flight"], [T.scout, "in_flight"], [T.queued, "queued"], [T.done, "done"]]);
    expect(rows[0]).toMatchObject({ title: "Add a CSV export button with totals", repo: "alpha", kind: "ship", checked: false });
    expect(rows[1]).toMatchObject({ kind: "scout", title: "Why the export test flakes on CI" });
    expect(rows[2]).toMatchObject({ blocked_by: [T.ship], title: "Document the CSV export" });
    expect(rows[3]).toMatchObject({ checked: true, completed: { verb: "done" }, title: "Make the sync job idempotent" });
  });
  it("reads meta (last key wins), the status log, projects and secondmates", () => {
    expect(parseMeta("branch=a\nworktree=/x\nbranch=fm/b\n")).toEqual({ branch: "fm/b", worktree: "/x" });
    const log = parseStatusLog("working [key=impl] [at=1790000000]: step one\ncontinued prose\nnote: fyi\nblocked: waiting on keys\n");
    expect(log).toEqual([
      { verb: "working", text: "step one continued prose", at: new Date(1790000000 * 1000).toISOString(), key: "impl" },
      { verb: "note", text: "fyi", at: null, key: null },
      { verb: "blocked", text: "waiting on keys", at: null, key: null },
    ]);
    expect(taskStatus(null, log, [{ verb: "blocked" }])).toBe("blocked");
    // A decision the fold has closed is history: the task reads as working again.
    expect(taskStatus(null, log)).toBe("working");
    expect(parseProjects("- alpha [local-only] - app\n- beta [local-only +yolo branch=jr/] - svc\n- gamma - legacy\n")).toEqual([
      { name: "alpha", mode: "local-only", flags: [], description: "app" },
      { name: "beta", mode: "local-only", flags: ["+yolo", "branch=jr/"], description: "svc" },
      { name: "gamma", mode: "no-mistakes", flags: [], description: "legacy" },
    ]);
    expect(parseSecondmates("- sm-infra - Infra (home: /tmp/sm; projects: beta, gamma; added 2026-10-01)\n")[0]).toMatchObject({ id: "sm-infra", home: "/tmp/sm", projects: ["beta", "gamma"] });
  });
});

describe("tasks projection", () => {
  it("lists every task with status, worktree, branch, last event, report and mission", async () => {
    const r = await d.req("GET", "/api/firstmate/tasks");
    expect(r.status).toBe(200);
    const byId = Object.fromEntries(r.body.map((t: any) => [t.id, t]));
    expect(Object.keys(byId).sort()).toEqual([T.done, T.queued, T.scout, T.ship].sort());
    expect(byId[T.ship]).toMatchObject({
      status: "working", kind: "ship", harness: "claude", branch: `fm/${T.ship}`, mission: MISSION, mission_source: "marker", section: "in_flight", mode: "local-only",
      last_event: "working: running the e2e suite against the totals row", report: null, depends_on: [],
    });
    expect(byId[T.ship].worktree).toMatch(new RegExp(`${T.ship}$`));
    expect(byId[T.ship].turn_ended).toBeTruthy();
    expect(byId[T.scout]).toMatchObject({ status: "needs-decision", kind: "scout", mission: MISSION });
    expect(byId[T.scout].report).toBe(path.join(home, "data", T.scout, "report.md"));
    expect(byId[T.queued]).toMatchObject({ status: "waiting", section: "queued", depends_on: [T.ship], mission: MISSION });
    expect(byId[T.done]).toMatchObject({ status: "done", section: "done", mission: "sync-job", mission_source: "crews" });
  });

  it("filters by mission and serves reports", async () => {
    const r = await d.req("GET", `/api/firstmate/tasks?mission=${MISSION}`);
    expect(r.body.map((t: any) => t.id).sort()).toEqual([T.queued, T.scout, T.ship].sort());
    const rep = await d.req("GET", `/api/firstmate/tasks/${T.scout}/report`);
    expect(rep.body.text).toContain("Recommendation: fix the race first");
    expect((await d.req("GET", `/api/firstmate/tasks/${T.ship}/report`)).status).toBe(404);
  });

  it("links marker tasks into the mission's authored crews", async () => {
    await waitFor(async () => (await d.req("GET", `/api/missions/${MISSION}`)).body.crews.length === 3, 4000);
    const m = (await d.req("GET", `/api/missions/${MISSION}`)).body;
    expect(m.crews.sort()).toEqual([T.queued, T.scout, T.ship].sort());
  });

  it("reports status: configured for herdr, not running, task counts, Firstmate's summary", async () => {
    const s = (await d.req("GET", "/api/firstmate/status")).body;
    expect(s).toMatchObject({ home, home_exists: true, configured: true, backend: "herdr", running: false, pane: null, herdr_connected: true });
    expect(s.tasks).toMatchObject({ total: 4, in_flight: 2, queued: 1, done: 1, for_missions: 4 });
    expect(s.summary).toMatchObject({ state: "captain_decision", decisions_open: 1, active: 2, queued: 1, landed: 1 });
    expect(s.projects.map((p: any) => p.mode)).toEqual(["local-only", "local-only"]);
    expect(s.vendor).toMatchObject({ present: true, pinned: true });
  });

  it("serves status without reading the filesystem or rebuilding account configuration", async () => {
    const read = vi.spyOn(fs, "readFileSync");
    const stat = vi.spyOn(fs, "statSync");
    const exists = vi.spyOn(fs, "existsSync");
    try {
      expect((await d.req("GET", "/api/firstmate/status")).status).toBe(200);
      expect(read).not.toHaveBeenCalled();
      expect(stat).not.toHaveBeenCalled();
      expect(exists).not.toHaveBeenCalled();
    } finally { read.mockRestore(); stat.mockRestore(); exists.mockRestore(); }
  });

  it("picks up changes to FM_HOME and announces them", async () => {
    const seen: string[] = [];
    const off = d.ctx.bus.onChange((c) => { if (c.entity === "tasks") seen.push(c.entity); });
    fs.appendFileSync(path.join(home, "state", `${T.ship}.status`), `done [at=${Math.floor(Date.now() / 1000)}]: ready in branch fm/${T.ship}\n`);
    await waitFor(async () => (await d.req("GET", `/api/firstmate/tasks/${T.ship}`)).body.status === "done", 4000);
    expect((await d.req("GET", `/api/firstmate/tasks/${T.ship}`)).body.last_event).toBe(`done: ready in branch fm/${T.ship}`);
    expect(seen.length).toBeGreaterThan(0);
    off();
  });

  it("knows a crewmate by the Herdr pane its task recorded, never by its cwd", async () => {
    const wt = (await d.req("GET", `/api/firstmate/tasks/${T.ship}`)).body.worktree;
    expect((await d.req("GET", `/api/firstmate/tasks/${T.ship}`)).body).toMatchObject({ pane: PANES.ship, herdr_session: "default", backend: "herdr" });
    // The crewmate's pane, wherever its shell wandered; and a captain session opened inside the worktree.
    fake.addPane({ workspace_id: "w90", pane_id: PANES.ship, cwd: "/tmp", agent: "claude", agent_status: "working", title: "CSV crewmate", label: "alpha-wt" });
    fake.addPane({ workspace_id: "w91", cwd: path.join(wt, "src"), agent: "claude", agent_status: "idle", title: "Captain poking around", label: "captain" });
    await waitFor(async () => (await d.req("GET", `/api/firstmate/tasks/${T.ship}`)).body.workers.length === 1, 5000);
    const w = (await d.req("GET", `/api/firstmate/tasks/${T.ship}`)).body.workers[0];
    expect(w).toMatchObject({ id: `local:${PANES.ship}`, agent: "claude", status: "working", controllable: true });
    await waitFor(async () => ((await d.req("GET", "/api/workers")).body as any[]).some((x) => x.title === "Captain poking around"), 5000);
    const all = (await d.req("GET", "/api/workers")).body as any[];
    expect(all.find((x) => x.id === `local:${PANES.ship}`)).toMatchObject({ crew: T.ship, owner: { tier: "crew", task: T.ship, via: "pane" }, mission: MISSION });
    expect(all.find((x) => x.title === "Captain poking around")).toMatchObject({ crew: null, owner: { tier: "watched", task: null }, mission: null });
  });

  it("knows a crewmate by the FM_TASK_ID its hooks report when the task records no Herdr pane", async () => {
    // The scout task runs on a tmux window, so the pane names no task; its Claude hooks carry FM_TASK_ID.
    const pane = fake.addPane({ workspace_id: "w92", cwd: "/tmp", agent: "claude", agent_status: "idle", title: "Flake scout" });
    const session = "aaaaaaaa-0000-4000-8000-0000000000a1";
    d.ctx.emit({ source: "hook.claude", type: "session.start", session, agent: "claude", cwd: "/tmp", pane: pane.pane_id, data: { fm_task: T.scout } } as any);
    await waitFor(async () => (await d.req("GET", `/api/firstmate/tasks/${T.scout}`)).body.workers.length === 1, 5000);
    const w = await waitFor(async () => ((await d.req("GET", "/api/workers")).body as any[]).find((x) => x.id === `local:${pane.pane_id}`));
    expect(w).toMatchObject({ session: `claude:${session}`, crew: T.scout, owner: { tier: "crew", task: T.scout, via: "env" }, mission: MISSION });
    // An FM_TASK_ID for a task this home does not have names no crew.
    const stray = fake.addPane({ workspace_id: "w93", cwd: "/tmp", agent: "claude", agent_status: "idle", title: "Other home's crewmate" });
    d.ctx.emit({ source: "hook.claude", type: "session.start", session: "aaaaaaaa-0000-4000-8000-0000000000a2", agent: "claude", cwd: "/tmp", pane: stray.pane_id, data: { fm_task: "not-in-this-home" } } as any);
    await waitFor(async () => ((await d.req("GET", "/api/workers")).body as any[]).some((x) => x.id === `local:${stray.pane_id}` && x.session), 5000);
    expect(((await d.req("GET", "/api/workers")).body as any[]).find((x) => x.id === `local:${stray.pane_id}`).owner.tier).toBe("watched");
  });

  it("does not mistake a recorded crew pane launched from the Firstmate checkout for its supervisor", async () => {
    const dir = d.ctx.service("firstmate").status().vendor.path;
    const existing = fake.panes.get(PANES.ship);
    const original = existing ? { ...existing } : null;
    const pane = existing ?? fake.addPane({ workspace_id: "w90", pane_id: PANES.ship, agent: "codex", agent_status: "idle" });
    try {
      pane.cwd = dir;
      pane.foreground_cwd = (await d.req("GET", `/api/firstmate/tasks/${T.ship}`)).body.worktree;
      pane.label = "firstmate";
      await d.ctx.service("herdr").refresh();
      expect((await d.req("GET", "/api/firstmate/status")).body).toMatchObject({ running: false, pane: null });
      await waitFor(async () => ((await d.req("GET", "/api/workers")).body as any[]).find((w) => w.id === `local:${PANES.ship}`)?.owner.tier === "crew");
    } finally {
      if (original) Object.assign(pane, original);
      else fake.closePane(pane.pane_id);
      await d.ctx.service("herdr").refresh();
    }
  });
});

describe("intents", () => {
  const intent = async (kind: string, target: string, payload: Record<string, unknown>) => (await d.req("POST", "/api/intents", { kind, target, payload })).body;

  it("files create_task while Firstmate is stopped, for its next start, and never auto-starts it", async () => {
    const it = await intent("create_task", MISSION, { brief: "Add a CSV export" });
    expect(it.status, it.error).toBe("sent");
    expect(it.result).toMatchObject({ via: "inbox", outcome: "created", firstmate_running: false });
    expect(fs.readdirSync(path.join(home, "state", "inbox")).filter((n) => n.endsWith(".note")).length).toBeGreaterThan(0);
    expect(fake.calls.some((c) => c.method === "agent.start")).toBe(false);
  });

  it("starts Firstmate in its own Herdr pane with FM_HOME, only when asked", async () => {
    const r = await d.req("POST", "/api/firstmate/start");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ kind: "start_firstmate", status: "sent", result: { started: true, running: true } });
    const ws = fake.calls.find((c) => c.method === "workspace.create");
    expect(ws?.params).toMatchObject({ label: "firstmate", env: { FM_HOME: home, FM_BACKEND: "herdr" } });
    expect(ws?.params.cwd).toMatch(/vendor\/firstmate$/);
    expect(fake.calls.find((c) => c.method === "agent.start")?.params).toMatchObject({ name: expect.stringMatching(/^firstmate/), kind: "claude" });
    expect(fs.existsSync(path.join(home, "data", "captain.md"))).toBe(true);
    const s = (await d.req("GET", "/api/firstmate/status")).body;
    expect(s.running).toBe(true);
    // A second start reuses the pane.
    const again = await d.req("POST", "/api/firstmate/start");
    expect(again.body.result.started).toBe(false);
    expect(fake.calls.filter((c) => c.method === "agent.start").length).toBe(1);
  });

  it("Firstmate's own pane is the control worker, not crew or watched", async () => {
    const pane = (await d.req("GET", "/api/firstmate/status")).body.pane;
    await waitFor(async () => ((await d.req("GET", "/api/workers")).body as any[]).some((x) => x.id === pane.worker), 5000);
    expect(((await d.req("GET", "/api/workers")).body as any[]).find((x) => x.id === pane.worker).owner).toEqual({ tier: "control", task: null, via: "control" });
  });

  /** The note fm-inbox.sh filed for an intent, by its request id. */
  const noteFor = (requestId: string) => {
    const dir = path.join(home, "state", "inbox");
    const name = fs.readdirSync(dir).filter((n) => n.endsWith(".note")).find((n) => fs.readFileSync(path.join(dir, n), "utf8").includes(`request_id=${requestId}`));
    return name ? fs.readFileSync(path.join(dir, name), "utf8") : null;
  };

  it("create_task files a captain inbox note with the mission marker, goal, done_when, evidence and local-only, and leaves Firstmate's draft alone", async () => {
    const pane = (await d.req("GET", "/api/firstmate/status")).body.pane;
    // The captain is half-way through typing to Firstmate.
    fake.panes.get(pane.pane_id)!.input = "and also check the nightly job";
    const prompts = fake.prompts.length, inputs = fake.inputs.length;
    const it = await intent("create_task", MISSION, { brief: "Add the totals row to the CSV export" });
    expect(it.status).toBe("sent");
    expect(it.result).toMatchObject({ mission: MISSION, via: "inbox", outcome: "created", firstmate_running: true, marker: `joyride-mission: ${MISSION}` });
    expect(it.result.cleared).toBeUndefined();
    // Nothing was typed into Firstmate's pane, so the draft is still there.
    expect(fake.prompts.length).toBe(prompts);
    expect(fake.inputs.length).toBe(inputs);
    expect(fake.panes.get(pane.pane_id)!.input).toBe("and also check the nightly job");
    const note = noteFor(it.id)!;
    expect(note).toMatch(new RegExp(`^id=${it.result.note}$`, "m"));
    // One check wake for Firstmate's next drain.
    expect(fs.readFileSync(path.join(home, "state", "inbox", ".announced", it.result.note), "utf8")).toMatch(/^\d{4}-/);
    const p = { text: note };
    expect(p.text).toContain(`joyride-mission: ${MISSION}`);
    expect(p.text).toContain("What to do: Add the totals row to the CSV export");
    expect(p.text).toContain("Users can export the report as CSV, including a totals row.");
    expect(p.text).toContain("- The export button downloads a CSV with a totals row");
    expect(p.text).toContain(`joyride-evidence run --mission ${MISSION}`);
    expect(p.text).toContain("project mode local-only, no push/PR");
    expect(p.text).toContain(FIXTURE_REPOS.alpha);
  });

  it("create_task with images puts their stored paths in the note, with how to open them", async () => {
    const img = (await d.req("POST", "/api/uploads", { name: "mock.png", data: pngDataUrl() })).body.path;
    const prompts = fake.prompts.length;
    const it = await intent("create_task", MISSION, { brief: "Match the totals row to this mock", images: [img] });
    expect(it.status).toBe("sent");
    expect(it.result.images).toEqual([img]);
    expect(fake.prompts.length).toBe(prompts);
    const note = noteFor(it.id)!;
    expect(note).toContain(`The captain attached an image. It is stored at:\n- ${img}\nPut these paths in the task brief so the crewmate opens them too`);
    expect(note).toContain("Read in Claude Code and view_image in Codex");
    expect((await intent("create_task", MISSION, { brief: "x", images: ["/etc/hosts"] })).error).toMatch(/not an image uploaded to Joyride/);
  });

  // Clipboard screenshots all arrive named image.png, often with the same bytes.
  const pasteThree = async () => {
    const got: string[] = [];
    for (let i = 0; i < 3; i++) got.push((await d.req("POST", "/api/uploads", { name: "image.png", data: pngDataUrl() })).body.path);
    expect(new Set(got).size).toBe(3);
    return got;
  };

  it("create_task with the same screenshot pasted three times lists three distinct paths, in order", async () => {
    const imgs = await pasteThree();
    const it = await intent("create_task", MISSION, { brief: "These three show the clipped chart", images: imgs });
    expect(it.status).toBe("sent");
    expect(it.payload.images).toEqual(imgs);
    expect(it.result.images).toEqual(imgs);
    const note = noteFor(it.id)!;
    expect(note).toContain(`The captain attached 3 images. They are stored at:\n- ${imgs[0]}\n- ${imgs[1]}\n- ${imgs[2]}\nPut these paths in the task brief`);
  });

  it("create_task explains bad input", async () => {
    expect((await intent("create_task", "no-such-mission", { brief: "x" })).error).toMatch(/no mission no-such-mission/);
    expect((await intent("create_task", MISSION, { brief: "  " })).error).toMatch(/Say what the crew should do/);
  });

  it("steer_task runs bin/fm-send.sh against FM_HOME and records the steer in the task inbox", async () => {
    const r = await d.req("POST", "/api/firstmate/send", { task: T.scout, text: "Fix the download race first, then the timezone." });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ kind: "steer_task", target: T.scout, status: "sent", result: { task: T.scout, recorded: true } });
    const inbox = path.join(home, "state", `${T.scout}.inbox`);
    const msgs = fs.readdirSync(inbox).filter((n) => n.endsWith(".msg"));
    expect(msgs.length).toBe(1);
    expect(fs.readFileSync(path.join(inbox, msgs[0]), "utf8")).toContain("Fix the download race first, then the timezone.");
    // The doorbell went to stubs, never to a real terminal.
    expect(fs.readFileSync(path.join(process.env.JOYRIDE_RUNTIME!, "firstmate-stubs", "calls.log"), "utf8")).toMatch(/tmux /);
    expect((await d.req("GET", `/api/firstmate/tasks/${T.scout}`)).body.inbox_pending).toBe(1);
  });

  it("steer_task with images writes their absolute paths into the inbox message, with how to open them", async () => {
    const img = (await d.req("POST", "/api/uploads", { name: "bug.png", data: pngDataUrl() })).body.path;
    const inbox = path.join(home, "state", `${T.scout}.inbox`);
    const before = new Set(fs.readdirSync(inbox));
    const r = await d.req("POST", "/api/firstmate/send", { task: T.scout, text: "The chart is cut off, see the screenshot.", images: [img] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "sent", payload: { images: [img] }, result: { recorded: true, images: [img] } });
    const msg = fs.readdirSync(inbox).find((n) => n.endsWith(".msg") && !before.has(n))!;
    const body = fs.readFileSync(path.join(inbox, msg), "utf8");
    expect(body).toContain("The chart is cut off, see the screenshot.");
    expect(body).toContain(`- ${img}`);
    expect(body).toMatch(/Open each one before you act on this message: Read in Claude Code and view_image in Codex/);
    const bad = await d.req("POST", "/api/firstmate/send", { task: T.scout, text: "x", images: ["/etc/hosts"] });
    expect(bad.body.error).toMatch(/not an image uploaded to Joyride/);
  });

  it("steer_task with the same screenshot pasted three times writes three distinct paths, in order", async () => {
    const imgs = await pasteThree();
    const inbox = path.join(home, "state", `${T.scout}.inbox`);
    const before = new Set(fs.readdirSync(inbox));
    const r = await d.req("POST", "/api/firstmate/send", { task: T.scout, text: "Three looks at the same bug.", images: imgs });
    expect(r.body).toMatchObject({ status: "sent", payload: { images: imgs }, result: { recorded: true, images: imgs } });
    const msg = fs.readdirSync(inbox).find((n) => n.endsWith(".msg") && !before.has(n))!;
    const body = fs.readFileSync(path.join(inbox, msg), "utf8");
    expect(body).toContain(`The captain attached 3 images. They are stored at:\n- ${imgs[0]}\n- ${imgs[1]}\n- ${imgs[2]}\nOpen each one`);
  });

  it("steer_task explains an unknown task and an empty message", async () => {
    const a = await intent("steer_task", "nope", { text: "hi" });
    expect(a.status).toBe("failed");
    expect(a.error).toMatch(/no running task nope/);
    expect((await intent("steer_task", T.ship, { text: " " })).error).toMatch(/message is empty/);
  });
});
