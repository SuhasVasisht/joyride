// Agent intent: a short, current statement per session of what the agent is
// trying to do, so a glance at the map or a worker says "why" and not only
// "which tool". The heavy LLM (task "session_intent", Codex Luna by default)
// reads a condensed transcript (first request, latest requests, latest
// assistant message, recent tools) and answers
//   { goal (<=12 words), now (<=15), next (<=15), waiting_on (string | null) }.
// Results are cached per session and keyed by the transcript's size/updated
// signature; turn.stop and prompt.submit refresh them, debounced to at most
// once a minute per session, at most 4 at a time. Sessions idle for more than
// 7 days are only described when someone opens them.
// Service `intentions`: get(key), list(keys), request(key, {explicit}), refresh(key).
import { defineModule, type Ctx } from "../../core/context.ts";
import { llm } from "../../core/llm.ts";
import { fakeModels, registerLlmFake } from "../../core/fakes.ts";
import { now } from "../../core/util.ts";

export type Intention = {
  key: string;
  goal: string;
  now: string;
  next: string;
  waiting_on: string | null;
  /** Transcript signature this was written from. */
  sig: string;
  /** When it was written (ISO). */
  generated: string;
};
export type IntentionView = { key: string; intention: Intention | null; pending: boolean; stale: boolean; error: string | null };

export const INTENT_SCHEMA = {
  type: "object",
  properties: {
    goal: { type: "string", description: "The overall objective, at most 12 words." },
    now: { type: "string", description: "What it is doing this minute, at most 15 words." },
    next: { type: "string", description: "What it will do next, at most 15 words." },
    waiting_on: { type: ["string", "null"], description: "What it needs from the human, or null." },
  },
  required: ["goal", "now", "next", "waiting_on"],
  additionalProperties: false,
} as const;

const SQL = `CREATE TABLE intentions (key TEXT PRIMARY KEY, sig TEXT NOT NULL, generated TEXT NOT NULL, json TEXT NOT NULL);`;

type Turn = { role: "user" | "assistant"; ts: string | null; text: string; tools: { name: string; summary: string }[]; steps?: ({ kind: "text"; text: string } | { kind: "tool"; name: string; summary: string })[] };
type Session = { key: string; source: string; title: string; first_prompt: string; repo: string | null; cwd: string; updated: string; turns: number; branch?: string | null };

