// Herdr client + service against the fake Herdr: absent → connect, status
// transitions → events, focus/create/close, drift reconcile, events_lost,
// reconnect after a Herdr restart, restart baseline, and a second machine
// reached through a named-session socket.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { sandboxDaemon } from "../sandbox.ts";
import { startFakeHerdr, waitFor, assertSandboxed, FAKE_SESSIONS, type FakeHerdr } from "../fixtures/fake-herdr.ts";

process.env.JOYRIDE_HERDR_POLL_MS = "400";
process.env.JOYRIDE_HERDR_RETRY_MAX_MS = "300";

let d: Awaited<ReturnType<typeof sandboxDaemon>>;
let fake: FakeHerdr | undefined;
let remote: FakeHerdr | undefined;

const herdrEvents = (type?: string) => {
  d.tailer.drain();
  return (d.ctx.db.prepare("SELECT json FROM events WHERE source = 'herdr' ORDER BY rowid").all() as { json: string }[])
    .map((r) => JSON.parse(r.json)).filter((e) => !type || e.type === type);
};
const status = async () => (await d.req("GET", "/api/herdr/status")).body;

beforeAll(async () => {
  d = await sandboxDaemon("herdr", ["live", "guard"]);
  d.ctx.config.machines = [{ label: "local" }, { label: "remote1", herdr_session: "remote1" }];
  await assertSandboxed(d.sb.env);
  await d.start();
});
afterAll(async () => {
  await d?.stop();
  await fake?.stop();
  await remote?.stop();
});

