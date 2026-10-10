import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { sandboxDaemon } from "../sandbox.ts";

// Fixture sessions point at /tmp/joyride-fixture-repos/<name>; make them git repos so repoRootOf resolves.
const REPOS = "/tmp/joyride-fixture-repos";
function fixtureRepos() {
  for (const r of ["alpha", "beta", "gamma"]) {
    const dir = path.join(REPOS, r);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(path.join(dir, ".git"))) { try { execFileSync("git", ["init", "-q", dir]); } catch { fs.mkdirSync(path.join(dir, ".git"), { recursive: true }); } }
  }
  fs.mkdirSync("/tmp/joyride-fixture-norepo/scratch", { recursive: true });
}

const ALPHA = `${REPOS}/alpha`, BETA = `${REPOS}/beta`, GAMMA = `${REPOS}/gamma`;
const C1 = "11111111-1111-4111-8111-111111111111";
const C2 = "22222222-2222-4222-8222-222222222222";
const C3 = "33333333-3333-4333-8333-333333333333";
const C6 = "66666666-6666-4666-8666-666666666666";
const C9 = "99999999-9999-4999-8999-999999999999";
const C10 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HIDDEN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const X1 = "019a0000-0000-7000-8000-000000000001", X2 = "019a0000-0000-7000-8000-000000000002", X3 = "019a0000-0000-7000-8000-000000000003", X4 = "019a0000-0000-7000-8000-000000000004";

