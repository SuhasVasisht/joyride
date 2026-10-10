// Nudges and generative updates (control plane CP6). Small asks at the right moments, rate-limited so
// the map never shouts (rules.ts), plus each idea's generated headline, now and next (idea_brief).
//   rules   task done 2 h ago → "how did it land?" 👍/👎; idea quiet 5 days with open tasks → keep, pause
//           or drop; fleet prune proposals → save and
//           close, or keep; Firstmate's own pane blocked → open its chat.
//   acts    every action runs through its owner: missions.setState, ideas.undo, the captain-only
//           answer_ask intent for prune asks. Dismissals are permanent; snoozes last 7 days.
//   feedback a note on the task tagged feedback; a 👎 also raises a learning candidate and files an inbox
//           note to Firstmate with the captain's words.
//   service `nudges`: response(), act(id, action, words?), feedback(input), brief(idea), briefs(), refresh()
//   routes: GET /api/nudges, POST /api/nudges/:id/act {action, words?}, POST /api/nudges/feedback {task, verdict, words?},
//           GET /api/nudges/briefs, GET /api/nudges/briefs/:idea, POST /api/nudges/briefs/:idea/refresh
//   bus entities: nudges (the visible set changed), idea_briefs (a brief was written)
import { defineModule, type Ctx } from "../../core/context.ts";
import { kvGet, kvSet } from "../../core/db.ts";
import { llm } from "../../core/llm.ts";
import { fakeModels, registerLlmFake } from "../../core/fakes.ts";
import { now, sha256, truncate } from "../../core/util.ts";
import type { NotesService } from "../notes/index.ts";
import type { MissionsService } from "../missions/index.ts";
import type { Ask } from "../../shared/asks.ts";
import { noteTitle, toBullets } from "../../shared/notes.ts";
import type { FeedbackResult, FeedbackVerdict, IdeaBrief, Nudge, UndoNotice, NudgesResponse, NudgeRule } from "../../shared/nudges.ts";
import { undoNotices } from "./undo.ts";
import { candidates, emptyState, limit, LIMITS, THRESHOLDS, type NudgeState, type RuleIdea, type RuleTask } from "./rules.ts";
import { BRIEF_SCHEMA, briefInput, briefPrompt, briefSig, cleanBrief, fakeBrief, type BriefRaw } from "./brief.ts";

export { LIMITS, THRESHOLDS };
export const BRIEF_LIMITS = { perHour: 30, debounceMs: 2000, timeoutMs: 120_000 };

export type NudgesService = {
  response(): NudgesResponse;
  undoNotices(): UndoNotice[];
  undo(id: string): { message: string; result?: unknown };
  act(id: string, action: string, words?: string): Promise<{ nudge: string; action: string; message: string; result?: unknown }>;
  feedback(input: { task: string; verdict: FeedbackVerdict; words?: string }): Promise<FeedbackResult>;
  brief(idea: string): IdeaBrief | null;
  briefs(): Record<string, IdeaBrief>;
  refresh(): boolean;
  /** Resolves when no idea_brief call is queued or running (tests). */
  idle(): Promise<void>;
};

class NudgeError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const STATE_KEY = "nudges:state";
const feedbackKey = (task: string) => `nudges:feedback:${task}`;
const briefKey = (idea: string) => `nudges:brief:${idea}`;

let lifecycle: { start(): void; stop(): void } | null = null;

