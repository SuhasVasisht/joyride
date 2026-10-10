// Keeps a Herdr server running for the default machine, so nobody has to open a
// terminal and type `herdr` before Joyride can see or steer agents.
//
// - On start, and whenever the socket has been unreachable for more than 10 s,
//   it runs `herdr server` detached (own session and process group) with an
//   environment stripped of every CLAUDE* / JOYRIDE* variable (see
//   CLEAN_AGENT_ENV in herdr.ts: a server started from inside a Claude Code
//   session would pass those markers to every pane). Output goes to
//   .joyride/herdr-server.log.
// - It never starts a second server: a socket that answers, or one that is
//   there but slow, counts as running; a server it started recently gets time
//   to come up; Herdr itself refuses a second server on the same socket.
// - Tests never spawn a real Herdr unless the sandbox sets JOYRIDE_MANAGE_HERDR=1.
import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { herdrRequest } from "./herdr-client.ts";

export type Probe = "up" | "down" | "unresponsive";
export type ManagerState = "off" | "idle" | "up" | "down" | "starting" | "failed";
export type ManagerStatus = {
  enabled: boolean; reason: string | null; state: ManagerState; machine: string; socket: string; bin: string; log: string;
  pid: number | null; started_at: string | null; starts: number; last_error: string | null; down_since: string | null;
};
export type StartResult = { ok: boolean; started: boolean; already_running: boolean; pid: number | null; message: string };

export type ManagerDeps = {
  probe?: (socket: string) => Promise<Probe>;
  spawn?: (bin: string, args: string[], opts: { env: Record<string, string>; cwd: string; logFile: string }) => { pid: number | null; error?: Promise<Error | null> };
  pidAlive?: (pid: number) => boolean;
  /** The live client's view: while it is connected the server is up and no probe is needed. */
  connected?: () => boolean;
  now?: () => number;
  log?: (msg: string) => void;
};
export type ManagerOpts = {
  machine: string;
  socket: string;
  bin: string;
  logFile: string;
  /** Lock/state file shared by every daemon on this runtime, so two daemons don't race to start one server. */
  stateFile: string;
  enabled: boolean;
  /** Why management is off (shown in the status). */
  reason?: string | null;
  downAfterMs?: number;
  checkMs?: number;
  /** How long a freshly started server gets before another start is considered. */
  graceMs?: number;
  onStarted?: (pid: number | null) => void;
};

/** Herdr's own default API socket (it honours XDG_CONFIG_HOME). */
export function herdrDefaultSocket(env: NodeJS.ProcessEnv = process.env) {
  const cfg = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(cfg, "herdr", "herdr.sock");
}

/** The environment a managed Herdr server (and so every pane it opens) starts with. */
export function cleanServerEnv(env: NodeJS.ProcessEnv, socket: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v == null) continue;
    if (/^(CLAUDE|JOYRIDE)/.test(k)) continue;
    // Pane markers from a Herdr pane the daemon itself may run in.
    if (/^HERDR_(PANE_ID|TAB_ID|WORKSPACE_ID|ENV|SESSION|SOCKET_PATH|CLIENT_SOCKET_PATH)$/.test(k)) continue;
    out[k] = v;
  }
  // Only redirect the socket when Joyride is configured for a non-default one (sandboxes, tests).
  if (path.resolve(socket) !== path.resolve(herdrDefaultSocket(env))) out.HERDR_SOCKET_PATH = socket;
  return out;
}

/** The Herdr binary: JOYRIDE_HERDR_BIN, the configured path if it exists, else `herdr` on PATH. */
export function resolveHerdrBin(configured: string, env: NodeJS.ProcessEnv = process.env) {
  if (env.JOYRIDE_HERDR_BIN) return env.JOYRIDE_HERDR_BIN;
  return fs.existsSync(configured) ? configured : "herdr";
}

/** Whether this daemon may manage Herdr at all. */
export function managementAllowed(configManage: boolean, env: NodeJS.ProcessEnv = process.env): { enabled: boolean; reason: string | null } {
  if (env.JOYRIDE_MANAGE_HERDR === "0") return { enabled: false, reason: "Turned off with JOYRIDE_MANAGE_HERDR=0." };
  if ((env.JOYRIDE_TEST || env.VITEST) && env.JOYRIDE_MANAGE_HERDR !== "1") return { enabled: false, reason: "Tests never start a real Herdr (set JOYRIDE_MANAGE_HERDR=1 in the sandbox to allow it)." };
  if (!configManage && env.JOYRIDE_MANAGE_HERDR !== "1") return { enabled: false, reason: "Turned off in joyride.config.yaml (herdr.manage: false)." };
  return { enabled: true, reason: null };
}

