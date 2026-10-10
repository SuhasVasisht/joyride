import { launchSessionForPane } from "./launch-identity.ts";
// The `workers` service: one row per live agent process, merged from
//   (a) Herdr panes running an agent (controllable: Joyride can type into them)
//   (b) live Claude Code processes in <claudeDir>/sessions/<pid>.json
//   (c) Codex sessions with hook activity in the last 10 minutes and no session.end
// Hook events add the current action, last message and status hints. Each worker's owner (crew,
// control or watched) comes from Firstmate's task records via resolveOwner (owner.ts), and its helm
// (who is steering it now) from the captain's steers via helmFor (helm.ts).
import fs from "node:fs";
import path from "node:path";
import type { Ctx, EventRecord } from "../../core/context.ts";
import type { AgentKind, WorkerStatus, WorkerView } from "../../shared/schema.ts";
import { paths } from "../../shared/paths.ts";
import { pidAlive, repoRootOf, truncate } from "../../core/util.ts";
import type { HerdrService, MachinePane } from "./herdr.ts";
import { isUnder, paneSessionKey, paneTitle, toAgentKind } from "./common.ts";
import { resolveOwner, type CrewKey } from "./owner.ts";
import { helmFor, type HelmTracker } from "./helm.ts";

/** What the workers projection asks of the firstmate service (absent when that module is off). */
type FirstmateOwners = { crewKeys(): CrewKey[]; controlWorker(): string | null; isControlWorker?(w: Pick<WorkerView, "id" | "cwd">): boolean };
/** What it asks of the fleet service: whether the captain keeps a session to themself (fleet.yaml). */
type FleetMembership = { excluded(w: { id: string; session: string | null; cwd: string }): boolean };

export const CODEX_ACTIVE_MS = 10 * 60 * 1000;

export type ClaudeProc = {
  pid: number; sessionId: string; cwd: string; status: string; name: string; kind: string;
  updated: string | null; statusUpdated: string | null; alive: boolean; file: string;
};

const msIso = (v: unknown) => (typeof v === "number" && v > 0 ? new Date(v).toISOString() : typeof v === "string" ? v : null);

/** Read the Claude Code live-process registry. *.key files are never touched. */
export function readClaudeRegistry(dir = path.join(paths.claudeDir, "sessions")): ClaudeProc[] {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out: ClaudeProc[] = [];
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;
    const file = path.join(dir, n);
    try {
      const d = JSON.parse(fs.readFileSync(file, "utf8"));
      const pid = Number(d.pid ?? n.split(".")[0]);
      if (!pid || !d.sessionId) continue;
      out.push({
        pid, sessionId: String(d.sessionId), cwd: String(d.cwd ?? ""), status: String(d.status ?? "unknown"), name: String(d.name ?? ""), kind: String(d.kind ?? ""),
        updated: msIso(d.updatedAt), statusUpdated: msIso(d.statusUpdatedAt ?? d.updatedAt), alive: pidAlive(pid), file,
      });
    } catch { /* partial write or unreadable: skip */ }
  }
  return out;
}

const REGISTRY_FRESH_MS = 20 * 60e3;
export function staleAware(status: WorkerStatus, updated: string | null | undefined): WorkerStatus {
  if (status !== "working" || !updated) return status;
  return Date.now() - Date.parse(updated) > REGISTRY_FRESH_MS ? "idle" : status;
}
export function registryStatus(s: string): WorkerStatus {
  switch (s) {
    case "busy": case "working": case "running": case "shell": return "working";
    case "idle": case "ready": return "idle";
    case "waiting": case "blocked": case "permission": case "needs_input": case "input": return "blocked";
    default: return "unknown";
  }
}

export type HookState = {
  key: string; agent: "claude" | "codex"; session: string; cwd: string; pane: string | null; socket: string | null;
  first: string; last: string; hint: WorkerStatus | null; hintTs: string; current_action: string; last_message: string; title: string; ended: boolean;
  /** FM_TASK_ID from the session's hook environment: set only in a Firstmate crewmate's pane. */
  fm_task: string | null;
};

function parseMaybeJson(v: unknown): any {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return v;
  try { return JSON.parse(t.replace(/…$/, "")); } catch { return v; }
}

