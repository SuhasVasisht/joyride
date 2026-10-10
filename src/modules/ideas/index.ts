// Files unplaced Firstmate tasks into ideas with Jev and idea_naming.
// Each placement is one authored grouping commit with a ledger and Undo.
import fs from "node:fs";
import path from "node:path";
import { defineModule, type Ctx } from "../../core/context.ts";
import { kvGet, kvSet } from "../../core/db.ts";
import { jev, jevAvailable, probs, pick, q } from "../../core/jev.ts";
import { llm } from "../../core/llm.ts";
import { ensureDir, git, now, readJson, rid, truncate, writeJsonAtomic } from "../../core/util.ts";
import { MapActor } from "../../shared/map-actions.ts";
import { paths } from "../../shared/paths.ts";
import type { Lens, Mission } from "../../shared/schema.ts";
import {
  PIN_DAYS, briefExcerpt, opSignature, parseGitLog, pinsFromLog, placementFromJev, summarize, validatePlan,
  type OpResult, type Pins, PlacementOp, type World, type WorldTask,
} from "./plan.ts";
import { NAMING_SCHEMA, namingPrompt, type Naming } from "./prompts.ts";

export type RunKind = "place";
export type Run = {
  id: string;
  kind: RunKind;
  trigger: string; // backfill | task | manual | start
  dry_run: boolean;
  at: string;
  ms: number;
  models: { place?: string; naming?: string };
  summary: string;
  ops: (OpResult & { via?: string })[];
  commit: string | null;
  error: string | null;
  undone: { at: string; commit: string | null } | null;
};
export type IdeasService = {
  place(opts?: { dryRun?: boolean; trigger?: string; tasks?: string[] }): Promise<Run>;
  undo(runOrCommit: string, actor?: MapActor): { run: Run; commit: string | null; message: string };
  log(limit?: number): Run[];
  pins(): Pins;
  /** Resolves when no run is in progress (tests). */
  idle(): Promise<void>;
};

class IdeasError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

// Rate limits for runs housekeeping starts on its own (routes run when asked, one at a time).
export const LIMITS = {
  placeBatch: 20, // tasks per placement run
  placeGapMs: 60_000, // between automatic placement runs
  placeRetryMs: 6 * 36e5, // before a task that could not be placed is tried again
  namingPerHour: 30, // idea_naming calls
};
const LEDGER_MAX = 500;

const ledgerFile = () => path.join(paths.runtime, "ideas", "ledger.json");
const modelOf = (task: string, ctx: Ctx) => {
  const c = ctx.config.llm.tasks[task] ?? ctx.config.llm.default;
  return `${c.model}${c.effort ? ` (${c.effort})` : ""}${c.account ? ` on ${c.account}` : ""}`;
};

function autoEnabled(ctx: Ctx): boolean {
  const env = process.env.JOYRIDE_HOUSEKEEPING;
  if (env === "0") return false;
  if (env === "1") return true;
  return ctx.config.housekeeping?.auto !== false;
}

let lifecycle: { start(): void; stop(): void } | null = null;

