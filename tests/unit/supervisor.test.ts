import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test, expect, vi } from "vitest";
import { paths } from "../../src/shared/paths.ts";
import { pidAlive } from "../../src/core/util.ts";
import { acquireSupervisorLock, CrashBackoff, Supervisor, supervisorState } from "../../src/cli/supervisor.ts";
import { installService, assertServiceLocation } from "../../src/cli/service.ts";

async function until(fn: () => boolean, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!fn()) {
    if (Date.now() > end) throw new Error("Timed out waiting for supervisor");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("crashes back off exponentially, cap within a minute, and reset after a stable run", () => {
  const b = new CrashBackoff({ baseMs: 100, maxMs: 300, windowMs: 1000, cap: 4 });
  expect(b.exited(100, 10)).toEqual({ kind: "retry", delayMs: 100, failures: 1 });
  expect(b.exited(200, 10)).toEqual({ kind: "retry", delayMs: 200, failures: 2 });
  expect(b.exited(300, 10)).toEqual({ kind: "retry", delayMs: 300, failures: 3 });
  expect(b.exited(400, 10)).toEqual({ kind: "capped", failures: 4 });
  expect(b.exited(2000, 1000)).toEqual({ kind: "retry", delayMs: 100, failures: 1 });
  b.reset();
  expect(b.exited(2100, 10)).toEqual({ kind: "retry", delayMs: 100, failures: 1 });
});

test("the pid lock excludes simultaneous processes and releases for a new owner", async () => {
  const runtime = path.join(paths.runtime, "lock-test");
  const code = `
    import { acquireSupervisorLock } from './src/cli/supervisor.ts';
    const release = acquireSupervisorLock(${JSON.stringify(runtime)}, {pid: process.pid, code: ${JSON.stringify(paths.code)}, root: ${JSON.stringify(paths.root)}});
    console.log(release ? 'owner' : 'excluded');
    if (release) { process.on('SIGTERM', () => { release(); process.exit(0); }); setInterval(() => {}, 1000); }
  `;
  const children = Array.from({ length: 5 }, () => spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] }));
  try {
    const results = await Promise.all(children.map(async (child) => String((await once(child.stdout!, "data"))[0]).trim()));
    expect(results.filter((r) => r === "owner")).toHaveLength(1);
    expect(results.filter((r) => r === "excluded")).toHaveLength(4);
  } finally {
    await Promise.all(children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exit = once(child, "exit"); child.kill("SIGTERM"); await exit;
    }));
  }
  const release = acquireSupervisorLock(runtime, { pid: process.pid, code: paths.code, root: paths.root });
  expect(release).not.toBeNull(); release?.();
  const crashed = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    expect(String((await once(crashed.stdout!, "data"))[0]).trim()).toBe("owner");
    const exit = once(crashed, "exit");
    crashed.kill("SIGKILL");
    await exit;
    const afterCrash = acquireSupervisorLock(runtime, { pid: process.pid, code: paths.code, root: paths.root });
    expect(afterCrash).not.toBeNull(); afterCrash?.();
  } finally { if (crashed.exitCode === null && crashed.signalCode === null) crashed.kill("SIGKILL"); }
  // A crashed supervisor leaves a stale pid, which the next owner reclaims.
  fs.writeFileSync(path.join(runtime, "supervisor.pid"), JSON.stringify({ pid: 2147483647, code: paths.code, root: paths.root }));
  const reclaimed = acquireSupervisorLock(runtime, { pid: process.pid, code: paths.code, root: paths.root });
  expect(reclaimed).not.toBeNull(); reclaimed?.();
});

function fixture(name: string, script: string, backoff?: CrashBackoff) {
  const runtime = path.join(paths.runtime, name);
  fs.mkdirSync(runtime, { recursive: true });
  const log: string[] = [];
  let stopped = false;
  const release = vi.fn();
  const supervisor = new Supervisor({
    owner: { pid: process.pid, code: paths.code, root: paths.root }, runtime,
    command: process.execPath, args: ["-e", script], env: process.env,
    healthy: async () => true, watchdogMs: 10000, log: (s) => log.push(s),
    release, onStop: () => { stopped = true; }, backoff,
  });
  supervisor.start();
  return { supervisor, runtime, log, release, stopped: () => stopped };
}

