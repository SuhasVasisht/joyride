// The `herdr` service: one HerdrClient per configured machine, a cached pane
// projection, and Joyride events (source "herdr") for status transitions,
// pane lifecycle and focus. Machines come from joyride.config.yaml:
//   machines: [{ label: local }, { label: devvm, herdr_session: devvm }]
// A machine with herdr_session connects to <sessions dir>/<name>/herdr.sock,
// where the sessions dir is JOYRIDE_HERDR_SESSIONS_DIR or the "sessions"
// folder next to paths.herdrSocket (that is Herdr's own layout).
import fs from "node:fs";
import path from "node:path";
import type { Ctx } from "../../core/context.ts";
import { kvGet, kvSet } from "../../core/db.ts";
import { paths } from "../../shared/paths.ts";
import { slugify } from "../../core/util.ts";
import { HerdrClient, HerdrError, normPane, type HerdrStatus, type PaneState } from "./herdr-client.ts";
import type { ReplyBinding } from "../../shared/schema.ts";
import { paneSessionKey, paneTitle, sessionIdFromRef, splitPaneRef, toAgentKind } from "./common.ts";
import { codexHookTrustKeys, pickOption, screenText } from "./screen.ts";
import { ComposerError, attachImages, composerAgents, emptyComposer, keepComposer } from "./composer.ts";
import { canSendImages, noImagesReason } from "../../shared/images.ts";
import { HerdrManager, managementAllowed, resolveHerdrBin, type ManagerStatus, type StartResult } from "./herdr-manager.ts";

export type MachineSpec = { label: string; socket: string | null; session: string | null; ssh: string | null; startHint: string };
export type MachineStatus = {
  label: string; socket: string | null; session: string | null; connected: boolean; state: string; error: string | null;
  version: string | null; panes: number; agents: number; last_connected: string | null; last_event: string | null; status_subscribed: boolean; stale: boolean; last_refresh: string | null;
};
export type MachinePane = PaneState & { machine: string };
/** New panes must own their conversation. Inherited Claude markers disable transcript saving;
 * inherited Codex ids make the session hook reject the new conversation binding. */
export const CLEAN_AGENT_ENV: Record<string, string> = Object.fromEntries([
  "CLAUDECODE", "CLAUDE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_PID", "CLAUDE_CODE_EXECPATH", "JOYRIDE_INTERNAL", "JOYRIDE_GUARD",
  "CODEX_THREAD_ID", "CODEX_SESSION_ID", "FM_TASK_ID", "JOYRIDE_NEW_JOB",
].map((k) => [k, ""]));
export type LaunchOpts = {
  cwd: string; agent: "claude" | "codex" | "cursor"; prompt?: string; label?: string; machine?: string; resume?: string; args?: string[]; promptTimeoutMs?: number;
  /** Extra environment for the pane (on top of the scrubbed conversation markers). */
  env?: Record<string, string>;
  /** Answer Claude's folder-trust dialog automatically: only for folders Joyride itself created or vendored. */
  autoTrust?: boolean;
  /** Stable name for a singleton control agent. Herdr refuses a concurrent owner. */
  agentName?: string;
};
export type LaunchResult = { machine: string; pane_id: string; workspace_id: string; tab_id: string; worker: string; name: string; argv: string[]; created: "workspace" | "tab"; prompt_sent: boolean; warning?: string };