/** "Bash: npm test", "Edit: src/x.ts" ... from a tool.pre payload. */
export function summarizeAction(tool: unknown, input: unknown): string {
  const t = String(tool ?? "").trim() || "tool";
  const i = parseMaybeJson(input);
  let detail = "";
  if (i && typeof i === "object" && !Array.isArray(i)) {
    const o = i as Record<string, any>;
    const cmd = Array.isArray(o.command) ? o.command[o.command.length - 1] : o.command ?? o.cmd;
    detail = String(cmd ?? o.file_path ?? o.path ?? o.notebook_path ?? o.pattern ?? o.url ?? o.query ?? o.description ?? o.prompt ?? "");
    if (!detail) detail = JSON.stringify(o);
  } else if (Array.isArray(i)) detail = String(i[i.length - 1] ?? "");
  else detail = String(i ?? "");
  detail = detail.replace(/\s+/g, " ").trim();
  return truncate(detail ? `${t}: ${detail}` : t, 160);
}

const HOOK_HINTS: Record<string, WorkerStatus> = {
  "session.start": "idle", "prompt.submit": "working", "tool.pre": "working", "permission.request": "blocked",
  "turn.stop": "idle", "turn.stop_failure": "idle", "session.end": "exited",
};

const STATUS_ORDER: Record<string, number> = { blocked: 0, working: 1, idle: 2, done: 3, unknown: 4, exited: 5 };

export class WorkersProjection {
  hooks = new Map<string, HookState>();
  private registryCache: { at: number; list: ClaudeProc[] } | null = null;
  private changeTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private offHerdr: (() => void) | null = null;
  private helmTimer: NodeJS.Timeout | null = null;
  private snapshot: WorkerView[] = [];
  private registryReading = false;

  constructor(private ctx: Ctx, private herdr: HerdrService, private helm: HelmTracker | null = null) {}

  /** Seed hook state and the captain's helm from the indexed event log, so a daemon restart keeps current actions. */
  seed(hours = 12) {
    try {
      const since = new Date(Date.now() - hours * 3600e3).toISOString();
      const rows = this.ctx.db.prepare(`SELECT json FROM events WHERE (source IN ('hook.claude','hook.codex') OR (source = 'live' AND type IN ('steer.attributed', 'helm.released')) OR (source = 'intent' AND type = 'intent.sent'))
        AND ts >= ? ORDER BY ts DESC LIMIT 50000`).all(since) as { json: string }[];
      for (let i = rows.length - 1; i >= 0; i--) {
        try { const e = JSON.parse(rows[i].json); this.applyHook(e); this.helm?.observe(e); } catch {}
      }
    } catch (e: any) { this.ctx.log(`workers: could not seed hook state: ${e.message}`); }
  }

  /** Returns true when the event changed worker-visible state. */
  applyHook(e: EventRecord): boolean {
    if (!e.source?.startsWith("hook.") || !e.session) return false;
    const agent = (e.agent ?? e.source.slice(5)) as string;
    if (agent !== "claude" && agent !== "codex") return false;
    const key = `${agent}:${e.session}`;
    let s = this.hooks.get(key);
    if (!s) {
      s = { key, agent, session: e.session, cwd: e.cwd ?? "", pane: null, socket: null, first: e.ts, last: e.ts, hint: null, hintTs: "", current_action: "", last_message: "", title: "", ended: false, fm_task: null };
      this.hooks.set(key, s);
    }
    const d = e.data ?? {};
    if (e.ts > s.last) s.last = e.ts;
    if (e.cwd) s.cwd = e.cwd;
    if (e.pane) { s.pane = e.pane; s.socket = (d.herdr_socket as string) ?? null; }
    if (typeof d.fm_task === "string" && d.fm_task) s.fm_task = d.fm_task;
    let hint: WorkerStatus | null = HOOK_HINTS[e.type] ?? null;
    switch (e.type) {
      case "session.start": s.ended = false; break;
      case "prompt.submit": s.ended = false; if (!s.title && d.prompt) s.title = truncate(String(d.prompt).replace(/\s+/g, " "), 80); break;
      case "tool.pre": s.current_action = summarizeAction(d.tool, d.input); break;
      case "permission.request": s.current_action = `Waiting for permission: ${summarizeAction(d.tool, d.input)}`; break;
      case "notification":
        if (d.kind === "permission_prompt") hint = "blocked";
        else if (d.kind === "idle_prompt") hint = "idle";
        break;
      case "turn.stop": if (d.last) s.last_message = truncate(String(d.last), 2000); break;
      case "turn.stop_failure": s.last_message = truncate(`Turn failed: ${typeof d.error === "string" ? d.error : JSON.stringify(d.error ?? "")}`, 2000); break;
      case "session.end": s.ended = true; break;
    }
    if (hint && e.ts >= s.hintTs) { s.hint = hint; s.hintTs = e.ts; }
    return true;
  }

