// Herdr socket client (one per machine). Herdr speaks newline-delimited JSON
// over a unix socket and answers exactly one request per connection, so every
// call opens its own connection and correlates the response by id. Two
// long-lived subscription connections keep the pane cache fresh:
//   - lifecycle: pane/workspace/tab events (pushed as {event:"pane_created",data})
//   - status:    pane.agent_status_changed, one entry per pane (rebuilt when panes change)
// Events are treated as invalidation signals; a serialized reconcile
// (pane.list + agent.list) is the authority, and also runs every pollMs.
import net from "node:net";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { pidAlive } from "../../core/util.ts";

export class HerdrError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = "HerdrError"; }
}

export type HerdrStatus = "idle" | "working" | "blocked" | "done" | "unknown";
export type AgentSessionRef = { source: string; agent: string; kind: string; value: string };
export type PaneState = {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  terminal_id: string;
  focused: boolean;
  cwd: string | null;
  foreground_cwd: string | null;
  label: string | null;
  title: string | null;
  terminal_title: string | null;
  agent: string | null;
  name: string | null;
  agent_status: HerdrStatus;
  agent_session: AgentSessionRef | null;
  tokens: Record<string, string>;
  launch_pending: boolean;
  /** When Joyride observed the current agent_status (ISO). */
  status_since: string;
  /** Foreground process pids, fetched for agent panes without a native session ref. */
  fg_pids: number[];
};

let seq = 0;
const nextId = (p: string) => `${p}_${process.pid}_${++seq}`;
const nowIso = () => new Date().toISOString();

function connError(socket: string, e: NodeJS.ErrnoException): HerdrError {
  if (e.code === "ENOENT" || e.code === "ECONNREFUSED") return new HerdrError("unavailable", `Herdr is not running: nothing is listening on ${socket}.`);
  return new HerdrError("io", `Herdr socket ${socket}: ${e.message}`);
}

/** One request on its own connection. Rejects with HerdrError(code) on Herdr errors, timeouts and socket failures. */
export function herdrRequest(socket: string, method: string, params: Record<string, unknown> = {}, timeoutMs = 1500): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = nextId("rq");
    let buf = "";
    let done = false;
    const conn = net.createConnection(socket);
    const finish = (err: Error | null, res?: any) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      conn.destroy();
      if (err) reject(err); else resolve(res);
    };
    const timer = setTimeout(() => finish(new HerdrError("timeout", `Herdr did not answer ${method} within ${timeoutMs} ms.`)), timeoutMs);
    conn.setEncoding("utf8");
    conn.on("connect", () => conn.write(JSON.stringify({ id, method, params }) + "\n"));
    conn.on("data", (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== id && msg.id !== "") continue; // not ours (Herdr uses "" when it could not read the id)
        if (msg.error) finish(new HerdrError(msg.error.code ?? "error", msg.error.message ?? "Herdr error"));
        else finish(null, msg.result ?? {});
      }
    });
    conn.on("error", (e) => finish(connError(socket, e)));
    conn.on("close", () => finish(new HerdrError("closed", `Herdr closed the connection before answering ${method}.`)));
  });
}

type SubHandlers = { onAck?: () => void; onEvent: (event: string, data: any) => void; onEnd: (err: HerdrError | null) => void };

/** A long-lived events.subscribe connection. onEnd fires once unless close() was called by us. */
export class HerdrSubscription {
  readonly id = nextId("sub");
  acked = false;
  private conn: net.Socket;
  private buf = "";
  private ended = false;
  private ackTimer: NodeJS.Timeout;
  constructor(socket: string, subscriptions: object[], private h: SubHandlers, ackTimeoutMs = 5000) {
    this.conn = net.createConnection(socket);
    this.conn.setEncoding("utf8");
    this.ackTimer = setTimeout(() => this.end(new HerdrError("timeout", "Herdr did not acknowledge the event subscription.")), ackTimeoutMs);
    this.conn.on("connect", () => this.conn.write(JSON.stringify({ id: this.id, method: "events.subscribe", params: { subscriptions } }) + "\n"));
    this.conn.on("data", (d: string) => {
      this.buf += d;
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.error) { this.end(new HerdrError(msg.error.code ?? "error", msg.error.message ?? "subscription error")); return; }
        if (msg.result && !this.acked) { this.acked = true; clearTimeout(this.ackTimer); this.h.onAck?.(); continue; }
        if (msg.event) { try { this.h.onEvent(String(msg.event), msg.data ?? {}); } catch { /* handler bugs must not kill the stream */ } }
      }
    });
    this.conn.on("error", (e) => this.end(connError(socket, e)));
    this.conn.on("close", () => this.end(new HerdrError("closed", "Herdr closed the event stream (it may have stopped); reconnecting.")));
  }
  private end(err: HerdrError | null) {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.ackTimer);
    this.conn.destroy();
    this.h.onEnd(err);
  }
  close() {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.ackTimer);
    this.conn.destroy();
  }
}

