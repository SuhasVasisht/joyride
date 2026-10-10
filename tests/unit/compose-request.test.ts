// New task from anywhere (CP5): placement thresholds and options, the joyride-request marker,
// receipts parsing and request progress (pure), then create_task targeting an idea, `new` and `auto`
// through the real bin/fm-inbox.sh, progress read from its receipts and the backlog.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { sandboxDaemon } from "../sandbox.ts";
import { waitFor, assertSandboxed, FIXTURE_REPOS } from "../fixtures/fake-herdr.ts";
import { buildFirstmateHome, FIXTURE_TASKS as T } from "../e2e/crew-fixture.ts";
import {
  REPLY_KEEP_MS, UNREAD_NUDGE_MS, findRequestNote, kindFrom, mapReplies, parseReceipts, placeCriteria, placementFrom, requestProgress, steerableTasks,
  type ReceiptNote,
} from "../../src/modules/firstmate/request.ts";
import { buildTaskRequest } from "../../src/modules/firstmate/prompt.ts";
import { paths } from "../../src/shared/paths.ts";

process.env.JOYRIDE_FIRSTMATE_POLL_MS = "200";

const task = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `Task ${id}`, status: "working", section: "in_flight", mission: null, request: null, last_event: "", ...extra }) as any;
const idea = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `Idea ${id}`, goal: "goal", state: "open", archive: false, updated: "2026-10-01T00:00:00Z", ...extra }) as any;

describe("replies on the map", () => {
  const NOW = Date.parse("2026-10-05T12:00:00Z");
  const it0 = (id: string, extra: Record<string, unknown> = {}) => ({ id, kind: "create_task", status: "sent", created: "2026-10-05T11:00:00Z", payload: { brief: `ask ${id}` }, result: { mission: "idea-a", created_idea: false }, ...extra });
  const note = (rid: string, body: string | null, at = "2026-10-05T11:30:00Z"): ReceiptNote => ({ id: `n-${rid}`, at: "2026-10-05T11:00:00Z", source: "joyride", request_id: rid, acknowledged: true, announced: true, reply: body ? { id: `n-${rid}`, at, body, cursor: "000000000001" } : null });
  const receipts = { schema: "fm-inbox-receipts.v1", pending: [note("r-pending", "on it", "2026-10-05T11:40:00Z")], handled: [note("r-new", "made an idea"), note("r-task", "briefed jr-x"), note("r-quiet", null), note("r-old", "old"), note("r-gone", "dismissed")] };
  it("lists answered requests newest first, with the task a request became, never steers, dismissed or aged-out ones", () => {
    const intents = [
      it0("r-new", { result: { mission: "new-idea", created_idea: true } }), it0("r-task"), it0("r-quiet"), it0("r-pending"),
      it0("r-old", { created: new Date(NOW - REPLY_KEEP_MS - 1000).toISOString() }), it0("r-gone"),
      it0("r-steer", { result: { via: "steer", task: "t1" } }), it0("r-failed", { status: "failed" }), { ...it0("r-other"), kind: "steer_task" },
    ];
    const list = mapReplies(intents, receipts, [{ id: "jr-x", title: "Task X", request: "r-task" }], { "r-gone": "2026-10-05T11:50:00Z" }, NOW);
    expect(list.map((r) => r.request)).toEqual(["r-pending", "r-new", "r-task"]);
    expect(list[1]).toMatchObject({ mission: "new-idea", created_idea: true, task: null, text: "ask r-new", reply: { body: "made an idea" } });
    expect(list[2]).toMatchObject({ mission: "idea-a", task: { id: "jr-x", title: "Task X" }, reply: { body: "briefed jr-x" } });
  });
});

