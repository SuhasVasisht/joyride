// The daemon keeps a Herdr server running: when it starts it, after how long a
// lost socket, with which environment, and every way it avoids a second server.
// The last block lets a sandbox daemon really spawn a stand-in `herdr server`.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { HerdrManager, cleanServerEnv, herdrDefaultSocket, managementAllowed, type Probe } from "../../src/modules/live/herdr-manager.ts";
import { sandboxDaemon } from "../sandbox.ts";
import { waitFor } from "../fixtures/fake-herdr.ts";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const tmpDirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync("/tmp/jr-mgr-"); tmpDirs.push(d); return d; };
afterAll(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

function rig(opts: { probe?: Probe; enabled?: boolean; stateFile?: string } = {}) {
  let probe: Probe = opts.probe ?? "down";
  let t = 1_000_000;
  const spawned: { bin: string; args: string[]; env: Record<string, string> }[] = [];
  const alive = new Set<number>();
  const dir = tmp();
  const m = new HerdrManager({
    machine: "local", socket: "/tmp/jr-mgr-test/herdr.sock", bin: "/opt/fake/herdr", enabled: opts.enabled ?? true, reason: opts.enabled === false ? "off for this test" : null,
    logFile: path.join(dir, "herdr-server.log"), stateFile: opts.stateFile ?? path.join(dir, "state.json"), downAfterMs: 10_000, graceMs: 20_000,
  }, {
    probe: async () => probe,
    spawn: (bin, args, o) => { const pid = 4000 + spawned.length; spawned.push({ bin, args, env: o.env }); alive.add(pid); return { pid, error: Promise.resolve(null) }; },
    pidAlive: (pid) => alive.has(pid),
    now: () => t,
  });
  return { m, spawned, alive, dir, set: (p: Probe) => { probe = p; }, advance: (ms: number) => { t += ms; } };
}

describe("herdr server manager", () => {
  it("starts `herdr server` when nothing answers at daemon start, with a scrubbed environment", async () => {
    process.env.CLAUDECODE = "1"; process.env.CLAUDE_CODE_SESSION_ID = "abc"; process.env.JOYRIDE_SOMETHING = "x"; process.env.HERDR_PANE_ID = "w9:p9";
    try {
      const r = rig();
      await r.m.tick();
      expect(r.spawned).toHaveLength(1);
      expect(r.spawned[0]).toMatchObject({ bin: "/opt/fake/herdr", args: ["server"] });
      const env = r.spawned[0].env;
      expect(Object.keys(env).filter((k) => /^(CLAUDE|JOYRIDE)/.test(k))).toEqual([]);
      expect(env.HERDR_PANE_ID).toBeUndefined();
      expect(env.HERDR_SOCKET_PATH).toBe("/tmp/jr-mgr-test/herdr.sock"); // not Herdr's default socket, so it is pointed there
      expect(env.PATH).toBe(process.env.PATH);
      expect(r.m.status()).toMatchObject({ enabled: true, state: "starting", pid: 4000, starts: 1 });
      expect(JSON.parse(fs.readFileSync(path.join(r.dir, "state.json"), "utf8"))).toMatchObject({ pid: 4000, socket: "/tmp/jr-mgr-test/herdr.sock" });
    } finally {
      for (const k of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "JOYRIDE_SOMETHING", "HERDR_PANE_ID"]) delete process.env[k];
    }
  });

  it("leaves Herdr's own default socket alone in the environment", () => {
    const env = cleanServerEnv({ PATH: "/bin", HOME: "/Users/x" }, herdrDefaultSocket({ HOME: "/Users/x" }));
    expect(env.HERDR_SOCKET_PATH).toBeUndefined();
  });

  it("never starts a second server: running, slow to answer, or still booting", async () => {
    const up = rig({ probe: "up" });
    await up.m.tick();
    expect(up.spawned).toHaveLength(0);
    expect(up.m.status().state).toBe("up");

    const slow = rig({ probe: "unresponsive" });
    await slow.m.tick();
    expect(slow.spawned).toHaveLength(0);

    const boot = rig();
    await boot.m.tick();
    boot.advance(12_000);
    await boot.m.tick(); // down for 12 s, but the server it started is still within its grace period
    expect(boot.spawned).toHaveLength(1);
    expect(boot.m.status().state).toBe("starting");
    expect((await boot.m.startNow()).already_running).toBe(true);
    expect(boot.spawned).toHaveLength(1);
  });

  it("doesn't even probe the socket while the live client is connected", async () => {
    let probes = 0;
    const m = new HerdrManager({ machine: "local", socket: "/tmp/jr-mgr-test/h.sock", bin: "/opt/fake/herdr", enabled: true, logFile: path.join(tmp(), "log"), stateFile: path.join(tmp(), "s.json") },
      { probe: async () => { probes++; return "down"; }, connected: () => true, spawn: () => { throw new Error("must not spawn"); } });
    await m.tick(); await m.tick();
    expect(probes).toBe(0);
    expect(m.status().state).toBe("up");
  });

  it("respects a server another daemon just started (shared state file)", async () => {
    const a = rig();
    await a.m.tick();
    const b = rig({ stateFile: path.join(a.dir, "state.json") });
    b.alive.add(4000); // a's server process is alive
    await b.m.tick();
    expect(b.spawned).toHaveLength(0);
    expect(b.m.status().state).toBe("starting");
  });

  it("restarts only after the socket has been down for more than 10 s", async () => {
    const r = rig({ probe: "up" });
    await r.m.tick();
    r.set("down");
    await r.m.tick();
    r.advance(5_000); await r.m.tick();
    r.advance(4_000); await r.m.tick();
    expect(r.spawned).toHaveLength(0);
    expect(r.m.status().state).toBe("down");
    r.advance(2_000); await r.m.tick(); // 11 s
    expect(r.spawned).toHaveLength(1);
  });

  it("backs off when a started server never answers, and recovers once it does", async () => {
    const r = rig();
    await r.m.tick(); // start 1
    r.alive.clear(); // it died straight away
    r.advance(15_000); await r.m.tick();
    expect(r.spawned).toHaveLength(1); // 15 s < 20 s backoff
    expect(r.m.status().state).toBe("failed");
    r.advance(6_000); await r.m.tick(); // 21 s: try again
    expect(r.spawned).toHaveLength(2);
    r.alive.clear();
    r.advance(25_000); await r.m.tick(); // second failure: 40 s backoff
    expect(r.spawned).toHaveLength(2);
    r.set("up"); await r.m.tick();
    expect(r.m.status()).toMatchObject({ state: "up", last_error: null });
  });

  it("is off in tests unless the sandbox opts in, and off when the config says so", () => {
    expect(managementAllowed(true, { JOYRIDE_TEST: "1" })).toMatchObject({ enabled: false });
    expect(managementAllowed(true, { VITEST: "true" }).reason).toMatch(/JOYRIDE_MANAGE_HERDR=1/);
    expect(managementAllowed(true, { JOYRIDE_TEST: "1", JOYRIDE_MANAGE_HERDR: "1" })).toEqual({ enabled: true, reason: null });
    expect(managementAllowed(false, {})).toMatchObject({ enabled: false, reason: expect.stringMatching(/herdr.manage: false/) });
    expect(managementAllowed(true, { JOYRIDE_MANAGE_HERDR: "0" })).toMatchObject({ enabled: false });
    expect(managementAllowed(true, {})).toEqual({ enabled: true, reason: null });
  });

  it("does nothing when disabled, and the start button says why", async () => {
    const r = rig({ enabled: false });
    r.m.start();
    await r.m.tick();
    expect(r.spawned).toHaveLength(0);
    expect(await r.m.startNow()).toMatchObject({ ok: false, started: false, message: "off for this test" });
    r.m.stop();
  });

  it("reports a missing binary instead of retrying blindly", async () => {
    const dir = tmp();
    const m = new HerdrManager({ machine: "local", socket: path.join(dir, "h.sock"), bin: path.join(dir, "no-such-herdr"), enabled: true, logFile: path.join(dir, "log"), stateFile: path.join(dir, "s.json") },
      { probe: async () => "down" });
    const r = await m.startNow();
    expect(r).toMatchObject({ ok: false, started: false });
    expect(r.message).toMatch(/not installed at .*no-such-herdr.*JOYRIDE_HERDR_BIN/);
    expect(m.status()).toMatchObject({ state: "failed" });
  });
});