export type HerdrApi = {
  connected(machine?: string): boolean;
  call(method: string, params?: Record<string, unknown>, opts?: { machine?: string; timeoutMs?: number }): Promise<any>;
  /** Cached projection across machines (cheap). */
  snapshot(): { machines: MachineStatus[]; panes: MachinePane[] };
  /** Authoritative re-read (pane.list + agent.list) of one or all machines. */
  refresh(machine?: string): Promise<void>;
  /** Submit text to an agent, after emptying its input box (the result's `cleared` is what was there; `queued` when the agent was working). */
  /** Relay a prompt. With images (checked absolute paths), each is attached before the text goes in.
   * keepDraft: never clear the input box; text there (the captain's draft) refuses the prompt with composer_draft. */
  prompt(paneId: string, text: string, opts?: { machine?: string; images?: string[]; keepDraft?: boolean; binding?: ReplyBinding }): Promise<any>;
  sendKeys(paneId: string, keys: string[] | string, opts?: { machine?: string }): Promise<any>;
  launch(opts: LaunchOpts): Promise<LaunchResult>;
  machines(): MachineStatus[];
  /** managed: this daemon starts `herdr server` itself when the default machine's socket is down. */
  status(): { connected: boolean; any_connected: boolean; managed: boolean; manager: ManagerStatus | null; machines: MachineStatus[] };
  /** Start the default machine's Herdr server now if nothing answers on its socket. */
  startServer(): Promise<StartResult>;
  notify(title: string, body?: string, opts?: { machine?: string; sound?: boolean }): Promise<any>;
  onChange(fn: () => void): () => void;
  /** Machine label for a HERDR_SOCKET_PATH seen in hook events (null/undefined = default machine). */
  machineForSocket(socket: string | null | undefined): string;
  /** Machine label for a Herdr session name ("default" or unset = the default machine); null when no machine uses it. */
  machineForHerdrSession(name: string | null | undefined): string | null;
  defaultMachine(): string;
};

export function herdrSessionsDir() {
  return process.env.JOYRIDE_HERDR_SESSIONS_DIR ?? path.join(path.dirname(paths.herdrSocket), "sessions");
}

export function resolveMachines(config: Ctx["config"]): MachineSpec[] {
  const list = config.machines?.length ? config.machines : [{ label: "local" }];
  let defaultTaken = false;
  return list.map((m: any) => {
    if (m.herdr_session) {
      return { label: m.label, socket: path.join(herdrSessionsDir(), m.herdr_session, "herdr.sock"), session: m.herdr_session, ssh: null, startHint: `herdr --session ${m.herdr_session} server` };
    }
    if (m.herdr_machine) return { label: m.label, socket: null, session: null, ssh: m.herdr_machine, startHint: `herdr --remote ${m.herdr_machine}` };
    if (defaultTaken) return { label: m.label, socket: null, session: null, ssh: null, startHint: "herdr" };
    defaultTaken = true;
    return { label: m.label, socket: paths.herdrSocket, session: null, ssh: null, startHint: "herdr" };
  });
}

/** Turn Herdr error codes into messages that say what happened and what to do. */
export function explainHerdrError(e: any, pane: string, machine: string, socket: string | null): Error {
  const code = e?.code ?? "error";
  const herdrMsg = e?.message ?? String(e);
  let msg: string;
  switch (code) {
    case "agent_blocked": msg = `The agent in pane ${pane} (${machine}) is waiting on a prompt in its terminal (a permission or a question). Answer it in the Herdr pane or the approvals tray, then send your reply again.`; break;
    case "agent_not_ready": msg = `The agent in pane ${pane} (${machine}) can't take input right now: ${herdrMsg}. It may have exited or still be starting; open the pane in Herdr to check.`; break;
    case "pane_not_found": case "agent_not_found": case "not_found": msg = `Pane ${pane} no longer exists in Herdr on ${machine}. Refresh the workers list.`; break;
    case "unavailable": msg = `Herdr on ${machine} is not reachable at ${socket}. Start Herdr and try again.`; break;
    case "timeout": msg = `Herdr on ${machine} did not answer in time: ${herdrMsg} Check that Herdr is responsive, then try again.`; break;
    default: msg = `Herdr on ${machine} refused the request (${code}): ${herdrMsg}`;
  }
  const err = new Error(msg) as Error & { code?: string };
  err.code = code;
  return err;
}

type Baseline = Record<string, { terminal_id: string; agent: string | null; status: HerdrStatus }>;