describe("placement", () => {
  const tasks = [task("a"), task("b"), task("c", { section: "done", status: "done" }), task("d", { section: "queued", status: "waiting" })];
  const ideas = [idea("x"), idea("y")];

  it("offers only tasks in flight, and names every target for Jev", () => {
    expect(steerableTasks(tasks).map((t) => t.id)).toEqual(["a", "b"]);
    expect(Object.keys(placeCriteria(steerableTasks(tasks), ideas))).toEqual(["new", "task:a", "task:b", "idea:x", "idea:y"]);
  });

  it("sends on its own at 0.75 and above, and waits below", () => {
    const sure = placementFrom("idea:x", { "idea:x": 0.8, "task:a": 0.1, new: 0.1 }, steerableTasks(tasks), ideas);
    expect(sure).toMatchObject({ auto: true, choice: { kind: "idea", id: "x" }, via: "jev" });
    const unsure = placementFrom("task:a", { "task:a": 0.6, "idea:y": 0.3, new: 0.1 }, steerableTasks(tasks), ideas);
    expect(unsure.auto).toBe(false);
    expect(unsure.choice).toMatchObject({ kind: "task", id: "a", p: 0.6 });
    // The top three by probability, then "New idea", always.
    expect(unsure.options.map((o) => (o.kind === "new" ? "new" : `${o.kind}:${o.id}`))).toEqual(["task:a", "idea:y", "task:b", "new"]);
    expect(placementFrom("new", { new: 0.9 }, [], ideas)).toMatchObject({ auto: true, choice: { kind: "new" } });
  });

  it("never sends when Jev is unavailable or names something unknown", () => {
    expect(placementFrom(null, {}, steerableTasks(tasks), ideas)).toMatchObject({ choice: null, auto: false, via: "none" });
    expect(placementFrom("idea:gone", { "idea:gone": 0.99 }, steerableTasks(tasks), ideas)).toMatchObject({ choice: null, auto: false });
  });
});

describe("task, note or list", () => {
  it("turns Jev's kind answer into a guess, sure at 0.75 like a placement", () => {
    expect(kindFrom("note", { note: 0.8, task: 0.1, list: 0.1 })).toEqual({ choice: "note", p: 0.8, auto: true });
    expect(kindFrom("list", { list: 0.6, task: 0.4 })).toEqual({ choice: "list", p: 0.6, auto: false });
    expect(kindFrom(null, {})).toBeUndefined();
    expect(kindFrom("idea:x", { "idea:x": 1 })).toBeUndefined();
  });
});

describe("request marker and progress", () => {
  it("puts joyride-request next to joyride-mission, and asks for a reply when no task is made", () => {
    const text = buildTaskRequest({ mission: { id: "m1", title: "M", goal: "", done_when: [], repos: [], branches: [] } as any, brief: "do it", evidenceBin: "/e", skillsDir: "/s", request: "int_123" });
    expect(text).toContain("joyride-mission: m1\njoyride-request: int_123");
    expect(text).toContain("fm-inbox.sh reply <note id>");
    expect(buildTaskRequest({ mission: { id: "m1", title: "M", goal: "", done_when: [], repos: [], branches: [] } as any, brief: "do it", evidenceBin: "/e", skillsDir: "/s" })).not.toContain("joyride-request");
  });

  const note = (extra: Partial<ReceiptNote> = {}): ReceiptNote => ({ id: "n1", at: new Date(0).toISOString(), source: "captain", request_id: "int_1", acknowledged: false, announced: true, reply: null, ...extra });

  it("parses fm-inbox-receipts.v1 and finds a request's note, handled first", () => {
    const r = parseReceipts(`noise\n${JSON.stringify({ schema: "fm-inbox-receipts.v1", pending: [note()], handled: [note({ id: "n2", acknowledged: true })] })}\n`);
    expect(findRequestNote(r, "int_1")?.id).toBe("n2");
    expect(findRequestNote(r, "int_9")).toBeNull();
    expect(() => parseReceipts("{\"schema\":\"other\"}")).toThrow(/unexpected receipts/);
  });

  it("moves through Sent, Read, Replied and Became task", () => {
    const at = Date.parse(note().at!);
    expect(requestProgress("int_1", null, [])).toMatchObject({ stage: "unknown" });
    expect(requestProgress("int_1", note(), [], at + 1000)).toMatchObject({ stage: "sent", unread_too_long: false });
    expect(requestProgress("int_1", note(), [], at + UNREAD_NUDGE_MS)).toMatchObject({ stage: "sent", unread_too_long: true });
    expect(requestProgress("int_1", note({ acknowledged: true }), [])).toMatchObject({ stage: "read", unread_too_long: false });
    expect(requestProgress("int_1", note({ acknowledged: true, reply: { id: "n1", at: null, body: "Folded into jr-x", cursor: "1" } }), [])).toMatchObject({ stage: "replied", reply: { body: "Folded into jr-x" } });
    const p = requestProgress("int_1", note(), [task("jr-new", { request: "int_1", mission: "m1" })]);
    expect(p).toMatchObject({ stage: "task", task: { id: "jr-new", mission: "m1" } });
  });
});

