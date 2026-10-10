// Asks (control plane CP0): one projected list of everything the captain owes, each
// placed on the task, worker or idea it belongs to. Projection reads the
// firstmate, attention, guard and workers services. CP1's captain-only answer_ask
// intent routes answers through the owner and records an authored answer note.
// Options come from the text ("1) … (A, recommended) …"); otherwise a cached ask_options
// extraction (cheap model, keyed by text hash) suggests them in the background.
//   service `asks`: list(filter?), get(id), response(filter?), refresh()
//   routes: GET /api/asks[?needs_you=1&kind=&task=&mission=&worker=], GET /api/asks/:id
//   bus entity: asks
import fs from "node:fs";
import path from "node:path";
import { defineModule, type Ctx } from "../../core/context.ts";
import { kvGet, kvSet } from "../../core/db.ts";
import { llm } from "../../core/llm.ts";
import { fakeModels, registerLlmFake } from "../../core/fakes.ts";
import { now, sha256 } from "../../core/util.ts";
import type { AttentionItem, GuardRequest, WorkerView } from "../../shared/schema.ts";
import type { Ask, AskCall, AskKind, AsksResponse } from "../../shared/asks.ts";
import { parseBacklog, type HomeState } from "../firstmate/state.ts";
import { buildAsks, crosscheck, type Suggestion } from "./build.ts";
import { registerAnswers } from "./answer.ts";
import { registerRecheck } from "./recheck.ts";

export type AskFilter = { needs_you?: boolean; kind?: AskKind; task?: string; mission?: string; worker?: string };
export type AsksApi = {
  list(f?: AskFilter): Ask[];
  get(id: string): Ask | null;
  response(f?: AskFilter): AsksResponse;
  refresh(): boolean;
  registerSource(name: string, source: () => Ask[]): () => void;
};

const OPTIONS_SCHEMA = {
  type: "object",
  properties: {
    calls: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          options: { type: "array", items: { type: "object", properties: { label: { type: "string" }, recommended: { type: "boolean" } }, required: ["label", "recommended"] } },
        },
        required: ["question", "options"],
      },
    },
  },
  required: ["calls"],
};

export const optionsPrompt = (text: string) => `A worker or Firstmate asked the captain the question below. List the answers the captain could pick.
Rules:
- One entry in "calls" per separate decision; most questions have one.
- 2 to 4 short options per call, each a plain-verb answer the captain could send as is ("Fix the race first").
- Mark an option recommended only when the question itself says which one is recommended or preferred.
- Use only choices the question names or clearly implies; never invent new work. If it names none, return the obvious yes/no pair.

Question:
"""
${text.slice(0, 4000)}
"""`;

type Cached = { status: "ok"; calls: AskCall[]; at: string } | { status: "failed"; error: string; at: string };
const RETRY_FAILED_MS = 3600e3;
const MAX_QUEUE = 20;

let lifecycle: { start(): void; stop(): void } | null = null;

function toCalls(raw: any): AskCall[] {
  const calls = Array.isArray(raw?.calls) ? raw.calls : [];
  return calls.slice(0, 6).map((c: any, i: number) => ({
    n: calls.length > 1 ? i + 1 : null,
    question: String(c?.question ?? "").slice(0, 400),
    options: (Array.isArray(c?.options) ? c.options : []).slice(0, 4).map((o: any, j: number) => ({ id: String.fromCharCode(65 + j), label: String(o?.label ?? "").slice(0, 200), recommended: o?.recommended === true })).filter((o: any) => o.label),
  })).filter((c: AskCall) => c.options.length >= 2);
}

/** Under fake models: a deterministic yes/no pair, so tests see the suggested path end to end. */
function fakeOptions(prompt: string) {
  const q = prompt.match(/"""\n([\s\S]*?)\n"""/)?.[1]?.trim() ?? "";
  return { calls: [{ question: q.slice(0, 200), options: [{ label: "Go ahead as proposed", recommended: false }, { label: "Hold off for now", recommended: false }] }] };
}