export const LIFECYCLE_SUBSCRIPTIONS = [
  "pane.created", "pane.closed", "pane.updated", "pane.focused", "pane.moved", "pane.exited", "pane.agent_detected",
  "workspace.created", "workspace.closed", "tab.created", "tab.closed",
].map((type) => ({ type }));

const STATUSES = new Set(["idle", "working", "blocked", "done", "unknown"]);
const asStatus = (s: unknown): HerdrStatus => (STATUSES.has(String(s)) ? (s as HerdrStatus) : "unknown");

/** Normalize an authoritative PaneInfo/AgentInfo record. Herdr omits null fields, so absent means null. */
export function normPane(raw: any, prev?: PaneState): PaneState {
  return {
    pane_id: String(raw.pane_id),
    workspace_id: raw.workspace_id ?? prev?.workspace_id ?? "",
    tab_id: raw.tab_id ?? prev?.tab_id ?? "",
    terminal_id: raw.terminal_id ?? prev?.terminal_id ?? "",
    focused: Boolean(raw.focused),
    cwd: raw.cwd ?? null,
    foreground_cwd: raw.foreground_cwd ?? null,
    label: raw.label ?? null,
    title: raw.title ?? null,
    terminal_title: raw.terminal_title_stripped ?? raw.terminal_title ?? null,
    agent: raw.agent ?? null,
    name: raw.name ?? null,
    agent_status: asStatus(raw.agent_status),
    agent_session: raw.agent_session && raw.agent_session.value ? raw.agent_session : null,
    tokens: raw.tokens ?? {},
    launch_pending: Boolean(raw.launch_pending),
    status_since: prev?.status_since ?? nowIso(),
    fg_pids: prev && prev.terminal_id === raw.terminal_id && prev.agent === (raw.agent ?? null) ? prev.fg_pids : [],
  };
}

export type ClientOpts = {
  machine: string;
  socket: string;
  /** Shell command that starts this Herdr server, used in error messages. */
  startHint?: string;
  /** Replaces "Start it with `herdr`" when Joyride starts the server itself. */
  unavailableHint?: string;
  pollMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  requestTimeoutMs?: number;
  random?: () => number;
  refresh?: (fn: () => Promise<void>) => Promise<void>;
  log?: (msg: string) => void;
};

/**
 * Events emitted:
 *  connection(connected: boolean)
 *  hydrated(panes: PaneState[])            first successful reconcile after start()
 *  pane-created(p) / pane-closed(p)
 *  status(p, prev: HerdrStatus | null)      agent pane status transition (prev null = agent appeared)
 *  agent-exited(p, prevAgent, prevStatus)   the agent left a pane that is still open
 *  focus(p)
 *  changed()                                anything in the cache changed
 */
export class HerdrClient extends EventEmitter {
  readonly machine: string;
  readonly socket: string;
  state: "idle" | "connecting" | "connected" | "disconnected" = "idle";
  error: string | null = null;
  version: string | null = null;
  lastConnected: string | null = null;
  lastEvent: string | null = null;
  lastRefresh: string | null = null;
  hydrated = false;
  panes = new Map<string, PaneState>();
  focusedPane: string | null = null;

  private life: HerdrSubscription | null = null;
  private statusSub: HerdrSubscription | null = null;
  private statusKey = "";
  private retryMs: number;
  private retryTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private reconciling: Promise<void> | null = null;
  private again = false;
  private stopped = true;
  private opts: Required<Omit<ClientOpts, "log">> & { log: (m: string) => void };