test("SIGKILL restarts the daemon with backoff; explicit restart keeps the supervisor and skips backoff", async () => {
  const f = fixture("restart-test", "console.log(process.env.JOYRIDE_SUPERVISED); setInterval(() => {}, 1000);");
  try {
    await until(() => fs.readFileSync(path.join(f.runtime, "daemon.log"), "utf8").includes("1"));
    const first = supervisorState(f.runtime)!.daemon!;
    process.kill(first, "SIGKILL");
    await until(() => supervisorState(f.runtime)?.phase === "backoff");
    const exitedAt = Date.now();
    await until(() => supervisorState(f.runtime)?.phase === "running");
    const second = supervisorState(f.runtime)!.daemon!;
    expect(second).not.toBe(first);
    expect(Date.now() - exitedAt).toBeGreaterThanOrEqual(200);
    expect(pidAlive(first)).toBe(false);
    f.supervisor.restart();
    await until(() => supervisorState(f.runtime)?.daemon !== second);
    expect(supervisorState(f.runtime)?.pid).toBe(process.pid);
    expect(f.log.filter((l) => l.includes("restarting daemon in"))).toHaveLength(1);
  } finally { f.supervisor.stop(); await until(f.stopped); }
  expect(f.release).toHaveBeenCalledOnce();
});

test("the supervisor stops at the crash-loop cap and explains how to recover", async () => {
  const f = fixture("cap-test", "process.exit(3)", new CrashBackoff({ baseMs: 10, maxMs: 20, windowMs: 60000, cap: 3 }));
  try {
    await until(f.stopped);
    expect(supervisorState(f.runtime)).toMatchObject({ phase: "stopped", daemon: null, failures: 3 });
    expect(f.log.filter((l) => l.includes("started daemon"))).toHaveLength(3);
    expect(f.log.join("\n")).toContain("crash-loop cap reached");
    expect(f.log.join("\n")).toContain("then run joyride up");
    expect(f.release).toHaveBeenCalledOnce();
  } finally { f.supervisor.stop(); }
});

test("down during backoff cancels the pending restart", async () => {
  const f = fixture("stop-backoff", "process.exit(3)");
  try {
    await until(() => supervisorState(f.runtime)?.phase === "backoff");
    f.supervisor.stop();
    await until(f.stopped);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(f.log.filter((l) => l.includes("started daemon"))).toHaveLength(1);
    expect(f.release).toHaveBeenCalledOnce();
  } finally { f.supervisor.stop(); }
});

test("launchd refuses to compete with a running supervisor before writing", () => {
  const home = path.join(paths.runtime, "service-conflict");
  const runtime = path.join(paths.runtime, "conflict-runtime");
  const release = acquireSupervisorLock(runtime, { pid: process.pid, code: paths.code, root: paths.root });
  const launchctl = vi.fn(() => "");
  try {
    expect(() => installService({ home, runtime, code: paths.code, root: paths.root, node: process.execPath, uid: 501, launchctl })).toThrow("joyride down");
    expect(fs.existsSync(home)).toBe(false);
    expect(launchctl).not.toHaveBeenCalled();
  } finally { release?.(); }
});

test.each(["Documents", "Desktop", "Downloads"])("launchd refuses protected %s code, data or logs before any writes or launchctl calls", (folder) => {
  const home = path.join(paths.runtime, `privacy-${folder}`);
  const launchctl = vi.fn(() => "");
  const baseline = { home, code: "/code/joyride", root: "/data/joyride", runtime: path.join(home, "runtime"), node: "/node/bin/node", uid: 501, launchctl };
  for (const field of ["code", "root", "runtime"] as const) {
    const o = { ...baseline, [field]: path.join(home, folder, "joyride") };
    expect(() => installService(o)).toThrow("Full Disk Access");
    expect(() => installService(o)).toThrow("move the repo");
    expect(() => installService(o)).toThrow("supervisor");
    expect(fs.existsSync(home)).toBe(false);
    expect(launchctl).not.toHaveBeenCalled();
  }
  expect(() => assertServiceLocation({ ...baseline, code: path.join(home, `${folder}-safe`) })).not.toThrow();
});

test("launchd detects symlinks into protected folders, even when the runtime does not exist", () => {
  const home = path.join(paths.runtime, "privacy-link");
  fs.mkdirSync(path.join(home, "Documents"), { recursive: true });
  fs.symlinkSync(path.join(home, "Documents"), path.join(home, "alias"));
  expect(() => assertServiceLocation({ home, code: path.join(home, "alias/repo"), root: "/data", runtime: "/runtime", node: "/node" })).toThrow("macOS privacy-protected");
});
