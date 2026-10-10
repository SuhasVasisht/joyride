// Notes (control plane CP4a): authored files with kind note, scoped to an idea, a task,
// an agent or global; /api/notes; the per-task digest the SessionStart hook appends for
// a crewmate (FM_TASK_ID); notes kept out of repo digests and health; notes in task
// requests; and the `joyride notes` argument parsing and output.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { sandboxDaemon } from "../sandbox.ts";
import { parseFrontmatter } from "../../src/shared/frontmatter.ts";
import { loadNoteFiles, noteEntry } from "../../src/shared/note-files.ts";
import { buildTaskNotesDigest, noteScope, noteTitle, parseNoteScope, taskDigestFile, toBullets, NOTES_DIGEST_MAX_CHARS } from "../../src/shared/notes.ts";
import { buildTaskRequest, REQUEST_NOTES_MAX_BULLETS } from "../../src/modules/firstmate/prompt.ts";
import { formatNote, formatTaskNotes, parseNotesArgs } from "../../src/cli/notes.ts";
import type { Mission } from "../../src/shared/schema.ts";

delete process.env.FM_HOME; // never touch a real Firstmate home from tests

const BUN = process.env.BUN_BIN ?? path.join(os.homedir(), ".bun", "bin", "bun");
const HOOK = path.resolve(__dirname, "../../src/hooks/hook.ts");
const IDEA = "control-plane";
const TASK = "cp4a-notes";

let d: Awaited<ReturnType<typeof sandboxDaemon>>;
let home: string;
let runtime: string;
let repo: string;

const git = (cwd: string, args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
const lastCommit = () => git(home, ["log", "-1", "--format=%s"]);
const digests = () => path.join(runtime, "task-notes");
const taskDigest = (task: string) => { try { return fs.readFileSync(path.join(digests(), taskDigestFile(task)!), "utf8"); } catch { return null; } };
const eventsOf = (type: string) => (d.ctx.db.prepare("SELECT json FROM events WHERE type = ? ORDER BY ts").all(type) as any[]).map((x) => JSON.parse(x.json));

async function note(body: Record<string, unknown>) {
  const r = await d.req("POST", "/api/notes", body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}
function sessionStart(o: { cwd: string; task?: string; agent?: "claude" | "codex"; session?: string }) {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), JOYRIDE_HOME: home, JOYRIDE_RUNTIME: runtime, JOYRIDE_PORT: "1" };
  delete env.JOYRIDE_INTERNAL;
  delete env.FM_TASK_ID;
  if (o.task) env.FM_TASK_ID = o.task;
  const agent = o.agent ?? "claude";
  const r = spawnSync(BUN, [HOOK, agent, "SessionStart"], {
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: o.session ?? "sess-notes", cwd: o.cwd, source: "startup" }),
    env, encoding: "utf8", timeout: 20000,
  });
  expect(r.status, r.stderr).toBe(0);
  if (agent === "codex") return r.stdout;
  return r.stdout ? (JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string) : "";
}

beforeAll(async () => {
  d = await sandboxDaemon("notes", ["missions", "notes"]);
  home = d.sb.env.JOYRIDE_HOME;
  runtime = d.sb.env.JOYRIDE_RUNTIME;
  repo = path.join(d.sb.dir, "repos", "notes-alpha");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 1;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "init"]);
  await d.start();
  // The idea files the task through its authored crews list (as Firstmate's projection would).
  const m = await d.req("POST", "/api/missions", { id: IDEA, title: "The map as the control plane", crews: [TASK], repos: [repo] });
  expect(m.status, JSON.stringify(m.body)).toBe(201);
});
afterAll(async () => { await d?.stop(); });

