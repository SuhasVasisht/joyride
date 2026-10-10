// Intents: reply in place (Herdr-managed and not), guard approvals, launch_session,
// handler registry, persistence and events.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { sandboxDaemon } from "../sandbox.ts";
import { startFakeHerdr, waitFor, assertSandboxed, FAKE_SESSIONS, FIXTURE_REPOS, type FakeHerdr } from "../fixtures/fake-herdr.ts";

process.env.JOYRIDE_HERDR_POLL_MS = "400";

const UNMANAGED = "cccccccc-0000-4000-8000-0000000000aa";
const CODEX_ONLY = "dddddddd-0000-7000-8000-0000000000bb";

let d: Awaited<ReturnType<typeof sandboxDaemon>>;
let fake: FakeHerdr;
let kid: ChildProcess;

const post = async (kind: string, target: string, payload: Record<string, unknown> = {}) => (await d.req("POST", "/api/intents", { kind, target, payload }));
const intentEvents = () => {
  d.tailer.drain();
  return (d.ctx.db.prepare("SELECT json FROM events WHERE source = 'intent' ORDER BY rowid").all() as { json: string }[]).map((r) => JSON.parse(r.json));
};

beforeAll(async () => {
  d = await sandboxDaemon("intents", ["live", "guard"]);
  kid = spawn("sleep", ["300"], { stdio: "ignore" });
  const reg = path.join(d.sb.env.JOYRIDE_CLAUDE_DIR, "sessions");
  fs.mkdirSync(reg, { recursive: true });
  fs.writeFileSync(path.join(reg, `${kid.pid}.json`), JSON.stringify({ pid: kid.pid, sessionId: UNMANAGED, cwd: FIXTURE_REPOS.beta, status: "idle", name: "docs pass", updatedAt: Date.now(), statusUpdatedAt: Date.now() }));
  d.ctx.emit({ source: "hook.codex", type: "prompt.submit", session: CODEX_ONLY, agent: "codex", cwd: FIXTURE_REPOS.alpha, data: { prompt: "check the logs" } });
  fake = await startFakeHerdr(d.sb.env.JOYRIDE_HERDR_SOCKET, { scenario: "default" });
  await assertSandboxed(d.sb.env);
  await d.start();
  await waitFor(async () => (await d.req("GET", "/api/workers")).body.length >= 5, 5000);
});
afterAll(async () => {
  await d?.stop();
  await fake?.stop();
  kid?.kill();
});