describe("herdr connection", () => {
  it("keeps running and reports disconnected while Herdr is absent", async () => {
    const s = await status();
    expect(s.connected).toBe(false);
    expect(s.any_connected).toBe(false);
    expect(s.machines.map((m: any) => m.label)).toEqual(["local", "remote1"]);
    expect(s.machines[0].error).toMatch(/not running.*Start it with `herdr`/);
    expect(s.machines[1].socket).toBe(path.join(path.dirname(d.sb.env.JOYRIDE_HERDR_SOCKET), "sessions", "remote1", "herdr.sock"));
    expect(s.machines[1].error).toMatch(/herdr --session remote1 server/);
    expect((await d.req("GET", "/api/workers")).body).toEqual([]);
    expect(d.ctx.service("herdr").connected()).toBe(false);
  });

  it("connects when Herdr comes up and records the starting state", async () => {
    fake = await startFakeHerdr(d.sb.env.JOYRIDE_HERDR_SOCKET, { scenario: "default" });
    await waitFor(async () => (await status()).connected, 5000);
    await waitFor(() => herdrEvents("agent.status").length >= 3);
    const blocked = herdrEvents("agent.status").find((e) => e.pane === "w1:p2");
    expect(blocked).toMatchObject({ source: "herdr", agent: "claude", session: FAKE_SESSIONS.claudeBlocked });
    expect(blocked.data).toMatchObject({ status: "blocked", prev: null, agent: "claude", session_ref: `claude:${FAKE_SESSIONS.claudeBlocked}`, machine: "local", worker: "local:w1:p2" });
    expect(herdrEvents("pane.created").map((e) => e.pane).sort()).toEqual(["w1:p1", "w1:p2", "w2:p1", "w2:p2"]);
    const s = await status();
    expect(s.machines[0]).toMatchObject({ connected: true, panes: 4, agents: 3, version: "0.9.1-fake" });
    await waitFor(async () => (await status()).machines[0].status_subscribed);
  });

  it("turns pushed status changes into agent.status transitions", async () => {
    fake!.setStatus("w1:p1", "blocked");
    const ev = await waitFor(() => herdrEvents("agent.status").find((e) => e.pane === "w1:p1" && e.data.status === "blocked"));
    expect(ev.data).toMatchObject({ prev: "working", agent: "claude", session_ref: `claude:${FAKE_SESSIONS.claudeWorking}`, machine: "local" });
    fake!.setStatus("w1:p1", "working");
    await waitFor(() => herdrEvents("agent.status").find((e) => e.pane === "w1:p1" && e.data.status === "working" && e.data.prev === "blocked"));
    expect(herdrEvents("agent.status").filter((e) => e.pane === "w1:p1").length).toBe(3);
  });

  it("emits pane.focused, pane.created and pane.closed", async () => {
    fake!.focusPane("w2:p1");
    const f = await waitFor(() => herdrEvents("pane.focused").find((e) => e.pane === "w2:p1"));
    expect(f.data).toMatchObject({ machine: "local", workspace_id: "w2", agent: "codex", session_ref: `codex:${FAKE_SESSIONS.codexIdle}` });

    fake!.addPane({ workspace_id: "w2", cwd: "/tmp/joyride-fixture-repos/beta", agent: "claude", agent_status: "working",
      agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: "added-session" } });
    await waitFor(() => herdrEvents("pane.created").find((e) => e.pane === "w2:p3"));
    await waitFor(() => herdrEvents("agent.status").find((e) => e.pane === "w2:p3" && e.data.status === "working" && e.data.prev === null));
    fake!.closePane("w2:p3");
    await waitFor(() => herdrEvents("pane.closed").find((e) => e.pane === "w2:p3"));
    expect((await status()).machines[0].panes).toBe(4);
  });

  it("closing a workspace closes its panes (Herdr only sends workspace_closed)", async () => {
    fake!.addPane({ cwd: "/tmp", label: "scratch" });
    await waitFor(() => herdrEvents("pane.created").find((e) => e.pane === "w3:p1"));
    await d.ctx.service("herdr").call("workspace.close", { workspace_id: "w3" });
    await waitFor(() => herdrEvents("pane.closed").find((e) => e.pane === "w3:p1"));
  });

  it("reconciles changes that were never pushed", async () => {
    fake!.setStatus("w2:p1", "working", { push: false });
    const ev = await waitFor(() => herdrEvents("agent.status").find((e) => e.pane === "w2:p1" && e.data.status === "working"), 3000);
    expect(ev.data.prev).toBe("idle");
  });

  it("resubscribes after events_lost and keeps receiving pushes", async () => {
    const before = fake!.calls.filter((c) => c.method === "events.subscribe").length;
    fake!.eventsLost();
    await waitFor(() => fake!.calls.filter((c) => c.method === "events.subscribe").length >= before + 2 && fake!.subscriberCount() === 2, 4000);
    fake!.setStatus("w2:p1", "idle");
    await waitFor(() => herdrEvents("agent.status").find((e) => e.pane === "w2:p1" && e.data.status === "idle"));
  });

  it("reconnects after Herdr restarts and catches up on what changed", async () => {
    await fake!.stop();
    await waitFor(async () => !(await status()).connected, 3000);
    await waitFor(async () => /not running/.test((await status()).machines[0].error ?? ""), 3000);
    fake!.setStatus("w2:p1", "working", { push: false });
    fake!.closePane("w2:p2", { push: false });
    await fake!.restart();
    await waitFor(async () => (await status()).connected, 5000);
    await waitFor(() => herdrEvents("agent.status").filter((e) => e.pane === "w2:p1" && e.data.status === "working").length >= 2, 3000);
    await waitFor(() => herdrEvents("pane.closed").find((e) => e.pane === "w2:p2"), 3000);
  });

  it("does not repeat events across a daemon restart, but records changes made while it was down", async () => {
    await waitFor(async () => (await status()).machines[0].status_subscribed);
    await new Promise((r) => setTimeout(r, 400)); // let the baseline persist
    const count = herdrEvents().length;
    d.ctx.bus.change({ entity: "missions" }); // Stop while the worker projection has a pending refresh.
    await d.stop();
    fake!.setStatus("w1:p2", "idle", { push: false });
    await d.start();
    await waitFor(async () => (await status()).connected, 5000);
    await waitFor(async () => (await d.req("GET", "/api/workers")).body.some((w: any) => w.id === "local:w1:p2" && w.status === "idle"));
    const ev = await waitFor(() => herdrEvents("agent.status").find((e) => e.pane === "w1:p2" && e.data.status === "idle"), 3000);
    expect(ev.data.prev).toBe("blocked");
    await new Promise((r) => setTimeout(r, 300));
    expect(herdrEvents().length).toBe(count + 1);
  });

  it("connects a second machine through a named-session socket and labels its workers", async () => {
    const sock = (await status()).machines[1].socket;
    remote = await startFakeHerdr(sock, { scenario: "default", version: "remote-fake" });
    // Connected comes first; its pane list (the agent count) lands a moment later.
    await waitFor(async () => { const m = (await status()).machines[1]; return m.connected && m.agents === 3; }, 5000);
    const s = await status();
    expect(s.machines[1]).toMatchObject({ label: "remote1", session: "remote1", connected: true, agents: 3, version: "remote-fake" });
    const workers = await waitFor(async () => {
      const rows = (await d.req("GET", "/api/workers")).body;
      return rows.some((w: any) => w.id === "remote1:w1:p2") && rows;
    });
    const rw = workers.find((w: any) => w.id === "remote1:w1:p2");
    expect(rw).toMatchObject({ machine: "remote1", pane: "w1:p2", agent: "claude", controllable: true, session: `claude:${FAKE_SESSIONS.claudeBlocked}` });
    expect(workers.find((w: any) => w.id === "local:w1:p2")?.machine).toBe("local");
    await waitFor(() => herdrEvents("agent.status").find((e) => e.data.machine === "remote1" && e.pane === "w1:p2"));
    const pong = await d.ctx.service("herdr").call("ping", {}, { machine: "remote1" });
    expect(pong.version).toBe("remote-fake");
    await d.ctx.service("herdr").prompt("remote1:w2:p1", "from joyride");
    expect(remote.prompts).toEqual([expect.objectContaining({ target: "w2:p1", text: "from joyride" })]);
    expect(fake!.prompts).toEqual([]);
  });
});