let d: Awaited<ReturnType<typeof sandboxDaemon>>;
let svc: any;
const claudeFile = (id: string, cwd = ALPHA) => path.join(d.sb.env.JOYRIDE_CLAUDE_DIR, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${id}.jsonl`);
const userLine = (id: string, text: string, ts = new Date().toISOString()) =>
  JSON.stringify({ parentUuid: null, isSidechain: false, type: "user", cwd: ALPHA, sessionId: id, gitBranch: "main", timestamp: ts, origin: { kind: "human" }, message: { role: "user", content: text } }) + "\n";

beforeAll(async () => {
  fixtureRepos();
  d = await sandboxDaemon("sessions", ["sessions"]);
  svc = d.ctx.service("sessions");
  await svc.reindex();
});
afterAll(async () => { await d?.stop(); });

describe("session readers", () => {
  it("keeps full recovery text separate from cached display turns", async () => {
    const file = claudeFile(C1);
    const before = fs.readFileSync(file);
    const text = "Recovery context with a pending promise.\n".repeat(5000) + "FINAL PROMISE";
    try {
      fs.appendFileSync(file, userLine(C1, text));
      await svc.reindex();
      const display = await svc.transcriptState(`claude:${C1}`, { limit: 1 });
      expect(display.turns[0].text.length).toBeLessThan(2100);
      const full = await svc.transcriptState(`claude:${C1}`, { limit: 1, fullText: true });
      expect(full.turns[0].text === text).toBe(true);
      expect((await svc.transcriptState(`claude:${C1}`, { limit: 1 })).turns[0].text.length).toBeLessThan(2100);
    } finally { fs.writeFileSync(file, before); await svc.reindex(); }
  });
  it("lists visible sessions from both stores, newest first", () => {
    const list = svc.list({ limit: 100 });
    const keys = list.map((s: any) => s.key);
    expect(keys).toHaveLength(12);
    expect(keys.filter((k: string) => k.startsWith("claude:"))).toHaveLength(9);
    expect(keys.filter((k: string) => k.startsWith("codex:"))).toHaveLength(3);
    expect(keys[0]).toBe(`claude:${C1}`);
    const updated = list.map((s: any) => s.updated);
    expect([...updated].sort().reverse()).toEqual(updated);
  });

  it("derives Claude fields from the transcript records", () => {
    const s = svc.get(`claude:${C1}`);
    expect(s).toMatchObject({
      source: "claude", id: C1, title: "Add CSV export to report page", first_prompt: "Add a CSV export button to the report page",
      cwd: ALPHA, repo: ALPHA, branch: "main", turns: 2, model: "claude-sonnet-4-5", subagents: 1, archived: false,
    });
    // streamed records repeat a message id; usage counts once (input + cache + output)
    expect(s.tokens).toBe(1170 + 1240 + 1345);
    expect(Date.now() - Date.parse(s.updated)).toBeLessThan(15 * 60e3);
    expect(Date.parse(s.started)).toBeLessThan(Date.parse(s.updated));
    expect(s.transcript).toBe(claudeFile(C1));
    expect(svc.get(`claude:${C2}`).title).toBe("Flaky export test fix"); // custom title beats the ai title
    expect(svc.get(`claude:${C6}`).branch).toBe("HEAD");
    expect(svc.get(`claude:${C10}`).repo).toBeNull();
    expect(svc.get(C3).key).toBe(`claude:${C3}`); // raw id lookup
  });

  it("derives Codex fields from the threads table and rollouts", () => {
    expect(svc.get(`codex:${X1}`)).toMatchObject({ source: "codex", title: "Export CSV encoding fix", repo: ALPHA, branch: "main", turns: 2, tokens: 52000, model: "gpt-5.1-codex" });
    expect(svc.get(`codex:${X2}`)).toMatchObject({ repo: BETA, branch: "master", turns: 2, first_prompt: "Make the sync job idempotent" });
    expect(svc.get(`codex:${X3}`)).toMatchObject({ repo: GAMMA, turns: 1 });
  });

  it("excludes internal .joyride/llm sessions and empty files", () => {
    expect(svc.get(`claude:${C9}`)).toBeNull();
    expect(svc.get(`codex:${X4}`)).toBeNull();
    expect(svc.get(`claude:${HIDDEN}`)).not.toBeNull(); // indexed, but hidden from lists
    expect(svc.list({ limit: 100 }).some((s: any) => s.key === `claude:${HIDDEN}`)).toBe(false);
    expect(svc.list({ q: "Name these clusters" })).toEqual([]);
    expect(svc.counts()).toMatchObject({ visible: 12, internal: 2, hidden: 1, claude: 9, codex: 3 });
  });

  it("filters by repo, since and text", () => {
    expect(svc.list({ repo: "beta" }).map((s: any) => s.id).sort()).toEqual(["55555555-5555-4555-8555-555555555555", C6, X2].sort());
    expect(svc.list({ repo: ALPHA })).toHaveLength(5);
    expect(svc.list({ since: "30d" })).toHaveLength(9);
    expect(svc.list({ q: "OAuth" }).map((s: any) => s.id)).toEqual([C3]);
    expect(svc.list({ limit: 2 })).toHaveLength(2);
  });

  it("caches parses by path, mtime and size and resumes appended files from the last offset", async () => {
    const again = await svc.reindex();
    expect(again.claude.parsed).toBe(0);
    expect(again.claude.cached).toBe(again.claude.files);
    expect(again.codex.parsed).toBe(0);

    const changes: any[] = [];
    const off = d.ctx.bus.onChange((c) => changes.push(c));
    fs.appendFileSync(claudeFile(C2), userLine(C2, "Also pin the locale"));
    const r = await svc.reindex();
    off();
    expect(r.claude.parsed).toBe(1);
    expect(r.claude.incremental).toBe(1);
    expect(r.claude.bytes).toBeLessThan(400);
    expect(svc.get(C2).turns).toBe(2);
    expect(changes.some((c) => c.entity === "sessions" && c.id === `claude:${C2}`)).toBe(true);

    // A fresh daemon over the same index re-parses nothing.
    const { createDaemon } = await import("../../src/server/app.ts");
    const d2 = await createDaemon({ only: ["sessions"], quiet: true });
    const r2 = await d2.ctx.service<any>("sessions").reindex();
    expect(r2.claude.parsed).toBe(0);
    expect(r2.codex.parsed).toBe(0);
    expect(d2.ctx.service<any>("sessions").list({ limit: 100 })).toHaveLength(12);
    d2.ctx.db.close();
  });

  it("condenses a Claude transcript", async () => {
    const turns = await svc.transcript(`claude:${C1}`, { limit: 50 });
    expect(turns.map((t: any) => t.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(turns[0].text).toBe("Add a CSV export button to the report page");
    expect(turns[1].tools).toEqual([{ name: "Bash", summary: "npm test" }, { name: "Edit", summary: `${ALPHA}/src/report/page.tsx` }]);
    expect(turns[1].text).toBe("Added an Export CSV button next to the date filter.");
    expect(turns[2].text).toBe("Also include the totals row in the export");
    expect(turns[3].text.length).toBeLessThanOrEqual(2000);
    expect(turns[3].text.endsWith("…")).toBe(true);
    expect(JSON.stringify(turns)).not.toMatch(/task-notification|Request interrupted|14 passing|thinking/);
    const last = await svc.transcript(C1, { limit: 1 });
    expect(last).toHaveLength(1);
    expect(last[0].role).toBe("assistant");
  });

  it("condenses Codex transcripts in both rollout formats", async () => {
    const t1 = await svc.transcript(`codex:${X1}`);
    expect(t1.map((t: any) => t.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(t1[0].text).toBe("CSV export breaks on non-ASCII names");
    expect(t1[1].tools).toEqual([{ name: "shell", summary: "grep -rn encode src/export" }, { name: "apply_patch", summary: "csv.ts" }]);
    expect(t1[1].text).toBe("The writer used latin1. Switched it to UTF-8 with a BOM.");
    expect(t1[3].tools).toEqual([{ name: "shell", summary: "npm test" }]);

    const t2 = await svc.transcript(`codex:${X2}`);
    expect(t2.map((t: any) => [t.role, t.text])).toEqual([
      ["user", "Make the sync job idempotent"],
      ["assistant", "The job re-inserts rows on retry. It now upserts by order id."],
      ["user", "Run the tests"],
      ["assistant", "All 14 tests pass."],
    ]);
    expect(t2[1].tools).toEqual([{ name: "shell", summary: "cat sync/job.py" }]);
    expect(JSON.stringify(t2)).not.toMatch(/environment_context/);
  });

  it("serves the HTTP routes", async () => {
    const list = await d.req("GET", "/api/sessions?repo=beta");
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(3);
    const one = await d.req("GET", `/api/sessions/claude:${C1}`);
    expect(one.status).toBe(200);
    expect(one.body.title).toBe("Add CSV export to report page");
    expect((await d.req("GET", "/api/sessions/claude:nope")).status).toBe(404);
    const tr = await d.req("GET", `/api/sessions/codex:${X2}/transcript?limit=2`);
    expect(tr.status).toBe(200);
    expect(tr.body.turns).toHaveLength(2);
    expect((await d.req("GET", `/api/sessions/claude:${C9}/transcript`)).status).toBe(404);
  });

  it("refreshes a session quickly on a hook event", async () => {
    await d.start();
    fs.appendFileSync(claudeFile(C1), userLine(C1, "One more change please"));
    const changed = new Promise<void>((resolve) => {
      const off = d.ctx.bus.onChange((c) => { if (c.entity === "sessions" && svc.get(C1)?.turns === 3) { off(); resolve(); } });
    });
    d.ctx.bus.emitEvent({ ts: new Date().toISOString(), id: "ev_test", source: "hook.claude", type: "turn.stop", session: C1, agent: "claude", cwd: ALPHA, data: {} });
    await Promise.race([changed, new Promise((_, rej) => setTimeout(() => rej(new Error("no refresh within 5s")), 5000))]);
    expect(svc.get(C1).turns).toBe(3);
  });

  it("reads the Codex store read-only, falling back to a private copy", async () => {
    const { readThreads } = await import("../../src/modules/sessions/codex.ts");
    const Database = (await import("better-sqlite3")).default;
    expect(readThreads("/tmp/joyride-no-such-codex-dir")).toBeNull();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "joyride-walfb-"));
    try {
      const live = path.join(dir, "live"), snap = path.join(dir, "snap");
      fs.mkdirSync(live); fs.mkdirSync(snap);
      const w = new Database(path.join(live, "state_5.sqlite"));
      w.pragma("journal_mode = WAL"); w.pragma("wal_autocheckpoint = 0");
      w.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, cwd TEXT, title TEXT, source TEXT)");
      w.prepare("INSERT INTO threads VALUES ('t1', '/x', 1, 2, '/tmp', 'only in the WAL', 'cli')").run();
      // writer still open: rows live only in the WAL; the -shm exists, so a direct read-only open is used
      const direct = readThreads(live);
      expect(direct?.via).toBe("direct");
      expect(direct?.rows.map((r) => r.title)).toEqual(["only in the WAL"]);
      // no -shm: a read-only open would create one, so the reader copies instead and leaves the store untouched
      for (const f of ["state_5.sqlite", "state_5.sqlite-wal"]) fs.copyFileSync(path.join(live, f), path.join(snap, f));
      const copy = readThreads(snap);
      expect(copy?.via).toBe("copy");
      expect(copy?.rows).toHaveLength(1);
      expect(fs.readdirSync(snap).sort()).toEqual(["state_5.sqlite", "state_5.sqlite-wal"]);
      w.close();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