export class HerdrService {
  clients = new Map<string, HerdrClient>();
  specs: MachineSpec[] = [];
  private listeners = new Set<() => void>();
  private changeTimer: NodeJS.Timeout | null = null;
  private persistTimers = new Map<string, NodeJS.Timeout>();
  manager: HerdrManager | null = null;
  started = false;

  constructor(private ctx: Ctx) {}

  start() {
    if (this.started) return;
    this.started = true;
    this.specs = resolveMachines(this.ctx.config);
    const pollMs = Number(process.env.JOYRIDE_HERDR_POLL_MS ?? 5000);
    const retryMaxMs = Number(process.env.JOYRIDE_HERDR_RETRY_MAX_MS ?? 15000);
    // The default machine's server (the one at paths.herdrSocket) is Joyride's to keep running.
    const local = this.specs.find((s) => s.socket === paths.herdrSocket && !s.session);
    if (local) {
      const allowed = managementAllowed(this.ctx.config.herdr?.manage ?? true);
      this.manager = new HerdrManager({
        machine: local.label, socket: local.socket!, bin: resolveHerdrBin(paths.herdrBin), enabled: allowed.enabled, reason: allowed.reason,
        logFile: path.join(paths.runtime, "herdr-server.log"), stateFile: path.join(paths.runtime, "state", "herdr-server.json"),
        downAfterMs: Number(process.env.JOYRIDE_HERDR_DOWN_AFTER_MS ?? 10_000),
        onStarted: () => {
          // Connect as soon as the new server's socket answers instead of waiting out the retry backoff.
          for (const ms of [400, 1200, 3000, 6000]) setTimeout(() => { const c = this.clients.get(local.label); if (c && !c.connected()) c.reconnectNow(); }, ms).unref();
          this.changed();
        },
      }, { log: (m) => this.ctx.log(m), connected: () => this.clients.get(local.label)?.connected() ?? false });
    }
    for (const spec of this.specs) {
      if (!spec.socket) continue;
      const managed = this.manager?.enabled && spec === local;
      const c = new HerdrClient({
        machine: spec.label, socket: spec.socket, startHint: spec.startHint, pollMs, retryMaxMs, log: (m) => this.ctx.log(m),
        refresh: (fn) => this.ctx.service<import("../../core/diagnostics.ts").Diagnostics>("diagnostics").refresh(`herdr ${spec.label}`, fn),
        unavailableHint: managed ? `Joyride starts it on its own; if it keeps failing, see ${path.join(paths.runtime, "herdr-server.log")}.` : undefined,
      });
      this.wire(c);
      this.clients.set(spec.label, c);
      c.start();
    }
    this.manager?.start();
  }

  stop() {
    this.manager?.stop();
    this.manager = null;
    for (const c of this.clients.values()) { c.stop(); c.removeAllListeners(); }
    this.clients.clear();
    for (const t of this.persistTimers.values()) clearTimeout(t);
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.changeTimer = null;
    this.persistTimers.clear();
    this.started = false;
  }