describe("note helpers", () => {
  it("resolves one scope from scope, idea, task, session or global", () => {
    expect(noteScope({})).toBe("global");
    expect(noteScope({ idea: IDEA })).toBe(`mission:${IDEA}`);
    expect(noteScope({ mission: IDEA })).toBe(`mission:${IDEA}`);
    expect(noteScope({ task: TASK })).toBe(`task:${TASK}`);
    expect(noteScope({ session: "claude:1b2c" })).toBe("session:claude:1b2c");
    expect(noteScope({ scope: "global" })).toBe("global");
    expect(noteScope({ global: true })).toBe("global");
    expect(() => noteScope({ task: TASK, idea: IDEA })).toThrow(/one place/);
    expect(() => noteScope({ scope: "repo:alpha" })).toThrow(/not a place a note can go/);
    expect(() => noteScope({ scope: "fleet" })).toThrow(/not a place/);
    expect(() => noteScope({ task: "../etc" })).toThrow(/not a place/);
    expect(parseNoteScope("task:abc")).toEqual({ kind: "task", id: "abc" });
    expect(parseNoteScope("mission:")).toBeNull();
  });
  it("turns text or a list into bullets and titles from the first one", () => {
    expect(toBullets("- one\n\n* two\n•  three \n4. four\nplain")).toEqual(["one", "two", "three", "four", "plain"]);
    expect(toBullets(["a\nb", "  c  "])).toEqual(["a", "b", "c"]);
    expect(toBullets(undefined)).toEqual([]);
    expect(noteTitle(["Save first, close later"])).toBe("Save first, close later");
    expect(noteTitle(["x".repeat(200)]).length).toBe(80);
  });
  it("keeps a task digest within its budget and says when notes did not fit", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `note-${i}`, bullets: [`bullet ${i} ${"words ".repeat(30)}`] }));
    const d1 = buildTaskNotesDigest({ task: "t1", mission: { id: "m1", title: "M one" }, taskNotes: many.slice(0, 15), ideaNotes: many.slice(15) });
    expect(d1.text.length).toBeLessThanOrEqual(NOTES_DIGEST_MAX_CHARS);
    expect(d1.text.split("\n").filter(Boolean).length).toBeLessThanOrEqual(40);
    expect(d1.text).toMatch(new RegExp(`^Joyride notes from the captain for task t1 and its idea "M one" \\(m1\\): ${d1.ids.length} of 30 notes`));
    expect(buildTaskNotesDigest({ task: "t1", mission: null, taskNotes: [], ideaNotes: [] }).text).toBe("");
  });
});

