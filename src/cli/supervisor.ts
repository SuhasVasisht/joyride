import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { z } from "zod";
import Database from "better-sqlite3";
import { paths, DAEMON_URL } from "../shared/paths.ts";
import { ensureDir, pidAlive, readJson, writeJsonAtomic } from "../core/util.ts";
import { assertDaemonProcess } from "./daemons.ts";
import { restartStoppedDaemon } from "./restart.ts";

const Owner = z.object({ pid: z.number().int().positive(), code: z.string(), root: z.string() });
const State = Owner.extend({ daemon: z.number().int().positive().nullable(), phase: z.enum(["running", "backoff", "stopped"]), failures: z.number(), retryAt: z.number().nullable() });
const lockPath = (runtime: string) => path.join(runtime, "supervisor.pid");
const statePath = (runtime: string) => path.join(runtime, "supervisor.json");
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function supervisorState(runtime = paths.runtime) {
  const parsed = State.safeParse(readJson<unknown>(statePath(runtime), null));
  return parsed.success ? parsed.data : null;
}

export function supervisorOwner(runtime = paths.runtime) {
  const parsed = Owner.safeParse(readJson<unknown>(lockPath(runtime), null));
  return parsed.success && pidAlive(parsed.data.pid) ? parsed.data : null;
}

// SQLite's process lock arbitrates the pid file, including stale-owner recovery.
// The OS releases it on SIGKILL, without a reclamation file that could itself go stale.
export function acquireSupervisorLock(runtime: string, owner: z.infer<typeof Owner>) {
  ensureDir(runtime);
  const lock = new Database(path.join(runtime, "supervisor.lock"), { timeout: 0 });
  try {
    lock.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    lock.close();
    if (error instanceof Error && "code" in error && error.code === "SQLITE_BUSY") return null;
    throw error;
  }
  try {
    if (fs.existsSync(lockPath(runtime))) {
      const parsed = Owner.safeParse(readJson<unknown>(lockPath(runtime), null));
      if (!parsed.success) throw new Error(`Cannot read ${lockPath(runtime)}. Check and remove the invalid pid lock before running joyride up.`);
      if (pidAlive(parsed.data.pid)) { lock.close(); return null; }
    }
    writeJsonAtomic(lockPath(runtime), owner);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try { fs.unlinkSync(lockPath(runtime)); }
      finally { lock.close(); }
    };
  } catch (error) { lock.close(); throw error; }
}

export class CrashBackoff {
  private failures: number[] = [];
  constructor(private policy = { baseMs: 250, maxMs: 30_000, windowMs: 60_000, cap: 6 }) {}
  exited(now: number, ranMs: number): { kind: "retry"; delayMs: number; failures: number } | { kind: "capped"; failures: number } {
    if (ranMs >= this.policy.windowMs) this.failures = [];
    this.failures = this.failures.filter((at) => now - at < this.policy.windowMs);
    this.failures.push(now);
    const failures = this.failures.length;
    if (failures >= this.policy.cap) return { kind: "capped", failures };
    return { kind: "retry", delayMs: Math.min(this.policy.maxMs, this.policy.baseMs * 2 ** (failures - 1)), failures };
  }
  reset() { this.failures = []; }
}