  registry(): ClaudeProc[] {
    return this.registryCache?.list ?? [];
  }

  private missionOf(key: string | null): string | null {
    if (!key) return null;
    try {
      const m = this.ctx.services.get("missions");
      const r = m?.missionOfSession?.(key);
      return typeof r === "string" ? r : r?.id ?? null;
    } catch { return null; }
  }

  compute(): WorkerView[] {
    const llm = paths.llmCwd;
    const workers: WorkerView[] = [];
    const meta = new Map<WorkerView, { baseTs: string; herdr: boolean }>();
    const byPane = new Map<string, WorkerView>();
    const bySession = new Map<string, WorkerView>();
    const byPid = new Map<number, WorkerView>();
    const add = (w: WorkerView, baseTs: string, herdr: boolean) => { workers.push(w); meta.set(w, { baseTs, herdr }); if (w.session) bySession.set(w.session, w); };

    // Latest hook session seen in each Herdr pane (hooks inherit HERDR_PANE_ID / HERDR_SOCKET_PATH).
    const paneHook = new Map<string, HookState>();
    for (const s of this.hooks.values()) {
      if (!s.pane) continue;
      const k = `${this.herdr.machineForSocket(s.socket)}|${s.pane}`;
      const cur = paneHook.get(k);
      if (!cur || cur.last < s.last) paneHook.set(k, s);
    }

    // (a) Herdr agent panes
    const connected = new Map(this.herdr.machineStatus().map((m) => [m.label, m.connected]));
    for (const p of this.herdr.allPanes() as MachinePane[]) {
      if (!p.agent) continue;
      const agent = toAgentKind(p.agent) as AgentKind;
      let session = paneSessionKey(p);
      if (!session) {
        const h = paneHook.get(`${p.machine}|${p.pane_id}`);
        if (h && h.agent === agent && !h.ended) session = h.key;
        session ??= launchSessionForPane(this.ctx, p);
      }
      const w: WorkerView = {
        id: `${p.machine}:${p.pane_id}`, machine: p.machine, agent, status: p.agent_status as WorkerStatus, pane: p.pane_id, terminal_id: p.terminal_id, pid: null,
        cwd: p.foreground_cwd ?? p.cwd ?? "", repo: null, session, title: paneTitle(p), current_action: "", last_message: "",
        controllable: Boolean(connected.get(p.machine)), updated: p.status_since, mission: null, crew: null, owner: { tier: "watched", task: null, via: null }, helm: null,
      };
      add(w, p.status_since, true);
      byPane.set(`${p.machine}|${p.pane_id}`, w);
      for (const pid of p.fg_pids ?? []) byPid.set(pid, w);
    }

    // (b) live Claude Code processes
    const local = this.herdr.defaultMachine();
    for (const r of this.registry()) {
      if (!r.alive) continue;
      const key = `claude:${r.sessionId}`;
      let w = bySession.get(key) ?? byPid.get(r.pid);
      if (!w) {
        const h = this.hooks.get(key);
        if (h?.pane) w = byPane.get(`${this.herdr.machineForSocket(h.socket)}|${h.pane}`);
      }
      if (w && (w.agent === "claude")) {
        w.pid = r.pid;
        if (!w.session) { w.session = key; bySession.set(key, w); }
        if (!w.title || w.title === w.pane) w.title = r.name || w.title;
        continue;
      }
      add({
        // A registry entry can say "busy" for days after the process went quiet; trust it only while fresh.
        id: `${local}:pid:${r.pid}`, machine: local, agent: "claude", status: staleAware(registryStatus(r.status), r.statusUpdated ?? r.updated), pane: null, pid: r.pid,
        cwd: r.cwd, repo: null, session: key, title: r.name || path.basename(r.cwd) || `claude ${r.pid}`, current_action: "", last_message: "",
        controllable: false, updated: r.statusUpdated ?? r.updated ?? new Date().toISOString(), mission: null, crew: null, owner: { tier: "watched", task: null, via: null }, helm: null,
      }, r.statusUpdated ?? "", false);
    }

    // (c) Codex sessions active in the last 10 minutes
    const cutoff = new Date(Date.now() - CODEX_ACTIVE_MS).toISOString();
    for (const s of this.hooks.values()) {
      if (s.agent !== "codex" || s.ended || s.last < cutoff || bySession.has(s.key)) continue;
      if (s.pane) {
        const w = byPane.get(`${this.herdr.machineForSocket(s.socket)}|${s.pane}`);
        if (w && w.agent === "codex") { if (!w.session) { w.session = s.key; bySession.set(s.key, w); } continue; }
      }
      add({
        id: `${local}:codex:${s.session}`, machine: local, agent: "codex", status: "unknown", pane: null, pid: null,
        cwd: s.cwd, repo: null, session: s.key, title: s.title || path.basename(s.cwd) || "codex", current_action: "", last_message: "",
        controllable: false, updated: s.last, mission: null, crew: null, owner: { tier: "watched", task: null, via: null }, helm: null,
      }, "", false);
    }

    // Enrich from hooks, filter internal sessions, resolve repo, owner and mission.
    let fm: FirstmateOwners | null = null;
    try { fm = (this.ctx.services.get("firstmate") as FirstmateOwners | undefined) ?? null; } catch {}
    let keys: CrewKey[] = [];
    let control: string | null = null;
    try { keys = fm?.crewKeys() ?? []; control = fm?.controlWorker() ?? null; } catch (e: any) { this.ctx.log(`workers: could not read Firstmate's crew: ${e.message}`); }
    let fleet: FleetMembership | null = null;
    try { fleet = (this.ctx.services.get("fleet") as FleetMembership | undefined) ?? null; } catch {}
    const out: WorkerView[] = [];
    for (const w of workers) {
      if (isUnder(w.cwd, llm)) continue;
      const h = w.session ? this.hooks.get(w.session) : undefined;
      const m = meta.get(w)!;
      if (h) {
        w.current_action = h.current_action;
        w.last_message = h.last_message;
        if (!w.cwd) w.cwd = h.cwd;
        if (isUnder(h.cwd, llm)) continue;
        if (h.hint && !(m.herdr && h.hint === "exited") && (w.status === "unknown" || h.hintTs > m.baseTs)) w.status = h.hint;
        if (h.last > w.updated) w.updated = h.last;
      }
      w.repo = w.cwd ? repoRootOf(w.cwd) : null;
      const o = resolveOwner(w, h?.fm_task, keys, fm?.isControlWorker?.(w) ? w.id : control);
      w.owner = { tier: o.tier, task: o.task, via: o.via };
      // A session the captain started can be kept out of the fleet; crew and Firstmate's pane cannot.
      if (o.tier === "watched") { try { if (fleet?.excluded(w)) w.owner = { tier: "excluded", task: null, via: null }; } catch {} }
      w.crew = o.tier === "crew" ? o.task : null;
      // A crewmate on a mission's task belongs to that mission even when its session is not linked.
      w.mission = this.missionOf(w.session) ?? o.mission;
      // Nobody but the captain steers Firstmate's own pane or a session the captain keeps to themself: no helm.
      w.helm = w.owner.tier === "control" || w.owner.tier === "excluded" ? null : helmFor(this.helm?.markOf(w.id, w.session), w);
      out.push(w);
    }
    this.wakeAtHelmRelease(out);
    out.sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0));
    return out;
  }

  /** A captain's helm runs out with no event to announce it: refresh the projection when the next one does. */
  private wakeAtHelmRelease(list: WorkerView[]) {
    const next = Math.min(...list.map((w) => (w.helm?.until ? Date.parse(w.helm.until) : Infinity)));
    if (this.helmTimer) { clearTimeout(this.helmTimer); this.helmTimer = null; }
    if (!Number.isFinite(next)) return;
    this.helmTimer = setTimeout(() => { this.helmTimer = null; this.changed(); }, Math.max(1000, next - Date.now() + 500));
    this.helmTimer.unref();
  }

  changed() {
    this.cached = null;
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      void this.ctx.service<import("../../core/diagnostics.ts").Diagnostics>("diagnostics").refresh("workers", () => {
        this.snapshot = this.current();
        this.ctx.bus.change({ entity: "workers" });
      }).catch((e) => this.ctx.log(`workers: refresh failed: ${e}`));
    }, 100);
    this.changeTimer.unref();
  }

  private async refreshRegistry() {
    if (this.registryReading) return;
    this.registryReading = true;
    try {
      await this.ctx.service<import("../../core/diagnostics.ts").Diagnostics>("diagnostics").refresh("Claude registry", async () => {
        const dir = path.join(paths.claudeDir, "sessions");
        const names = await fs.promises.readdir(dir).catch(() => []);
        const list: ClaudeProc[] = [];
        for (const name of names) {
          if (!/^\d+\.json$/.test(name)) continue;
          const file = path.join(dir, name);
          try {
            const d = JSON.parse(await fs.promises.readFile(file, "utf8"));
            const pid = Number(d.pid ?? name.split(".")[0]);
            if (!pid || !d.sessionId) continue;
            list.push({ pid, sessionId: String(d.sessionId), cwd: String(d.cwd ?? ""), status: String(d.status ?? "unknown"), name: String(d.name ?? ""), kind: String(d.kind ?? ""), updated: msIso(d.updatedAt), statusUpdated: msIso(d.statusUpdatedAt ?? d.updatedAt), alive: pidAlive(pid), file });
          } catch { /* An unreadable or partial registry record is retried on the next poll. */ }
        }
        this.registryCache = { at: Date.now(), list };
        this.changed();
      });
    } catch (e) { this.ctx.log(`workers: registry refresh failed: ${e}`); }
    finally { this.registryReading = false; }
  }

  start() {
    void this.refreshRegistry();
    this.changed();
    const offH = this.herdr.api().onChange(() => this.changed());
    // Mission links live in the missions module, crew records in the firstmate module and exclusions in
    // fleet.yaml (the fleet module); refresh on any of them.
    const offM = this.ctx.bus.onChange((c) => { if (c.entity === "missions" || c.entity === "tasks" || (c.entity === "fleet" && (c.data as any)?.policy)) this.changed(); });
    this.offHerdr = () => { offH(); offM(); };
    // Registry changes have no event source; poll a cheap fingerprint.
    this.pollTimer = setInterval(() => { void this.refreshRegistry(); this.changed(); }, Number(process.env.JOYRIDE_WORKERS_POLL_MS ?? 5000));
    this.pollTimer.unref();
  }

  stop() {
    this.offHerdr?.();
    this.offHerdr = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.changeTimer) clearTimeout(this.changeTimer);
    if (this.helmTimer) clearTimeout(this.helmTimer);
    this.pollTimer = this.changeTimer = this.helmTimer = null;
  }

  /** compute() with a short TTL: consumers like attention may ask once per event while a backlog drains. */
  private cached: { at: number; list: WorkerView[] } | null = null;
  current(): WorkerView[] {
    const t = Date.now();
    if (this.cached && t - this.cached.at < 250) return this.cached.list;
    const list = this.compute();
    this.cached = { at: t, list };
    return list;
  }

  api() {
    const self = this;
    return {
      list: (): WorkerView[] => self.current(),
      snapshot: (): WorkerView[] => self.snapshot,
      get: (id: string): WorkerView | null => self.current().find((w) => w.id === id) ?? null,
      /** By session key (`claude:<id>`) or raw native id. */
      forSession: (key: string): WorkerView | null => self.current().find((w) => w.session === key || (w.session?.split(":").slice(1).join(":") === key)) ?? null,
      byMission: (id: string): WorkerView[] => self.current().filter((w) => w.mission === id),
      hookState: (key: string): HookState | null => self.hooks.get(key) ?? null,
    };
  }
}
export type WorkersApi = ReturnType<WorkersProjection["api"]>;