describe("/api/notes", () => {
  it("saves a note on an idea, a task, an agent and globally, as active committed authored files", async () => {
    const idea = await note({ idea: IDEA, bullets: ["Save first, close later", "Only captain calls turn orange"] });
    expect(idea).toMatchObject({ kind: "note", status: "active", scope: `mission:${IDEA}`, title: "Save first, close later", anchor: { kind: "mission", id: IDEA }, bullets: ["Save first, close later", "Only captain calls turn orange"], provenance: { type: "human", ref: "api" } });
    expect(idea.id).toMatch(/^note-save-first-close-later-[0-9a-f]{6}$/);
    const file = path.join(home, "notes", `${idea.id}.md`);
    const { data, content } = parseFrontmatter(fs.readFileSync(file, "utf8"));
    expect(data).toMatchObject({ kind: "note", scope: `mission:${IDEA}`, status: "active" });
    expect(content.trim()).toBe("- Save first, close later\n- Only captain calls turn orange");
    expect(lastCommit()).toBe(`joyride: notes: add a note to mission:${IDEA}`);
    expect(git(home, ["status", "--porcelain", "--", "notes"])).toBe("");

    const task = await note({ task: TASK, text: "Keep the hook fast\nNo map UI in this phase" });
    expect(task).toMatchObject({ scope: `task:${TASK}`, bullets: ["Keep the hook fast", "No map UI in this phase"] });
    const agent = await note({ session: "claude:11111111-aaaa", bullets: ["This agent is on the old branch"] });
    expect(agent.scope).toBe("session:claude:11111111-aaaa");
    const global = await note({ bullets: ["Lunch at noon"] });
    expect(global.scope).toBe("global");

    // listed by anchor (anchors combine), newest first
    expect((await d.req("GET", `/api/notes?task=${TASK}`)).body.map((n: any) => n.id)).toEqual([task.id]);
    expect((await d.req("GET", `/api/notes?idea=${IDEA}`)).body.map((n: any) => n.id)).toEqual([idea.id]);
    expect((await d.req("GET", `/api/notes?session=claude:11111111-aaaa`)).body.map((n: any) => n.id)).toEqual([agent.id]);
    expect((await d.req("GET", "/api/notes?global=1")).body.map((n: any) => n.id)).toEqual([global.id]);
    expect((await d.req("GET", `/api/notes?task=${TASK}&mission=${IDEA}`)).body.map((n: any) => n.id).sort()).toEqual([idea.id, task.id].sort());
    expect((await d.req("GET", "/api/notes")).body.length).toBe(4);
    expect((await d.req("GET", "/api/notes?q=orange")).body.map((n: any) => n.id)).toEqual([idea.id]);
    expect((await d.req("GET", `/api/notes/${task.id}`)).body.bullets).toEqual(["Keep the hook fast", "No map UI in this phase"]);
  });

  it("edits a note's bullets and place, archives and restores it, each as one commit", async () => {
    const n = await note({ task: TASK, bullets: ["Draft bullet"] });
    const e = await d.req("PUT", `/api/notes/${n.id}`, { bullets: ["Better bullet", "and a second one"] });
    expect(e.status, JSON.stringify(e.body)).toBe(200);
    expect(e.body).toMatchObject({ id: n.id, title: "Better bullet", bullets: ["Better bullet", "and a second one"], scope: `task:${TASK}` });
    expect(lastCommit()).toBe(`joyride: notes: edit ${n.id}`);
    const moved = await d.req("PUT", `/api/notes/${n.id}`, { idea: IDEA });
    expect(moved.body.scope).toBe(`mission:${IDEA}`);
    expect(lastCommit()).toBe(`joyride: notes: edit ${n.id} (moved to mission:${IDEA})`);

    const a = await d.req("POST", `/api/notes/${n.id}/archive`);
    expect(a.body.status).toBe("archived");
    expect(lastCommit()).toBe(`joyride: notes: archive ${n.id}`);
    expect((await d.req("GET", `/api/notes?idea=${IDEA}`)).body.map((x: any) => x.id)).not.toContain(n.id);
    expect((await d.req("GET", `/api/notes?idea=${IDEA}&include_archived=1`)).body.map((x: any) => x.id)).toContain(n.id);
    const r = await d.req("POST", `/api/notes/${n.id}/restore`);
    expect(r.body.status).toBe("active");
    await d.req("POST", `/api/notes/${n.id}/archive`);
  });

  it("pins board items to a group and moves them between a group, an idea and Unfiled", async () => {
    expect((await d.req("POST", "/api/lenses", { id: "launch", title: "Launch" })).status).toBeLessThan(300);
    const list = await note({ group: "launch", bullets: ["[ ] book the room", "[x] send invites"], title: "Demo day" });
    expect(list).toMatchObject({ scope: "group:launch", anchor: { kind: "group", id: "launch" }, title: "Demo day", bullets: ["[ ] book the room", "[x] send invites"] });
    expect(lastCommit()).toBe("joyride: notes: add a note to group:launch");
    expect((await d.req("GET", "/api/notes?group=launch")).body.map((n: any) => n.id)).toEqual([list.id]);
    // A link card is titled by its link; a mixed card by its first line; a list stays "List" until named.
    const link = await note({ scope: "group:launch", bullets: ["[Launch spec](https://example.com/files/launch-spec.pdf)"] });
    expect(link.title).toBe("Launch spec");
    const bare = await note({ bullets: ["https://example.com/files/Q4-plan_v2.pdf"] });
    expect(bare.title).toBe("Q4 plan v2");
    const mixed = await note({ group: "launch", bullets: ["Rehearse the demo", "[ ] tell Sam", "https://example.com/brief.pdf"] });
    expect(mixed.title).toBe("Rehearse the demo");
    const unnamed = await note({ bullets: ["[ ] milk", "[ ] eggs"] });
    expect(unnamed.title).toBe("List");
    // Editing the lines keeps an automatic title following them.
    expect((await d.req("PUT", `/api/notes/${mixed.id}`, { bullets: ["Rehearse the demo twice", "[x] tell Sam"] })).body.title).toBe("Rehearse the demo twice");
    expect((await d.req("PUT", `/api/notes/${link.id}`, { bullets: ["[Launch spec v2](https://example.com/files/launch-spec-2.pdf)"] })).body.title).toBe("Launch spec v2");
    // Move: to an idea, to Unfiled, back to the group.
    expect((await d.req("PUT", `/api/notes/${list.id}`, { idea: IDEA })).body.scope).toBe(`mission:${IDEA}`);
    expect(lastCommit()).toBe(`joyride: notes: edit ${list.id} (moved to mission:${IDEA})`);
    expect((await d.req("PUT", `/api/notes/${list.id}`, { global: true })).body.scope).toBe("global");
    expect((await d.req("PUT", `/api/notes/${list.id}`, { scope: "group:launch" })).body.scope).toBe("group:launch");
    // A group that doesn't exist is refused, with how to fix it.
    const bad = await d.req("PUT", `/api/notes/${list.id}`, { group: "no-such-group" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/There is no group "no-such-group"/);
    for (const n of [list, link, bare, mixed, unnamed]) await d.req("POST", `/api/notes/${n.id}/archive`);
  });

  it("refuses bad notes with errors that say how to fix them", async () => {
    expect((await d.req("POST", "/api/notes", { task: TASK, bullets: ["  ", ""] })).body.error).toMatch(/at least one bullet/);
    expect((await d.req("POST", "/api/notes", { task: TASK, idea: IDEA, bullets: ["x"] })).body.error).toMatch(/one place/);
    const unknown = await d.req("POST", "/api/notes", { idea: "no-such-idea", bullets: ["x"] });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatch(/There is no idea "no-such-idea"/);
    expect((await d.req("POST", "/api/notes", { scope: "repo:alpha", bullets: ["x"] })).body.error).toMatch(/not a place a note can go/);
    expect((await d.req("GET", "/api/notes/note-missing-000000")).status).toBe(404);
    expect((await d.req("PUT", "/api/notes/note-missing-000000", { bullets: ["x"] })).status).toBe(404);
    const notNote = await d.req("PUT", "/api/notes/dec-old", { bullets: ["x"] });
    expect(notNote.status).toBe(404);
    expect(notNote.body.error).toMatch(/There is no note/);
  });
});

describe("task digest and the SessionStart hook", () => {
  it("holds the task's notes and its idea's, and the hook appends it for that crewmate only", async () => {
    const text = taskDigest(TASK)!;
    expect(text).toMatch(new RegExp(`^Joyride notes from the captain for task ${TASK} and its idea "The map as the control plane" \\(${IDEA}\\)`));
    expect(text).toContain(`Task ${TASK}:\n`);
    expect(text).toContain("- Keep the hook fast");
    expect(text).toContain(`Idea ${IDEA}:\n- Save first, close later\n- Only captain calls turn orange`);
    expect(text).not.toContain("Lunch at noon"); // global notes stay out
    expect(text).not.toContain("old branch"); // so do agent notes

    const api = await d.req("GET", `/api/notes/task/${TASK}`);
    expect(api.body).toMatchObject({ task: TASK, mission: { id: IDEA, title: "The map as the control plane" }, file: `task-${TASK}.md`, digest: text });
    expect(api.body.task_notes.length).toBeGreaterThan(0);
    expect(api.body.idea_notes.map((n: any) => n.title)).toContain("Save first, close later");

    // A crewmate (FM_TASK_ID) in the repo gets the repo digest, then its task notes.
    const crew = sessionStart({ cwd: path.join(repo, "src"), task: TASK, session: "sess-crew-1" });
    expect(crew).toBe(text.trim());
    // The same session without FM_TASK_ID, or on another task, gets no notes.
    expect(sessionStart({ cwd: path.join(repo, "src") })).toBe("");
    expect(sessionStart({ cwd: path.join(repo, "src"), task: "some-other-task" })).toBe("");
    // Codex hooks print the same text.
    expect(sessionStart({ cwd: path.join(repo, "src"), task: TASK, agent: "codex", session: "sess-crew-2" })).toBe(text.trim());
    // Outside any repo with a digest, the notes still arrive (after the global digest).
    const outside = fs.mkdtempSync(path.join(d.sb.dir, "plain-"));
    expect(sessionStart({ cwd: outside, task: TASK })).toContain(text.trim());

    // The injection counts as usage of those notes.
    d.tailer.drain(); // session.start from the hook → usage + memory.injected
    d.tailer.drain(); // our own memory.injected events
    const injected = eventsOf("notes.injected").filter((e) => e.data.file === `task-${TASK}.md`);
    expect(injected[0]).toMatchObject({ session: "sess-crew-1" });
    const firstIdeaNote = api.body.idea_notes.find((n: any) => n.title === "Save first, close later");
    expect(injected[0].data.entries).toContain(firstIdeaNote.id);
    const used = (await d.req("GET", `/api/notes/${firstIdeaNote.id}`)).body.used_in;
    expect(used.digests).toContain(`task-${TASK}.md`);
    expect(used.count).toBeGreaterThanOrEqual(1);
  });

  it("follows edits, archives and a hand-written note, and removes a digest with no notes left", async () => {
    const lone = await note({ task: "lone-task", bullets: ["Only note on this task"] });
    expect(taskDigest("lone-task")).toContain("- Only note on this task");
    expect(taskDigest("lone-task")).toMatch(/^Joyride notes from the captain for task lone-task: 1 note;/);
    await d.req("PUT", `/api/notes/${lone.id}`, { bullets: ["Edited note"] });
    expect(taskDigest("lone-task")).toContain("- Edited note");
    await d.req("POST", `/api/notes/${lone.id}/archive`);
    expect(taskDigest("lone-task")).toBeNull();

    // A note written straight into notes/ reaches the task digest.
    const id = "note-by-hand-abc123";
    fs.writeFileSync(path.join(home, "notes", `${id}.md`), `---\nid: ${id}\nkind: note\ntitle: By hand\nscope: task:hand-task\nstatus: active\nconfidence: 1\nprovenance:\n  type: human\n  ref: hand\ncreated: ${new Date().toISOString()}\n---\n\n- By hand\n`);
    d.ctx.service("notes").rebuildTaskDigests();
    expect(taskDigest("hand-task")).toContain("- By hand");
  });

  it("finds authored notes by their task, idea or agent scope", () => {
    const all = loadNoteFiles(path.join(home, "notes")).notes.map(noteEntry);
    const hits = all.filter(n => n.scope === `task:${TASK}` && /hook/i.test(n.body));
    expect(hits.map((h) => h.title)).toContain("Keep the hook fast");
    expect(all.filter(n => n.scope === `mission:${IDEA}` && /orange/i.test(n.body)).map(n => n.kind)).toEqual(["note"]);
    expect(all.filter(n => n.scope === "session:claude:11111111-aaaa" && /branch/i.test(n.body)).length).toBe(1);
  });
});

describe("notes in task requests to Firstmate", () => {
  const mission: Mission = { id: IDEA, title: "The map as the control plane", state: "open", archive: false, goal: "One place to steer.", done_when: [], repos: ["/r"], branches: [], sessions: [], crews: [], lenses: [], blocks: [], override: null, created: "", updated: "" };
  it("puts the idea's notes in the request, capped, and says how to read the rest", () => {
    const text = buildTaskRequest({ mission, brief: "Ship notes", evidenceBin: "/bin/e", skillsDir: "/s", notes: [["Save first", "Close later"], ["Only captain calls turn orange"]] });
    expect(text).toContain("The captain's notes on this idea (put them in the task brief):\n- Save first\n- Close later\n- Only captain calls turn orange");
    expect(text.indexOf("The captain's notes")).toBeGreaterThan(text.indexOf("Mission goal:"));
    const many = Array.from({ length: 40 }, (_, i) => [`note ${i}`]);
    const capped = buildTaskRequest({ mission, brief: "x", evidenceBin: "/bin/e", skillsDir: "/s", notes: many });
    expect(capped).toContain(`10 more via \`joyride notes --idea ${IDEA}\``);
    expect(capped.split("\n").filter((l) => /^- note \d+$/.test(l)).length).toBe(REQUEST_NOTES_MAX_BULLETS);
    expect(buildTaskRequest({ mission, brief: "x", evidenceBin: "/bin/e", skillsDir: "/s" })).not.toContain("captain's notes");
  });
  it("gives create_task the idea's active notes through the notes service", async () => {
    const got = d.ctx.service("notes").forMission(IDEA).map((n: any) => n.bullets);
    expect(got.flat()).toContain("Save first, close later");
    expect(got.flat()).not.toContain("Better bullet"); // archived
  });
});

describe("joyride notes CLI", () => {
  it("parses where, bullets, stdin and flags", () => {
    expect(parseNotesArgs([])).toMatchObject({ cmd: "list", where: {}, bullets: [] });
    expect(parseNotesArgs(["--task", "t1", "--json"])).toMatchObject({ cmd: "list", where: { task: "t1" }, json: true });
    expect(parseNotesArgs(["--idea", "m1"]).where).toEqual({ mission: "m1" });
    expect(parseNotesArgs(["add", "--session", "claude:x", "one", "two"])).toMatchObject({ cmd: "add", where: { session: "claude:x" }, bullets: ["one", "two"] });
    expect(parseNotesArgs(["add", "-"])).toMatchObject({ stdin: true });
    expect(parseNotesArgs(["add", "--", "--not-a-flag"]).bullets).toEqual(["--not-a-flag"]);
    expect(parseNotesArgs(["edit", "note-x", "--title", "T", "new"])).toMatchObject({ cmd: "edit", id: "note-x", title: "T", bullets: ["new"] });
    expect(parseNotesArgs(["archive", "note-x"])).toMatchObject({ cmd: "archive", id: "note-x" });
    expect(parseNotesArgs(["--help"]).cmd).toBe("help");
    expect(() => parseNotesArgs(["archive"])).toThrow(/needs a note id/);
    expect(() => parseNotesArgs(["--task", "a", "--idea", "b"])).toThrow(/one place/);
    expect(() => parseNotesArgs(["--bogus"])).toThrow(/Unknown option --bogus/);
    expect(() => parseNotesArgs(["stray bullet"])).toThrow(/joyride notes add/);
  });
  it("prints a note's place, id and day, then its bullets", () => {
    expect(formatNote({ id: "note-a-1", scope: "task:t1", title: "A", status: "active", created: "2026-10-05T10:00:00Z", bullets: ["one", "two"] }))
      .toBe("task:t1 · note-a-1 · 2026-10-05\n  - one\n  - two");
    expect(formatTaskNotes({ task: "t1", mission: null, task_notes: [], idea_notes: [] })).toBe("Task t1\n  no notes on this task yet\n\nIdea: this task is not filed under an idea yet");
  });
});