describe("daemon routes", () => {
  let d: Awaited<ReturnType<typeof sandboxDaemon>>;
  beforeAll(async () => { d = await sandboxDaemon("herdr-manager", ["live"]); await d.start(); });
  afterAll(async () => { await d?.stop(); });

  it("reports managed: false in tests and refuses to start a real Herdr", async () => {
    const s = (await d.req("GET", "/api/herdr/status")).body;
    expect(s.managed).toBe(false);
    expect(s.manager).toMatchObject({ enabled: false, socket: d.sb.env.JOYRIDE_HERDR_SOCKET });
    expect(s.manager.reason).toMatch(/Tests never start a real Herdr/);
    const r = await d.req("POST", "/api/herdr/start", {});
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, started: false });
    const evil = await d.app.request("/api/herdr/start", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}" });
    expect(evil.status).toBe(403);
  });
});

describe("a sandbox that opts in starts the server itself", () => {
  let d: Awaited<ReturnType<typeof sandboxDaemon>>;
  let pid: number | null = null;
  beforeAll(async () => {
    process.env.JOYRIDE_MANAGE_HERDR = "1";
    process.env.JOYRIDE_HERDR_BIN = path.join(ROOT, "tests/fixtures/fake-herdr-bin.sh");
    process.env.JOYRIDE_HERDR_RETRY_MAX_MS = "300";
    process.env.CLAUDECODE = "1";
    d = await sandboxDaemon("herdr-manager-real", ["live"]);
    await d.start();
  });
  afterAll(async () => {
    await d?.stop();
    if (pid) { try { process.kill(-pid, "SIGTERM"); } catch {} try { process.kill(pid, "SIGTERM"); } catch {} }
    delete process.env.JOYRIDE_MANAGE_HERDR; delete process.env.JOYRIDE_HERDR_BIN; delete process.env.CLAUDECODE;
  });

  it("spawns `herdr server` detached on the sandbox socket and connects to it", async () => {
    const sock = d.sb.env.JOYRIDE_HERDR_SOCKET;
    const s = await waitFor(async () => {
      const b = (await d.req("GET", "/api/herdr/status")).body;
      return b.connected && b.machines[0]?.version === "managed-fake" ? b : null;
    }, 15000, 200);
    pid = s.manager.pid;
    expect(s).toMatchObject({ managed: true, manager: { enabled: true, starts: 1, bin: process.env.JOYRIDE_HERDR_BIN } });
    expect(s.machines[0]).toMatchObject({ connected: true, version: "managed-fake" });
    const env = fs.readFileSync(`${sock}.env`, "utf8");
    expect(env).toContain(`HERDR_SOCKET_PATH=${sock}`);
    expect(env).not.toMatch(/^(CLAUDE|JOYRIDE)/m);
    expect(fs.readFileSync(path.join(d.sb.env.JOYRIDE_RUNTIME, "herdr-server.log"), "utf8")).toMatch(/starting `.*fake-herdr-bin.sh server`[\s\S]*fake herdr server running/);
    // Already running: the button doesn't start another.
    const again = await d.req("POST", "/api/herdr/start", {});
    expect(again.body).toMatchObject({ ok: true, started: false, already_running: true });
  });
});
