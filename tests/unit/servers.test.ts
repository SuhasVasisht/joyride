import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sandboxDaemon } from "../sandbox.ts";
import { startFakeHerdr, waitFor, assertSandboxed, type FakeHerdr } from "../fixtures/fake-herdr.ts";
import { ServerDefinition, ServerRun } from "../../src/shared/servers.ts";
import { ServersService, assertFreePort } from "../../src/modules/servers/service.ts";
import { paths } from "../../src/shared/paths.ts";
import { atomicJson, journalFile, saveDefinition } from "../../src/modules/servers/store.ts";
import { nextLayout, readLayout, renderLayout } from "../../src/modules/missions/layout.ts";
import { runServers } from "../../src/cli/servers.ts";

const definition = (id: string) => ServerDefinition.parse({ id, name: "Review change", project: "Joyride", change: "A visible change", members: [{ id: "frontend", name: "Frontend", command: "node app.mjs", cwd: paths.root, ports: [4326] }] });
describe("server contracts", () => {
  it("rejects duplicate members, shared ports, port 3000 and nonlocal review links", () => {
    const g = definition("contract");
    expect(ServerDefinition.safeParse({ ...g, members: [...g.members, ...g.members] }).success).toBe(false);
    expect(ServerDefinition.safeParse({ ...g, members: [g.members[0], { ...g.members[0], id: "backend" }] }).success).toBe(false);
    expect(ServerDefinition.safeParse({ ...g, url: "https://example.com" }).success).toBe(false);
    expect(ServerDefinition.safeParse({ ...g, members: [{ ...g.members[0], ports: [3000] }] }).success).toBe(false);
  });
  it("persists canvas positions using the existing layout", () => {
    const layout = nextLayout(new Map([["lens:existing", { x: 50, y: 60 }]]), { group: "server:demo", x: 120, y: 240 });
    const file = path.join(paths.runtime, "layout.yaml");
    fs.writeFileSync(file, renderLayout(layout.groups));
    expect(readLayout(file).get("server:demo")).toEqual({ x: 120, y: 240 });
    expect(readLayout(file).get("lens:existing")).toEqual({ x: 50, y: 60 });
  });
  it("reports an occupied port without signalling its owner", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No TCP address");
      await expect(assertFreePort(address.port)).rejects.toThrow("occupied");
      expect(server.listening).toBe(true);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
  it("makes the supported interface discoverable without a daemon", async () => {
    expect(await runServers(["--help"])).toContain("docs/review-servers.md");
    await expect(runServers(["stop"])).rejects.toThrow("--purpose review|test");
  });
});

describe("server registry and ownership", () => {
  let d: Awaited<ReturnType<typeof sandboxDaemon>>, fake: FakeHerdr;
  beforeAll(async () => {
    d = await sandboxDaemon("servers", ["live", "servers", "missions"]);
    await assertSandboxed(d.sb.env);
    fake = await startFakeHerdr(d.sb.env.JOYRIDE_HERDR_SOCKET);
    await d.start();
    await waitFor(() => d.ctx.service("herdr").connected());
  });
  afterAll(async () => { await d.stop(); await fake.stop(); });
  it("commits definitions, keeps review/test purpose immutable and rejects mismatched cleanup", async () => {
    expect((await d.req("POST", "/api/servers", definition("review-demo"))).status).toBe(200);
    expect(fs.existsSync(path.join(paths.root, "servers/review-demo.yaml"))).toBe(true);
    const refused = await d.req("POST", "/api/servers/review-demo/action", { action: "stop", purpose: "test" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("review group");
    expect((await d.req("PUT", "/api/servers/review-demo", { ...definition("review-demo"), purpose: "test" })).status).toBe(409);
    expect(fake.calls.filter((x) => x.method === "pane.close")).toHaveLength(0);
  });
  it("reconciles a gone terminal as failed and an unavailable runtime as unknown", async () => {
    const g = definition("stale-demo"); saveDefinition(g);
    const run = ServerRun.parse({ nonce: "b868c001-507a-498e-aa75-8b5f8484c1d5", machine: "local", socket: d.sb.env.JOYRIDE_HERDR_SOCKET, phase: "launched", pane: "gone", terminal: "old-terminal", workspace: "gone-workspace", member: g.members[0], change: g.change, branch: "", error: null });
    atomicJson(journalFile(), { runs: { "stale-demo/frontend": run }, requests: {} });
    const svc = new ServersService(d.ctx);
    expect((await svc.list()).find((g) => g.id === "stale-demo")?.state).toBe("failed");
    run.socket = "/not-the-owning-runtime.sock";
    atomicJson(journalFile(), { runs: { "stale-demo/frontend": run }, requests: {} });
    const unavailable = new ServersService(d.ctx);
    expect((await unavailable.list()).find((g) => g.id === "stale-demo")?.state).toBe("unknown");
    await expect(unavailable.act(g.id, { action: "restart", purpose: "review" })).rejects.toThrow("socket changed");
    expect(fake.calls.filter((x) => x.method === "pane.close")).toHaveLength(0);
  });
  it("refuses to close an existing terminal whose process is not the recorded launch", async () => {
    const g = definition("identity-demo"); saveDefinition(g);
    const pane = d.ctx.service("herdr").snapshot().panes[0];
    const run = ServerRun.parse({ nonce: "bc60db1c-09c9-4f74-a37a-b40cdbde009b", machine: "local", socket: d.sb.env.JOYRIDE_HERDR_SOCKET, phase: "launched", pane: pane.pane_id, terminal: pane.terminal_id, workspace: pane.workspace_id, member: g.members[0], change: g.change, branch: "", error: null });
    atomicJson(journalFile(), { runs: { "identity-demo/frontend": run }, requests: {} });
    const svc = new ServersService(d.ctx);
    expect((await svc.list()).find((g) => g.id === "identity-demo")?.state).toBe("unknown");
    await expect(svc.act(g.id, { action: "stop", purpose: "review" })).rejects.toThrow("identity cannot be verified");
    expect(fake.calls.filter((x) => x.method === "pane.close")).toHaveLength(0);
  });
  it("keeps the daemon usable with a corrupt ownership journal and refuses lifecycle changes", async () => {
    fs.writeFileSync(journalFile(), "invalid json");
    const svc = new ServersService(d.ctx);
    await expect(svc.list()).rejects.toThrow("Restore the ownership journal");
    await expect(svc.act("review-demo", { action: "start", purpose: "review" })).rejects.toThrow("Restore the ownership journal");
    expect((await d.req("GET", "/api/health")).body.ok).toBe(true);
  });
  it("preserves a different process using a terminal after the recorded command exited", async () => {
    const g = definition("reused-terminal"); saveDefinition(g);
    const pane = fake.panes.get("w1:p1");
    if (!pane) throw new Error("Missing fixture pane");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    if (!child.pid) throw new Error("Missing fixture process");
    const pids = [...pane.pids]; pane.pids = [child.pid];
    const run = ServerRun.parse({ nonce: "e920ccf1-afdb-4d14-b9c7-686397a7e74c", machine: "local", socket: d.sb.env.JOYRIDE_HERDR_SOCKET, phase: "launched", pane: pane.pane_id, terminal: pane.terminal_id, workspace: pane.workspace_id, member: g.members[0], change: g.change, branch: "", error: null });
    atomicJson(journalFile(), { runs: { "reused-terminal/frontend": run }, requests: {} });
    atomicJson(path.join(paths.runtime, "servers", run.nonce, "status.json"), { nonce: run.nonce, pid: child.pid, state: "exited", exit: 1, at: new Date().toISOString() });
    try {
      const svc = new ServersService(d.ctx);
      expect((await svc.list()).find((g) => g.id === "reused-terminal")?.state).toBe("unknown");
      await expect(svc.act(g.id, { action: "stop", purpose: "review" })).rejects.toThrow("another process");
      expect(fake.calls.filter((x) => x.method === "pane.close")).toHaveLength(0);
      expect(child.exitCode).toBe(null);
    } finally {
      pane.pids = pids;
      await new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill("SIGTERM"); });
    }
  });
});
