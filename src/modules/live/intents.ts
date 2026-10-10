import { nativeLaunchSession, rememberLaunchSession } from "./launch-identity.ts";
import { paths } from "../../shared/paths.ts";
import type { SessionsService } from "../sessions/types.ts";
// The `intents` service: every human command is logged as an intent, then
// handed to the owner that executes it. Handlers are registered by kind, so
// other modules add their own (Firstmate registers create_task,
// firstmate replaces the steer_task placeholder).
import fs from "node:fs";
import { sessionHere } from "./session-here.ts";
import type { Ctx } from "../../core/context.ts";
import { IntentKind, IntentOrigin, ReplyBinding, WorkerPermissionMode, type Intent, type WorkerView } from "../../shared/schema.ts";
import { now, rid } from "../../core/util.ts";
import type { HerdrApi } from "./herdr.ts";
import type { WorkersApi } from "./workers.ts";
import { resumeCommand, shellQuote, paneSessionKey } from "./common.ts";
import { PROVIDER_TITLES, launchEnv, loginCommand, readAccounts, type Account } from "../../core/accounts.ts";
import { canSendImages, noImagesReason } from "../../shared/images.ts";

export type IntentRecord = Intent & { result?: unknown; /** When the human dismissed it from the chat view. */ dismissed?: string };
export type IntentHandler = (intent: IntentRecord, ctx: Ctx) => unknown | Promise<unknown>;

/** A handler failure with a message meant for the human, plus optional structured detail for the UI. */
export class IntentError extends Error {
  constructor(message: string, public detail?: Record<string, unknown>) { super(message); this.name = "IntentError"; }
}

/** `origin` says who asked (default captain); steer attribution reads it back from the intent events. */
export type CreateOpts = { origin?: Intent["origin"] };

export type IntentsApi = {
  create(kind: string, target: string, payload?: Record<string, unknown>, opts?: CreateOpts): Promise<IntentRecord>;
  list(opts?: { target?: string; kind?: string; status?: string; limit?: number }): IntentRecord[];
  /** Sent image replies for a session, including history beyond the public list's page cap. */
  imageReplies(session: string): IntentRecord[];
  get(id: string): IntentRecord | null;
  registerHandler(kind: string, fn: IntentHandler): void;
  kinds(): string[];
  /** A sent reply the transcript shows the agent took. */
  consumed(id: string): IntentRecord | null;
  /** Hide a reply from the chat view (a failed or unclaimed one the human is done with). */
  dismiss(id: string): IntentRecord | null;
};

export const INTENTS_SQL = `
CREATE TABLE intents (id TEXT PRIMARY KEY, created TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL, status TEXT NOT NULL, json TEXT NOT NULL);
CREATE INDEX intents_target ON intents(target, created);
CREATE INDEX intents_created ON intents(created);
`;

const HANDLER_TIMEOUT_MS = 90_000;
const ACK_WINDOW_MS = 10 * 60_000;

export class IntentsService {
  handlers = new Map<string, IntentHandler>();
  /** Sent replies waiting for a sign that the worker picked them up. */
  private awaitingAck = new Map<string, { worker: string; session: string | null; deadline: number }>();

  constructor(private ctx: Ctx) {}

  private save(it: IntentRecord) {
    this.ctx.db.prepare("INSERT INTO intents(id, created, kind, target, status, json) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, json=excluded.json")
      .run(it.id, it.created, it.kind, it.target, it.status, JSON.stringify(it));
    this.ctx.bus.change({ entity: "intents", id: it.id });
  }

  private emit(type: string, it: IntentRecord, data: Record<string, unknown> = {}) {
    try { this.ctx.emit({ source: "intent", type, data: { id: it.id, kind: it.kind, target: it.target, origin: it.origin, ...data } }); }
    catch (e: any) { this.ctx.log(`intents: could not append ${type}: ${e.message}`); }
  }

  get(id: string): IntentRecord | null {
    const row = this.ctx.db.prepare("SELECT json FROM intents WHERE id = ?").get(id) as { json: string } | undefined;
    return row ? JSON.parse(row.json) : null;
  }