export default defineModule({
  name: "nudges",
  order: 80, // after asks, ideas, notes and fleet
  register(ctx: Ctx) {
    const { app, db } = ctx;
    if (fakeModels()) registerLlmFake("idea_brief", fakeBrief);
    const optional = <T = any,>(name: string): T | null => (ctx.services.get(name) as T | undefined) ?? null;
    const readState = (): NudgeState => ({ ...emptyState(), ...kvGet<Partial<NudgeState>>(db, STATE_KEY, {}) });
    const writeState = (s: NudgeState) => kvSet(db, STATE_KEY, s);

    // ---------- the world the rules read ----------
    function tasks(): RuleTask[] {
      try {
        const ms = optional<any>("missions");
        return (optional<any>("firstmate")?.tasks() ?? []).map((t: any) => ({
          id: t.id, title: t.title ?? t.id, section: t.section ?? null, status: t.status ?? "", updated: t.updated ?? null,
          mission: ms?.missionOfTask?.(t.id) ?? t.mission ?? null, last_event: t.last_event ?? "",
        }));
      } catch { return []; }
    }
    function ideas(): (RuleIdea & { goal: string })[] {
      const sessions = optional<any>("sessions");
      try {
        return (optional<any>("missions")?.list({}) ?? []).map((m: any) => {
          let last: string | null = null;
          for (const r of m.sessions ?? []) { const s = sessions?.get?.(`${r.source}:${r.id}`); if (s?.updated && (!last || s.updated > last)) last = s.updated; }
          return { id: m.id, title: m.title, goal: m.goal ?? "", state: m.state, archive: Boolean(m.archive), last_activity: last };
        });
      } catch { return []; }
    }
    const blockedSince = new Map<string, string>();
    function firstmateBlocked() {
      try {
        const id = optional<any>("firstmate")?.controlWorker?.();
        const w = id ? optional<any>("workers")?.get?.(id) : null;
        if (!w || w.status !== "blocked") { blockedSince.clear(); return null; }
        if (!blockedSince.has(id)) blockedSince.set(id, now());
        return { worker: id, title: w.title ?? "Firstmate", since: blockedSince.get(id)! };
      } catch { return null; }
    }
    function prunes(): Ask[] {
      try { return (optional<any>("asks")?.list({ kind: "approval" }) ?? []).filter((a: Ask) => a.answer.via === "prune"); } catch { return []; }
    }
    function feedbackGiven(ts: RuleTask[]): Set<string> {
      return new Set(ts.filter((t) => t.section === "done" && kvGet(db, feedbackKey(t.id), null)).map((t) => t.id));
    }

    const notices = () => undoNotices([
          ...(optional<any>("ideas")?.log?.(50) ?? []),
          ...(optional<import("../missions/index.ts").MissionsService>("missions")?.mapHistory() ?? [])
            .filter((r) => r.actor).map((r) => ({ ...r, kind: r.key ? "map-hide" : "map", dry_run: false, agent: r.actor?.id })),
        ], Date.now());

    function compute(): NudgesResponse {
      const ts = tasks();
      const all = candidates({
        now: Date.now(), tasks: ts, ideas: ideas(), prunes: prunes(),
        firstmate: firstmateBlocked(), feedback: feedbackGiven(ts),
      });
      const state = readState();
      const out = limit(all, state, Date.now());
      if (JSON.stringify(out.shown) !== JSON.stringify(state.shown)) writeState({ ...state, shown: out.shown });
      const by_rule: Partial<Record<NudgeRule, number>> = {};
      for (const n of out.nudges) by_rule[n.rule] = (by_rule[n.rule] ?? 0) + 1;
      return { nudges: out.nudges, overflow: out.overflow, counts: { visible: out.nudges.length, overflow: out.overflow.length, by_rule }, generated: now() };
    }

    let last: NudgesResponse | null = null;
    let sig = "";
    function refresh(): boolean {
      last = compute();
      const next = JSON.stringify([last.nudges.map((n) => [n.id, n.title, n.why]), last.overflow.map((n) => n.id), notices()]);
      const changed = next !== sig;
      sig = next;
      if (changed) ctx.bus.change({ entity: "nudges" });
      return changed;
    }
    const find = (id: string): Nudge | null => { refresh(); return last!.nudges.find((n) => n.id === id) ?? last!.overflow.find((n) => n.id === id) ?? null; };

    // ---------- acting ----------
    function mark(kind: "dismissed" | "snoozed", id: string, value: string) {
      const s = readState();
      s[kind] = { ...s[kind], [id]: value };
      writeState(s);
    }

    async function act(id: string, action: string, words?: string) {
      const n = find(id);
      if (!n) throw new NudgeError(`There is no open nudge ${id}. It may have been handled already; refresh to see what is left.`, 404);
      if (!n.actions.some((a) => a.id === action) && action !== "dismiss" && action !== "snooze") throw new NudgeError(`"${action}" is not an action of this nudge. Use one of: ${n.actions.map((a) => a.id).join(", ")}.`);
      const done = (message: string, result?: unknown) => { refresh(); return { nudge: id, action, message, ...(result === undefined ? {} : { result }) }; };
      switch (action) {
        case "dismiss": mark("dismissed", id, now()); return done("Dismissed.");
        case "snooze": mark("snoozed", id, new Date(Date.now() + LIMITS.snoozeMs).toISOString()); return done("Snoozed for 7 days.");
        case "keep": mark("snoozed", id, new Date(Date.now() + THRESHOLDS.quietMs).toISOString()); return done("Kept. It won't ask again for 5 days.");
        case "pause":
        case "drop": {
          const ms = optional<any>("missions");
          if (!ms || !n.mission) throw new NudgeError("The missions module is not running, so the idea can't change state. Restart the daemon and try again.", 503);
          const state = action === "pause" ? "paused" : "dropped";
          await ms.setState(n.mission, state, `the captain answered "Still want this?" on the map: ${action}`);
          mark("dismissed", id, now());
          return done(action === "pause" ? "Paused the idea." : "Dropped the idea.");
        }
        case "up":
        case "down": {
          if (!n.task) throw new NudgeError("This nudge has no task to give feedback on.");
          const r = await feedback({ task: n.task, verdict: action, words });
          return done(action === "up" ? "Thanks. Saved as a note on the task." : r.told_firstmate ? "Saved and told Firstmate." : "Saved as a note on the task.", r);
        }
        case "preserve":
        case "keep_open": {
          const intents = optional<any>("intents");
          if (!intents) throw new NudgeError("Intents are not running, so the prune answer can't be sent. Restart the daemon and try again.", 503);
          const it = await intents.create("answer_ask", String(n.ref.ask), { answer: action === "preserve" ? "A" : "B" }, { origin: "captain" });
          if (it.status === "failed") throw new NudgeError(it.error ?? "The prune answer failed. Review the ask on the fleet page.", 409);
          return done(action === "preserve" ? "Saving the session, then closing its pane." : "Keeping the pane open.", { intent: it.id, status: it.status });
        }
        case "open": return done("Opened.");
        default: throw new NudgeError(`"${action}" is not a nudge action.`);
      }
    }

    function undo(id: string) {
      const n = notices().find((n) => n.id === id);
      if (!n) throw new NudgeError("This edit is no longer available to undo. Open map history to find it.", 404);
      if (n.ref.kind === "map-hide") {
        const missions = optional<import("../missions/index.ts").MissionsService>("missions");
        if (!missions) throw new NudgeError("The missions module is unavailable. Check the daemon and try again.", 503);
        const result = missions.unhideOnMap(String(n.ref.key));
        return { message: result.message };
      }
      const owner = n.ref.kind === "map" ? optional<import("../missions/index.ts").MissionsService>("missions") : optional<any>("ideas");
      if (!owner) throw new NudgeError("The module that made this edit is unavailable. Check the daemon and try again.", 503);
      let r: { message: string; commit: string | null };
      try { r = n.ref.kind === "map" ? owner.undoMove(String(n.ref.commit)) : owner.undo(String(n.ref.run)); } catch (e: any) { throw new NudgeError(e.message, e.status ?? 409); }
      return { message: r.message || "Undone.", result: { commit: r.commit } };
    }

    // ---------- feedback ----------
    async function feedback(input: { task: string; verdict: FeedbackVerdict; words?: string }): Promise<FeedbackResult> {
      const task = String(input.task ?? "").trim();
      if (!task) throw new NudgeError("Say which task the feedback is for.");
      if (input.verdict !== "up" && input.verdict !== "down") throw new NudgeError("Feedback is up or down.");
      const notes = optional<NotesService>("notes");
      if (!notes) throw new NudgeError("The notes module is not running, so feedback can't be saved. Restart the daemon and try again.", 503);
      const t = tasks().find((x) => x.id === task) ?? null;
      const words = toBullets(input.words ?? "");
      const lead = input.verdict === "up" ? "Feedback: landed well" : "Feedback: didn't land well";
      const bullets = [lead, ...words];
      const note = notes.create({
        title: noteTitle([`${lead}${words[0] ? `: ${words[0]}` : ""}`]), bullets, task,
        tags: ["feedback", input.verdict === "up" ? "landed" : "missed"], provenance: { type: "human", ref: "map:feedback" },
      });
      try { optional<any>("notes")?.rebuildTaskDigests?.(); } catch { /* digest rebuilds on the next change */ }
      ctx.bus.change({ entity: "notes", id: note.id });
      let learning: string | null = null, told = false, fmError: string | null = null;
      if (input.verdict === "down") {
        const what = t?.title ?? task;
        const said = words.join(" ") || "no words given";
        try {
          const fm = optional<any>("firstmate");
          if (!fm) throw new Error("Firstmate is not available");
          await fm.note(`nudge-feedback-${sha256(note.id).slice(0, 20)}`, `Captain feedback on ${task}: didn't land well. ${said}. (Joyride note ${note.id})`);
          told = true;
        } catch (e: any) { fmError = `Couldn't tell Firstmate: ${String(e?.message ?? e).slice(0, 300)}`; }
      }
      kvSet(db, feedbackKey(task), { verdict: input.verdict, note: note.id, at: now() });
      refresh();
      return { note: note.id, learning, told_firstmate: told, firstmate_error: fmError };
    }

    // ---------- idea_brief ----------
    const queue: string[] = [];
    const queued = new Set<string>();
    const calls: number[] = [];
    let running: Promise<void> | null = null;
    const budget = () => { const cut = Date.now() - 36e5; while (calls.length && calls[0] < cut) calls.shift(); return calls.length < BRIEF_LIMITS.perHour; };
    const modelOf = () => { const c = ctx.config.llm.tasks.idea_brief ?? ctx.config.llm.default; return `${c.model}${c.effort ? ` (${c.effort})` : ""}`; };

    function inputOf(idea: string) {
      const i = optional<MissionsService>("missions")?.get(idea);
      if (!i || i.archive) return null;
      const ts = tasks().filter((t) => t.mission === idea);
      if (!ts.length) return null;
      return briefInput(i, ts);
    }
    function enqueue(idea: string) {
      if (queued.has(idea)) return;
      queued.add(idea); queue.push(idea);
      if (!running) running = pump().finally(() => { running = null; });
    }
    async function pump() {
      while (queue.length) {
        const idea = queue.shift()!;
        const input = inputOf(idea);
        if (!input) { queued.delete(idea); continue; }
        if (!budget()) { ctx.log("nudges: idea_brief budget used up; waiting for the next hour"); queued.delete(idea); queue.length = 0; for (const q of queue) queued.delete(q); break; }
        calls.push(Date.now());
        const sigNow = briefSig(input);
        const old = kvGet<IdeaBrief | null>(db, briefKey(idea), null);
        let rec: IdeaBrief;
        try {
          const raw = cleanBrief(await llm<BriefRaw>(briefPrompt(input), { task: "idea_brief", schema: BRIEF_SCHEMA, timeoutMs: BRIEF_LIMITS.timeoutMs }));
          if (!raw) throw new Error("the model returned no headline");
          rec = { idea, ...raw, sig: sigNow, at: now(), model: modelOf(), status: "ok" };
        } catch (e: any) {
          rec = { idea, headline: old?.headline ?? "", now: old?.now ?? "", next: old?.next ?? "", sig: sigNow, at: now(), model: modelOf(), status: "failed", error: String(e?.message ?? e).slice(0, 300) };
        }
        kvSet(db, briefKey(idea), rec);
        queued.delete(idea);
        ctx.bus.change({ entity: "idea_briefs", id: idea });
      }
    }
    function brief(idea: string, input = inputOf(idea)): IdeaBrief | null {
      const cached = kvGet<IdeaBrief | null>(db, briefKey(idea), null);
      if (!input) return cached;
      const s = briefSig(input);
      if (cached?.sig === s) return cached;
      enqueue(idea);
      if (cached) return { ...cached, status: "stale" };
      return { idea, headline: "", now: "", next: "", sig: s, at: now(), model: modelOf(), status: "pending" };
    }
    function briefs(): Record<string, IdeaBrief> {
      const out: Record<string, IdeaBrief> = {};
      const ts = tasks();
      for (const i of ideas()) {
        if (i.archive) continue;
        const picked = ts.filter(t => t.mission === i.id);
        const b = brief(i.id, picked.length ? briefInput(i, picked) : null);
        if (b) out[i.id] = b;
      }
      return out;
    }

    const service: NudgesService = {
      response: () => { refresh(); return last!; },
      act, feedback, brief, briefs, refresh, undo, undoNotices: notices,
      idle: async () => { while (running) await running; },
    };
    ctx.services.set("nudges", service);

    // ---------- routes ----------
    const body = async (c: any) => { try { return (await c.req.json()) ?? {}; } catch { return {}; } };
    const wrap = (fn: (c: any) => any) => async (c: any) => {
      try { return await fn(c); }
      catch (e: any) { return c.json({ error: e.message }, e instanceof NudgeError ? e.status : e?.status ?? 500); }
    };
    app.get("/api/nudges/undo-toasts", wrap((c) => c.json(notices())));
    app.post("/api/nudges/undo-toasts/:id/undo", wrap((c) => c.json(undo(c.req.param("id")))));
    app.get("/api/nudges", wrap((c) => c.json(service.response())));
    app.post("/api/nudges/feedback", wrap(async (c) => {
      const b = await body(c);
      if (b.origin && b.origin !== "captain") throw new NudgeError("Only the captain gives feedback on the map.", 403);
      return c.json(await feedback({ task: String(b.task ?? ""), verdict: b.verdict, words: typeof b.words === "string" ? b.words : undefined }));
    }));
    app.get("/api/nudges/briefs", wrap((c) => c.json(briefs())));
    app.get("/api/nudges/briefs/:idea", wrap((c) => {
      const b = brief(c.req.param("idea"));
      return b ? c.json(b) : c.json({ error: `There is no idea ${c.req.param("idea")} with tasks to brief.` }, 404);
    }));
    app.post("/api/nudges/briefs/:idea/refresh", wrap((c) => {
      const idea = c.req.param("idea");
      if (!inputOf(idea)) throw new NudgeError(`There is no idea ${idea} with tasks to brief.`, 404);
      kvSet(db, briefKey(idea), { ...(kvGet<IdeaBrief | null>(db, briefKey(idea), null) ?? {}), sig: "" });
      return c.json(brief(idea));
    }));
    app.post("/api/nudges/:id/act", wrap(async (c) => {
      const b = await body(c);
      if (b.origin && b.origin !== "captain") throw new NudgeError("Only the captain answers nudges.", 403);
      if (!b.action) throw new NudgeError("Send {action}, one of the nudge's actions.");
      return c.json(await act(c.req.param("id"), String(b.action), typeof b.words === "string" ? b.words : undefined));
    }));

    // ---------- watching ----------
    let debounce: NodeJS.Timeout | null = null, briefTimer: NodeJS.Timeout | null = null, tick: NodeJS.Timeout | null = null;
    let offChange: (() => void) | null = null;
    const kick = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => { debounce = null; try { refresh(); } catch (e: any) { ctx.log(`nudges: refresh failed: ${e.message}`); } }, 250);
      debounce.unref?.();
    };
    const autoBriefs = () => process.env.JOYRIDE_IDEA_BRIEFS !== "0";
    const kickBriefs = () => {
      if (!autoBriefs()) return;
      if (briefTimer) clearTimeout(briefTimer);
      briefTimer = setTimeout(() => { briefTimer = null; try { briefs(); } catch (e: any) { ctx.log(`nudges: idea briefs failed: ${e.message}`); } }, BRIEF_LIMITS.debounceMs);
      briefTimer.unref?.();
    };
    const SOURCES = new Set(["tasks", "missions", "lenses", "map-layout", "ideas", "asks", "workers", "fleet", "notes"]);
    lifecycle = {
      start() {
        offChange = ctx.bus.onChange((ch) => {
          if (!SOURCES.has(ch.entity)) return;
          kick();
          if (ch.entity === "tasks" || ch.entity === "missions") kickBriefs();
        });
        // The rules are time-based too (2 h after done, 5 quiet days).
        tick = setInterval(kick, Number(process.env.JOYRIDE_NUDGES_TICK_MS ?? 60_000));
        tick.unref?.();
        kick();
        kickBriefs();
      },
      stop() {
        for (const t of [debounce, briefTimer]) if (t) clearTimeout(t);
        if (tick) clearInterval(tick);
        offChange?.();
      },
    };
  },
  start() { lifecycle?.start(); },
  stop() { lifecycle?.stop(); },
});