describe("reply", () => {
  it("prompts a Herdr-managed worker in place and acks when it starts working", async () => {
    const r = await post("reply", "local:w2:p1", { text: "Please add usage examples" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ kind: "reply", target: "local:w2:p1", status: "sent", error: null, result: { worker: "local:w2:p1", pane: "w2:p1", machine: "local", session: `codex:${FAKE_SESSIONS.codexIdle}` } });
    expect(fake.prompts.at(-1)).toMatchObject({ target: "w2:p1", text: "Please add usage examples" });
    await waitFor(async () => (await d.req("GET", `/api/intents/${r.body.id}`)).body.status === "acked", 4000);
    const types = intentEvents().filter((e) => e.data.id === r.body.id).map((e) => e.type);
    expect(types).toEqual(["intent.created", "intent.sent", "intent.acked"]);
  });

  it("explains how to unblock a worker that is waiting on a prompt", async () => {
    const r = await post("reply", "local:w1:p2", { text: "go ahead" });
    expect(r.body.status).toBe("failed");
    expect(r.body.error).toMatch(/waiting on a prompt in its terminal.*approvals tray/);
    expect(fake.prompts.some((p) => p.target === "w1:p2")).toBe(false);
  });

  it("gives the resume command for a Claude worker outside Herdr", async () => {
    const r = await post("reply", `local:pid:${kid.pid}`, { text: "status?" });
    expect(r.body.status).toBe("failed");
    expect(r.body.error).toContain(`claude --resume ${UNMANAGED}`);
    expect(r.body.error).toContain(FIXTURE_REPOS.beta);
    expect(r.body.error).toMatch(/running outside Herdr/);
    expect(r.body.result.resume).toEqual({ agent: "claude", session: UNMANAGED, cwd: FIXTURE_REPOS.beta, command: `cd ${FIXTURE_REPOS.beta} && claude --resume ${UNMANAGED}` });
    expect(intentEvents().find((e) => e.type === "intent.failed" && e.data.id === r.body.id)?.data.error).toContain("claude --resume");
  });

  it("gives the resume command for a Codex worker outside Herdr", async () => {
    const r = await post("reply", `local:codex:${CODEX_ONLY}`, { text: "status?" });
    expect(r.body.status).toBe("failed");
    expect(r.body.error).toContain(`codex resume ${CODEX_ONLY}`);
    expect(r.body.error).toContain(FIXTURE_REPOS.alpha);
  });

  it("fails clearly for unknown workers and empty replies", async () => {
    expect((await post("reply", "local:w9:p9", { text: "hi" })).body.error).toMatch(/not running anymore/);
    expect((await post("reply", "local:w2:p1", { text: "  " })).body.error).toMatch(/reply is empty/);
  });

  it("refuses a reply bound to a previous conversation, terminal or supervisor", async () => {
    const worker = (await d.req("GET", "/api/workers/local:w2:p1")).body;
    const binding = { session: worker.session, terminal_id: worker.terminal_id, control: false };
    const before = fake.prompts.length;
    for (const changed of [{ ...binding, session: "codex:previous" }, { ...binding, terminal_id: "previous-terminal" }, { ...binding, control: true }]) {
      const r = await post("reply", worker.id, { text: "Do not redirect this request", binding: changed });
      expect(r.body).toMatchObject({ status: "failed", result: { code: "connection_changed" } });
    }
    expect(fake.prompts).toHaveLength(before);
    expect((await post("reply", worker.id, { text: "To the same conversation", binding })).body.status).toBe("sent");
    expect(fake.prompts.at(-1)).toMatchObject({ target: "w2:p1", text: "To the same conversation" });
  });

  it("checks the native connection before editing a composer even when the worker snapshot is stale", async () => {
    const worker = (await d.req("GET", "/api/workers/local:w2:p1")).body;
    const pane = fake.panes.get("w2:p1")!;
    const original = pane.terminal_id;
    const prompts = fake.prompts.length, inputs = fake.inputs.length;
    pane.terminal_id = "replacement-terminal"; // no lifecycle push, so Joyride still has the old binding
    try {
      const r = await post("reply", worker.id, { text: "For the original supervisor", binding: { session: worker.session, terminal_id: original, control: false } });
      expect(r.body).toMatchObject({ status: "failed", result: { code: "connection_changed" } });
      expect(fake.prompts).toHaveLength(prompts);
      expect(fake.inputs).toHaveLength(inputs);
    } finally { pane.terminal_id = original; }
  });

  it("reports a transport outage without claiming the conversation needs resuming", async () => {
    await fake.stop();
    await waitFor(async () => (await d.req("GET", "/api/workers/local:w2:p1")).body.controllable === false);
    const before = fake.prompts.length;
    const r = await post("reply", "local:w2:p1", { text: "Keep this unsent request" });
    expect(r.body).toMatchObject({ status: "failed", result: { code: "reconnecting", session: `codex:${FAKE_SESSIONS.codexIdle}` } });
    expect(r.body.result.resume).toBeUndefined();
    expect(fake.prompts).toHaveLength(before);
    await fake.restart();
    await waitFor(async () => (await d.req("GET", "/api/workers/local:w2:p1")).body.controllable === true);
  });
});