  list(opts: { target?: string; kind?: string; status?: string; limit?: number } = {}): IntentRecord[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.target) { where.push("target = ?"); args.push(opts.target); }
    if (opts.kind) { where.push("kind = ?"); args.push(opts.kind); }
    if (opts.status) { where.push("status = ?"); args.push(opts.status); }
    const sql = `SELECT json FROM intents ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created DESC, rowid DESC LIMIT ?`;
    return (this.ctx.db.prepare(sql).all(...args, Math.min(opts.limit ?? 100, 1000)) as { json: string }[]).map((r) => JSON.parse(r.json));
  }

  isKnownKind(kind: string) { return this.handlers.has(kind) || (IntentKind.options as string[]).includes(kind); }

  async create(kind: string, target: string, payload: Record<string, unknown> = {}, opts: CreateOpts = {}): Promise<IntentRecord> {
    if (!kind || !this.isKnownKind(kind)) throw new IntentError(`Unknown intent kind "${kind}". Known kinds: ${[...new Set([...IntentKind.options, ...this.handlers.keys()])].join(", ")}.`);
    const origin = opts.origin ?? "captain";
    if (!IntentOrigin.options.includes(origin)) throw new IntentError(`Unknown intent origin "${origin}". Use ${IntentOrigin.options.join(", ")}.`);
    const ts = now();
    const it: IntentRecord = { id: rid("int_"), kind: kind as Intent["kind"], target: String(target ?? ""), payload: payload ?? {}, origin, status: "pending", error: null, created: ts, updated: ts };
    this.save(it);
    this.emit("intent.created", it, { payload: it.payload });
    const handler = this.handlers.get(kind);
    if (!handler) return this.fail(it, `No module handles "${kind}" intents yet, so nothing was sent.`);
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => handler(it, this.ctx)),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new IntentError(`The ${kind} handler did not finish within ${HANDLER_TIMEOUT_MS / 1000}s.`)), HANDLER_TIMEOUT_MS); }),
      ]);
      it.status = "sent";
      it.result = result ?? null;
      it.updated = now();
      this.save(it);
      this.emit("intent.sent", it, { result: it.result });
      // A reply that went in while the agent worked waits in the agent's queue: "working" and a
      // prompt-submit hook (Claude Code fires it when the message is queued) say nothing about it.
      // The transcript shows when it is taken (staged.ts).
      const r = result as { worker?: string; session?: string | null; queued?: boolean } | null;
      if (kind === "reply" && !r?.queued) this.awaitingAck.set(it.id, { worker: r?.worker ?? it.target, session: r?.session ?? null, deadline: Date.now() + ACK_WINDOW_MS });
      return it;
    } catch (e: any) {
      return this.fail(it, e?.message ?? String(e), e?.detail);
    } finally { if (timer) clearTimeout(timer); }
  }

  private fail(it: IntentRecord, message: string, detail?: Record<string, unknown>) {
    it.status = "failed";
    it.error = message;
    if (detail) it.result = detail;
    it.updated = now();
    this.save(it);
    this.emit("intent.failed", it, { error: message, ...(detail ? { detail } : {}) });
    return it;
  }

  consumed(id: string): IntentRecord | null {
    const it = this.get(id);
    if (!it || it.status !== "sent") return it;
    this.awaitingAck.delete(id);
    it.status = "acked";
    it.updated = now();
    this.save(it);
    this.emit("intent.acked", it, { via: "transcript" });
    return it;
  }

  dismiss(id: string): IntentRecord | null {
    const it = this.get(id);
    if (!it || it.dismissed) return it;
    it.dismissed = now();
    this.save(it);
    return it;
  }

  /** Mark replies acked when the worker starts working or the session sees a prompt. */
  onEvent(e: { source: string; type: string; session?: string; agent?: string; data?: Record<string, any> }) {
    if (!this.awaitingAck.size) return;
    const t = Date.now();
    for (const [id, w] of [...this.awaitingAck]) {
      if (w.deadline < t) { this.awaitingAck.delete(id); continue; }
      const herdrHit = e.source === "herdr" && e.type === "agent.status" && e.data?.worker === w.worker && e.data?.status === "working";
      const hookHit = e.source.startsWith("hook.") && e.type === "prompt.submit" && w.session && `${e.agent}:${e.session}` === w.session;
      if (!herdrHit && !hookHit) continue;
      this.awaitingAck.delete(id);
      const it = this.get(id);
      if (!it || it.status !== "sent") continue;
      it.status = "acked";
      it.updated = now();
      this.save(it);
      this.emit("intent.acked", it, { via: herdrHit ? "herdr" : "hook" });
    }
  }

  api(): IntentsApi {
    return {
      create: (k, t, p, o) => this.create(k, t, p, o),
      list: (o) => this.list(o),
      imageReplies: (session) => {
        const rows = this.ctx.db.prepare<[string], { json: string }>(`SELECT json FROM intents WHERE kind = 'reply' AND status IN ('sent', 'acked')
          AND json_extract(json, '$.result.session') = ? AND json_array_length(json, '$.payload.images') > 0
          ORDER BY created, rowid`).all(session);
        return rows.map((r) => JSON.parse(r.json));
      },
      get: (id) => this.get(id),
      registerHandler: (k, fn) => { this.handlers.set(k, fn); },
      kinds: () => [...this.handlers.keys()],
      consumed: (id) => this.consumed(id),
      dismiss: (id) => this.dismiss(id),
    };
  }
}

