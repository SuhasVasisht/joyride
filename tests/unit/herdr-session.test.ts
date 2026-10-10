// A second, real Herdr server standing in for a remote machine: a named session
// (`herdr --session <name> server`) that this test starts and stops itself.
// Opt-in: JOYRIDE_LIVE_HERDR=1 npx vitest run tests/unit/herdr-session.test.ts
// It never touches the default session; the stand-in agent is simulated with
// pane.report_agent, so no real Claude/Codex process is launched.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { sandboxDaemon } from "../sandbox.ts";
import { startFakeHerdr, waitFor, assertSandboxed, type FakeHerdr } from "../fixtures/fake-herdr.ts";

const enabled = process.env.JOYRIDE_LIVE_HERDR === "1";
const HERDR = process.env.JOYRIDE_HERDR_BIN ?? "/opt/homebrew/bin/herdr";
const NAME = `joyride-unit-${process.pid}`;
const SESSIONS = path.join(os.homedir(), ".config", "herdr", "sessions");
const SOCK = path.join(SESSIONS, NAME, "herdr.sock");

let d: Awaited<ReturnType<typeof sandboxDaemon>>;
let local: FakeHerdr;
let paneId = "";
let wsId = "";

const herdrEvents = (type: string) => {
  d.tailer.drain();
  return (d.ctx.db.prepare("SELECT json FROM events WHERE source = 'herdr' AND type = ? ORDER BY rowid").all(type) as { json: string }[]).map((r) => JSON.parse(r.json));
};
const standin = () => d.ctx.service("herdr");
const call = (m: string, p: Record<string, unknown>) => standin().call(m, p, { machine: "standin" });

describe.skipIf(!enabled)("named Herdr session as a remote machine stand-in", () => {
  beforeAll(async () => {
    spawn(HERDR, ["--session", NAME, "server"], { detached: true, stdio: "ignore" }).unref();
    await waitFor(() => fs.existsSync(SOCK), 10000, 100);
    d = await sandboxDaemon("herdr-session", ["live", "guard"]);
    process.env.JOYRIDE_HERDR_SESSIONS_DIR = SESSIONS;
    process.env.JOYRIDE_HERDR_POLL_MS = "500";
    d.ctx.config.machines = [{ label: "local" }, { label: "standin", herdr_session: NAME }];
    local = await startFakeHerdr(d.sb.env.JOYRIDE_HERDR_SOCKET, { scenario: "default" });
    await assertSandboxed(d.sb.env);
    await d.start();
  }, 30000);

  afterAll(async () => {
    try { if (wsId) await call("workspace.close", { workspace_id: wsId }); } catch {}
    await d?.stop();
    await local?.stop();
    try { execFileSync(HERDR, ["--session", NAME, "server", "stop"], { stdio: "ignore", timeout: 10000 }); } catch {}
    try { await waitFor(() => !fs.existsSync(SOCK), 5000, 100); } catch {}
    try { execFileSync(HERDR, ["session", "delete", NAME], { stdio: "ignore", timeout: 10000, input: "y\n" }); } catch {}
    fs.rmSync(path.join(SESSIONS, NAME), { recursive: true, force: true });
  }, 30000);

  it("connects to both the local Herdr and the named session", async () => {
    await waitFor(async () => (await d.req("GET", "/api/herdr/status")).body.machines.every((m: any) => m.connected), 8000);
    const s = (await d.req("GET", "/api/herdr/status")).body;
    expect(s.machines[1]).toMatchObject({ label: "standin", session: NAME, socket: SOCK, connected: true });
    await waitFor(async () => /^\d+\.\d+/.test((await d.req("GET", "/api/herdr/status")).body.machines[1].version ?? ""), 3000);
  });

  it("labels the stand-in's agents with their machine and emits their status changes", async () => {
    const ws = await call("workspace.create", { cwd: d.sb.dir, label: "joyride-standin", focus: false });
    paneId = ws.root_pane.pane_id;
    wsId = ws.workspace.workspace_id;
    await call("pane.report_agent", { pane_id: paneId, source: "custom:joyride-test", agent: "claude", state: "working" });
    const w = await waitFor(async () => { const b = (await d.req("GET", `/api/workers/standin:${paneId}`)).body; return b?.status === "working" ? b : null; }, 8000);
    expect(w).toMatchObject({ machine: "standin", agent: "claude", status: "working", pane: paneId, controllable: true });
    const ev = await waitFor(() => herdrEvents("agent.status").find((e) => e.data.machine === "standin" && e.pane === paneId), 5000);
    expect(ev.data).toMatchObject({ status: "working", prev: null, worker: `standin:${paneId}` });
    expect(herdrEvents("pane.created").some((e) => e.data.machine === "standin" && e.pane === paneId)).toBe(true);

    await call("pane.report_agent", { pane_id: paneId, source: "custom:joyride-test", agent: "claude", state: "blocked" });
    await waitFor(() => herdrEvents("agent.status").find((e) => e.data.machine === "standin" && e.pane === paneId && e.data.status === "blocked" && e.data.prev === "working"), 5000);
  });

  it("routes replies to the stand-in machine, not the local Herdr", async () => {
    const r = (await d.req("POST", "/api/intents", { kind: "reply", target: `standin:${paneId}`, payload: { text: "echo hi" } })).body;
    // The stand-in "agent" is only reported, not a real process, so Herdr refuses input
    // (agent_blocked or agent_not_ready); what matters is that the error came from the stand-in.
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(new RegExp(`pane ${paneId} \\(standin\\) (is waiting on a prompt|can't take input)`));
    expect(local.prompts).toEqual([]);
  });

  it("sees pane focus and closure on the stand-in", async () => {
    const t = await call("tab.create", { workspace_id: wsId, cwd: d.sb.dir, label: "second", focus: true });
    await call("pane.focus", { pane_id: paneId });
    await waitFor(() => herdrEvents("pane.created").find((e) => e.data.machine === "standin" && e.pane === t.root_pane.pane_id), 5000);
    const focus = herdrEvents("pane.focused").filter((e) => e.data.machine === "standin");
    console.log(`[standin] pane.focused events: ${focus.length}`);
    await call("workspace.close", { workspace_id: wsId });
    wsId = "";
    await waitFor(() => herdrEvents("pane.closed").find((e) => e.data.machine === "standin" && e.pane === paneId), 5000);
  });

  it("reports the stand-in as disconnected once its server stops", async () => {
    execFileSync(HERDR, ["--session", NAME, "server", "stop"], { stdio: "ignore", timeout: 10000 });
    await waitFor(async () => (await d.req("GET", "/api/herdr/status")).body.machines[1].connected === false, 8000);
    const m = (await d.req("GET", "/api/herdr/status")).body.machines[1];
    await waitFor(async () => /herdr --session/.test((await d.req("GET", "/api/herdr/status")).body.machines[1].error ?? ""), 5000);
    expect(m.connected).toBe(false);
    expect((await d.req("GET", "/api/herdr/status")).body.machines[0].connected).toBe(true);
  });
});
