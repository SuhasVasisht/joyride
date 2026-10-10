// In-process fake Herdr server: NDJSON over a unix socket, one request per
// connection (like the real one), events.subscribe keeps the connection open
// and receives pushes. Shapes follow `herdr api schema --json` (protocol 22).
//
//   const fake = await startFakeHerdr(socketPath, { scenario: "default" });
//   fake.setStatus("w1:p1", "blocked");   // pushes pane.agent_status_changed
//   fake.prompts                          // [{ target, text, ts }]
//   await fake.stop();
//
// Out-of-process tests (Playwright) can drive the same fake through
// `fake.*` socket methods; see fakeHerdrControl() below.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFileSync } from "node:child_process";

export type FakeStatus = "idle" | "working" | "blocked" | "done" | "unknown";
export type FakePane = {
  pane_id: string; terminal_id: string; workspace_id: string; tab_id: string; focused: boolean;
  cwd: string; foreground_cwd: string; label: string | null; title: string | null;
  agent: string | null; name: string | null; agent_status: FakeStatus;
  agent_session: { source: string; agent: string; kind: "id" | "path"; value: string } | null;
  pids: number[]; revision: number; screen: string[];
  /** A terminal prompt drawn under the screen (a Claude Code permission menu); send_keys answers and clears it. */
  menu: string[] | null;
  /**
   * What sits in the pane's input box (typed with pane.send_text / send_keys, or set with fake.set_screen).
   * agent.prompt pastes at the end of it and submits the whole box, like the real Claude Code and Codex
   * inputs, so leftover text merges with a prompt unless Joyride empties the box first.
   */
  input: string;
  /** The input box ignores editing keys (to test a box Joyride can't clear). */
  inputLocked?: boolean;
  /**
   * Images attached in the input box. Like the real Claude Code and Codex, a bracketed paste of
   * nothing but an existing image file's path (quoted or not) becomes an "[Image #N] " attachment.
   */
  attached?: string[];
  /** The agent leaves pasted image paths as text (to test an agent that doesn't take an image). */
  noImages?: boolean;
  /** Styled screen lines for pane.read format "ansi" (default: the screen with simple colouring). */
  ansi: string[] | null;
  /** Terminal size reported by pane.layout. */
  cols: number; rows: number;
};
type Workspace = { workspace_id: string; label: string; number: number };
type Tab = { tab_id: string; workspace_id: string; label: string; number: number };

/**
 * Repos the default scenario's panes live in (created as empty git repos if missing).
 * They match the transcript fixtures in tests/fixtures/claude and tests/fixtures/codex.
 */
export const FIXTURE_REPOS = {
  alpha: "/tmp/joyride-fixture-repos/alpha",
  beta: "/tmp/joyride-fixture-repos/beta",
} as const;

/**
 * Stable native session ids of the default scenario's agents (session keys are `${agent}:${id}`).
 * They are the ids of fixture transcripts, so panes link to sessions and missions:
 *   claude 11111111-… (alpha, "Add a CSV export button"), claude 22222222-… (alpha, flaky export test),
 *   codex 019a0000-…-0002 (beta, "Make the sync job idempotent").
 */
export const FAKE_SESSIONS = {
  claudeWorking: "11111111-1111-4111-8111-111111111111",
  claudeBlocked: "22222222-2222-4222-8222-222222222222",
  codexIdle: "019a0000-0000-7000-8000-000000000002",
} as const;

/**
 * The Claude Code permission menu the blocked pane (w1:p2) shows: a Bash command
 * box with three numbered options. pane.read returns it under the screen;
 * pane.send_keys answers it (unblocks the agent and clears the menu).
 */
export const CLAUDE_PERMISSION_MENU = [
  "╭──────────────────────────────────────────────────────────────────────────────╮",
  "│ Bash command                                                                 │",
  "│                                                                              │",
  "│   npm run test:export -- --runInBand                                         │",
  "│   Run the export tests serially to catch the flaky totals row                │",
  "│                                                                              │",
  "│ Do you want to proceed?                                                      │",
  "│ ❯ 1. Yes                                                                     │",
  "│   2. Yes, and don't ask again for npm run test:export commands in alpha      │",
  "│   3. No, and tell Claude what to do differently (esc)                        │",
  "╰──────────────────────────────────────────────────────────────────────────────╯",
];

/** Pane ids of the default scenario. */
export const FAKE_PANES = { claudeWorking: "w1:p1", claudeBlocked: "w1:p2", codexIdle: "w2:p1", shell: "w2:p2" } as const;

export type FakeHerdrOpts = { scenario?: string; promptFlipMs?: number; version?: string };

type Sub = { conn: net.Socket; id: string; lifecycle: Set<string>; status: Map<string, string | null> };