  constructor(opts: ClientOpts) {
    super();
    this.machine = opts.machine;
    this.socket = opts.socket;
    this.opts = { pollMs: 5000, retryBaseMs: 250, retryMaxMs: 15000, requestTimeoutMs: 1500, random: Math.random, refresh: (fn) => fn(), startHint: "herdr", unavailableHint: "", log: () => {}, ...opts };
    this.retryMs = this.opts.retryBaseMs;
  }

  connected() { return this.state === "connected"; }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
    this.pollTimer = setInterval(() => { if (this.state === "connected") this.reconcile().catch(() => {}); }, this.opts.pollMs);
    this.pollTimer.unref();
  }

  stop() {
    this.stopped = true;
    for (const t of [this.retryTimer, this.reconcileTimer]) if (t) clearTimeout(t);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.retryTimer = this.reconcileTimer = this.pollTimer = null;
    this.life?.close(); this.life = null;
    this.statusSub?.close(); this.statusSub = null; this.statusKey = "";
    this.state = "idle";
  }

  call(method: string, params: Record<string, unknown> = {}, timeoutMs = this.opts.requestTimeoutMs) {
    return herdrRequest(this.socket, method, params, timeoutMs);
  }

  /** Reconnect immediately (used after events_lost and by tests). */
  reconnectNow() {
    if (this.stopped) return;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.life?.close(); this.life = null;
    this.connect();
  }

  private describe(err: HerdrError | null) {
    if (!err) return null;
    if (err.code === "unavailable") return `${err.message} ${this.opts.unavailableHint || `Start it with \`${this.opts.startHint}\`; Joyride reconnects on its own.`}`;
    return err.message;
  }

  private connect() {
    if (this.stopped || this.life) return;
    if (this.state !== "connected") this.state = this.state === "idle" ? "connecting" : this.state;
    if (!fs.existsSync(this.socket)) return this.lost(new HerdrError("unavailable", `Herdr is not running: no socket at ${this.socket}.`));
    const sub = new HerdrSubscription(this.socket, LIFECYCLE_SUBSCRIPTIONS, {
      onAck: () => {
        this.state = "connected";
        this.lastConnected = nowIso();
        this.opts.log(`herdr ${this.machine}: connected (${this.socket})`);
        this.emit("connection", true);
        this.call("ping").then((r) => { this.version = r?.version ?? null; }).catch(() => {});
        this.reconcile().catch(() => {});
      },
      onEvent: (ev, data) => this.onLifecycle(ev, data),
      onEnd: (err) => { if (this.life === sub) { this.life = null; this.lost(err); } },
    }, this.opts.requestTimeoutMs);
    this.life = sub;
  }

  private lost(err: HerdrError | null) {
    this.life?.close(); this.life = null;
    const was = this.state === "connected";
    this.statusSub?.close(); this.statusSub = null; this.statusKey = "";
    this.state = "disconnected";
    this.error = this.describe(err);
    if (was) { this.opts.log(`herdr ${this.machine}: disconnected (${err?.code ?? "closed"})`); this.emit("connection", false); this.emit("changed"); }
    if (this.stopped) return;
    // events_lost: the cache is stale but Herdr is up, so resubscribe at once and reconcile.
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const delay = err?.code === "events_lost" ? 0 : this.retryMs * (0.8 + this.opts.random() * 0.4);
    if (err?.code !== "events_lost") this.retryMs = Math.min(this.retryMs * 2, this.opts.retryMaxMs);
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.connect(); }, delay);
    this.retryTimer.unref();
  }

  scheduleReconcile(ms = 150) {
    if (this.stopped || this.reconcileTimer) return;
    this.reconcileTimer = setTimeout(() => { this.reconcileTimer = null; if (this.state === "connected") this.reconcile().catch(() => {}); }, ms);
    this.reconcileTimer.unref();
  }

  /** Serialized authoritative refresh (pane.list + agent.list). */
  reconcile(): Promise<void> {
    if (this.stopped || this.state !== "connected") return Promise.resolve();
    if (this.reconciling) { this.again = true; return this.reconciling; }
    this.reconciling = this.opts.refresh(async () => {
      try {
        do { this.again = false; await this.reconcileOnce(); } while (this.again && !this.stopped);
      } catch (e: any) {
        this.opts.log(`herdr ${this.machine}: reconcile failed: ${e.message}`);
        this.again = false;
        this.lost(e instanceof HerdrError ? e : new HerdrError("io", String(e)));
        throw e;
      } finally { this.reconciling = null; }
    });
    return this.reconciling;
  }

  private async reconcileOnce() {
    // Wait for both sockets to finish, even when one fails first. A retry never overlaps this pair.
    const results = await Promise.allSettled([this.call("pane.list", {}), this.call("agent.list", {})]);
    const plResult = results[0], alResult = results[1];
    if (plResult?.status === "rejected") throw plResult.reason;
    if (alResult?.status === "rejected") throw alResult.reason;
    if (!plResult || !alResult) return;
    const pl = plResult.value, al = alResult.value;
    const fresh = new Map<string, any>();
    for (const p of pl?.panes ?? []) fresh.set(p.pane_id, { ...p });
    for (const a of al?.agents ?? []) fresh.set(a.pane_id, { ...(fresh.get(a.pane_id) ?? {}), ...a });
    if (this.stopped) return;

    const next = new Map<string, PaneState>();
    for (const [id, raw] of fresh) next.set(id, normPane(raw, this.panes.get(id)));
    await this.fillProcessPids(next);
    if (this.stopped) return;

    if (!this.hydrated) {
      this.panes = next;
      for (const p of next.values()) if (p.focused) this.focusedPane = p.pane_id;
      this.hydrated = true;
      this.emit("hydrated", [...next.values()]);
    } else {
      for (const [id, p] of [...this.panes]) if (!next.has(id)) { this.panes.delete(id); this.emit("pane-closed", p); }
      for (const [id, n] of next) {
        const cur = this.panes.get(id);
        if (!cur) {
          this.panes.set(id, n);
          this.emit("pane-created", n);
          if (n.agent) this.emit("status", n, null);
          continue;
        }
        const { agent, agent_status } = n;
        Object.assign(cur, n, { agent: cur.agent, agent_status: cur.agent_status, status_since: cur.status_since });
        this.applyAgentStatus(cur, agent, agent_status);
      }
    }
    this.ensureStatusSub();
    this.lastRefresh = nowIso();
    this.error = null;
    this.retryMs = this.opts.retryBaseMs;
    this.emit("changed");
  }

  /** For agent panes without a native session ref, learn their foreground pids (matches ~/.claude/sessions/<pid>.json). */
  private async fillProcessPids(next: Map<string, PaneState>) {
    const need = [...next.values()].filter((p) => p.agent && !p.agent_session && !(p.fg_pids.length && p.fg_pids.every(pidAliveSafe)));
    // Four sockets at a time, with one bounded pass per reconcile.
    const missing = need.slice(0, 4);
    await Promise.all(missing.map(async (p) => {
      try {
        const r = await this.call("pane.process_info", { pane_id: p.pane_id });
        const info = r?.process_info ?? r;
        p.fg_pids = (info?.foreground_processes ?? []).map((x: any) => Number(x.pid)).filter((n: number) => n > 0);
      } catch { /* optional */ }
    }));
  }

  /** Apply an agent/status observation; emits transitions. */
  applyAgentStatus(p: PaneState, agent: string | null, status: HerdrStatus) {
    const prevAgent = p.agent, prevStatus = p.agent_status;
    if (agent !== prevAgent) {
      p.agent = agent;
      p.agent_status = status;
      p.status_since = nowIso();
      if (prevAgent && !agent) { p.agent_session = null; p.fg_pids = []; this.emit("agent-exited", p, prevAgent, prevStatus); }
      else if (agent) this.emit("status", p, null);
      return;
    }
    if (status !== prevStatus) {
      p.agent_status = status;
      p.status_since = nowIso();
      if (p.agent) this.emit("status", p, prevStatus);
    }
  }

  private removeWhere(pred: (p: PaneState) => boolean) {
    for (const [id, p] of [...this.panes]) if (pred(p)) { this.panes.delete(id); this.emit("pane-closed", p); }
  }

  private onLifecycle(ev: string, data: any) {
    this.lastEvent = nowIso();
    const type = String(data?.type ?? ev).replace(/\./g, "_");
    if (this.hydrated) {
      switch (type) {
        case "pane_created": case "pane_updated": {
          const raw = data.pane;
          if (!raw?.pane_id) break;
          const cur = this.panes.get(raw.pane_id);
          const n = normPane(raw, cur);
          if (!cur) {
            this.panes.set(n.pane_id, n);
            this.emit("pane-created", n);
            if (n.agent) this.emit("status", n, null);
          } else {
            Object.assign(cur, n, { agent: cur.agent, agent_status: cur.agent_status, status_since: cur.status_since, name: n.name ?? cur.name });
            this.applyAgentStatus(cur, n.agent, n.agent_status);
          }
          break;
        }
        case "pane_closed": {
          const p = this.panes.get(data.pane_id);
          if (p) { this.panes.delete(p.pane_id); this.emit("pane-closed", p); }
          break;
        }
        case "pane_focused": {
          for (const p of this.panes.values()) p.focused = p.pane_id === data.pane_id;
          this.focusedPane = data.pane_id ?? null;
          const p = this.panes.get(data.pane_id) ?? ({ pane_id: data.pane_id, workspace_id: data.workspace_id ?? "" } as PaneState);
          this.emit("focus", p);
          break;
        }
        case "pane_moved": {
          const prev = this.panes.get(data.previous_pane_id);
          if (prev && data.pane?.pane_id) {
            this.panes.delete(prev.pane_id);
            const n = normPane(data.pane, prev);
            Object.assign(n, { agent: prev.agent, agent_status: prev.agent_status, status_since: prev.status_since });
            this.panes.set(n.pane_id, n);
          }
          break;
        }
        case "pane_agent_detected": {
          // Without final_status the event does not say what state the agent is in;
          // the reconcile scheduled below reads it instead of guessing.
          const p = this.panes.get(data.pane_id);
          if (p && (data.released || data.final_status)) this.applyAgentStatus(p, data.released ? null : data.agent ?? null, asStatus(data.final_status ?? p.agent_status));
          break;
        }
        case "workspace_closed": this.removeWhere((p) => p.workspace_id === data.workspace_id); break;
        case "tab_closed": this.removeWhere((p) => p.tab_id === data.tab_id); break;
      }
      this.emit("changed");
    }
    this.scheduleReconcile();
  }

  private onStatusEvent(data: any) {
    this.lastEvent = nowIso();
    if (!this.hydrated) return;
    const p = this.panes.get(data?.pane_id);
    if (!p) { this.scheduleReconcile(); return; }
    this.applyAgentStatus(p, data.agent ?? p.agent, asStatus(data.agent_status));
    if (data.title) p.title = data.title;
    this.emit("changed");
  }

  /** Per-pane agent status subscription; Herdr rejects the whole request if any pane is gone, so rebuild on change. */
  private ensureStatusSub() {
    if (this.stopped || this.state !== "connected") return;
    const ids = [...this.panes.keys()].sort();
    const key = ids.join(",");
    if (key === this.statusKey && this.statusSub) return;
    const old = this.statusSub;
    this.statusKey = key;
    if (!ids.length) { old?.close(); this.statusSub = null; return; }
    const sub: HerdrSubscription = new HerdrSubscription(this.socket, ids.map((pane_id) => ({ type: "pane.agent_status_changed", pane_id })), {
      onAck: () => old?.close(),
      onEvent: (_ev, data) => this.onStatusEvent(data),
      onEnd: (err) => {
        old?.close();
        if (this.statusSub !== sub) return;
        this.statusSub = null; this.statusKey = "";
        if (!this.stopped && this.state === "connected") this.scheduleReconcile(err?.code === "pane_not_found" ? 100 : 1000);
      },
    });
    this.statusSub = sub;
  }

  statusSubscribed() { return Boolean(this.statusSub?.acked); }
}

function pidAliveSafe(pid: number) { try { return pidAlive(pid); } catch { return false; } }