export default defineModule({
  name: "asks",
  order: 70, // after guard, attention, live and firstmate
  register(ctx: Ctx) {
    const { app, db } = ctx;
    if (fakeModels()) registerLlmFake("ask_options", fakeOptions);
    const optional = <T,>(name: string): T | null => (ctx.services.get(name) as T | undefined) ?? null;
    const escalateMs = () => Number(process.env.JOYRIDE_ASKS_ESCALATE_MS ?? 20 * 60e3);

    // ---------- ask_options: cached, one call at a time, never on the request path ----------
    const queue: string[] = [];
    const queued = new Set<string>();
    let running = false;
    const cacheKey = (text: string) => `asks:options:${sha256(text.trim())}`;
    function suggest(text: string): Suggestion {
      const hit = kvGet<Cached | null>(db, cacheKey(text), null);
      if (hit?.status === "ok") return { status: "ok", calls: hit.calls };
      if (hit?.status === "failed" && Date.now() - Date.parse(hit.at) < RETRY_FAILED_MS) return { status: "none" };
      if (!queued.has(text) && queue.length < MAX_QUEUE) { queued.add(text); queue.push(text); void pump(); }
      return queued.has(text) ? { status: "pending" } : { status: "none" };
    }
    async function pump() {
      if (running) return;
      running = true;
      try {
        while (queue.length) {
          const text = queue.shift()!;
          let rec: Cached;
          try {
            const raw = await llm(optionsPrompt(text), { task: "ask_options", schema: OPTIONS_SCHEMA, timeoutMs: 90_000 });
            const calls = toCalls(raw);
            rec = calls.length ? { status: "ok", calls, at: now() } : { status: "failed", error: "no options in the model's answer", at: now() };
          } catch (e: any) { rec = { status: "failed", error: String(e?.message ?? e).slice(0, 300), at: now() }; }
          kvSet(db, cacheKey(text), rec);
          queued.delete(text);
          refresh();
        }
      } finally { running = false; }
    }

    const sources = new Map<string, () => Ask[]>();
    // ---------- projection ----------
    function secondmateRows(home: HomeState) {
      const out: { id: string; rows: ReturnType<typeof parseBacklog> }[] = [];
      for (const sm of home.secondmates) {
        if (!sm.home || path.resolve(sm.home) === path.resolve(home.home)) continue;
        try { out.push({ id: sm.id, rows: parseBacklog(fs.readFileSync(path.join(sm.home, "data", "backlog.md"), "utf8")) }); } catch { /* unreadable or remote home: nothing to show */ }
      }
      return out;
    }
    function compute(): AsksResponse {
      const fm = optional<any>("firstmate");
      const home: HomeState | null = fm?.home?.() ?? null;
      let attention: AttentionItem[] = [], guard: GuardRequest[] = [], workers: WorkerView[] = [];
      try { attention = optional<any>("attention")?.list({ open: true, limit: 500 }) ?? []; } catch {}
      try { guard = optional<any>("guard")?.pending() ?? []; } catch {}
      try { workers = optional<any>("workers")?.list() ?? []; } catch {}
      let fmRunning = false;
      try { fmRunning = Boolean(fm?.controlWorker?.()); } catch {}
      const asks = buildAsks({
        tasks: home?.tasks ?? [], secondmates: home ? secondmateRows(home) : [], attention, guard, workers,
        firstmate: { running: fmRunning, wake_oldest: home?.wake.oldest ?? null },
        suggest, escalateMs: escalateMs(),
      });
      for (const source of sources.values()) asks.push(...source());
      const by_kind: Partial<Record<AskKind, number>> = {};
      for (const a of asks) by_kind[a.kind] = (by_kind[a.kind] ?? 0) + 1;
      return {
        asks,
        counts: { total: asks.length, needs_you: asks.filter((a) => a.needs_you).length, by_kind },
        crosscheck: crosscheck(asks, home?.summary ?? null, home?.summary_decisions ?? []),
        firstmate: { running: fmRunning, wake_pending: home?.wake.pending ?? 0, wake_oldest: home?.wake.oldest ?? null },
        generated: now(),
      };
    }

    let last: AsksResponse | null = null;
    let sig = "";
    /** Recompute; announce "asks" when the set, a state or an option changed. */
    function refresh(): boolean {
      last = compute();
      const next = JSON.stringify(last.asks.map((a) => [a.id, a.needs_you, a.state, a.options_source, a.calls, a.place, a.question]));
      const changed = next !== sig;
      sig = next;
      if (changed) ctx.bus.change({ entity: "asks" });
      return changed;
    }
    const match = (f: AskFilter = {}) => (a: Ask) =>
      (f.needs_you === undefined || a.needs_you === f.needs_you) && (!f.kind || a.kind === f.kind) && (!f.task || a.task === f.task || a.place.id === f.task)
      && (!f.mission || a.mission === f.mission) && (!f.worker || a.worker === f.worker);

    const api: AsksApi = {
      list: (f) => { refresh(); return last!.asks.filter(match(f)); },
      get: (id) => { refresh(); return last!.asks.find((a) => a.id === id) ?? null; },
      response: (f) => {
        refresh();
        const asks = last!.asks.filter(match(f));
        const by_kind: Partial<Record<AskKind, number>> = {};
        for (const a of asks) by_kind[a.kind] = (by_kind[a.kind] ?? 0) + 1;
        return { ...last!, asks, counts: { total: asks.length, needs_you: asks.filter((a) => a.needs_you).length, by_kind } };
      },
      refresh,
      registerSource: (name, source) => { sources.set(name, source); return () => { sources.delete(name); }; },
    };
    ctx.services.set("asks", api);
    registerAnswers(ctx, api);
    registerRecheck(ctx, api);

    // ---------- routes ----------
    const bool = (v: string | undefined) => (v === undefined || v === "" ? undefined : ["1", "true", "yes"].includes(v));
    app.get("/api/asks", (c) => {
      const q = c.req.query();
      return c.json(api.response({ needs_you: bool(q.needs_you), kind: (q.kind || undefined) as AskKind | undefined, task: q.task || undefined, mission: q.mission || q.idea || undefined, worker: q.worker || undefined }));
    });
    app.get("/api/asks/:id", (c) => {
      const a = api.get(c.req.param("id"));
      return a ? c.json(a) : c.json({ error: `There is no open ask ${c.req.param("id")}. It may have been answered already.` }, 404);
    });

    // ---------- watching ----------
    let debounce: NodeJS.Timeout | null = null;
    const kick = () => { if (debounce) clearTimeout(debounce); debounce = setTimeout(() => { debounce = null; try { refresh(); } catch (e: any) { ctx.log(`asks: refresh failed: ${e.message}`); } }, 200); debounce.unref(); };
    const SOURCES = new Set(["tasks", "attention", "guard", "workers", "fleet"]);
    const offChange = ctx.bus.onChange((ch) => { if (SOURCES.has(ch.entity)) kick(); });
    let tick: NodeJS.Timeout | null = null;
    lifecycle = {
      // Escalation is time-based (a decision waiting on a stopped Firstmate), so re-check on a clock too.
      start: () => { tick = setInterval(kick, Number(process.env.JOYRIDE_ASKS_TICK_MS ?? 30_000)); tick.unref(); },
      stop: () => { if (tick) clearInterval(tick); if (debounce) clearTimeout(debounce); offChange(); },
    };
  },
  start() { lifecycle?.start(); },
  stop() { lifecycle?.stop(); },
});