export type FakeHerdr = {
  socketPath: string;
  panes: Map<string, FakePane>;
  prompts: { target: string; text: string; ts: string; images?: string[] }[];
  keys: { target: string; keys: string[]; ts: string }[];
  /** Raw terminal input in order: pane.send_text / pane.send_input text and pane.send_keys / send_input keys. */
  inputs: { target: string; text?: string; keys?: string[]; ts: string }[];
  /** Lines submitted at a pane's input line with Enter (typed through the terminal, not agent.prompt). */
  typed: { target: string; text: string; ts: string; images?: string[] }[];
  notifications: { title: string; body: string | null }[];
  calls: { method: string; params: any }[];
  /** Change an agent's status; pushes pane.agent_status_changed unless push=false (silent drift for reconcile tests). */
  setStatus(paneId: string, status: FakeStatus, opts?: { push?: boolean }): void;
  addPane(p: Partial<FakePane> & { workspace_id?: string }, opts?: { push?: boolean }): FakePane;
  closePane(paneId: string, opts?: { push?: boolean }): void;
  focusPane(paneId: string): void;
  /** Push a raw lifecycle event to subscribers, e.g. push("pane_updated", { pane }). */
  push(event: string, data: Record<string, unknown>): void;
  /** Send events_lost to every subscriber and close them (like an overrun). */
  eventsLost(): void;
  /** Make the next call of `method` fail with this error. */
  failNext(method: string, code: string, message?: string): void;
  /** Apply the next request, but delay its reply. */
  delayNextReply(method: string, ms: number): void;
  /** Apply the next request, then lose its reply by closing the connection. */
  dropNextReply(method: string): void;
  subscriberCount(): number;
  stop(): Promise<void>;
  /** Listen again on the same socket with the same state (after stop()). */
  restart(): Promise<void>;
};

function ensureRepo(dir: string) {
  try {
    if (fs.existsSync(path.join(dir, ".git"))) return;
    fs.mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "ignore" });
  } catch { /* best effort: another process may be creating it */ }
}