/** Owns child processes directly; health probes never authorize signalling a foreign pid. */
export class Supervisor {
  private child: ChildProcess | null = null;
  private timer: NodeJS.Timeout | null = null;
  private forced: NodeJS.Timeout | null = null;
  private probe: NodeJS.Timeout | null = null;
  private probing = false;
  private stopped = false;
  private restarting = false;
  private healthyAt = 0;
  private startedAt = 0;
  private backoff: CrashBackoff;
  constructor(private options: {
    owner: z.infer<typeof Owner>; runtime: string; command: string; args: string[];
    env: NodeJS.ProcessEnv; log: (message: string) => void;
    healthy: (pid: number) => Promise<boolean>; watchdogMs: number;
    release: () => void; onStop: () => void;
    backoff?: CrashBackoff;
  }) { this.backoff = options.backoff ?? new CrashBackoff(); }
  start() {
    this.launch();
    this.probe = setInterval(() => { void this.checkHealth(); }, 250);
  }
  private publish(phase: z.infer<typeof State>["phase"], failures = 0, retryAt: number | null = null) {
    writeJsonAtomic(statePath(this.options.runtime), { ...this.options.owner, daemon: this.child?.pid ?? null, phase, failures, retryAt });
  }
  private launch() {
    if (this.stopped) return;
    this.startedAt = this.healthyAt = Date.now();
    this.restarting = false;
    const log = fs.openSync(path.join(this.options.runtime, "daemon.log"), "a");
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.owner.code, stdio: ["ignore", log, log],
      env: { ...this.options.env, JOYRIDE_SUPERVISED: "1" },
    });
    fs.closeSync(log);
    this.child = child;
    this.publish("running");
    this.options.log(`started daemon pid ${child.pid ?? "unavailable"}`);
    child.once("error", (error) => this.options.log(`daemon spawn failed: ${error.message}`));
    child.once("close", (code, signal) => {
      if (this.forced) clearTimeout(this.forced);
      this.forced = null;
      this.child = null;
      if (this.stopped) { this.finish(); return; }
      if (this.restarting) { this.backoff.reset(); this.launch(); return; }
      const next = this.backoff.exited(Date.now(), Date.now() - this.startedAt);
      this.options.log(`daemon exited (code ${code}, signal ${signal})`);
      if (next.kind === "capped") {
        this.options.log(`crash-loop cap reached: ${next.failures} exits in 60 seconds. Fix the error in daemon.log, then run joyride up.`);
        this.publish("stopped", next.failures);
        this.stopped = true;
        this.finish();
      } else {
        this.publish("backoff", next.failures, Date.now() + next.delayMs);
        this.options.log(`restarting daemon in ${next.delayMs} ms (failure ${next.failures}/6)`);
        this.timer = setTimeout(() => { this.timer = null; this.launch(); }, next.delayMs);
      }
    });
  }
  private async checkHealth() {
    const child = this.child;
    if (this.probing || !child?.pid || this.stopped || this.restarting) return;
    this.probing = true;
    try {
      const healthy = await this.options.healthy(child.pid);
      if (this.child !== child || this.stopped || this.restarting) return;
      if (healthy) this.healthyAt = Date.now();
      else if (Date.now() - this.healthyAt > this.options.watchdogMs) {
        this.options.log(`watchdog: daemon pid ${child.pid} did not answer health for ${Date.now() - this.healthyAt} ms; killing it for recovery`);
        child.kill("SIGKILL");
      }
    } catch (error) { this.options.log(`health probe failed: ${String(error)}`); }
    finally { this.probing = false; }
  }
  restart() {
    if (this.stopped || this.restarting) return;
    this.restarting = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.options.log("daemon restart requested");
    if (this.child) this.terminate();
    else { this.backoff.reset(); this.launch(); }
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.child) this.terminate();
    else this.finish();
  }
  private terminate() {
    const child = this.child;
    if (!child) return;
    child.kill("SIGTERM");
    this.forced = setTimeout(() => child.kill("SIGKILL"), 750);
  }
  private finish() {
    if (this.probe) clearInterval(this.probe);
    this.probe = null;
    this.options.release();
    this.options.onStop();
  }
}

export async function ownedSupervisor() {
  const owner = supervisorOwner();
  if (!owner) return null;
  if (owner.code !== paths.code || owner.root !== paths.root) throw new Error(`Supervisor pid ${owner.pid} belongs to ${owner.code} (data ${owner.root}). Use that checkout to control it.`);
  const argv = execFileSync("ps", ["-p", String(owner.pid), "-o", "args="], { encoding: "utf8", timeout: 1000 });
  if (!argv.includes(path.join(paths.code, "src/cli/supervisor-main.ts"))) throw new Error(`Pid ${owner.pid} is not this checkout's supervisor. Refusing to signal it.`);
  return owner;
}

export async function stopManualDaemon() {
  const parsed = Owner.safeParse(readJson<unknown>(path.join(paths.runtime, "daemon.json"), null));
  if (!parsed.success || !pidAlive(parsed.data.pid)) return;
  if (parsed.data.code !== paths.code || parsed.data.root !== paths.root) throw new Error(`Daemon pid ${parsed.data.pid} belongs to another checkout or data root. Refusing to stop it.`);
  await assertDaemonProcess(parsed.data.pid);
  process.kill(parsed.data.pid, "SIGTERM");
  await restartStoppedDaemon({ pid: parsed.data.pid, timeoutMs: 750, start: async () => {} });
}

export async function startSupervisor() {
  if (await ownedSupervisor()) return;
  ensureDir(paths.runtime);
  const log = fs.openSync(path.join(paths.runtime, "supervisor.log"), "a");
  const child = spawn(process.execPath, ["--import", "tsx", path.join(paths.code, "src/cli/supervisor-main.ts")], {
    cwd: paths.code, detached: true, stdio: ["ignore", log, log], env: { ...process.env },
  });
  child.unref();
  fs.closeSync(log);
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
}

export async function stopSupervisor() {
  const owner = await ownedSupervisor();
  if (!owner) { await stopManualDaemon(); return; }
  process.kill(owner.pid, "SIGTERM");
  for (let i = 0; i < 60; i++) {
    if (!pidAlive(owner.pid)) return;
    await pause(50);
  }
  throw new Error(`Supervisor pid ${owner.pid} did not stop. Check supervisor.log before retrying.`);
}

export async function daemonHealthy(pid: number) {
  try {
    const response = await fetch(DAEMON_URL + "/api/health", { signal: AbortSignal.timeout(500) });
    if (!response.ok) return false;
    const health: unknown = await response.json();
    const parsed = Owner.extend({ ok: z.literal(true) }).safeParse(health);
    return parsed.success && parsed.data.pid === pid && parsed.data.code === paths.code && parsed.data.root === paths.root;
  } catch { return false; }
}