describe("approvals", () => {
  const request = async () => (await d.req("POST", "/api/guard/requests", { rule: "git-push", title: "git push to a remote", tool: "Bash", input: { command: "git push origin main" }, session: FAKE_SESSIONS.claudeBlocked, agent: "claude", cwd: FIXTURE_REPOS.alpha })).body;

  it("approve and deny decide guard requests", async () => {
    const a = await request();
    expect(a.decision).toBe("pending");
    const ok = await post("approve", a.id, { reason: "release branch" });
    expect(ok.body).toMatchObject({ status: "sent", result: { request: a.id, decision: "allow" } });
    expect((await d.req("GET", `/api/guard/requests/${a.id}`)).body).toMatchObject({ decision: "allow", reason: "release branch" });

    const b = await request();
    expect((await post("deny", b.id)).body.status).toBe("sent");
    expect((await d.req("GET", `/api/guard/requests/${b.id}`)).body).toMatchObject({ decision: "deny", reason: "denied in Joyride" });
  });

  it("refuses to re-decide and reports unknown requests", async () => {
    const a = await request();
    await post("deny", a.id);
    const again = await post("approve", a.id);
    expect(again.body.status).toBe("failed");
    expect(again.body.error).toMatch(/already decided \(deny/);
    expect((await post("approve", "gr_missing")).body.error).toMatch(/no guard request gr_missing/i);
  });
});

describe("launch_session", () => {
  it("opens a tab in the workspace already at that folder, starts the agent and sends the first prompt", async () => {
    const r = await post("launch_session", "", { cwd: FIXTURE_REPOS.beta, agent: "claude", prompt: "Start with the README", label: "readme" });
    expect(r.body.status).toBe("sent");
    expect(r.body.result).toMatchObject({ machine: "local", workspace_id: "w2", created: "tab", prompt_sent: true });
    const pane = r.body.result.pane_id;
    expect(r.body.result.worker).toBe(`local:${pane}`);
    const start = fake.calls.find((c) => c.method === "agent.start");
    expect(start?.params).toMatchObject({ kind: "claude", pane_id: pane, args: [] });
    expect(fake.prompts.at(-1)).toMatchObject({ target: pane, text: "Start with the README" });
    await waitFor(async () => (await d.req("GET", `/api/workers/local:${pane}`)).body?.controllable === true, 3000);
  });

  it("opens a new workspace for a new folder and can resume a session", async () => {
    const dir = path.join(d.sb.dir, "newrepo");
    fs.mkdirSync(dir, { recursive: true });
    const r = await post("launch_session", dir, { agent: "codex", resume: CODEX_ONLY });
    expect(r.body).toMatchObject({ status: "sent", result: { created: "workspace", prompt_sent: false, argv: ["codex", "resume", CODEX_ONLY] } });
    expect(fake.calls.find((c) => c.method === "workspace.create" && c.params.cwd === dir)?.params).toMatchObject({ label: "newrepo", focus: false });
  });

  it("runs the agent on a configured account by putting its folder in the pane's environment", async () => {
    const file = path.join(d.sb.env.JOYRIDE_HOME, "joyride.config.yaml");
    const before = fs.readFileSync(file, "utf8");
    const second = path.join(d.sb.dir, "codex-2");
    fs.mkdirSync(second, { recursive: true });
    fs.writeFileSync(file, before.replace(/^usage:[\s\S]*$/m, `usage:\n  accounts:\n    - { provider: claude }\n    - { provider: codex }\n    - { provider: codex, label: Codex 2, home: ${second} }\n    - { provider: codex, label: Codex 3, home: ${path.join(d.sb.dir, "codex-3")} }\n`));
    try {
      const envOf = (dir: string) => fake.calls.filter((c) => (c.method === "workspace.create" || c.method === "tab.create") && c.params.cwd === dir).at(-1)?.params.env;
      const folder = (name: string) => { const x = path.join(d.sb.dir, name); fs.mkdirSync(x, { recursive: true }); return x; };
      const a = folder("acct-a");
      const r = await post("launch_session", a, { agent: "codex", account: "codex-2" });
      expect(r.body).toMatchObject({ status: "sent", result: { account: "codex-2", argv: ["codex"] } });
      expect(envOf(a)).toMatchObject({ CODEX_HOME: second, CLAUDECODE: "", CODEX_THREAD_ID: "", CODEX_SESSION_ID: "" });
      // No account, or the default login: today's launch, with no folder override.
      for (const [name, payload] of [["acct-b", { agent: "codex" }], ["acct-c", { agent: "codex", account: "codex" }]] as const) {
        const dir = folder(name);
        const plain = await post("launch_session", dir, payload);
        expect(plain.body.status).toBe("sent");
        expect(envOf(dir)).not.toHaveProperty("CODEX_HOME");
      }
      expect((await post("launch_session", a, { agent: "codex", account: "codex-3" })).body.error)
        .toBe(`Codex 3's folder ${path.join(d.sb.dir, "codex-3")} does not exist yet. Sign in to it first: mkdir -p ${path.join(d.sb.dir, "codex-3")} && CODEX_HOME=${path.join(d.sb.dir, "codex-3")} codex login`);
      expect((await post("launch_session", a, { agent: "claude", account: "codex-2" })).body.error).toMatch(/Codex 2 is a Codex account, so it can't run a Claude Code session\. claude accounts: claude-code\./);
      expect((await post("launch_session", a, { agent: "codex", account: "nope" })).body.error).toMatch(/no account "nope" under usage\.accounts.*codex accounts: codex, codex-2, codex-3/);
    } finally { fs.writeFileSync(file, before); }
  });

  it("rejects bad input with actionable errors", async () => {
    expect((await post("launch_session", "", { cwd: "/nope/missing", agent: "claude" })).body.error).toMatch(/does not exist/);
    expect((await post("launch_session", "", { cwd: FIXTURE_REPOS.alpha, agent: "gemini" })).body.error).toMatch(/"claude", "codex" or "cursor"/);
    expect((await post("launch_session", "", { cwd: FIXTURE_REPOS.alpha, agent: "claude", machine: "mars" })).body.error).toMatch(/Unknown machine "mars"/);
  });
  it("closes only its newly created pane when agent startup fails", async () => {
    const dir = path.join(d.sb.dir, "failed-launch");
    fs.mkdirSync(dir, { recursive: true });
    const before = new Set((await d.req("GET", "/api/workers")).body.map((w: { id: string }) => w.id));
    fake.failNext("agent.start", "agent_spawn_failed", "credentials unavailable");
    const r = await post("launch_session", dir, { agent: "codex" });
    expect(r.body.status).toBe("failed");
    const created = fake.calls.find((c) => c.method === "workspace.create" && c.params.cwd === dir);
    expect(created).toBeTruthy();
    const closed = fake.calls.filter((c) => c.method === "pane.close").at(-1);
    expect(closed).toBeTruthy();
    await waitFor(async () => !(await d.req("GET", "/api/workers")).body.some((w: { cwd: string }) => w.cwd === dir), 3000);
    for (const id of before) expect((await d.req("GET", "/api/workers")).body.some((w: { id: string }) => w.id === id)).toBe(true);
  });
});

describe("registry and storage", () => {
  it("steer_task is a placeholder until Firstmate registers a handler", async () => {
    const r = await post("steer_task", "task-1", { text: "focus on tests" });
    expect(r.body.status).toBe("failed");
    expect(r.body.error).toMatch(/firstmate not available/i);
    const seen: any[] = [];
    d.ctx.service("intents").registerHandler("steer_task", (it: any) => { seen.push(it); return { routed: "firstmate" }; });
    const ok = await post("steer_task", "task-1", { text: "focus on tests" });
    expect(ok.body).toMatchObject({ status: "sent", result: { routed: "firstmate" } });
    expect(seen[0]).toMatchObject({ kind: "steer_task", target: "task-1", payload: { text: "focus on tests" } });
  });

  it("other modules can add kinds; known kinds without a handler fail; unknown kinds are rejected", async () => {
    d.ctx.service("intents").registerHandler("reverify", async () => ({ checked: true }));
    expect((await post("reverify", "mission-x")).body.status).toBe("sent");
    expect((await post("tell_note", "note-x")).body.error).toMatch(/No module handles "tell_note"/);
    const bad = await post("teleport", "x");
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/Unknown intent kind "teleport"/);
    expect((await d.req("POST", "/api/intents", { target: "x" })).status).toBe(400);
  });

  it("lists, filters and persists intents in SQLite", async () => {
    const all = (await d.req("GET", "/api/intents")).body;
    expect(all.length).toBeGreaterThan(10);
    const forW = (await d.req("GET", "/api/intents?target=local:w2:p1")).body;
    expect(forW.every((i: any) => i.target === "local:w2:p1")).toBe(true);
    expect((await d.req("GET", "/api/intents?kind=approve&limit=2")).body.length).toBeLessThanOrEqual(2);
    const svc = d.ctx.service("intents");
    expect(svc.get(all[0].id)?.id).toBe(all[0].id);
    expect((await d.req("GET", "/api/intents/int_nope")).status).toBe(404);
    const rows = d.ctx.db.prepare("SELECT count(*) AS n FROM intents").get() as { n: number };
    expect(rows.n).toBe(all.length);
  });
});