export async function startFakeHerdr(socketPath: string, opts: FakeHerdrOpts = {}): Promise<FakeHerdr> {
  const scenario = opts.scenario ?? "default";
  const flipMs = opts.promptFlipMs ?? 300;
  const responseDelays = new Map<string, number>();
  const workspaces = new Map<string, Workspace>();
  const tabs = new Map<string, Tab>();
  const panes = new Map<string, FakePane>();
  const subs = new Set<Sub>();
  const failures = new Map<string, { code: string; message: string }>();
  const replies = new Map<string, { kind: "delay"; ms: number } | { kind: "drop" }>();
  let term = 0;
  let focused: string | null = null;

  const wsNum = () => workspaces.size + 1;
  function addWorkspace(label: string, id?: string): Workspace {
    const n = id ? Number(id.slice(1)) : Math.max(0, ...[...workspaces.keys()].map((k) => Number(k.slice(1)))) + 1;
    const w = { workspace_id: id ?? `w${n}`, label, number: wsNum() };
    workspaces.set(w.workspace_id, w);
    return w;
  }
  function addTab(workspace_id: string, label: string): Tab {
    const n = [...tabs.values()].filter((t) => t.workspace_id === workspace_id).length + 1;
    const t = { tab_id: `${workspace_id}:t${n}`, workspace_id, label, number: n };
    tabs.set(t.tab_id, t);
    return t;
  }
  function makePane(p: Partial<FakePane> & { workspace_id: string; tab_id?: string }): FakePane {
    const n = Math.max(0, ...[...panes.keys()].filter((k) => k.startsWith(p.workspace_id + ":")).map((k) => Number(k.split(":p")[1]))) + 1;
    const tab_id = p.tab_id ?? [...tabs.values()].find((t) => t.workspace_id === p.workspace_id)?.tab_id ?? addTab(p.workspace_id, "1").tab_id;
    const cwd = p.cwd ?? "/tmp";
    const pane: FakePane = {
      pane_id: p.pane_id ?? `${p.workspace_id}:p${n}`, terminal_id: p.terminal_id ?? `term_fake_${++term}`, workspace_id: p.workspace_id, tab_id,
      focused: false, cwd, foreground_cwd: p.foreground_cwd ?? cwd, label: p.label ?? null, title: p.title ?? null,
      agent: p.agent ?? null, name: p.name ?? null, agent_status: p.agent_status ?? (p.agent ? "idle" : "unknown"),
      agent_session: p.agent_session ?? null, pids: p.pids ?? [], revision: 0, screen: p.screen ?? [], menu: p.menu ?? null,
      input: p.input ?? "", ansi: p.ansi ?? null, cols: p.cols ?? 100, rows: p.rows ?? 30,
    };
    panes.set(pane.pane_id, pane);
    return pane;
  }

  // ---------- scenarios ----------
  if (scenario === "default") {
    ensureRepo(FIXTURE_REPOS.alpha);
    ensureRepo(FIXTURE_REPOS.beta);
    const w1 = addWorkspace("alpha", "w1");
    const t1 = addTab(w1.workspace_id, "agents");
    makePane({ workspace_id: "w1", tab_id: t1.tab_id, pane_id: "w1:p1", cwd: FIXTURE_REPOS.alpha, agent: "claude", agent_status: "working", title: "CSV export with totals",
      agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: FAKE_SESSIONS.claudeWorking }, screen: ["● Running tests…"] });
    makePane({ workspace_id: "w1", tab_id: t1.tab_id, pane_id: "w1:p2", cwd: FIXTURE_REPOS.alpha, agent: "claude", agent_status: "blocked", title: "Flaky export test",
      agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: FAKE_SESSIONS.claudeBlocked },
      screen: ["> Fix the flaky export test", "", "● The totals row test fails about one run in five. I'll run the export tests serially to see the order dependency.", ""],
      menu: [...CLAUDE_PERMISSION_MENU] });
    const w2 = addWorkspace("beta", "w2");
    const t2 = addTab(w2.workspace_id, "agents");
    makePane({ workspace_id: "w2", tab_id: t2.tab_id, pane_id: "w2:p1", cwd: FIXTURE_REPOS.beta, agent: "codex", agent_status: "idle", title: "Idempotent sync job",
      agent_session: { source: "herdr:codex", agent: "codex", kind: "id", value: FAKE_SESSIONS.codexIdle }, screen: ["› Make the sync job idempotent"] });
    makePane({ workspace_id: "w2", tab_id: t2.tab_id, pane_id: "w2:p2", cwd: FIXTURE_REPOS.beta, screen: ["$ "] });
    focused = "w1:p1";
    panes.get("w1:p1")!.focused = true;
  } else if (scenario !== "empty") {
    throw new Error(`fake-herdr: unknown scenario ${scenario} (use "default" or "empty")`);
  }

  // ---------- wire shapes ----------
  const paneInfo = (p: FakePane) => {
    const o: Record<string, unknown> = {
      pane_id: p.pane_id, terminal_id: p.terminal_id, workspace_id: p.workspace_id, tab_id: p.tab_id, focused: p.pane_id === focused,
      cwd: p.cwd, foreground_cwd: p.foreground_cwd, agent_status: p.agent_status, revision: p.revision,
      scroll: { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 40 },
    };
    if (p.agent) o.agent = p.agent;
    if (p.agent_session) o.agent_session = p.agent_session;
    if (p.label) o.label = p.label;
    if (p.title) o.title = p.title;
    return o;
  };
  const agentInfo = (p: FakePane) => ({ ...paneInfo(p), name: p.name ?? undefined, interactive_ready: true, launch_pending: false, state_change_seq: 0 });
  const tabStatus = (ids: string[]): FakeStatus => {
    const st = ids.map((id) => panes.get(id)?.agent_status).filter(Boolean);
    return st.includes("blocked") ? "blocked" : st.includes("working") ? "working" : st.includes("idle") ? "idle" : "unknown";
  };
  const tabInfo = (t: Tab) => {
    const ids = [...panes.values()].filter((p) => p.tab_id === t.tab_id).map((p) => p.pane_id);
    return { tab_id: t.tab_id, workspace_id: t.workspace_id, number: t.number, label: t.label, focused: Boolean(focused && panes.get(focused)?.tab_id === t.tab_id), pane_count: ids.length, agent_status: tabStatus(ids) };
  };
  const wsInfo = (w: Workspace) => {
    const ps = [...panes.values()].filter((p) => p.workspace_id === w.workspace_id);
    const ts = [...tabs.values()].filter((t) => t.workspace_id === w.workspace_id);
    return { workspace_id: w.workspace_id, number: w.number, label: w.label, focused: Boolean(focused && panes.get(focused)?.workspace_id === w.workspace_id),
      pane_count: ps.length, tab_count: ts.length, active_tab_id: ts[0]?.tab_id ?? "", agent_status: tabStatus(ps.map((p) => p.pane_id)) };
  };
  const errorOf = (code: string, message: string) => ({ code, message });

  // ---------- pushes ----------
  function pushLifecycle(event: string, data: Record<string, unknown>) {
    const subType = event.replace("_", "."); // pane_agent_detected -> pane.agent_detected
    for (const s of subs) if (s.lifecycle.has(subType)) s.conn.write(JSON.stringify({ data: { type: event, ...data }, event }) + "\n");
  }
  function pushStatus(p: FakePane) {
    for (const s of subs) {
      if (!s.status.has(p.pane_id)) continue;
      const want = s.status.get(p.pane_id);
      if (want && want !== p.agent_status) continue;
      s.conn.write(JSON.stringify({ data: { agent: p.agent, agent_status: p.agent_status, pane_id: p.pane_id, workspace_id: p.workspace_id, ...(p.title ? { title: p.title } : {}) }, event: "pane.agent_status_changed" }) + "\n");
    }
  }
  function setStatus(paneId: string, status: FakeStatus, o: { push?: boolean } = {}) {
    const p = panes.get(paneId);
    if (!p) throw new Error(`fake-herdr: no pane ${paneId}`);
    if (p.agent_status === status) return;
    p.agent_status = status;
    p.revision++;
    if (o.push !== false) pushStatus(p);
  }
  function addPane(p: Partial<FakePane> & { workspace_id?: string }, o: { push?: boolean } = {}) {
    const wsId = p.workspace_id ?? addWorkspace(p.label ?? path.basename(p.cwd ?? "/tmp")).workspace_id;
    if (!workspaces.has(wsId)) addWorkspace(p.label ?? wsId, wsId);
    const pane = makePane({ ...p, workspace_id: wsId });
    if (o.push !== false) pushLifecycle("pane_created", { pane: paneInfo(pane) });
    if (pane.agent && o.push !== false) pushLifecycle("pane_agent_detected", { agent: pane.agent, pane_id: pane.pane_id, workspace_id: pane.workspace_id });
    return pane;
  }
  function closePane(paneId: string, o: { push?: boolean } = {}) {
    const p = panes.get(paneId);
    if (!p) return;
    panes.delete(paneId);
    if (focused === paneId) focused = null;
    for (const s of subs) s.status.delete(paneId);
    if (o.push !== false) pushLifecycle("pane_closed", { pane_id: paneId, workspace_id: p.workspace_id });
  }
  function focusPane(paneId: string) {
    if (focused === paneId) return;
    focused = paneId;
    const p = panes.get(paneId);
    pushLifecycle("pane_focused", { pane_id: paneId, workspace_id: p?.workspace_id ?? "" });
  }
  function startAgent(p: FakePane, kind: string, name: string | null, args: string[]) {
    p.agent = kind;
    p.name = name;
    p.agent_status = "idle";
    const resumeIdx = args.findIndex((a) => a === "--resume" || a === "resume");
    const fixedIdx = args.indexOf("--session-id");
    const sid = resumeIdx >= 0 && args[resumeIdx + 1] ? args[resumeIdx + 1] : fixedIdx >= 0 && args[fixedIdx + 1] ? args[fixedIdx + 1] : `fake-${kind}-${p.pane_id.replace(":", "-")}-${p.terminal_id.slice(-3)}`;
    p.agent_session = { source: `herdr:${kind}`, agent: kind, kind: "id", value: sid };
    p.screen.push(`$ ${[kind, ...args].join(" ")}`);
    if (kind === "codex") p.screen.push("OpenAI Codex", "›");
    pushLifecycle("pane_agent_detected", { agent: kind, pane_id: p.pane_id, workspace_id: p.workspace_id });
    pushStatus(p);
  }

  // ---------- terminal rendering and typing ----------
  const ESC = "\x1b[";
  const colour = (l: string) =>
    /^●/.test(l) ? `${ESC}38;2;215;119;87m●${ESC}0m${l.slice(1)}`
      : /^\s*⎿/.test(l) ? `${ESC}2m${l}${ESC}0m`
        : /^[>›]/.test(l) ? `${ESC}1m${l}${ESC}0m`
          : l;
  /**
   * The pane as pane.read returns it: screen, then any menu, then the input box (always in ansi, when
   * non-empty in text). In ansi the box is drawn the way the real agents draw it (see src/modules/live/composer.ts):
   * Claude Code "❯" + no-break space between two rules with an inverse cursor cell, Codex "› " with a dim placeholder.
   */
  function render(p: FakePane, ansi: boolean): string[] {
    const body = ansi ? [...(p.ansi ?? p.screen.map(colour)), ...(p.menu ?? [])] : [...p.screen, ...(p.menu ?? [])];
    const lines = p.input.split("\n");
    if (ansi && p.agent === "codex" && !p.menu) {
      body.push("", `${ESC}1m› ${ESC}0m${p.input ? lines[0] : `${ESC}2mAsk Codex to do anything${ESC}0m`}`, ...lines.slice(1).map((l) => `  ${l}`), "", `  ${ESC}38;2;122;131;150m? for shortcuts${ESC}0m`);
    } else if (ansi && p.agent === "cursor" && !p.menu) {
      body.push("", `  ${ESC}2m→ ${ESC}0m${p.input ? lines[0] : `${ESC}2mPlan, search, build anything${ESC}0m`}`, ...lines.slice(1).map((l) => `    ${l}`), "", `  ${ESC}2mGrok 4.7 · Run Everything${ESC}0m`);
    } else if (ansi && p.agent && !p.menu) {
      const rule = `${ESC}38;2;122;131;150m${"─".repeat(Math.min(p.cols, 80))}${ESC}0m`;
      const box = lines.map((l, i) => `${i ? "  " : "❯\u00a0"}${l}${i === lines.length - 1 ? `${ESC}7m ${ESC}0m` : ""}`);
      body.push("", rule, ...box, rule, `  ${ESC}38;2;122;131;150m? for shortcuts${ESC}0m`);
    } else if (p.input) body.push(`❯ ${p.input}`);
    return body;
  }
  const PASTE = /\x1b\[20[01]~/g;
  function typeText(p: FakePane, text: string) {
    const lone = text.match(/^\x1b\[200~([\s\S]*)\x1b\[201~$/)?.[1].trim().replace(/^'([\s\S]*)'$/, "$1").replace(/'\\''/g, "'");
    if (lone && (p.agent === "claude" || p.agent === "codex") && !p.noImages && /\.(png|jpe?g|gif|webp)$/i.test(lone) && fs.existsSync(lone)) {
      p.attached = [...(p.attached ?? []), lone];
      p.input += `[Image #${p.attached.length}] `;
    } else p.input += text.replace(PASTE, "").replace(/\r\n?/g, "\n");
    p.revision++;
  }
  /**
   * Line editing for keys that reach a pane without a menu, with the cursor at the end of the input:
   * Enter submits, Backspace deletes, Ctrl+U kills the last line, Ctrl+K has nothing after the cursor, Ctrl+C clears.
   */
  function typeKeys(p: FakePane, keys: string[]) {
    for (const k of keys) {
      if (p.inputLocked && k !== "enter") continue;
      if (k === "enter") {
        if (p.input.trim()) { state.typed.push({ target: p.pane_id, text: p.input, ts: new Date().toISOString(), ...(p.attached?.length ? { images: p.attached } : {}) }); p.screen.push(`> ${p.input}`); }
        p.input = "";
      } else if (k === "backspace") p.input = [...p.input].slice(0, -1).join("");
      else if (k === "ctrl+c") p.input = "";
      else if (k === "ctrl+u") p.input = p.input.slice(0, p.input.lastIndexOf("\n") + 1);
      else if (k === "ctrl+k") { /* the cursor is at the end */ }
      else if (k === "space") p.input += " ";
      else if ([...k].length === 1) p.input += k;
    }
    if (!p.input) p.attached = [];
    p.revision++;
  }

  // ---------- request handling ----------
  const state = { prompts: [] as FakeHerdr["prompts"], keys: [] as FakeHerdr["keys"], inputs: [] as FakeHerdr["inputs"], typed: [] as FakeHerdr["typed"], notifications: [] as FakeHerdr["notifications"], calls: [] as FakeHerdr["calls"] };
  const timers = new Set<NodeJS.Timeout>();
  const later = (ms: number, fn: () => void) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); };

  function paneOr(id: string | undefined): FakePane {
    const p = id ? panes.get(id) : focused ? panes.get(focused) : undefined;
    if (!p) throw errorOf("pane_not_found", `pane ${id} not found`);
    return p;
  }
  function agentOr(target: string): FakePane {
    const p = panes.get(target) ?? [...panes.values()].find((x) => x.name === target);
    if (!p) throw errorOf("agent_not_found", `agent ${target} not found`);
    if (!p.agent) throw errorOf("agent_not_ready", `agent ${target} is not an active named agent`);
    return p;
  }

  function handle(method: string, params: any): any {
    state.calls.push({ method, params });
    const f = failures.get(method);
    if (f) { failures.delete(method); throw f; }
    switch (method) {
      case "ping": return { type: "pong", version: opts.version ?? "0.9.1-fake", protocol: 22, capabilities: { live_handoff: false } };
      case "session.snapshot": return { type: "session_snapshot", snapshot: {
        version: opts.version ?? "0.9.1-fake", protocol: 22, focused_workspace_id: focused ? panes.get(focused)?.workspace_id ?? null : null, focused_tab_id: focused ? panes.get(focused)?.tab_id ?? null : null, focused_pane_id: focused,
        workspaces: [...workspaces.values()].map(wsInfo), tabs: [...tabs.values()].map(tabInfo), panes: [...panes.values()].map(paneInfo), layouts: [],
        agents: [...panes.values()].filter((p) => p.agent).map(agentInfo) } };
      case "workspace.list": return { type: "workspace_list", workspaces: [...workspaces.values()].map(wsInfo) };
      case "pane.list": return { type: "pane_list", panes: [...panes.values()].filter((p) => !params?.workspace_id || p.workspace_id === params.workspace_id).map(paneInfo) };
      case "pane.get": return { type: "pane_info", pane: paneInfo(paneOr(params?.pane_id)) };
      case "agent.list": return { type: "agent_list", agents: [...panes.values()].filter((p) => p.agent).map(agentInfo) };
      case "agent.get": return { type: "agent_info", agent: agentInfo(agentOr(params.target)) };
      case "pane.process_info": { const p = paneOr(params?.pane_id); return { type: "pane_process_info", process_info: { pane_id: p.pane_id, shell_pid: null, foreground_processes: p.pids.map((pid) => ({ pid, name: p.agent ?? "zsh" })) } }; }
      case "pane.read": case "agent.read": {
        const p = method === "pane.read" ? paneOr(params.pane_id) : agentOr(params.target);
        const ansi = params.format === "ansi" && params.strip_ansi === false;
        const lines = params.lines ?? (ansi ? p.rows : 40);
        const all = render(p, ansi);
        return { type: "pane_read", read: { pane_id: p.pane_id, workspace_id: p.workspace_id, tab_id: p.tab_id, source: params.source ?? "recent", format: ansi ? "ansi" : "text", text: all.slice(-lines).join(ansi ? "\r\n" : "\n") + (ansi ? "" : "\n"), revision: p.revision, truncated: false } };
      }
      case "pane.layout": {
        const p = paneOr(params?.pane_id);
        const rect = { x: 0, y: 0, width: p.cols, height: p.rows };
        return { type: "pane_layout", layout: { workspace_id: p.workspace_id, tab_id: p.tab_id, zoomed: false, area: rect, focused_pane_id: focused, panes: [{ pane_id: p.pane_id, focused: p.pane_id === focused, rect }], splits: [] } };
      }
      case "agent.prompt": {
        const p = agentOr(params.target);
        if (p.agent_status === "blocked") throw errorOf("agent_blocked", `agent ${params.target} is blocked and requires interactive input`);
        // Pasted at the cursor (the end of whatever is in the input box), then Enter submits the whole box.
        const submitted = p.input + String(params.text);
        const images = (p.attached ?? []).filter((_, i) => submitted.includes(`[Image #${i + 1}]`));
        p.input = "";
        p.attached = [];
        state.prompts.push({ target: p.pane_id, text: submitted, ts: new Date().toISOString(), ...(images.length ? { images } : {}) });
        p.screen.push(`> ${submitted}`);
        setStatus(p.pane_id, "working");
        later(flipMs, () => { if (panes.get(p.pane_id) === p && p.agent_status === "working") setStatus(p.pane_id, "idle"); });
        return { type: "agent_prompted", agent: agentInfo(p) };
      }
      case "agent.send_keys": case "pane.send_keys": {
        const p = method === "agent.send_keys" ? agentOr(params.target) : paneOr(params.pane_id);
        const bad = (params.keys ?? []).find((k: string) => /^(delete|home|end|insert|pageup|pagedown|backtab)$/.test(k));
        if (bad) throw errorOf("invalid_key", `unsupported key ${bad}`);
        state.keys.push({ target: p.pane_id, keys: params.keys ?? [], ts: new Date().toISOString() });
        if (method === "pane.send_keys") state.inputs.push({ target: p.pane_id, keys: params.keys ?? [], ts: new Date().toISOString() });
        if (!p.menu && method === "pane.send_keys") typeKeys(p, params.keys ?? []);
        if (p.menu) {
          // Answer the menu like Claude Code does: a digit picks that option, esc declines.
          const k = String((params.keys ?? [])[0] ?? "");
          const opt = p.menu.map((l) => l.match(/([1-9])\.\s+(.+?)\s*│?\s*$/)).find((m) => m && m[1] === k);
          const declined = k === "esc" || /^No\b/.test(opt?.[2] ?? "");
          p.menu = null;
          p.screen.push(declined ? "  ⎿  Declined. Waiting for what to do instead." : `● Bash(npm run test:export -- --runInBand)`, declined ? "" : `  ⎿  Running… (you chose ${opt ? `"${opt[2]}"` : k})`);
          p.revision++;
        }
        if (p.agent && p.agent_status === "blocked") { setStatus(p.pane_id, "working"); later(flipMs, () => { if (panes.get(p.pane_id) === p && p.agent_status === "working") setStatus(p.pane_id, "idle"); }); }
        return { type: "ok" };
      }
      case "pane.send_text": {
        const p = paneOr(params.pane_id);
        state.inputs.push({ target: p.pane_id, text: String(params.text), ts: new Date().toISOString() });
        typeText(p, String(params.text));
        return { type: "ok" };
      }
      case "pane.send_input": {
        const p = paneOr(params.pane_id);
        const keys: string[] = params.keys ?? [];
        const bad = keys.find((k) => /^(delete|home|end|insert|pageup|pagedown|backtab)$/.test(k));
        if (bad) throw errorOf("invalid_key", `unsupported key ${bad}`);
        const ts = new Date().toISOString();
        if (params.text) { state.inputs.push({ target: p.pane_id, text: String(params.text), ts }); typeText(p, String(params.text)); }
        if (keys.length) { state.inputs.push({ target: p.pane_id, keys, ts }); state.keys.push({ target: p.pane_id, keys, ts }); typeKeys(p, keys); }
        return { type: "ok" };
      }
      case "workspace.create": {
        const w = addWorkspace(params?.label ?? path.basename(params?.cwd ?? "/tmp"));
        const t = addTab(w.workspace_id, "1");
        const p = makePane({ workspace_id: w.workspace_id, tab_id: t.tab_id, cwd: params?.cwd ?? "/tmp" });
        if (params?.focus) focused = p.pane_id;
        pushLifecycle("pane_created", { pane: paneInfo(p) });
        pushLifecycle("workspace_created", { workspace: wsInfo(w) });
        pushLifecycle("tab_created", { tab: tabInfo(t) });
        return { type: "workspace_created", workspace: wsInfo(w), tab: tabInfo(t), root_pane: paneInfo(p) };
      }
      case "tab.create": {
        const wsId = params?.workspace_id ?? (focused ? panes.get(focused)?.workspace_id : [...workspaces.keys()][0]);
        if (!wsId || !workspaces.has(wsId)) throw errorOf("workspace_not_found", `workspace ${wsId} not found`);
        const t = addTab(wsId, params?.label ?? String([...tabs.values()].filter((x) => x.workspace_id === wsId).length + 1));
        const p = makePane({ workspace_id: wsId, tab_id: t.tab_id, cwd: params?.cwd ?? "/tmp" });
        pushLifecycle("pane_created", { pane: paneInfo(p) });
        pushLifecycle("tab_created", { tab: tabInfo(t) });
        return { type: "tab_created", tab: tabInfo(t), root_pane: paneInfo(p) };
      }
      case "agent.start": {
        const p = paneOr(params.pane_id);
        if (p.agent) throw errorOf("pane_not_at_shell_prompt", `pane ${p.pane_id} is already running ${p.agent}`);
        if (params.name && [...panes.values()].some((x) => x.name === params.name)) throw errorOf("agent_name_taken", `agent name ${params.name} is already in use`);
        startAgent(p, String(params.kind), params.name ?? null, params.args ?? []);
        return { type: "agent_started", agent: agentInfo(p), argv: [String(params.kind), ...(params.args ?? [])] };
      }
      case "pane.close": closePane(params.pane_id); return { type: "ok" };
      case "workspace.close": {
        const id = params.workspace_id;
        const w = workspaces.get(id);
        if (!w) throw errorOf("workspace_not_found", `workspace ${id} not found`);
        const info = wsInfo(w);
        for (const p of [...panes.values()]) if (p.workspace_id === id) { panes.delete(p.pane_id); for (const s of subs) s.status.delete(p.pane_id); }
        for (const t of [...tabs.values()]) if (t.workspace_id === id) tabs.delete(t.tab_id);
        workspaces.delete(id);
        pushLifecycle("workspace_closed", { workspace: info, workspace_id: id });
        return { type: "ok" };
      }
      case "pane.focus": focusPane(paneOr(params.pane_id).pane_id); return { type: "ok" };
      case "notification.show": state.notifications.push({ title: params.title, body: params.body ?? null }); return { type: "notification_show", shown: true, reason: "shown" };
      case "pane.report_agent": {
        const p = paneOr(params.pane_id);
        if (!p.agent) { p.agent = params.agent; pushLifecycle("pane_agent_detected", { agent: p.agent, pane_id: p.pane_id, workspace_id: p.workspace_id }); }
        if (params.state) setStatus(p.pane_id, params.state);
        return { type: "ok" };
      }
      // ----- test control side channel -----
      case "fake.set_delay": {
        for (const method of params.methods) responseDelays.set(method, Number(params.ms));
        return { type: "ok" };
      }
      case "fake.set_status": setStatus(params.pane_id, params.status, { push: params.push }); return { type: "ok" };
      case "fake.set_screen": {
        const p = paneOr(params.pane_id);
        if (Array.isArray(params.screen)) p.screen = params.screen.map(String);
        if (params.ansi !== undefined) p.ansi = params.ansi;
        if (params.input !== undefined) p.input = String(params.input);
        if (params.lock_input !== undefined) p.inputLocked = Boolean(params.lock_input);
        if (params.no_images !== undefined) p.noImages = Boolean(params.no_images);
        if (params.cols) p.cols = Number(params.cols);
        if (params.rows) p.rows = Number(params.rows);
        p.revision++;
        return { type: "ok" };
      }
      case "fake.set_menu": { const p = paneOr(params.pane_id); p.menu = params.menu === undefined ? [...CLAUDE_PERMISSION_MENU] : params.menu; p.revision++; if (params.status) setStatus(p.pane_id, params.status); return { type: "ok" }; }
      case "fake.add_pane": return { type: "pane_info", pane: paneInfo(addPane(params ?? {}, { push: params?.push })) };
      case "fake.close_pane": closePane(params.pane_id, { push: params.push }); return { type: "ok" };
      case "fake.focus_pane": focusPane(params.pane_id); return { type: "ok" };
      case "fake.events_lost": setImmediate(eventsLost); return { type: "ok" };
      case "fake.state": return { type: "fake_state", prompts: state.prompts, keys: state.keys, inputs: state.inputs, typed: state.typed, notifications: state.notifications, panes: [...panes.values()].map((p) => ({ ...paneInfo(p), input: p.input })), subscribers: subs.size };
      default: throw errorOf("unknown_method", `unknown method ${method}`);
    }
  }

  function onConnection(conn: net.Socket) {
    conn.setEncoding("utf8");
    let buf = "";
    let handled = false;
    conn.on("error", () => {});
    conn.on("data", (d: string) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i < 0 || handled) return;
      handled = true; // one request per connection, like Herdr
      const line = buf.slice(0, i);
      let req: any;
      try { req = JSON.parse(line); } catch { conn.end(JSON.stringify({ id: "", error: errorOf("invalid_json", "invalid JSON") }) + "\n"); return; }
      const responseDelay = responseDelays.get(req.method) ?? 0;
      if (responseDelay) {
        // A real RPC timeout while the pane and agent keep running, including reconnect acknowledgements.
        const timer = setTimeout(() => conn.end(JSON.stringify({ id: req.id, result: handle(req.method, req.params ?? {}) }) + "\n"), responseDelay);
        conn.once("close", () => clearTimeout(timer));
        return;
      }
      const id = typeof req.id === "string" ? req.id : "";
      if (req.method === "events.subscribe") {
        state.calls.push({ method: req.method, params: req.params });
        const entries: any[] = req.params?.subscriptions ?? [];
        const sub: Sub = { conn, id, lifecycle: new Set(), status: new Map() };
        for (const [n, e] of entries.entries()) {
          if (e.type === "pane.agent_status_changed") {
            if (!panes.has(e.pane_id)) { conn.end(JSON.stringify({ id: `${id}:sub:${n}:probe`, error: errorOf("pane_not_found", `pane ${e.pane_id} not found`) }) + "\n"); return; }
            sub.status.set(e.pane_id, e.agent_status ?? null);
          } else sub.lifecycle.add(String(e.type));
        }
        subs.add(sub);
        conn.on("close", () => subs.delete(sub));
        conn.write(JSON.stringify({ id, result: { type: "subscription_started" } }) + "\n");
        return;
      }
      try {
        const reply = replies.get(req.method);
        replies.delete(req.method);
        const answer = JSON.stringify({ id, result: handle(String(req.method), req.params ?? {}) }) + "\n";
        if (reply?.kind === "drop") conn.destroy();
        else if (reply?.kind === "delay") later(reply.ms, () => { if (!conn.destroyed) conn.end(answer); });
        else conn.end(answer);
      }
      catch (e: any) { conn.end(JSON.stringify({ id, error: e?.code ? e : errorOf("internal", String(e?.message ?? e)) }) + "\n"); }
    });
  }

  function eventsLost() {
    for (const s of [...subs]) { s.conn.end(JSON.stringify({ id: s.id, error: errorOf("events_lost", "subscriber fell behind retained event history") }) + "\n"); subs.delete(s); }
  }

  let server: net.Server | null = null;
  const sockets = new Set<net.Socket>();
  async function listen() {
    fs.mkdirSync(path.dirname(socketPath), { recursive: true });
    try { fs.unlinkSync(socketPath); } catch {}
    server = net.createServer((c) => { sockets.add(c); c.on("close", () => sockets.delete(c)); onConnection(c); });
    await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(socketPath, () => resolve()); });
  }
  async function stop() {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    for (const s of sockets) s.destroy();
    subs.clear();
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
    try { fs.unlinkSync(socketPath); } catch {}
  }
  await listen();

  return {
    socketPath, panes, ...state,
    setStatus, addPane, closePane, focusPane,
    push: (event, data) => pushLifecycle(event, data),
    eventsLost,
    failNext: (method, code, message) => { failures.set(method, errorOf(code, message ?? code)); },
    delayNextReply: (method, ms) => { replies.set(method, { kind: "delay", ms }); },
    dropNextReply: (method) => { replies.set(method, { kind: "drop" }); },
    subscriberCount: () => subs.size,
    stop,
    restart: listen,
  };
}