function notControllable(w: WorkerView, herdrConnected: boolean): IntentError {
  const sessionId = w.session ? w.session.split(":").slice(1).join(":") : null;
  const cmd = resumeCommand(w.agent, sessionId);
  const resume = { agent: w.agent, session: sessionId, cwd: w.cwd, command: `cd ${shellQuote(w.cwd || "~")} && ${cmd}` };
  if (w.pane && !herdrConnected) {
    return new IntentError(`Herdr on ${w.machine} is not connected, so Joyride can't type into pane ${w.pane}. Joyride reconnects on its own; send the reply again when the connection returns.`, { code: "reconnecting", worker: w.id, session: w.session });
  }
  return new IntentError(
    `${w.title || w.id} is running outside Herdr, so Joyride can't type into it. Reply in its own terminal, or quit it there and resume it inside a Herdr pane: ${resume.command}` +
      (sessionId ? ` (or send a launch_session intent with {"cwd": "${w.cwd}", "agent": "${w.agent}", "resume": "${sessionId}"}).` : "."),
    { resume },
  );
}

/** The images an intent carries, checked by the uploads service: only images Joyride stored go out. */
export function attachedImages(ctx: Ctx, wanted: unknown): string[] {
  if (wanted == null || (Array.isArray(wanted) && !wanted.length)) return [];
  let uploads: { resolve(w: unknown): string[] };
  try { uploads = ctx.service("uploads"); } catch { throw new IntentError("The uploads module is not running, so images can't be sent. Send the text alone."); }
  try { return uploads.resolve(wanted); } catch (e: any) { throw new IntentError(e?.message ?? String(e)); }
}

export { readScreen, pickOption, promptOf } from "./screen.ts";
import { readScreen, pickOption, promptOf } from "./screen.ts";
import { guardRefusal, type GuardAction, type GuardPolicy } from "./steer-guard.ts";

const GUARDED_STOPS = new Set(["composer_draft", "composer_busy", "composer_not_found", "agent_blocked", "images_unsupported"]);

/** The fleet policy the steer guard checks (fleet.yaml), or null when the fleet module is not running. */
function fleetPolicy(ctx: Ctx): GuardPolicy {
  try { return (ctx.services.get("fleet")?.policy?.() as GuardPolicy | undefined) ?? null; } catch { return null; }
}

/** Refuse a guarded (non-captain) action with the reason the guard gave; nothing has been typed yet. */
function guard(ctx: Ctx, w: WorkerView, action: GuardAction, it: IntentRecord) {
  if ((it.origin ?? "captain") === "captain") return;
  const r = guardRefusal(w, action, fleetPolicy(ctx));
  if (r) throw new IntentError(r.message, { refused: r.code, worker: w.id, session: w.session, helm: w.helm ?? null });
}