  private wire(c: HerdrClient) {
    const m = c.machine;
    c.on("hydrated", (panes: PaneState[]) => {
      // Compare against what we last saw (persisted) so restarts don't repeat events
      // and changes that happened while Joyride was down still land in the log.
      const base = kvGet<Baseline>(this.ctx.db, `live:herdr:baseline:${m}`, {});
      const seen = new Set<string>();
      for (const p of panes) {
        seen.add(p.pane_id);
        const b = base[p.pane_id];
        const same = b && b.terminal_id === p.terminal_id;
        if (!same) this.emitPane("pane.created", m, p, { missed: Boolean(Object.keys(base).length) });
        if (!p.agent) {
          if (same && b.agent) this.emitPane("agent.status", m, p, { status: "exited", prev: b.status, agent: b.agent });
          continue;
        }
        if (!same || b.agent !== p.agent) this.emitStatus(m, p, null);
        else if (b.status !== p.agent_status) this.emitStatus(m, p, b.status);
      }
      for (const [id, b] of Object.entries(base)) if (!seen.has(id)) this.emitPane("pane.closed", m, { pane_id: id, terminal_id: b.terminal_id, agent: b.agent } as PaneState, { missed: true });
      this.persist(c);
    });
    c.on("pane-created", (p: PaneState) => { this.emitPane("pane.created", m, p); this.persist(c); });
    c.on("pane-closed", (p: PaneState) => { this.emitPane("pane.closed", m, p); this.persist(c); });
    c.on("status", (p: PaneState, prev: HerdrStatus | null) => { this.emitStatus(m, p, prev); this.persist(c); });
    c.on("agent-exited", (p: PaneState, prevAgent: string, prevStatus: HerdrStatus) => {
      this.emitPane("agent.status", m, { ...p, agent: prevAgent }, { status: "exited", prev: prevStatus });
      this.persist(c);
    });
    c.on("focus", (p: PaneState) => this.emitPane("pane.focused", m, p));
    c.on("connection", () => this.changed());
    c.on("changed", () => this.changed());
  }

  private emitStatus(machine: string, p: PaneState, prev: HerdrStatus | null) {
    this.emitPane("agent.status", machine, p, { status: p.agent_status, prev });
  }

  private emitPane(type: string, machine: string, p: PaneState, extra: Record<string, unknown> = {}) {
    try {
      const agent = (extra.agent as string | undefined) ?? p.agent ?? null;
      this.ctx.emit({
        source: "herdr", type, pane: p.pane_id,
        agent: toAgentKind(agent) ?? undefined,
        session: sessionIdFromRef(p.agent_session) ?? undefined,
        cwd: p.foreground_cwd ?? p.cwd ?? undefined,
        data: {
          machine, worker: `${machine}:${p.pane_id}`, workspace_id: p.workspace_id ?? null, tab_id: p.tab_id ?? null,
          agent, session_ref: p.agent_session ? paneSessionKey(p) : null, title: p.agent ? paneTitle(p) : (p.title ?? null),
          ...extra,
        },
      });
    } catch (e: any) { this.ctx.log(`herdr: could not append ${type} event: ${e.message}`); }
  }

  private persist(c: HerdrClient) {
    if (this.persistTimers.has(c.machine)) return;
    const t = setTimeout(() => {
      this.persistTimers.delete(c.machine);
      const base: Baseline = {};
      for (const p of c.panes.values()) base[p.pane_id] = { terminal_id: p.terminal_id, agent: p.agent, status: p.agent_status };
      try { kvSet(this.ctx.db, `live:herdr:baseline:${c.machine}`, base); } catch { /* db closed during shutdown */ }
    }, 200);
    t.unref();
    this.persistTimers.set(c.machine, t);
  }