async function defaultProbe(socket: string): Promise<Probe> {
  try { await herdrRequest(socket, "ping", {}, 2500); return "up"; }
  catch (e: any) { return e?.code === "unavailable" ? "down" : "unresponsive"; }
}

function defaultSpawn(bin: string, args: string[], o: { env: Record<string, string>; cwd: string; logFile: string }) {
  fs.mkdirSync(path.dirname(o.logFile), { recursive: true });
  const fd = fs.openSync(o.logFile, "a");
  try {
    fs.writeSync(fd, `\n[joyride ${new Date().toISOString()}] starting \`${bin} ${args.join(" ")}\`${o.env.HERDR_SOCKET_PATH ? ` (HERDR_SOCKET_PATH=${o.env.HERDR_SOCKET_PATH})` : ""}\n`);
    // detached: a new session and process group, so the server outlives the daemon and never gets its signals.
    const child = nodeSpawn(bin, args, { detached: true, stdio: ["ignore", fd, fd], env: o.env, cwd: o.cwd });
    const error = new Promise<Error | null>((resolve) => {
      child.once("error", (e) => resolve(e));
      child.once("spawn", () => resolve(null));
    });
    child.unref();
    return { pid: child.pid ?? null, error };
  } finally { fs.closeSync(fd); }
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e.code === "EPERM"; } };

export class HerdrManager {
  state: ManagerState;
  pid: number | null = null;
  startedAt: number | null = null;
  starts = 0;
  failures = 0;
  /** The last start was followed by a socket that answered. */
  cameUp = true;
  lastError: string | null = null;
  downSince: number | null = null;
  private first = true;
  private timer: NodeJS.Timeout | null = null;
  private busy: Promise<unknown> | null = null;
  private d: Required<ManagerDeps>;
  private o: Required<Omit<ManagerOpts, "onStarted" | "reason">> & Pick<ManagerOpts, "onStarted" | "reason">;

  constructor(opts: ManagerOpts, deps: ManagerDeps = {}) {
    this.o = { downAfterMs: 10_000, checkMs: 2_000, graceMs: 20_000, ...opts };
    this.d = { probe: defaultProbe, spawn: defaultSpawn, pidAlive: alive, connected: () => false, now: Date.now, log: () => {}, ...deps };
    this.state = opts.enabled ? "idle" : "off";
  }

  get enabled() { return this.o.enabled; }

