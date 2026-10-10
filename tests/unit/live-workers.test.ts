// Workers projection: Herdr panes + Claude registry (<claudeDir>/sessions/<pid>.json)
// + recent Codex hook activity, enriched by hook events.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { sandboxDaemon } from "../sandbox.ts";
import { startFakeHerdr, waitFor, assertSandboxed, FAKE_SESSIONS, FIXTURE_REPOS, type FakeHerdr } from "../fixtures/fake-herdr.ts";
// NOTE: never import src/ statically here: src/shared/paths.ts reads the env at import time,
// and sandboxDaemon() must set it first. Load src modules with `await import()` after the sandbox exists.

process.env.JOYRIDE_HERDR_POLL_MS = "400";
process.env.JOYRIDE_WORKERS_POLL_MS = "300";

const S = {
  unmanaged: "cccccccc-0000-4000-8000-000000000004",
  inPaneByPid: "cccccccc-0000-4000-8000-000000000005",
  internal: "cccccccc-0000-4000-8000-00000000000f",
  codexLive: "dddddddd-0000-7000-8000-000000000006",
  codexEnded: "dddddddd-0000-7000-8000-000000000007",
  codexStale: "dddddddd-0000-7000-8000-000000000008",
  claudeByHookPane: "eeeeeeee-0000-4000-8000-000000000009",
};

let d: Awaited<ReturnType<typeof sandboxDaemon>>;
let fake: FakeHerdr;
const kids: ChildProcess[] = [];
const sleeper = () => { const c = spawn("sleep", ["300"], { stdio: "ignore" }); kids.push(c); return c.pid!; };
let pidUnmanaged = 0, pidInPane = 0, pidInternal = 0;
const changes: string[] = [];

const workers = async () => (await d.req("GET", "/api/workers")).body as any[];
const byId = async (id: string) => (await workers()).find((w) => w.id === id);
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