  private changed() {
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      for (const fn of this.listeners) { try { fn(); } catch {} }
    }, 50);
    this.changeTimer.unref();
  }

  client(machine?: string): HerdrClient {
    const label = machine ?? this.defaultMachine();
    const c = this.clients.get(label);
    if (c) return c;
    const spec = this.specs.find((s) => s.label === label);
    if (spec?.ssh) throw new Error(`Machine ${label} is a saved SSH machine (${spec.ssh}); Joyride connects to Herdr sessions by socket only. Add it with herdr_session on a forwarded socket, or run Joyride on that machine.`);
    if (spec) throw new Error(`Machine ${label} has no Herdr socket configured. Give it a herdr_session in joyride.config.yaml.`);
    throw new Error(`Unknown machine "${label}". Known machines: ${this.specs.map((s) => s.label).join(", ") || "none"}.`);
  }

  defaultMachine() { return this.specs.find((s) => s.socket)?.label ?? this.specs[0]?.label ?? "local"; }

  machineStatus(): MachineStatus[] {
    return this.specs.map((s) => {
      const c = this.clients.get(s.label);
      if (!c) return {
        label: s.label, socket: s.socket, session: s.session, connected: false, state: "unsupported",
        error: s.ssh ? `Saved SSH machine ${s.ssh} is not supported yet; use a named Herdr session (herdr_session) instead.` : "No Herdr socket configured for this machine.",
        version: null, panes: 0, agents: 0, last_connected: null, last_event: null, status_subscribed: false, stale: true, last_refresh: null,
      };
      const panes = [...c.panes.values()];
      return {
        label: s.label, socket: s.socket, session: s.session, connected: c.connected(), state: c.state, error: c.error, version: c.version,
        panes: panes.length, agents: panes.filter((p) => p.agent).length, last_connected: c.lastConnected, last_event: c.lastEvent, status_subscribed: c.statusSubscribed(), stale: !c.connected() || Boolean(c.error), last_refresh: c.lastRefresh,
      };
    });
  }

  allPanes(): MachinePane[] {
    const out: MachinePane[] = [];
    for (const c of this.clients.values()) for (const p of c.panes.values()) out.push({ ...p, machine: c.machine });
    return out;
  }

  private resolvePane(paneId: string, machine?: string) {
    const { machine: m, pane } = splitPaneRef(paneId, [...this.clients.keys()]);
    const label = machine ?? m ?? this.defaultMachine();
    return { client: this.client(label), pane, machine: label };
  }

  async launch(o: LaunchOpts): Promise<LaunchResult> {
    if (o.agent !== "claude" && o.agent !== "codex" && o.agent !== "cursor") throw new Error(`Agent must be "claude", "codex" or "cursor", not "${o.agent}".`);
    if (!o.cwd || !path.isAbsolute(o.cwd)) throw new Error("Launching a session needs an absolute folder path (cwd).");
    if (!fs.existsSync(o.cwd)) throw new Error(`Folder ${o.cwd} does not exist. Pick an existing folder and try again.`);
    if (o.agentName && !/^[a-z][a-z0-9_-]{0,31}$/.test(o.agentName)) throw new Error("Agent names need a lowercase letter followed by up to 31 letters, digits, underscores or hyphens.");
    const c = this.client(o.machine);
    if (!c.connected()) throw new Error(`Herdr on ${c.machine} is not connected (${c.error ?? "connecting"}). Start Herdr, then launch again.`);
    const label = o.label?.trim() || path.basename(o.cwd);
    const wrap = (e: any, pane: string) => (e instanceof HerdrError ? explainHerdrError(e, pane, c.machine, c.socket) : e);

    // Reuse a workspace already rooted at this folder; otherwise open a new one.
    const existing = [...c.panes.values()].find((p) => p.cwd === o.cwd || p.foreground_cwd === o.cwd);
    let created: "workspace" | "tab";
    let root: any;
    try {
      if (existing) {
        const r = await c.call("tab.create", { workspace_id: existing.workspace_id, cwd: o.cwd, label, focus: false, env: { ...CLEAN_AGENT_ENV, ...(o.env ?? {}) } }, 10000);
        root = r.root_pane; created = "tab";
      } else {
        const r = await c.call("workspace.create", { cwd: o.cwd, label, focus: false, env: { ...CLEAN_AGENT_ENV, ...(o.env ?? {}) } }, 10000);
        root = r.root_pane; created = "workspace";
      }
    } catch (e) { throw wrap(e, "(new)"); }
    const paneId: string = root.pane_id;
    // Herdr agent names: lowercase letter first, [a-z0-9_-], at most 32 characters.
    let base = slugify(label, 18).replace(/[^a-z0-9_-]/g, "-");
    if (!/^[a-z]/.test(base)) base = `j-${base}`.slice(0, 18);
    const name = o.agentName ?? `${base}-${o.agent.slice(0, 6)}-${Math.random().toString(36).slice(2, 6)}`.slice(0, 32);
    const args = [...(o.resume ? (o.agent === "codex" ? ["resume", o.resume] : ["--resume", o.resume]) : []), ...(o.args ?? [])];
    let started: any;
    // A freshly created pane needs a moment before its shell prompt is ready; Herdr answers
    // agent_pane_busy until then, so retry briefly instead of failing the launch.
    for (let attempt = 0; ; attempt++) {
      try { started = await c.call("agent.start", { name, kind: o.agent, pane_id: paneId, args, timeout_ms: 30000 }, 40000); break; }
      catch (e: any) {
        const code = e?.code ?? e?.error?.code ?? (String(e?.message ?? "").match(/agent_pane_busy/) ? "agent_pane_busy" : "");
        if (code === "agent_pane_busy" && attempt < 30) { await new Promise((r) => setTimeout(r, 500)); continue; }
        // This pane was created by this launch. A failed start must not leave a retry orphan.
        try { await c.call("pane.close", { pane_id: paneId }); }
        catch (cleanupError) { throw new Error(`${String(wrap(e, paneId))}. The failed launch pane ${c.machine}:${paneId} could not be closed: ${String(cleanupError)}. Close it before retrying.`); }
        throw wrap(e, paneId);
      }
    }

    if (o.autoTrust) {
      // Joyride owns this folder. Clear its folder or Codex hook trust dialog so
      // the recovery prompt can reach the agent without a first-run interruption.
      const until = Date.now() + 20000;
      let prev = "", stable = 0;
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, 700));
        let scr = "";
        try { scr = screenText(await c.call("pane.read", { pane_id: paneId, source: "visible", lines: 60, strip_ansi: true })); } catch { continue; }
        const hooks = o.agent === "codex" ? codexHookTrustKeys(scr) : null;
        if (hooks) { await c.call("pane.send_keys", { pane_id: paneId, keys: hooks }); continue; }
        if (/trust (this folder|the files)|project you created or one you trust/i.test(scr)) {
          const opt = pickOption(scr, "allow");
          if (opt) { try { await c.call("agent.send_keys", { target: paneId, keys: opt.keys }); } catch { await c.call("pane.send_keys", { pane_id: paneId, keys: opt.keys }).catch(() => {}); } }
          break;
        }
        if (/❯\s*$|Try "|accept edits|auto mode|bypass permissions/m.test(scr) || (o.agent === "codex" && /OpenAI Codex/.test(scr) && /^\s*›/m.test(scr))) break;
        stable = scr.trim() && scr === prev ? stable + 1 : 0;
        if (stable >= 2 && o.agent !== "codex") break;
        prev = scr;
      }
    }

    let promptSent = false;
    let warning: string | undefined;
    if (o.prompt?.trim()) {
      const deadline = Date.now() + (o.promptTimeoutMs ?? 45000);
      let lastErr: any = null;
      while (Date.now() < deadline) {
        try {
          const a = (await c.call("agent.get", { target: paneId }, 5000))?.agent;
          if (a && !a.launch_pending && a.interactive_ready !== false) {
            await c.call("agent.prompt", { target: paneId, text: o.prompt });
            promptSent = true;
            break;
          }
        } catch (e: any) {
          lastErr = e;
          if (e?.code && !["agent_not_ready", "agent_not_found", "timeout"].includes(e.code)) break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!promptSent) warning = `The agent started, but the first prompt was not delivered${lastErr ? ` (${lastErr.message})` : ""}. Reply to worker ${c.machine}:${paneId} once it is ready.`;
    }
    c.scheduleReconcile(50);
    return {
      machine: c.machine, pane_id: paneId, workspace_id: root.workspace_id, tab_id: root.tab_id, worker: `${c.machine}:${paneId}`, name,
      argv: started?.argv ?? [o.agent, ...args], created, prompt_sent: promptSent, ...(warning ? { warning } : {}),
    };
  }

  /**
   * Empty a supported agent input box before a prompt: agent.prompt pastes at the input's
   * cursor, so leftover text (an old prompt an arrow key recalled, a draft) would go out merged
   * with the reply. Returns the text it cleared. A blocked agent is left to agent.prompt, which
   * refuses it before sending anything. A working agent's box is checked but never cleared.
   */
  private async emptyInput(c: HerdrClient, pane: string, machine: string, keepDraft = false): Promise<{ cleared: string | null; working: boolean }> {
    let agent: any;
    const where = `pane ${pane} (${machine})`;
    try { agent = (await c.call("agent.get", { target: pane }, 5000))?.agent; } catch {
      if (keepDraft) throw new ComposerError(`Joyride can't tell what the agent in ${where} is doing, so it can't check its input box for a draft. Nothing was sent.`, "composer_not_found");
      return { cleared: null, working: false };
    }
    const working = agent?.agent_status === "working";
    if (keepDraft && (!agent || !composerAgents.has(agent.agent))) throw new ComposerError(`Joyride can't read the input box of the agent in ${where}, so it can't tell whether someone is typing there. Nothing was sent.`, "composer_not_found");
    if (!agent || !composerAgents.has(agent.agent) || agent.agent_status === "blocked") return { cleared: null, working };
    if (keepDraft) { await keepComposer({ agent: agent.agent, where, ...this.composerIo(c, pane) }); return { cleared: null, working }; }
    return { cleared: await emptyComposer({ agent: agent.agent, where, busy: working, ...this.composerIo(c, pane) }), working };
  }

  private composerIo(c: HerdrClient, pane: string) {
    return {
      read: async () => { const r = await c.call("pane.read", { pane_id: pane, source: "visible", format: "ansi", strip_ansi: false }, 3000); return String(r?.read?.text ?? r?.text ?? ""); },
      send: (keys: string[]) => c.call("pane.send_keys", { pane_id: pane, keys }),
    };
  }

  /**
   * A prompt with images: empty the input box, paste each image path on its own and wait for the
   * agent's "[Image #N]" attachment, then paste the text and submit (Enter alone when there is no
   * text). Agents that don't load images from paths are refused before anything is typed.
   */
  private async promptWithImages(c: HerdrClient, pane: string, machine: string, text: string, images: string[]) {
    const agent = (await c.call("agent.get", { target: pane }, 5000))?.agent;
    const where = `pane ${pane} (${machine})`;
    if (!canSendImages(agent?.agent)) throw new ComposerError(noImagesReason(agent?.agent, `The agent in ${where}`), "images_unsupported");
    if (agent.agent_status === "blocked") throw Object.assign(new Error("agent is blocked"), { code: "agent_blocked" });
    const io = this.composerIo(c, pane);
    const cleared = await emptyComposer({ agent: agent.agent, where, busy: agent.agent_status === "working", ...io });
    await attachImages({ agent: agent.agent, where, paths: images, ...io, paste: (t) => c.call("pane.send_text", { pane_id: pane, text: t }) });
    const r = text.trim() ? await c.call("agent.prompt", { target: pane, text }) : await c.call("pane.send_keys", { pane_id: pane, keys: ["enter"] });
    return { ...r, images: images.length, ...(cleared ? { cleared } : {}), ...(agent.agent_status === "working" ? { queued: true } : {}) };
  }

  /** Machine label for a Herdr session name (Firstmate's meta `herdr_session`): "default" is the default machine. */
  machineForHerdrSession(name: string | null | undefined): string | null {
    if (!name || name === "default") return this.defaultMachine();
    return this.specs.find((s) => s.session === name)?.label ?? null;
  }

  machineForSocket(socket: string | null | undefined): string {
    if (!socket) return this.defaultMachine();
    const want = path.resolve(socket);
    return this.specs.find((s) => s.socket && path.resolve(s.socket) === want)?.label ?? this.defaultMachine();
  }

  private _api: HerdrApi | null = null;
  api(): HerdrApi {
    if (this._api) return this._api;
    const self = this;
    return (this._api = {
      connected: (machine) => { try { return self.client(machine).connected(); } catch { return false; } },
      call: (method, params = {}, opts = {}) => self.client(opts.machine).call(method, params, opts.timeoutMs),
      snapshot: () => ({ machines: self.machineStatus(), panes: self.allPanes() }),
      refresh: async (machine) => { await Promise.all((machine ? [self.client(machine)] : [...self.clients.values()]).filter((c) => c.connected()).map((c) => c.reconcile())); },
      prompt: async (paneId, text, opts = {}) => {
        const { client, pane, machine } = self.resolvePane(paneId, opts.machine);
        try {
          if (opts.binding) {
            const current = normPane((await client.call("agent.get", { target: pane }, 5000))?.agent ?? {});
            const nativeSession = paneSessionKey(current);
            if (!current.agent || opts.binding.terminal_id && current.terminal_id !== opts.binding.terminal_id
              || nativeSession && nativeSession !== opts.binding.session) {
              throw new HerdrError("connection_changed", "This chat's connection changed. Nothing was sent. Reopen the active conversation from the map before sending.");
            }
          }
          if (opts.images?.length) {
            if (opts.keepDraft) throw new ComposerError("Images go in through the input box, which Joyride would have to clear first, so a steer that must keep the captain's draft carries text only.", "images_unsupported");
            return await self.promptWithImages(client, pane, machine, text, opts.images);
          }
          const { cleared, working } = await self.emptyInput(client, pane, machine, opts.keepDraft);
          const r = await client.call("agent.prompt", { target: pane, text });
          // Sent while the agent works: it holds the text in its queue until the turn ends.
          return { ...r, ...(cleared ? { cleared } : {}), ...(working ? { queued: true } : {}) };
        } catch (e) { throw e instanceof ComposerError ? e : explainHerdrError(e, pane, machine, client.socket); }
        finally { client.scheduleReconcile(100); }
      },
      sendKeys: async (paneId, keys, opts = {}) => {
        const { client, pane, machine } = self.resolvePane(paneId, opts.machine);
        const list = Array.isArray(keys) ? keys : [keys];
        try { return await client.call("agent.send_keys", { target: pane, keys: list }); }
        catch (e: any) {
          if (e?.code === "agent_not_ready" || e?.code === "agent_not_found") {
            try { return await client.call("pane.send_keys", { pane_id: pane, keys: list }); } catch (e2) { throw explainHerdrError(e2, pane, machine, client.socket); }
          }
          throw explainHerdrError(e, pane, machine, client.socket);
        } finally { client.scheduleReconcile(100); }
      },
      launch: (o) => self.launch(o),
      machines: () => self.machineStatus(),
      status: () => {
        const machines = self.machineStatus();
        const def = self.defaultMachine();
        const manager = self.manager?.status() ?? null;
        return { connected: machines.find((m) => m.label === def)?.connected ?? false, any_connected: machines.some((m) => m.connected), managed: Boolean(manager?.enabled), manager, machines };
      },
      startServer: async () => {
        if (!self.manager) return { ok: false, started: false, already_running: false, pid: null, message: "No local Herdr machine is configured, so there is no server for Joyride to start." };
        const r = await self.manager.startNow();
        self.changed();
        return r;
      },
      notify: (title, body, opts = {}) => self.client(opts.machine).call("notification.show", { title, body: body ?? null, sound: opts.sound ? "request" : "none" }),
      onChange: (fn) => { self.listeners.add(fn); return () => self.listeners.delete(fn); },
      machineForSocket: (socket) => self.machineForSocket(socket),
      machineForHerdrSession: (name) => self.machineForHerdrSession(name),
      defaultMachine: () => self.defaultMachine(),
    });
  }
}