  start() {
    if (!this.o.enabled || this.timer) return;
    const loop = () => {
      this.timer = setTimeout(async () => { await this.tick().catch(() => {}); if (this.timer) loop(); }, this.o.checkMs);
      this.timer.unref?.();
    };
    this.tick().catch(() => {}).finally(() => { if (!this.timer) loop(); });
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** One check: start the server when it is down at startup, or down for longer than downAfterMs. */
  async tick(): Promise<void> {
    if (!this.o.enabled) return;
    if (this.busy) { await this.busy; return; }
    const run = (async () => {
      const p: Probe = this.d.connected() ? "up" : await this.d.probe(this.o.socket);
      const t = this.d.now();
      if (p !== "down") {
        // "unresponsive": something is listening, so a server is running; starting another would fail anyway.
        if (p === "up") { this.state = "up"; this.failures = 0; this.lastError = null; this.cameUp = true; }
        this.downSince = null;
        this.first = false;
        return;
      }
      if (this.downSince == null) this.downSince = t;
      const due = this.first || t - this.downSince > this.o.downAfterMs;
      this.first = false;
      if (!due) { this.state = "down"; return; }
      if (this.booting(t)) { this.state = "starting"; return; }
      if (this.startedAt != null && !this.cameUp && t - this.startedAt < this.backoffMs(this.failures + 1)) {
        // The last start never answered: back off instead of starting a server every few seconds.
        this.state = "failed";
        this.lastError ??= `Herdr was started but its socket never answered. See ${this.o.logFile}.`;
        return;
      }
      await this.spawnServer("auto");
    })();
    this.busy = run;
    try { await run; } finally { this.busy = null; }
  }

  /** A server this (or another) daemon started recently is still coming up. */
  private booting(t: number): boolean {
    if (this.pid && this.startedAt != null && t - this.startedAt < this.o.graceMs && this.d.pidAlive(this.pid)) return true;
    const other = this.readLock();
    return Boolean(other && other.pid !== this.pid && t - other.at < this.o.graceMs && this.d.pidAlive(other.pid));
  }

  private backoffMs(failures: number) { return Math.min(5 * 60_000, this.o.downAfterMs * 2 ** Math.min(failures, 6)); }

  private readLock(): { pid: number; at: number } | null {
    try { const j = JSON.parse(fs.readFileSync(this.o.stateFile, "utf8")); return j?.pid ? { pid: Number(j.pid), at: Date.parse(j.started_at) || 0 } : null; } catch { return null; }
  }

  private async spawnServer(why: "auto" | "manual"): Promise<StartResult> {
    const env = cleanServerEnv(process.env, this.o.socket);
    const t = this.d.now();
    if (this.startedAt != null && !this.cameUp) this.failures++; // the last start never came up
    this.cameUp = false;
    this.state = "starting";
    this.startedAt = t;
    this.starts++;
    this.d.log(`herdr ${this.o.machine}: socket ${this.o.socket} is not answering; starting \`${this.o.bin} server\` (${why}), log ${this.o.logFile}`);
    let res: ReturnType<Required<ManagerDeps>["spawn"]>;
    try { res = this.d.spawn(this.o.bin, ["server"], { env, cwd: os.homedir(), logFile: this.o.logFile }); }
    catch (e: any) { return this.fail(`Couldn't start Herdr: ${e.message}`); }
    const err = res.error ? await Promise.race([res.error, new Promise<null>((r) => setTimeout(() => r(null), 1000))]) : null;
    if (err) {
      const msg = (err as any).code === "ENOENT"
        ? `Herdr is not installed at ${this.o.bin}. Install Herdr, or set JOYRIDE_HERDR_BIN to its path.`
        : `Couldn't start Herdr: ${err.message}`;
      return this.fail(msg);
    }
    this.pid = res.pid;
    try { fs.mkdirSync(path.dirname(this.o.stateFile), { recursive: true }); fs.writeFileSync(this.o.stateFile, JSON.stringify({ pid: res.pid, started_at: new Date(t).toISOString(), socket: this.o.socket, bin: this.o.bin })); } catch {}
    this.o.onStarted?.(res.pid);
    return { ok: true, started: true, already_running: false, pid: res.pid, message: `Started Herdr (pid ${res.pid ?? "unknown"}). Joyride connects as soon as its socket answers.` };
  }

  private fail(msg: string): StartResult {
    this.state = "failed";
    this.failures++;
    this.lastError = msg;
    this.d.log(`herdr ${this.o.machine}: ${msg}`);
    return { ok: false, started: false, already_running: false, pid: null, message: msg };
  }

  /** Start now if nothing answers on the socket (the "Start Herdr" button). */
  async startNow(): Promise<StartResult> {
    if (!this.o.enabled) return { ok: false, started: false, already_running: false, pid: null, message: this.o.reason ?? "Joyride does not manage Herdr here." };
    if (this.busy) await this.busy.catch(() => {});
    const p = await this.d.probe(this.o.socket);
    if (p === "up") { this.state = "up"; return { ok: true, started: false, already_running: true, pid: this.pid, message: "Herdr is already running." }; }
    if (p === "unresponsive") return { ok: false, started: false, already_running: true, pid: this.pid, message: `A Herdr server is listening on ${this.o.socket} but not answering. Joyride won't start a second one; check ${this.o.logFile} or restart Herdr.` };
    if (this.booting(this.d.now())) return { ok: true, started: false, already_running: true, pid: this.pid, message: "Herdr is starting; give it a few seconds." };
    this.failures = 0;
    const run = this.spawnServer("manual");
    this.busy = run;
    try { return await run; } finally { this.busy = null; }
  }

  status(): ManagerStatus {
    return {
      enabled: this.o.enabled, reason: this.o.enabled ? null : this.o.reason ?? null, state: this.state, machine: this.o.machine, socket: this.o.socket, bin: this.o.bin, log: this.o.logFile,
      pid: this.pid, started_at: this.startedAt != null ? new Date(this.startedAt).toISOString() : null, starts: this.starts, last_error: this.lastError,
      down_since: this.downSince != null ? new Date(this.downSince).toISOString() : null,
    };
  }
}