beforeAll(async () => {
  d = await sandboxDaemon("live-workers", ["live", "guard"]);
  const reg = path.join(d.sb.env.JOYRIDE_CLAUDE_DIR, "sessions");
  fs.mkdirSync(reg, { recursive: true });
  pidUnmanaged = sleeper(); pidInPane = sleeper(); pidInternal = sleeper();
  const dead = spawnSync("true").pid!;
  const entry = (pid: number, sessionId: string, cwd: string, status: string, name = "") => fs.writeFileSync(path.join(reg, `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd, startedAt: Date.now() - 3600e3, kind: "interactive", entrypoint: "cli", name, status, updatedAt: Date.now() - 60e3, statusUpdatedAt: Date.now() - 60e3 }));
  entry(process.pid, FAKE_SESSIONS.claudeWorking, FIXTURE_REPOS.alpha, "busy", "ingest refactor");
  entry(pidUnmanaged, S.unmanaged, FIXTURE_REPOS.beta, "idle", "harbor notes");
  entry(pidInPane, S.inPaneByPid, FIXTURE_REPOS.alpha, "busy");
  entry(dead, "ffffffff-dead-4000-8000-000000000000", FIXTURE_REPOS.alpha, "busy");
  entry(pidInternal, S.internal, path.join(d.sb.env.JOYRIDE_RUNTIME, "llm"), "busy");
  fs.writeFileSync(path.join(reg, `${pidUnmanaged}.0123456789abcdef.key`), "not json, never read");
  fs.writeFileSync(path.join(reg, "424242.json"), "{ partial");

  fake = await startFakeHerdr(d.sb.env.JOYRIDE_HERDR_SOCKET, { scenario: "default" });
  // A Claude pane Herdr has no session ref for: matched to the registry by its foreground pid.
  fake.addPane({ workspace_id: "w3", label: "pid-match", cwd: FIXTURE_REPOS.alpha, agent: "claude", agent_status: "working", pids: [pidInPane] }, { push: false });
  // A Claude pane matched through the HERDR_PANE_ID its hooks report.
  fake.addPane({ workspace_id: "w3", cwd: FIXTURE_REPOS.alpha, agent: "claude", agent_status: "idle" }, { push: false });

  const hook = (agent: "claude" | "codex", type: string, session: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    d.ctx.emit({ source: `hook.${agent}`, type, session, agent, cwd: FIXTURE_REPOS.alpha, data, ...extra } as any);
  hook("claude", "tool.pre", FAKE_SESSIONS.claudeWorking, { tool: "Bash", input: JSON.stringify({ command: "npm test -- --run" }) });
  hook("claude", "turn.stop", FAKE_SESSIONS.claudeBlocked, { last: "I need approval to push the branch." });
  hook("claude", "permission.request", S.unmanaged, { tool: "Bash", input: JSON.stringify({ command: "git push origin main" }) }, { cwd: FIXTURE_REPOS.beta });
  hook("claude", "prompt.submit", S.claudeByHookPane, { prompt: "fix the flaky test", herdr_socket: d.sb.env.JOYRIDE_HERDR_SOCKET }, { pane: "w3:p2" });
  hook("codex", "tool.pre", FAKE_SESSIONS.codexIdle, { tool: "shell", input: JSON.stringify({ command: ["bash", "-lc", "rg TODO"] }) }, { cwd: FIXTURE_REPOS.beta });
  hook("codex", "prompt.submit", S.codexLive, { prompt: "Write the release notes for v2" }, { cwd: FIXTURE_REPOS.beta });
  hook("codex", "turn.stop", S.codexLive, { last: "Release notes drafted in NOTES.md" }, { cwd: FIXTURE_REPOS.beta });
  hook("codex", "prompt.submit", S.codexEnded, { prompt: "done soon" }, { cwd: FIXTURE_REPOS.beta });
  hook("codex", "session.end", S.codexEnded, {}, { cwd: FIXTURE_REPOS.beta });
  hook("codex", "prompt.submit", S.codexStale, { prompt: "old work" }, { cwd: FIXTURE_REPOS.beta, ts: ago(20 * 60e3) });

  d.ctx.bus.onChange((c) => changes.push(c.entity));
  await assertSandboxed(d.sb.env);
  await d.start();
  await waitFor(async () => (await d.req("GET", "/api/herdr/status")).body.connected);
  await waitFor(async () => (await workers()).length >= 7, 5000);
});
afterAll(async () => {
  await d?.stop();
  await fake?.stop();
  for (const k of kids) k.kill();
});

describe("workers projection", () => {
  it("lists Herdr agent panes as controllable workers, not plain shells", async () => {
    const list = await workers();
    expect(list.find((w) => w.id === "local:w2:p2")).toBeUndefined(); // shell pane
    const blocked = list.find((w) => w.id === "local:w1:p2");
    expect(blocked).toMatchObject({ machine: "local", agent: "claude", status: "blocked", pane: "w1:p2", controllable: true, session: `claude:${FAKE_SESSIONS.claudeBlocked}`,
      cwd: FIXTURE_REPOS.alpha, repo: FIXTURE_REPOS.alpha, title: "Flaky export test", last_message: "I need approval to push the branch.", mission: null, crew: null });
    expect(list[0].status).toBe("blocked"); // most urgent first
  });

  it("merges a live Claude process into its Herdr pane by session id", async () => {
    const w = await byId("local:w1:p1");
    expect(w).toMatchObject({ pid: process.pid, session: `claude:${FAKE_SESSIONS.claudeWorking}`, current_action: "Bash: npm test -- --run", controllable: true });
    expect((await workers()).find((x) => x.id === `local:pid:${process.pid}`)).toBeUndefined();
  });

  it("merges by the pane's foreground pid when Herdr has no session ref", async () => {
    const w = await byId("local:w3:p1");
    expect(w).toMatchObject({ pid: pidInPane, session: `claude:${S.inPaneByPid}`, controllable: true });
    expect(await byId(`local:pid:${pidInPane}`)).toBeUndefined();
  });

  it("adopts the session reported by hooks running in a pane", async () => {
    // Herdr saw this pane idle after the hook fired, so Herdr's status wins.
    expect(await byId("local:w3:p2")).toMatchObject({ session: `claude:${S.claudeByHookPane}`, status: "idle" });
  });

  it("lists Claude processes outside Herdr as non-controllable, with hook status hints", async () => {
    const w = await byId(`local:pid:${pidUnmanaged}`);
    expect(w).toMatchObject({ agent: "claude", pane: null, pid: pidUnmanaged, controllable: false, session: `claude:${S.unmanaged}`, title: "harbor notes",
      status: "blocked", current_action: "Waiting for permission: Bash: git push origin main", repo: FIXTURE_REPOS.beta });
  });

  it("skips dead pids, internal sessions, .key files and unreadable entries", async () => {
    const list = await workers();
    expect(list.some((w) => w.session === "claude:ffffffff-dead-4000-8000-000000000000")).toBe(false);
    expect(list.some((w) => w.pid === pidInternal || w.session === `claude:${S.internal}`)).toBe(false);
  });

  it("includes Codex sessions with recent hook activity and no session.end", async () => {
    const list = await workers();
    const live = list.find((w) => w.id === `local:codex:${S.codexLive}`);
    expect(live).toMatchObject({ agent: "codex", controllable: false, status: "idle", title: "Write the release notes for v2", last_message: "Release notes drafted in NOTES.md", cwd: FIXTURE_REPOS.beta });
    expect(list.some((w) => w.session === `codex:${S.codexEnded}`)).toBe(false);
    expect(list.some((w) => w.session === `codex:${S.codexStale}`)).toBe(false);
  });

  it("enriches a Codex Herdr pane from hooks and prefers whichever status is newer", async () => {
    expect(await byId("local:w2:p1")).toMatchObject({ session: `codex:${FAKE_SESSIONS.codexIdle}`, current_action: "shell: rg TODO", status: "idle" });
    d.ctx.emit({ source: "hook.codex", type: "tool.pre", session: FAKE_SESSIONS.codexIdle, agent: "codex", cwd: FIXTURE_REPOS.beta, data: { tool: "shell", input: '{"command":"cargo test"}' } });
    await waitFor(async () => (await byId("local:w2:p1"))?.status === "working");
    expect((await byId("local:w2:p1")).current_action).toBe("shell: cargo test");
  });

  it("follows live hook events and Herdr status changes", async () => {
    d.ctx.emit({ source: "hook.claude", type: "tool.pre", session: S.unmanaged, agent: "claude", cwd: FIXTURE_REPOS.beta, data: { tool: "Edit", input: JSON.stringify({ file_path: "/x/README.md" }) } });
    await waitFor(async () => (await byId(`local:pid:${pidUnmanaged}`))?.current_action === "Edit: /x/README.md");
    expect((await byId(`local:pid:${pidUnmanaged}`)).status).toBe("working");
    fake.setStatus("w1:p2", "idle");
    await waitFor(async () => (await byId("local:w1:p2"))?.status === "idle");
    expect(changes).toContain("workers");
  });

  it("drops a worker when its process exits", async () => {
    kids[0].kill();
    await waitFor(async () => !(await byId(`local:pid:${pidUnmanaged}`)), 3000);
  });

  it("serves single workers and lookups", async () => {
    expect((await d.req("GET", "/api/workers/local:w1:p2")).body.id).toBe("local:w1:p2");
    expect((await d.req("GET", "/api/workers/local:nope")).status).toBe(404);
    const svc = d.ctx.service("workers");
    expect(svc.forSession(`claude:${FAKE_SESSIONS.claudeBlocked}`)?.id).toBe("local:w1:p2");
    expect(svc.forSession(FAKE_SESSIONS.claudeBlocked)?.id).toBe("local:w1:p2");
    expect(svc.byMission("nothing")).toEqual([]);
  });

  it("uses the missions service when one is registered", async () => {
    d.ctx.services.set("missions", { missionOfSession: (k: string) => (k === `claude:${FAKE_SESSIONS.claudeBlocked}` ? "uploader-retry" : null) });
    d.ctx.bus.change({ entity: "missions" }); // what the missions module announces when links change
    try {
      await waitFor(async () => (await byId("local:w1:p2")).mission === "uploader-retry");
      expect(d.ctx.service("workers").byMission("uploader-retry").map((w: any) => w.id)).toEqual(["local:w1:p2"]);
    } finally { d.ctx.services.delete("missions"); d.ctx.bus.change({ entity: "missions" }); }
  });

  it("keeps a native live connection usable despite a stale session-end hook", async () => {
    d.ctx.emit({ source: "hook.codex", type: "session.end", session: FAKE_SESSIONS.codexIdle, agent: "codex", data: {} });
    await waitFor(async () => {
      const w = await byId("local:w2:p1");
      return w?.session === `codex:${FAKE_SESSIONS.codexIdle}` && w.controllable;
    });
    expect((await byId("local:w2:p1")).status).not.toBe("exited");
  });

  it("marks Herdr workers non-controllable while Herdr is down", async () => {
    await fake.stop();
    await waitFor(async () => (await byId("local:w1:p2"))?.controllable === false, 3000);
    await fake.restart();
    await waitFor(async () => (await byId("local:w1:p2"))?.controllable === true, 5000);
  });
});

describe("helpers", () => {
  it("summarizes tool input", async () => {
    const { summarizeAction } = await import("../../src/modules/live/workers.ts");
    expect(summarizeAction("Bash", '{"command":"git status"}')).toBe("Bash: git status");
    expect(summarizeAction("Read", { file_path: "/a/b.ts" })).toBe("Read: /a/b.ts");
    expect(summarizeAction("shell", { command: ["bash", "-lc", "ls"] })).toBe("shell: ls");
    expect(summarizeAction("mcp__x__y", '{"query":"abc"}')).toBe("mcp__x__y: abc");
    expect(summarizeAction("Bash", '{"command":"echo hi", "description": "tr…')).toMatch(/^Bash: /);
  });
  it("maps registry statuses", async () => {
    const { registryStatus } = await import("../../src/modules/live/workers.ts");
    expect(registryStatus("busy")).toBe("working");
    expect(registryStatus("idle")).toBe("idle");
    expect(registryStatus("waiting")).toBe("blocked");
    expect(registryStatus("???")).toBe("unknown");
  });
});