/** Built-in handlers: reply, approve, deny, launch_session, answer_prompt and the steer_task placeholder. */
export function registerBuiltins(svc: IntentsService, ctx: Ctx, deps: { herdr: () => HerdrApi; workers: () => WorkersApi }) {
  svc.handlers.set("reply", async (it) => {
    const text = String(it.payload.text ?? it.payload.message ?? "").trim();
    // A guarded steer (from Firstmate) never clears the input box, and images would need it cleared.
    const guarded = (it.origin ?? "captain") !== "captain";
    if (guarded && it.payload.images != null && (!Array.isArray(it.payload.images) || it.payload.images.length)) throw new IntentError("A steer from Firstmate carries text only: attaching an image would mean clearing the input box first, which could hold the captain's draft.", { refused: "images" });
    const images = attachedImages(ctx, it.payload.images);
    if (!text && !images.length) throw new IntentError("The reply is empty. Type a message or attach an image, then send it again.");
    const w = deps.workers().get(it.target);
    if (!w) throw new IntentError(`Worker ${it.target} is not running anymore. Refresh the workers list; to continue an ended session, use launch_session with resume.`);
    const parsedBinding = it.payload.binding === undefined ? null : ReplyBinding.safeParse(it.payload.binding);
    if (parsedBinding && !parsedBinding.success) throw new IntentError("The reply's conversation binding is invalid. Reopen the chat before sending.");
    const binding = parsedBinding?.success ? parsedBinding.data : undefined;
    if (binding && (binding.session !== w.session || binding.terminal_id && binding.terminal_id !== w.terminal_id
      || binding.control && (!w.session || ctx.services.get("firstmate")?.controlWorker?.() !== w.id))) {
      throw new IntentError("This chat's connection changed. Your message was not sent. Reopen the active conversation from the map before sending.", { code: "connection_changed", worker: w.id, session: binding.session });
    }
    guard(ctx, w, "steer", it);
    if (images.length && !canSendImages(w.agent)) throw new IntentError(noImagesReason(w.agent, w.title || w.id));
    if (!w.controllable || !w.pane) throw notControllable(w, deps.herdr().connected(w.machine));
    let sent: any;
    try { sent = await deps.herdr().prompt(w.pane, text, { machine: w.machine, ...(binding ? { binding } : {}), ...(images.length ? { images } : {}), ...(guarded ? { keepDraft: true } : {}) }); }
    catch (e: any) {
      // For a guarded steer these mean Joyride typed nothing on purpose: a draft, a busy box, a prompt on screen.
      const refused = guarded && GUARDED_STOPS.has(e?.code) ? { refused: e.code } : {};
      throw new IntentError(e?.message ?? String(e), { ...(e?.detail ?? {}), worker: w.id, session: w.session, ...(e?.code ? { code: e.code } : {}), ...refused });
    }
    // Sent while the agent works, the reply waits in its queue until the turn ends.
    const queued = Boolean(sent?.queued);
    return { worker: w.id, machine: w.machine, pane: w.pane, session: w.session, ...(queued ? { queued } : {}), ...(images.length ? { images } : {}), ...(sent?.cleared ? { cleared: String(sent.cleared).slice(0, 300) } : {}) };
  });

  const decide = (decision: "allow" | "deny") => async (it: IntentRecord) => {
    // Blast-radius approvals are the captain's alone; answering a session's own prompt is answer_prompt.
    if ((it.origin ?? "captain") !== "captain") throw new IntentError("Only the captain decides a gated action in Joyride's approvals tray. Firstmate may answer a watched session's own permission prompt (answer_prompt), never a guard request.", { refused: "guard_is_captains" });
    let guard: any;
    try { guard = ctx.service("guard"); } catch { throw new IntentError("The guard module is not running, so approvals can't be recorded."); }
    const r = guard.get(it.target);
    if (!r) throw new IntentError(`There is no guard request ${it.target}. It may have been cleared; check the approvals tray.`);
    if (r.decision !== "pending") throw new IntentError(`Guard request ${it.target} was already decided (${r.decision}${r.reason ? `: ${r.reason}` : ""}). If the agent still needs it, ask the agent to retry.`);
    const reason = String(it.payload.reason ?? (decision === "allow" ? "approved in Joyride" : "denied in Joyride"));
    const out = guard.decide(it.target, decision, reason, decision === "allow" ? it.payload.remember : undefined);
    return { request: out.id, decision: out.decision, rule: out.rule };
  };
  svc.handlers.set("approve", decide("allow"));
  svc.handlers.set("deny", decide("deny"));

  // `account` (an id from usage.accounts) runs the agent on that login: its credential folder goes
  // into the pane's environment as CODEX_HOME or CLAUDE_CONFIG_DIR. Without it, the default login.
  svc.handlers.set("launch_session", async (it) => {
    const p = it.payload as Record<string, any>;
    const cwd = p.cwd ?? (it.target.startsWith("/") ? it.target : undefined);
    const agent = p.agent ?? "claude";
    const account = p.account ? launchAccount(String(p.account), agent) : null;
    try {
      if (p.here && (agent !== "claude" && agent !== "codex" || p.resume)) throw new IntentError("Start a session here opens a new Claude Code or Codex session. Use Start a session to resume a session.");
      const here = p.here ? sessionHere(ctx, p.here, WorkerPermissionMode.parse(p.permission_mode ?? ctx.config.workers.permission_mode), agent, cwd) : null;
      const marker = `joyride-launch: ${it.id}`;
      const launchedAt = Date.now();
      const r = await deps.herdr().launch({ cwd: here?.cwd ?? cwd, agent, prompt: here ? [here.prompt, p.prompt, agent === "codex" ? marker : null].filter(Boolean).join("\n\n") : p.prompt, label: here?.label ?? p.label, machine: p.machine, resume: p.resume, args: here ? [...here.args, ...(p.args ?? [])] : p.args, autoTrust: Boolean(p.autoTrust), env: { ...(p.env ?? {}), ...(account ? launchEnv(account) : {}) } });
      let warning = r.warning;
      let session = here?.session;
      if (here && agent === "codex") {
        const deadline = Date.now() + 10000;
        do {
          await deps.herdr().refresh(r.machine);
          const pane = deps.herdr().snapshot().panes.find(pane => pane.machine === r.machine && pane.pane_id === r.pane_id);
          session = pane ? paneSessionKey(pane) ?? undefined : undefined;
          if (!session && r.prompt_sent && r.machine === deps.herdr().defaultMachine()) {
            try { session = nativeLaunchSession(account?.home ?? p.env?.CODEX_HOME ?? paths.codexDir, here.cwd, marker, launchedAt) ?? undefined; } catch { /* retry while the native state is being saved */ }
          }
          if (session) { if (pane) rememberLaunchSession(ctx, pane, session); break; }
          await new Promise(resolve => setTimeout(resolve, 300));
        } while (Date.now() < deadline);
      }
      try {
        here?.link(session);
        if (session && ctx.services.has("sessions")) await ctx.service<SessionsService>("sessions").reindex();
      }
      catch (e) { warning = [warning, `The session started but could not be filed: ${e instanceof Error ? e.message : String(e)}. File it from the map.`].filter(Boolean).join(" "); }
      if (p.personal && r.prompt_sent && (it.origin ?? "captain") === "captain") ctx.emit({ source: "live", type: "steer.attributed", pane: r.pane_id, cwd: here?.cwd ?? cwd, agent, session: session?.slice(session.indexOf(":") + 1), data: { worker: r.worker, session: session ?? null, by: "captain", via: "joyride-launch", intent: it.id, task: null, prompt: p.prompt, at: new Date().toISOString() } });
      return { ...r, cwd: here?.cwd ?? cwd, ...(warning ? { warning } : {}), ...(session ? { session } : {}), ...(account ? { account: account.id } : {}) };
    } catch (e: any) { throw new IntentError(e.message); }
  });
  function launchAccount(id: string, agent: string): Account {
    const list: Account[] = ctx.services.get("usage")?.accounts?.() ?? readAccounts();
    const a = list.find((x) => x.id === id);
    const same = list.filter((x) => x.provider === agent).map((x) => x.id).join(", ");
    if (!a) throw new IntentError(`There is no account "${id}" under usage.accounts in joyride.config.yaml.${same ? ` ${agent} accounts: ${same}.` : ""}`);
    if (a.provider !== agent) throw new IntentError(`${a.label} is a ${PROVIDER_TITLES[a.provider]} account, so it can't run a ${PROVIDER_TITLES[agent as Account["provider"]] ?? agent} session.${same ? ` ${agent} accounts: ${same}.` : ""}`);
    if (a.home && !fs.existsSync(a.home)) throw new IntentError(`${a.label}'s folder ${a.homeLabel} does not exist yet. Sign in to it first: ${loginCommand(a)}`);
    return a;
  }

  // Answer a prompt the agent is showing in its terminal (permission menu, y/n question) from
  // anywhere: read the visible screen, pick the option matching the human's choice, send its key.
  // A guarded answer (from Firstmate) must name a choice the prompt itself offers, say why, and find
  // the same prompt on a second read just before its key goes in; it is recorded with the prompt it answered.
  svc.handlers.set("answer_prompt", async (it) => {
    const w = deps.workers().get(it.target);
    if (!w) throw new IntentError(`Worker ${it.target} is not running anymore.`);
    const p = it.payload as { choice?: string; keys?: string[]; text?: string; why?: string };
    const guarded = (it.origin ?? "captain") !== "captain";
    const why = String(p.why ?? "").trim();
    if (guarded) {
      if (Array.isArray(p.keys) && p.keys.length) throw new IntentError("Firstmate answers a prompt only with a choice the prompt offers (allow, allow_always or deny), never with raw keys.", { refused: "keys" });
      if (p.text) throw new IntentError("Answer the prompt and steer the session as two steps: a guarded answer carries no follow-up text.", { refused: "text" });
      if (!["allow", "allow_always", "deny"].includes(String(p.choice ?? ""))) throw new IntentError(`Say which choice to pick: allow, allow_always or deny (got "${p.choice ?? ""}").`, { refused: "choice" });
      if (!why) throw new IntentError("Say why Firstmate is giving this answer (why); it is recorded with the answer for the captain.", { refused: "why" });
      guard(ctx, w, "answer_prompt", it);
      if (w.status !== "blocked") throw new IntentError(`${w.title || w.id} is not waiting at a prompt (Herdr says ${w.status}), so there is nothing to answer. Nothing was sent.`, { refused: "no_prompt", worker: w.id });
    }
    if (!w.controllable || !w.pane) throw notControllable(w, deps.herdr().connected(w.machine));
    const screen = await readScreen(deps.herdr(), w.pane, w.machine);
    let keys: string[] | null = Array.isArray(p.keys) && p.keys.length ? p.keys.map(String) : null;
    let picked: string | null = null;
    const choice = (p.choice ?? "allow") as "allow" | "allow_always" | "deny";
    const prompt = promptOf(screen);
    if (!keys) {
      const opt = pickOption(screen, choice, { strict: guarded });
      if (!opt) throw new IntentError(guarded ? `The prompt on ${w.title || w.id}'s screen offers no "${choice}" choice${prompt ? ` (it offers: ${prompt.options.join("; ")})` : ""}. Nothing was sent.` : `Couldn't find a "${choice}" option on the agent's screen. Open the pane in Herdr to answer it, or send explicit keys.`, { ...(guarded ? { refused: "not_offered" } : {}), screen: screen.slice(-1200) });
      if (guarded) {
        // The prompt must still be there: a key typed after it closed would land in the input box.
        const again = await readScreen(deps.herdr(), w.pane, w.machine);
        const opt2 = pickOption(again, choice, { strict: true });
        if (!opt2 || opt2.label !== opt.label || opt2.keys.join(" ") !== opt.keys.join(" ")) throw new IntentError(`The prompt on ${w.title || w.id}'s screen changed while Joyride read it, so nothing was sent. Read it again and answer the prompt it shows now.`, { refused: "prompt_changed", screen: again.slice(-1200) });
      }
      keys = opt.keys; picked = opt.label;
    }
    await deps.herdr().sendKeys(w.pane, keys, { machine: w.machine });
    if (p.text) { await new Promise((r) => setTimeout(r, 400)); await deps.herdr().prompt(w.pane, String(p.text), { machine: w.machine }).catch(() => {}); }
    return { worker: w.id, pane: w.pane, session: w.session, keys, picked, choice: keys && !picked ? null : choice, prompt, ...(why ? { why } : {}), screen: screen.slice(-1200) };
  });

  // Bring a worker's pane to the front in the attached Herdr window, so you can type in it yourself.
  svc.handlers.set("focus", async (it) => {
    const w = deps.workers().get(it.target);
    if (!w) throw new IntentError(`Worker ${it.target} is not running anymore.`);
    if (!w.pane) throw notControllable(w, deps.herdr().connected(w.machine));
    try { await deps.herdr().call("agent.focus", { target: w.pane }, { machine: w.machine }); }
    catch { await deps.herdr().call("pane.focus", { pane_id: w.pane }, { machine: w.machine }); }
    return { worker: w.id, pane: w.pane, machine: w.machine, hint: "Switch to your Herdr window. No Herdr window open? The worker's Terminal tab in Joyride shows the same pane." };
  });

  // Move an agent that runs in a plain terminal into Herdr: end the process gracefully (its
  // conversation stays on disk), then resume the same session in a Herdr tab at the same folder.
  svc.handlers.set("move_to_herdr", async (it) => {
    // It ends the agent's process: the captain's call, never Firstmate's (that would be closing a session).
    if ((it.origin ?? "captain") !== "captain") throw new IntentError("Only the captain moves a session into Herdr: it ends the agent's process in its terminal.", { refused: "captain_only" });
    const w = deps.workers().get(it.target);
    if (!w) throw new IntentError(`Worker ${it.target} is not running anymore. Resume its session from the session pane instead.`);
    if (w.controllable) throw new IntentError("This agent already runs in Herdr.");
    if (!w.pid) throw new IntentError("Joyride doesn't know this agent's process, so it can't stop it. Quit it in its terminal, then use Resume in Herdr on its session.");
    if (w.status === "working" && !it.payload.force) throw new IntentError("It is working right now. Wait until it is idle (or pass force) so no turn is cut off.");
    const sessionId = (w.session ?? "").replace(/^(claude|codex):/, "");
    if (!sessionId) throw new IntentError("No session is linked to this agent, so there is nothing to resume.");
    if (process.pid === w.pid) throw new IntentError("That is the Joyride daemon itself.");
    try { process.kill(w.pid, "SIGTERM"); } catch (e: any) { if (e.code !== "ESRCH") throw new IntentError(`Couldn't stop process ${w.pid}: ${e.message}`); }
    for (let i = 0; i < 40; i++) { try { process.kill(w.pid, 0); await new Promise((r) => setTimeout(r, 250)); } catch { break; } }
    try { process.kill(w.pid, 0); throw new IntentError(`Process ${w.pid} did not exit after SIGTERM; it is still running in its terminal. Quit it there, then resume.`); } catch (e) { if (e instanceof IntentError) throw e; }
    try {
      const r = await deps.herdr().launch({ cwd: w.cwd, agent: w.agent === "codex" ? "codex" : "claude", resume: sessionId, label: w.cwd.split("/").filter(Boolean).pop() ?? "session" });
      return { ...r, moved_from_pid: w.pid, session: w.session };
    } catch (e: any) { throw new IntentError(`Stopped the old process, but the Herdr launch failed: ${e.message}. Resume it from the session pane.`); }
  });

  svc.handlers.set("steer_task", () => {
    throw new IntentError("Firstmate not available: task steering needs the Firstmate module. Reply to the worker directly for now.");
  });
}