/**
 * Tripwire for tests: throws unless src/shared/paths.ts resolved to the sandbox env.
 * A static import of anything under src/ before sandboxDaemon() makes paths point at the
 * real ~/.claude, Herdr socket and .joyride runtime; call this before daemon.start().
 */
export async function assertSandboxed(env: Record<string, string>) {
  const { paths } = await import("../../src/shared/paths.ts");
  const bad = ([["runtime", "JOYRIDE_RUNTIME"], ["claudeDir", "JOYRIDE_CLAUDE_DIR"], ["codexDir", "JOYRIDE_CODEX_DIR"], ["herdrSocket", "JOYRIDE_HERDR_SOCKET"]] as const)
    .filter(([k, e]) => (paths as any)[k] !== env[e]);
  if (bad.length) throw new Error(`Test is not sandboxed: ${bad.map(([k]) => k).join(", ")} point outside the sandbox. Remove static imports of src/ from this test file.`);
}

/** Poll until fn() is truthy (sync or async); returns its value. */
export async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 5000, stepMs = 50): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try { const v = await fn(); if (v) return v; last = v; } catch (e) { last = e; }
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs} ms (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** Drive a running fake from another process (e.g. Playwright): fake.set_status, fake.add_pane, fake.close_pane, fake.focus_pane, fake.events_lost, fake.state. */
export function fakeHerdrControl(socketPath: string, method: string, params: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(socketPath);
    let buf = "";
    c.setEncoding("utf8");
    c.on("connect", () => c.write(JSON.stringify({ id: "ctl", method, params }) + "\n"));
    c.on("data", (d: string) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i < 0) return;
      const msg = JSON.parse(buf.slice(0, i));
      c.destroy();
      if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`)); else resolve(msg.result);
    });
    c.on("error", reject);
  });
}