describe("create_task from anywhere, with the real fm-inbox.sh", () => {
  const MISSION = "csv-export";
  let d: Awaited<ReturnType<typeof sandboxDaemon>>;
  let home: string;
  const intent = async (kind: string, target: string, payload: Record<string, unknown>) => (await d.req("POST", "/api/intents", { kind, target, payload })).body;
  const noteFor = (requestId: string) => {
    for (const dir of [path.join(home, "state", "inbox"), path.join(home, "state", "inbox", "handled")]) {
      if (!fs.existsSync(dir)) continue;
      const name = fs.readdirSync(dir).filter((n) => n.endsWith(".note")).find((n) => fs.readFileSync(path.join(dir, n), "utf8").includes(`request_id=${requestId}`));
      if (name) return { file: path.join(dir, name), text: fs.readFileSync(path.join(dir, name), "utf8") };
    }
    return null;
  };

  beforeAll(async () => {
    home = path.join(process.env.JOYRIDE_RUNTIME!, "firstmate");
    buildFirstmateHome(home, MISSION);
    d = await sandboxDaemon("compose-request", ["sessions", "missions", "live", "firstmate"]);
    await assertSandboxed(d.sb.env);
    await d.start();
    expect((await d.req("POST", "/api/missions", { id: MISSION, title: "CSV export with totals", goal: "Users can export the report as CSV.", repos: [FIXTURE_REPOS.alpha] })).status).toBe(201);
    await waitFor(async () => (await d.req("GET", `/api/firstmate/tasks/${T.ship}`)).body.mission === MISSION, 4000);
  });
  afterAll(async () => { await d?.stop(); });

  it("places a request: a fixed idea is certain; the fake Jev's 0.7 waits for the captain", async () => {
    const fixed = (await d.req("POST", "/api/firstmate/place", { text: "Add a footer", idea: MISSION })).body;
    expect(fixed).toMatchObject({ auto: true, via: "fixed", choice: { kind: "idea", id: MISSION } });
    const r = (await d.req("POST", "/api/firstmate/place", { text: "Add a CSV export footer with totals" })).body;
    expect(r.auto).toBe(false);
    expect(r.options.at(-1)).toMatchObject({ kind: "new" });
    expect(r.options.some((o: any) => o.kind === "task" && o.id === T.ship)).toBe(true);
    expect((await d.req("POST", "/api/firstmate/place", { text: " " })).status).toBe(400);
    expect((await d.req("POST", "/api/firstmate/place", { text: "x", idea: "nope" })).status).toBe(404);
  });

  it("asks Jev whether unsure text is a task, a note or a list only when told to, in the same placement", async () => {
    const plain = (await d.req("POST", "/api/firstmate/place", { text: "remember the PDF export rounds differently" })).body;
    expect(plain.kind).toBeUndefined();
    const r = (await d.req("POST", "/api/firstmate/place", { text: "remember the PDF export rounds differently", kinds: true })).body;
    // The fake Jev matches "remember" to the note criterion at 0.7: below the threshold, so the captain picks.
    expect(r.kind).toEqual({ choice: "note", p: 0.7, auto: false });
    expect(r.options.at(-1)).toMatchObject({ kind: "new" });
    const fixed = (await d.req("POST", "/api/firstmate/place", { text: "remember the PDF export rounds differently", idea: MISSION, kinds: true })).body;
    expect(fixed).toMatchObject({ via: "fixed", choice: { kind: "idea", id: MISSION }, kind: { choice: "note", auto: false } });
  });

  it("create_task auto refuses to guess below the threshold, and says how to fix it", async () => {
    const it = await intent("create_task", "auto", { brief: "Add a CSV export footer with totals" });
    expect(it.status).toBe("failed");
    expect(it.error).toMatch(/isn't sure where this goes .*Pick an idea, a task or a new idea/);
  });

  it("create_task into an idea carries both markers, and its progress follows Firstmate's receipts to the task", async () => {
    const it = await intent("create_task", MISSION, { brief: "Add a footer row to the CSV export" });
    expect(it.status, it.error).toBe("sent");
    expect(it.result).toMatchObject({ via: "inbox", request: it.id, mission: MISSION, created_idea: false });
    const n = noteFor(it.id)!;
    expect(n.text).toContain(`joyride-mission: ${MISSION}\njoyride-request: ${it.id}`);

    expect((await d.req("GET", `/api/firstmate/requests/${it.id}`)).body).toMatchObject({ stage: "sent", note: { acknowledged: false }, task: null });
    // Firstmate drains the note (moves it to handled/): Read.
    const handled = path.join(home, "state", "inbox", "handled");
    fs.mkdirSync(handled, { recursive: true });
    fs.renameSync(n.file, path.join(handled, path.basename(n.file)));
    await waitFor(async () => (await d.req("GET", `/api/firstmate/requests/${it.id}`)).body.stage === "read", 4000);
    // Firstmate writes the task with the marker kept verbatim in its brief: Became task.
    const id = "jr-csv-footer";
    fs.appendFileSync(path.join(home, "data", "backlog.md"), "");
    const backlog = fs.readFileSync(path.join(home, "data", "backlog.md"), "utf8").replace("## Queued\n", `## Queued\n\n- [ ] ${id} - Add a footer row to the CSV export (repo: alpha) (kind: ship)\n`);
    fs.writeFileSync(path.join(home, "data", "backlog.md"), backlog);
    fs.mkdirSync(path.join(home, "data", id), { recursive: true });
    fs.writeFileSync(path.join(home, "data", id, "brief.md"), `# Task\n## Captain's intent\njoyride-mission: ${MISSION}\njoyride-request: ${it.id}\n\nAdd a footer row.\n`);
    await waitFor(async () => (await d.req("GET", `/api/firstmate/requests/${it.id}`)).body.stage === "task", 4000);
    expect((await d.req("GET", `/api/firstmate/requests/${it.id}`)).body.task).toMatchObject({ id, mission: MISSION });
  });

  it("shows Firstmate's reply when it answers instead of making a task", async () => {
    const it = await intent("create_task", MISSION, { brief: "Is the totals row rounded on the server?" });
    const n = noteFor(it.id)!;
    const noteId = n.text.match(/^id=(.+)$/m)![1];
    execFileSync(path.join(paths.firstmateDir, "bin", "fm-inbox.sh"), ["reply", noteId, "Yes, server-side. No task needed."], { env: { ...process.env, FM_HOME: home } });
    await waitFor(async () => (await d.req("GET", `/api/firstmate/requests/${it.id}`)).body.stage === "replied", 4000);
    expect((await d.req("GET", `/api/firstmate/requests/${it.id}`)).body.reply.body).toBe("Yes, server-side. No task needed.");
    // The map pins it to the idea the request went into, until the captain dismisses it.
    const mine = async () => ((await d.req("GET", "/api/firstmate/replies")).body as any[]).find((r) => r.request === it.id);
    expect(await mine()).toMatchObject({ mission: MISSION, task: null, created_idea: false, text: "Is the totals row rounded on the server?", reply: { body: "Yes, server-side. No task needed." } });
    expect((await d.req("POST", `/api/firstmate/requests/${it.id}/dismiss`)).status).toBe(200);
    expect(await mine()).toBeUndefined();
  });

  it("create_task new names and commits an idea, then files the request into it", async () => {
    const it = await intent("create_task", "new", { brief: "Nightly backup of the reports database" });
    expect(it.status, it.error).toBe("sent");
    expect(it.result).toMatchObject({ created_idea: true, via: "inbox" });
    const m = (await d.req("GET", `/api/missions/${it.result.mission}`)).body;
    expect(m.title).toBe("Nightly backup of the reports");
    expect(noteFor(it.id)!.text).toContain(`joyride-mission: ${m.id}\njoyride-request: ${it.id}`);
    const log = execFileSync("git", ["-C", paths.root, "log", "--format=%s", "-5"], { encoding: "utf8" });
    expect(log).toMatch(/new idea "Nightly backup of the reports" from a map request/);
  });

  it("nudges an unread request by repairing Firstmate's wake, and refuses once read", async () => {
    const it = await intent("create_task", MISSION, { brief: "Check the export button label" });
    const r = await d.req("POST", `/api/firstmate/requests/${it.id}/nudge`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ stage: "sent", nudged: true });
    expect((await d.req("POST", "/api/firstmate/requests/int_nope/nudge")).status).toBe(404);
  });

  it("keeps preferences in Firstmate's canonical files rather than creating fleet entries", async () => {
    expect((await d.req("GET", "/api/memory?kind=preference&scope=fleet")).status).toBe(404);
  });
});
