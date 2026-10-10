import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test, expect, vi } from "vitest";
import { sandboxDaemon } from "../sandbox.ts";
import { waitFor } from "../fixtures/fake-herdr.ts";
import { Diagnostics } from "../../src/core/diagnostics.ts";
import { HerdrClient, herdrRequest } from "../../src/modules/live/herdr-client.ts";
import { EventTailer } from "../../src/core/eventlog.ts";
import { checkPortOwner, assertDaemonProcess } from "../../src/cli/daemons.ts";
import { paths } from "../../src/shared/paths.ts";
import { installService, uninstallService, serviceUp, serviceDown, serviceRestart, servicePlist } from "../../src/cli/service.ts";

test("health and the root page read snapshots without filesystem or Herdr calls", async () => {
  const d = await sandboxDaemon("health", []);
  await d.start();
  const stat = vi.spyOn(fs, "statSync");
  const read = vi.spyOn(fs, "readFileSync");
  try {
    const h = await d.req("GET", "/api/health");
    expect(h.body).toMatchObject({ ok: true, root: paths.root, code: paths.code, refreshers: { ui: { error: null } } });
    expect(h.body.event_loop.p99_ms).toBeGreaterThanOrEqual(0);
    const root = await d.app.request("/");
    expect(root.status).toBe(200);
    expect(await root.text()).toContain('name="joyride-build"');
    expect(stat).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  } finally { stat.mockRestore(); read.mockRestore(); await d.stop(); }
});

test("event backlog yields to timers and keeps exact offsets including a partial line", async () => {
  fs.mkdirSync(paths.events, { recursive: true });
  const file = path.join(paths.events, "2099-01-01.jsonl");
  const line = (id: number) => JSON.stringify({ id: `ev-${id}`, ts: "2099-01-01T00:00:00Z", source: "hook.codex", type: "tool.pre", data: { unicode: "桜" } });
  fs.writeFileSync(file, Array.from({ length: 10000 }, (_, i) => line(i)).join("\n") + "\n" + line(10000).slice(0, 50));
  const offsets = new Map<string, number>();
  const seen = new Set<string>();
  const tailer = new EventTailer({ get: (f) => offsets.get(f) ?? 0, set: (f, n) => offsets.set(f, n) }, (e) => { expect(seen.has(e.id)).toBe(false); seen.add(e.id); });
  let timerSaw = Infinity;
  const timer = setTimeout(() => { timerSaw = seen.size; }, 0);
  try {
    tailer.start();
    await waitFor(() => seen.size === 10000);
    expect(timerSaw).toBeLessThan(10000);
    fs.appendFileSync(file, line(10000).slice(50) + "\n");
    await waitFor(() => seen.has("ev-10000"));
    expect(offsets.get(file)).toBe(fs.statSync(file).size);
  } finally { clearTimeout(timer); tailer.stop(); fs.unlinkSync(file); }
});

test("a socket EPIPE rejects promptly and destroys the request connection", async () => {
  const socket = new net.Socket();
  const create = vi.spyOn(net, "createConnection").mockReturnValue(socket);
  const destroyed = vi.spyOn(socket, "destroy");
  try {
    const request = herdrRequest("fake.sock", "pane.list", {}, 100);
    socket.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    await expect(request).rejects.toThrow("write EPIPE");
    expect(destroyed).toHaveBeenCalled();
  } finally { create.mockRestore(); destroyed.mockRestore(); socket.destroy(); }
});

test("hung reconciles keep their snapshot, coalesce requests, back off and recover on fresh sockets", async () => {
  const socket = path.join(process.env.JOYRIDE_SANDBOX_DIR!, "failure.sock");
  let hang = false;
  let calls = 0;
  let connections = 0;
  const conns = new Set<net.Socket>();
  const server = net.createServer((conn) => {
    connections++;
    conns.add(conn); conn.on("close", () => conns.delete(conn)); conn.on("error", () => {});
    conn.setEncoding("utf8");
    conn.once("data", (data) => {
      const req = JSON.parse(String(data));
      if (req.method === "events.subscribe") { conn.write(JSON.stringify({ id: req.id, result: {} }) + "\n"); return; }
      if (req.method === "pane.list" || req.method === "agent.list") { calls++; if (hang) return; }
      const result = req.method === "pane.list" ? { panes: [{ pane_id: "one", terminal_id: "one", label: "Last good" }] } : {};
      conn.end(JSON.stringify({ id: req.id, result }) + "\n");
    });
  });
  await new Promise<void>((r) => server.listen(socket, r));
  const client = new HerdrClient({ machine: "lab", socket, pollMs: 10000, requestTimeoutMs: 80, retryBaseMs: 120, retryMaxMs: 400, random: () => 0.5 });
  try {
    client.start();
    await waitFor(() => client.hydrated);
    const previous = client.lastRefresh;
    hang = true;
    const initial = calls;
    const promises = Array.from({ length: 30 }, () => client.reconcile());
    await Promise.allSettled(promises);
    expect(calls - initial).toBe(2);
    expect(client.connected()).toBe(false);
    expect(client.error).toMatch(/within 80 ms/);
    expect(client.lastRefresh).toBe(previous);
    expect(client.panes.get("one")?.label).toBe("Last good");
    await new Promise((r) => setTimeout(r, 500));
    expect(calls - initial).toBeLessThanOrEqual(8);
    const before = connections;
    hang = false;
    await waitFor(() => client.connected() && !client.error && client.lastRefresh !== previous);
    expect(connections).toBeGreaterThan(before);
  } finally { client.stop(); for (const conn of conns) conn.destroy(); await new Promise<void>((r) => server.close(() => r())); }
});