const clipText = (s: string, n: number) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
/** At most n words, sentence case, no trailing period or quotes. */
export function tidy(s: unknown, n: number): string {
  let t = String(s ?? "").replace(/\s+/g, " ").trim().replace(/^["'“‘]+|["'”’]+$/g, "");
  const words = t.split(" ").filter(Boolean);
  if (words.length > n) t = words.slice(0, n).join(" ");
  t = t.replace(/[.;:,]+$/, "");
  return t ? t[0].toUpperCase() + t.slice(1) : "";
}

export function sessionSig(s: Pick<Session, "updated" | "turns">) { return `${s.updated}|${s.turns}`; }

/** The condensed transcript the model reads. */
export function intentPrompt(s: Session, turns: Turn[], live: { status?: string | null; action?: string | null } = {}): string {
  const users = turns.filter((t) => t.role === "user" && t.text.trim());
  const first = s.first_prompt || users[0]?.text || s.title;
  const latestUsers = users.slice(-3).filter((t) => t.text !== first);
  const lastAssistant = [...turns].reverse().find((t) => t.role === "assistant" && t.text.trim());
  const tools: string[] = [];
  for (const t of turns) for (const x of t.tools) tools.push(`${x.name}: ${x.summary}`);
  const lines = [
    `Agent: ${s.source === "codex" ? "Codex" : "Claude Code"} in ${s.repo ?? s.cwd}${s.branch ? ` on branch ${s.branch}` : ""}.`,
    live.status ? `Status: ${live.status}${live.action ? ` (${clipText(live.action, 160)})` : ""}.` : "",
    "",
    "First request from the user:",
    clipText(first, 700),
    ...(latestUsers.length ? ["", "Latest requests from the user (oldest first):", ...latestUsers.map((t) => `- ${clipText(t.text, 400)}`)] : []),
    ...(lastAssistant ? ["", "Latest message from the agent:", clipText(lastAssistant.text, 1400)] : []),
    ...(tools.length ? ["", "Recent tool calls (oldest first):", ...tools.slice(-12).map((t) => `- ${clipText(t, 160)}`)] : []),
    "",
    "Say what this agent is trying to do, for someone glancing over a map of many agents.",
    "- goal: the overall objective of the session, at most 12 words.",
    "- now: what it is doing this minute, at most 15 words, present tense (\"Running the export tests\").",
    "- next: what it will most likely do next, at most 15 words.",
    "- waiting_on: if it has stopped and needs the human (a question, an approval, a decision), say what for in at most 12 words; otherwise null.",
    "Plain sentence case. No trailing period, no quotes, no file paths unless they are the point.",
  ];
  return lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}

/** Deterministic stand-in for tests: built from the condensed transcript. */
export function fakeIntent(prompt: string) {
  const sec = (title: string) => { const m = prompt.match(new RegExp(`${title}[^\\n]*\\n([\\s\\S]*?)(?:\\n\\n|$)`)); return m?.[1]?.trim() ?? ""; };
  const words = (s: string, n: number) => s.replace(/[.!]+$/, "").split(/\s+/).slice(0, n).join(" ");
  const first = (sec("First request from the user:").split("\n")[0] || "Work on the task").split(/(?<=[.?!])\s/)[0];
  const tools = sec("Recent tool calls").split("\n").map((l) => l.replace(/^- /, "")).filter(Boolean);
  const last = tools[tools.length - 1];
  const verb = (t: string) => {
    const [name, ...rest] = t.split(": ");
    const what = rest.join(": ");
    if (/^(Bash|shell|exec_command)$/i.test(name)) return `Running ${what}`;
    if (/^(Read|View)$/i.test(name)) return `Reading ${what.split("/").pop()}`;
    if (/^(Edit|Write|MultiEdit|apply_patch)$/i.test(name)) return `Editing ${what.split("/").pop()}`;
    if (/^(Grep|Glob|Search|web_search)$/i.test(name)) return `Searching for ${what}`;
    return `Using ${name}`;
  };
  const question = sec("Latest message from the agent:").match(/([^.!?\n]*\?)\s*$/)?.[1]?.trim();
  const blocked = /^Status: blocked/m.test(prompt);
  return {
    goal: words(first, 12),
    now: blocked ? "Waiting at a permission prompt in its terminal" : question ? "Waiting for your answer to its question" : last ? words(verb(last), 15) : "Reading the request",
    next: blocked ? "Run the command once you answer" : question ? "Carry on once you reply" : "Report back with what changed",
    waiting_on: blocked ? "Your answer to its permission prompt" : question ? words(question, 14) : null,
  };
}

export class IntentionsService {
  private queue: string[] = [];
  private queued = new Set<string>();
  private running = new Set<string>();
  private timers = new Map<string, NodeJS.Timeout>();
  private lastRun = new Map<string, number>();
  private failures = new Map<string, { at: number; error: string }>();
  private explicit = new Set<string>();
  stopped = false;

  constructor(private ctx: Ctx, private opts: { debounceMs?: number; maxConcurrent?: number; idleDays?: number; eventDelayMs?: number; failureBackoffMs?: number } = {}) {}

  private get debounceMs() { return this.opts.debounceMs ?? Number(process.env.JOYRIDE_INTENT_DEBOUNCE_MS ?? 60_000); }
  private get maxConcurrent() { return this.opts.maxConcurrent ?? Number(process.env.JOYRIDE_INTENT_CONCURRENCY ?? 4); }
  private get idleMs() { return (this.opts.idleDays ?? 7) * 864e5; }
  private get eventDelayMs() { return this.opts.eventDelayMs ?? Number(process.env.JOYRIDE_INTENT_EVENT_DELAY_MS ?? 4000); }
  private get failureBackoffMs() { return this.opts.failureBackoffMs ?? 10 * 60_000; }

  private sessions(): any | null { return this.ctx.services.get("sessions") ?? null; }

  get(key: string): Intention | null {
    const row = this.ctx.db.prepare("SELECT json FROM intentions WHERE key = ?").get(key) as { json: string } | undefined;
    return row ? JSON.parse(row.json) : null;
  }

  private save(it: Intention) {
    this.ctx.db.prepare("INSERT INTO intentions(key, sig, generated, json) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET sig=excluded.sig, generated=excluded.generated, json=excluded.json")
      .run(it.key, it.sig, it.generated, JSON.stringify(it));
  }

  /** The state of one session's intention; with request, a missing or stale one is queued. */
  view(key: string, request: { explicit: boolean } | null = null): IntentionView {
    const intention = this.get(key);
    const s = this.sessions()?.get(key) as Session | null;
    const stale = Boolean(s && intention && intention.sig !== sessionSig(s));
    if (request && s && (!intention || stale) && (request.explicit || Date.now() - Date.parse(s.updated) <= this.idleMs)) this.request(key, request);
    const f = this.failures.get(key);
    return { key, intention, pending: this.isPending(key), stale, error: f && !intention ? f.error : null };
  }

  isPending(key: string) { return this.queued.has(key) || this.running.has(key) || this.timers.has(key); }

  /**
   * Ask for a fresh intention. explicit: someone opened this session (idle ones count too).
   * Runs at most once per debounce window per session; extra requests in the window coalesce.
   */
  request(key: string, o: { explicit?: boolean; delayMs?: number } = {}) {
    if (this.stopped) return;
    if (o.explicit) this.explicit.add(key);
    const f = this.failures.get(key);
    const t = Date.now();
    if (f && t - f.at < this.failureBackoffMs) return;
    const last = Math.max(this.lastRun.get(key) ?? 0, Date.parse(this.get(key)?.generated ?? "") || 0);
    const wait = Math.max(o.delayMs ?? 0, last ? last + this.debounceMs - t : 0);
    if (this.queued.has(key) || this.running.has(key)) return;
    const timer = this.timers.get(key);
    if (timer) return; // already scheduled; it reads the newest transcript when it runs
    if (wait <= 0) { this.enqueue(key); return; }
    const tm = setTimeout(() => { this.timers.delete(key); this.enqueue(key); }, wait);
    tm.unref?.();
    this.timers.set(key, tm);
  }

  private enqueue(key: string) {
    if (this.stopped || this.queued.has(key) || this.running.has(key)) return;
    this.queued.add(key);
    this.queue.push(key);
    this.pump();
  }

  private pump() {
    while (!this.stopped && this.running.size < this.maxConcurrent && this.queue.length) {
      const key = this.queue.shift()!;
      this.queued.delete(key);
      this.running.add(key);
      this.run(key).catch(() => {}).finally(() => { this.running.delete(key); this.pump(); });
    }
  }

  /** Generate now (used by the queue and tests). Returns the saved intention, or null when skipped. */
  async run(key: string): Promise<Intention | null> {
    const explicit = this.explicit.delete(key);
    const svc = this.sessions();
    const s = svc?.get(key) as Session | null;
    if (!s) return null;
    if (!explicit && Date.now() - Date.parse(s.updated) > this.idleMs) return null;
    const sig = sessionSig(s);
    const cached = this.get(key);
    if (cached && cached.sig === sig && !explicit) return cached;
    this.lastRun.set(key, Date.now());
    let turns: Turn[] = [];
    try { turns = ((await svc.transcript(key, { limit: 30 })) ?? []) as Turn[]; } catch {}
    if (!turns.some((t) => t.role === "user") && !s.first_prompt) return null; // nothing to describe yet
    let live: { status?: string | null; action?: string | null } = {};
    try { const w = this.ctx.services.get("workers")?.forSession(key); if (w) live = { status: w.status, action: w.current_action }; } catch {}
    try {
      const r: any = await llm(intentPrompt(s, turns, live), { task: "session_intent", schema: INTENT_SCHEMA, timeoutMs: 120_000 });
      const waiting = r?.waiting_on == null ? null : tidy(r.waiting_on, 14);
      const it: Intention = {
        key, goal: tidy(r?.goal, 12), now: tidy(r?.now, 15), next: tidy(r?.next, 15),
        waiting_on: waiting && !/^(null|none|nothing|n\/a)$/i.test(waiting) ? waiting : null, sig, generated: now(),
      };
      if (!it.goal) throw new Error("the model returned no goal");
      this.save(it);
      this.failures.delete(key);
      this.ctx.bus.change({ entity: "intentions", id: key });
      return it;
    } catch (e: any) {
      const error = `Couldn't describe this session: ${String(e?.message ?? e).slice(0, 300)}`;
      this.failures.set(key, { at: Date.now(), error });
      this.ctx.log(`intentions: ${key}: ${error}`);
      this.ctx.bus.change({ entity: "intentions", id: key });
      return null;
    }
  }

  onEvent(e: { source: string; type: string; session?: string; agent?: string }) {
    if (!e.source?.startsWith("hook.") || !e.session) return;
    if (e.type !== "turn.stop" && e.type !== "prompt.submit") return;
    const agent = e.agent ?? e.source.slice(5);
    if (agent !== "claude" && agent !== "codex") return;
    // Give the transcript a moment to land on disk before reading it.
    this.request(`${agent}:${e.session}`, { delayMs: this.eventDelayMs });
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.queue = [];
    this.queued.clear();
  }

  api() {
    return {
      get: (key: string) => this.get(key),
      view: (key: string, explicit = true) => this.view(key, { explicit }),
      list: (keys: string[]) => keys.map((k) => this.view(k, { explicit: false })),
      request: (key: string, o?: { explicit?: boolean }) => this.request(key, o),
      refresh: (key: string) => this.run(key),
    };
  }
}

let svc: IntentionsService | null = null;

export default defineModule({
  name: "intentions",
  order: 75,
  migrations: { "001": SQL },
  register(ctx: Ctx) {
    if (fakeModels()) registerLlmFake("session_intent", (prompt) => fakeIntent(prompt));
    const s = (svc = new IntentionsService(ctx));
    ctx.services.set("intentions", s.api());
    ctx.bus.onEvent((e) => s.onEvent(e));

    ctx.app.get("/api/intentions", (c) => {
      const keys = [...new Set((c.req.query("keys") ?? "").split(",").map((k) => k.trim()).filter(Boolean))].slice(0, 300);
      const items: Record<string, Intention> = {};
      const pending: string[] = [];
      for (const v of s.api().list(keys)) {
        if (v.intention) items[v.key] = v.intention;
        if (v.pending) pending.push(v.key);
      }
      return c.json({ items, pending });
    });
    ctx.app.get("/api/intentions/:key", (c) => {
      const key = c.req.param("key");
      if (!ctx.services.get("sessions")?.get(key) && !s.get(key)) return c.json({ error: `No session ${key}. Check the key (source:id).` }, 404);
      if (c.req.query("refresh") === "1") s.request(key, { explicit: true });
      return c.json(s.view(key, { explicit: true }));
    });
  },
  start() { if (svc) svc.stopped = false; },
  stop() { svc?.stop(); },
});