export default defineModule({
  name: "ideas",
  order: 70, // after missions (15), live (workers) and firstmate (60)

  register(ctx: Ctx) {
    const { app, db } = ctx;
    const optional = (name: string): any => ctx.services.get(name);
    const missionsSvc = () => {
      const m = optional("missions");
      if (!m) throw new IdeasError("The missions module is not running, so there are no ideas to place tasks in.", 503);
      return m;
    };

    // ---------- ledger ----------
    const readLedger = (): Run[] => { const l = readJson<Run[]>(ledgerFile(), []); return Array.isArray(l) ? l : []; };
    function record(run: Run) {
      ensureDir(path.dirname(ledgerFile()));
      const list = readLedger().filter((r) => r.id !== run.id);
      list.unshift(run);
      writeJsonAtomic(ledgerFile(), list.slice(0, LEDGER_MAX));
      ctx.bus.change({ entity: "ideas", id: run.id });
    }
    /** Ops the captain undid, and tasks whose placement the captain undid: housekeeping never repeats them. */
    function vetoes(): { ops: Set<string>; tasks: Set<string> } {
      const ops = new Set<string>(), tasks = new Set<string>();
      for (const r of readLedger()) {
        if (!r.undone) continue;
        for (const o of r.ops) {
          if (o.status !== "applied") continue;
          const parsed = PlacementOp.safeParse(o.op);
          if (!parsed.success) continue;
          const op = parsed.data;
          ops.add(opSignature(op));
          if (r.kind === "place") { if (op.op === "move" && op.task) tasks.add(op.task); if (op.op === "create") for (const t of op.tasks) tasks.add(t); }
        }
      }
      return { ops, tasks };
    }

    // ---------- the world ----------
    function readPins(): Pins {
      const fmt = "--format=%x00%H%x09%aI%x09%s";
      const recent = git(paths.root, ["log", `--since=${PIN_DAYS}.days.ago`, fmt, "--name-only", "--no-renames", "--", "missions", "lenses"], { allowFail: true });
      const moves = git(paths.root, ["log", "-n", "5000", "--grep=^joyride: map move", fmt, "--", "missions", "lenses"], { allowFail: true });
      return pinsFromLog([...parseGitLog(recent), ...parseGitLog(moves)], Date.now());
    }

    function tasksNow(): (WorldTask & { kind: string; repo: string | null; project: string | null; brief: string | null; last_event: string; secondmate: string | null })[] {
      try {
        return (optional("firstmate")?.tasks() ?? []).map((t: any) => ({
          id: t.id, title: t.title, status: t.status, section: t.section ?? null, mission: t.mission ?? null,
          kind: t.kind ?? "", repo: t.repo ?? null, project: t.project ?? null, brief: t.brief ?? null, last_event: t.last_event ?? "", secondmate: t.secondmate ?? null,
        }));
      } catch { return []; }
    }

    function world(): World {
      const ms = missionsSvc();
      const missions: Mission[] = ms.list({}).map(({ health: _h, health_why: _w, ...m }: any) => m as Mission);
      const lenses: Lens[] = optional("lenses")?.list() ?? [];
      // The authored link is the truth even before Firstmate's projection has re-read it.
      const tasks = tasksNow().map((t) => ({ ...t, mission: ms.missionOfTask(t.id) ?? t.mission }));
      const v = vetoes();
      return {
        missions, lenses, tasks, pins: readPins(), vetoes: v.ops, now: now(),
      };
    }

    // ---------- applying ----------
    function commitRun(run: Run, w: World, ops: unknown[], maxOps: number): Run {
      const plan = validatePlan(w, ops, { maxOps, apply: !run.dry_run });
      const vias = run.ops;
      run.ops = plan.results.map((r, i) => ({ ...r, ...(vias[i]?.via ? { via: vias[i].via } : {}) }));
      run.summary = summarize(plan.results);
      if (!run.dry_run && (plan.missions.length || plan.lenses.length)) {
        const what = `file ${run.ops.filter((o) => o.status === "applied").length} Firstmate task${run.ops.filter((o) => o.status === "applied").length === 1 ? "" : "s"} into ideas`;
        run.commit = missionsSvc().applyGrouping({ missions: plan.missions, lenses: plan.lenses }, truncate(`housekeeping: ${what}: ${run.summary}`, 240));
      }
      return run;
    }

    const newRun = (kind: RunKind, trigger: string, dryRun: boolean): Run => ({
      id: rid(`hk-${kind}-`), kind, trigger, dry_run: dryRun, at: now(), ms: 0, models: {}, summary: "", ops: [], commit: null, error: null, undone: null,
    });

    // One placement run at a time.
    let chain: Promise<unknown> = Promise.resolve();
    function serial<T>(fn: () => Promise<T>): Promise<T> {
      const p = chain.then(fn);
      chain = p.catch(() => {});
      return p;
    }

    // ---------- place ----------
    const namingCalls: number[] = [];
    const namingBudget = () => { const cut = Date.now() - 36e5; while (namingCalls.length && namingCalls[0] < cut) namingCalls.shift(); return namingCalls.length < LIMITS.namingPerHour; };

    async function doPlace(opts: { dryRun?: boolean; trigger?: string; tasks?: string[] }): Promise<Run> {
      const t0 = Date.now();
      const run = newRun("place", opts.trigger ?? "manual", Boolean(opts.dryRun));
      run.models = { place: "jev", naming: modelOf("idea_naming", ctx) };
      try {
        const w = world();
        const v = vetoes();
        const attempts = kvGet<Record<string, string>>(db, "ideas:place_attempts", {});
        const retryCut = new Date(Date.now() - LIMITS.placeRetryMs).toISOString();
        const all = w.tasks as ReturnType<typeof tasksNow>;
        const want = opts.tasks?.length ? new Set(opts.tasks) : null;
        const todo = all.filter((t) =>
          !t.mission && !w.pins.tasks.has(t.id) && !v.tasks.has(t.id) && (!want || want.has(t.id))
          && (want || opts.trigger === "manual" || opts.trigger === "backfill" || !attempts[t.id] || attempts[t.id] < retryCut),
        ).slice(0, LIMITS.placeBatch);
        if (!todo.length) { run.summary = "no unfiled tasks"; return run; }

        const open = w.missions.filter((m) => !m.archive && m.state === "open").sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, 30);
        const tasksOf = (id: string) => all.filter((t) => t.mission === id).map((t) => t.title).slice(0, 5);
        // New ideas this run creates, so later tasks in the same run can join them (keyed "pending:<n>", never a mission id).
        const pending: { key: string; title: string; goal: string; group: string; tasks: string[] }[] = [];
        const ops: PlacementOp[] = [];
        const vias: { via: string }[] = [];
        const groups = w.lenses.map((l) => ({ id: l.id, title: l.title }));

        for (const t of todo) {
          attempts[t.id] = now();
          let brief = "";
          try { if (t.brief) brief = briefExcerpt(fs.readFileSync(t.brief, "utf8")); } catch {}
          const task = { id: t.id, title: t.title, kind: t.kind, repo: t.repo, brief, last_event: truncate(t.last_event, 200) };
          const ideas = [
            ...open.map((m) => ({ id: m.id, title: m.title, goal: truncate(m.goal.replace(/\s+/g, " "), 240), tasks: tasksOf(m.id) })),
            ...pending.map((p) => ({ id: p.key, title: p.title, goal: p.goal, tasks: p.tasks.map((x) => all.find((y) => y.id === x)?.title ?? x) })),
          ];
          let placed: { idea: string; via: string } | null = null;
          let candidates: string[] = [];
          if (ideas.length && jevAvailable()) {
            const criteria: Record<string, string> = { new: "None of these ideas; this task starts a separate stream of work." };
            for (const i of ideas) criteria[i.id] = `${i.title}. ${i.goal}${i.tasks.length ? ` Tasks: ${i.tasks.join("; ")}` : ""}`;
            try {
              const r = await jev({ task }, { idea: q.choice("A Firstmate task was filed without an idea. An idea is one stream of the captain's intent. Which idea is this task part of? Choose new when none clearly fits.", criteria) }, { timeoutMs: 15000, retries: 1 });
              const pl = placementFromJev(pick(r, "idea"), probs(r, "idea"), ideas.map((i) => i.id));
              candidates = pl.candidates;
              if (!pl.escalate && pl.idea) placed = { idea: pl.idea, via: `jev ${pl.p.toFixed(2)}` };
            } catch (e: any) { ctx.log(`ideas: jev placement for ${t.id} failed: ${e.message}`); }
          }
          if (!placed) {
            if (!namingBudget()) { ctx.log(`ideas: idea_naming budget used up; ${t.id} waits for the next run`); delete attempts[t.id]; continue; }
            namingCalls.push(Date.now());
            const shortlist = candidates.length ? ideas.filter((i) => candidates.includes(i.id)) : ideas.slice(0, 12);
            let n: Naming;
            try { n = await llm<Naming>(namingPrompt({ task, ideas: shortlist, groups }), { task: "idea_naming", schema: NAMING_SCHEMA, timeoutMs: 240000 }); }
            catch (e: any) { ctx.log(`ideas: idea_naming for ${t.id} failed: ${e.message}`); continue; }
            const existing = String(n?.existing ?? "").trim();
            if (existing && ideas.some((i) => i.id === existing)) placed = { idea: existing, via: "idea_naming" };
            else {
              const title = truncate(String(n?.title ?? "").trim() || t.title, 100);
              const same = pending.find((p) => p.title.toLowerCase() === title.toLowerCase());
              const openSame = open.find((m) => m.title.toLowerCase() === title.toLowerCase());
              if (openSame) placed = { idea: openSame.id, via: "idea_naming" };
              else if (same) placed = { idea: same.key, via: "idea_naming" };
              else {
                const p = { key: `pending:${pending.length + 1}`, title, goal: truncate(String(n?.goal ?? "").trim(), 600), group: String(n?.group ?? "").trim(), tasks: [t.id] };
                pending.push(p);
                continue;
              }
            }
          }
          const p = pending.find((x) => x.key === placed!.idea);
          if (p) { p.tasks.push(t.id); continue; }
          ops.push({ op: "move", task: t.id, to: placed.idea, from: null, why: "" });
          vias.push({ via: placed.via });
        }
        for (const p of pending) {
          ops.push({ op: "create", title: p.title, goal: p.goal, ...(p.group ? { group: p.group } : {}), tasks: p.tasks, why: "" });
          vias.push({ via: "idea_naming" });
        }
        if (!run.dry_run) kvSet(db, "ideas:place_attempts", attempts);
        run.ops = vias.map((x) => ({ op: {}, status: "proposed", text: "", via: x.via }));
        // Validate against the world as it is now: anything the captain did while the models ran wins.
        commitRun(run, world(), ops, LIMITS.placeBatch * 2);
        return run;
      } catch (e: any) {
        run.error = e.message;
        return run;
      } finally {
        run.ms = Date.now() - t0;
        if (run.ops.length || run.error || run.commit) record(run);
      }
    }

    // ---------- undo ----------
    function undo(key: string, actor?: MapActor) {
      const list = readLedger();
      const run = list.find((r) => r.id === key) ?? list.find((r) => r.commit && key.length >= 7 && r.commit.startsWith(key));
      if (!run) throw new IdeasError(`No housekeeping run ${key}. Pick one from GET /api/ideas/log.`, 404);
      if (run.undone) throw new IdeasError("That run is already undone.", 409);
      if (!run.commit) throw new IdeasError("That run changed nothing, so there is nothing to undo.", 409);
      let r: { commit: string | null; message: string };
      try { r = missionsSvc().undoHousekeeping(run.commit, actor); }
      catch (e: any) { throw new IdeasError(e.message, e.status ?? 409); }
      const next: Run = { ...run, undone: { at: now(), commit: r.commit } };
      record(next);
      return { run: next, commit: r.commit, message: r.message };
    }

    const service: IdeasService = {
      place: (o = {}) => serial(() => doPlace(o)),
      undo,
      log: (limit = 50) => readLedger().slice(0, limit),
      pins: readPins,
      idle: () => chain.then(() => {}),
    };
    ctx.services.set("ideas", service);

    // ---------- routes ----------
    const body = async (c: any) => { try { return (await c.req.json()) ?? {}; } catch { return {}; } };
    const wrap = (fn: (c: any) => any) => async (c: any) => {
      try { return await fn(c); }
      catch (e: any) { return c.json({ error: e.message }, e instanceof IdeasError ? e.status : e?.status ?? 500); }
    };
    const mapOf = (m: Map<string, string>) => Object.fromEntries(m);
    app.post("/api/ideas/place", wrap(async (c) => {
      const b = await body(c);
      return c.json(await service.place({ dryRun: Boolean(b.dry_run), trigger: b.trigger === "backfill" ? "backfill" : "manual", tasks: Array.isArray(b.tasks) ? b.tasks.map(String) : undefined }));
    }));
    app.get("/api/ideas/log", wrap((c) => c.json(service.log(Math.min(Number(c.req.query("limit") ?? 50) || 50, LEDGER_MAX)))));
    app.post("/api/ideas/undo", wrap(async (c) => {
      const b = await body(c);
      const key = String(b.run ?? b.commit ?? "");
      if (!key) throw new IdeasError("Send {run} with the run id from the log, or {commit}.");
      const actor = b.actor === undefined ? undefined : MapActor.safeParse(b.actor);
      if (actor && !actor.success) throw new IdeasError("Send a valid agent actor {kind: agent, id, via: cli or mcp}.");
      return c.json(undo(key, actor?.success ? actor.data : undefined));
    }));
    app.get("/api/ideas/pins", wrap((c) => { const p = readPins(); return c.json({ ideas: mapOf(p.ideas), tasks: mapOf(p.tasks), sessions: mapOf(p.sessions), grouped: mapOf(p.grouped) }); }));

    // ---------- triggers (automatic runs only) ----------
    let placeTimer: NodeJS.Timeout | null = null;
    let lastPlace = 0;
    let offChange: (() => void) | null = null;
    const auto = () => autoEnabled(ctx);

    function schedulePlace(trigger: string, delay = 30_000) {
      if (!auto() || placeTimer) return;
      const wait = Math.max(delay, lastPlace + LIMITS.placeGapMs - Date.now());
      placeTimer = setTimeout(() => {
        placeTimer = null;
        lastPlace = Date.now();
        service.place({ trigger }).catch((e) => ctx.log(`ideas: placement failed: ${e.message}`));
      }, wait);
      placeTimer.unref?.();
    }
    lifecycle = {
      start() {
        if (!auto()) return;
        offChange = ctx.bus.onChange((ch) => {
          if (ch.entity !== "tasks") return;
          if (tasksNow().some((t) => !t.mission)) schedulePlace("task");
        });
        // The first run after start-up files every task that has no idea yet: the backfill.
        Promise.resolve(optional("missions")?.settled?.()).then(() => {
          const first = !kvGet(db, "ideas:backfill_done", null);
          schedulePlace(first ? "backfill" : "start", 5_000);
          if (first) kvSet(db, "ideas:backfill_done", { at: now() });
        }).catch(() => {});
      },
      stop() {
        if (placeTimer) clearTimeout(placeTimer);
        placeTimer = null;
        offChange?.();
      },
    };
  },
  start() { lifecycle?.start(); },
  stop() { lifecycle?.stop(); },
});