test("launchd installation backs up and restores its predecessor; down unloads KeepAlive", () => {
  const root = path.join(process.env.JOYRIDE_SANDBOX_DIR!, "service");
  const calls: string[][] = [];
  const o = { home: root, runtime: path.join(root, "runtime"), code: '/code/joyride & co', root: '/data/joyride', node: '/node/bin/node', uid: 501, launchctl: (args: string[]) => { calls.push(args); return ""; } };
  const plist = path.join(root, "Library/LaunchAgents/com.joyride.daemon.plist");
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, "original plist");
  const generated = servicePlist(o);
  expect(generated).toContain("<key>KeepAlive</key><true/>");
  expect(generated).toContain("<key>RunAtLoad</key><true/>");
  expect(generated).toContain("<key>ProcessType</key><string>Interactive</string>");
  expect(generated).toContain("joyride &amp; co");
  installService(o); installService(o);
  expect(fs.readdirSync(path.join(o.runtime, "backups"))).toHaveLength(1);
  serviceDown(o); serviceUp(o); serviceRestart(o);
  expect(calls).toContainEqual(["bootout", "gui/501/com.joyride.daemon"]);
  expect(calls).toContainEqual(["kickstart", "-k", "gui/501/com.joyride.daemon"]);
  uninstallService(o);
  expect(fs.readFileSync(plist, "utf8")).toBe("original plist");
  expect(() => serviceDown(o)).toThrow("another checkout");
});

test("a failed launchd bootstrap restores the predecessor and leaves no install manifest", () => {
  const root = path.join(process.env.JOYRIDE_SANDBOX_DIR!, "service-failed");
  const o = { home: root, runtime: path.join(root, "runtime"), code: '/code/joyride', root: '/data/joyride', node: '/node/bin/node', uid: 501, launchctl: (args: string[]) => { if (args[0] === "bootstrap") throw new Error("bootstrap failed"); return ""; } };
  const plist = path.join(root, "Library/LaunchAgents/com.joyride.daemon.plist");
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, "original plist");
  expect(() => installService(o)).toThrow("Restored the previous plist");
  expect(fs.readFileSync(plist, "utf8")).toBe("original plist");
  expect(fs.existsSync(path.join(o.runtime, "install/service.json"))).toBe(false);
});

test.each([true, false])("a blocked main thread logs active work (supervised: %s)", async (supervised) => {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { Diagnostics } from './src/core/diagnostics.ts';
    const d = new Diagnostics(() => {}); d.start();
    setTimeout(async () => {
      d.beginRequest('GET', '/blocked');
      await d.refresh('hung refresh', () => { const until = Date.now() + 1500; while (Date.now() < until) {} });
      await d.stop(); process.exit(0);
    }, 1000);
  `], { env: { ...process.env, JOYRIDE_WATCHDOG_MS: "500", JOYRIDE_SUPERVISED: supervised ? "1" : "0" }, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (data) => { stderr += data; });
  try {
    const [code, signal] = await once(child, "exit");
    if (supervised) expect(signal).toBe("SIGKILL");
    else { expect(signal).toBeNull(); expect(code).toBe(0); }
    expect(stderr).toContain("watchdog");
    expect(stderr).toContain("/blocked");
    expect(stderr).toContain("hung refresh");
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
});

test("refresh diagnostics report failure and keep the last successful age", async () => {
  const d = new Diagnostics(() => {});
  await d.refresh("test", () => true);
  await expect(d.refresh("test", () => { throw new Error("unavailable"); })).rejects.toThrow("unavailable");
  expect(d.snapshot().refreshers.test).toMatchObject({ active_ms: null, error: "Error: unavailable" });
  expect(d.snapshot().refreshers.test?.age_ms).toBeGreaterThanOrEqual(0);
});

test("startup identifies another checkout and refuses a reused pid without signalling it", async () => {
  const server = http.createServer((_req, res) => res.end(JSON.stringify({ ok: true, pid: 123, code: "/other/checkout", root: "/other/data" })));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test port");
    await expect(checkPortOwner(address.port)).rejects.toThrow("pid 123 from /other/checkout");
    await expect(assertDaemonProcess(process.pid, "/another/code")).rejects.toThrow("Refusing to stop it");
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("a responsive loop with a hung health handler also triggers the supervised watchdog", async () => {
  const connections = new Set<net.Socket>();
  const server = http.createServer(() => {});
  server.on("connection", (socket) => { connections.add(socket); socket.on("close", () => connections.delete(socket)); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { Diagnostics } from './src/core/diagnostics.ts';
    const d = new Diagnostics(() => {}); d.start(${address.port}); setInterval(() => {}, 1000);
  `], { env: { ...process.env, JOYRIDE_WATCHDOG_MS: "500", JOYRIDE_SUPERVISED: "1" }, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (data) => { stderr += data; });
  try {
    const [, signal] = await once(child, "exit");
    expect(signal).toBe("SIGKILL");
    expect(stderr).toContain("health stopped answering");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    for (const socket of connections) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
