// Pure projection of everything the captain owes into one list of asks (DESIGN §3,
// control-plane report §3). Inputs are other modules' projections; nothing here reads
// files or calls a model, so tests can feed it fixtures directly.
//   backlog holds   -> captain_call   (orange while Firstmate's hold bucket is "live")
//   status fold     -> task_decision  (navy "Firstmate is deciding"; orange once it has stayed
//                                       open past the threshold while Firstmate is stopped or
//                                       has not drained its wake queue)
//   attention L3/L4 -> prompt         (orange: the deterministic floor)
//   guard pending   -> approval       (orange, L4)
//   attention L2    -> review, L1 nudges -> nudge (never orange)
import type { AttentionItem, GuardRequest, Level, WorkerView } from "../../shared/schema.ts";
import { parseCalls, recommendedAnswer, type Ask, type AskCall, type AsksCrosscheck, type HoldBucket } from "../../shared/asks.ts";
import { RESERVED_KEY_PREFIXES } from "../firstmate/fold.ts";
import { decodeHold } from "../firstmate/hold.ts";
import type { BacklogRow, TaskDetail } from "../firstmate/state.ts";

/** Firstmate's undated-hold age threshold (FM_SNAPSHOT_UNDATED_HOLD_AGE_DAYS default). */
export const HOLD_AGE_DAYS = 14;
/** How long a crewmate's decision may wait on a stopped or undrained Firstmate before it is the captain's. */
export const ESCALATE_MS = 20 * 60e3;
/** Keys Firstmate's own libraries raise and close; never the captain's to answer. */
const PLUMBING_KEYS = [...RESERVED_KEY_PREFIXES, "remote-reply-continuity-"];

export type Suggestion = { status: "ok"; calls: AskCall[] } | { status: "pending" } | { status: "none" };

export type BuildInput = {
  tasks: TaskDetail[];
  /** Captain holds in each secondmate's own backlog: shown read-only. */
  secondmates?: { id: string; rows: BacklogRow[] }[];
  attention: AttentionItem[];
  guard: GuardRequest[];
  workers: WorkerView[];
  firstmate: { running: boolean; wake_oldest: string | null };
  /** Cached ask_options extraction for a text with no parsed options. */
  suggest?: (text: string) => Suggestion;
  now?: number;
  escalateMs?: number;
};

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);
const dayMs = (d: string | null) => {
  if (!d) return NaN;
  return Date.parse(/T/.test(d) ? d : `${d}T00:00:00Z`);
};

/** Firstmate's hold bucket for a backlog row held for the captain, else null (fm-fleet-snapshot.sh). */
export function holdBucket(
  row: { section: string | null; hold_kind: string | null; hold_reason: string | null; hold_until: string | null; hold_set: string | null; since: string | null; blocked_by: string[] },
  resolved: (id: string) => boolean,
  now = Date.now(),
): HoldBucket | null {
  if (row.hold_kind !== "captain" || row.hold_reason == null || row.section === "done" || row.section == null) return null;
  if (row.blocked_by.some((b) => !resolved(b))) return "blocked";
  const today = new Date(now).toISOString().slice(0, 10);
  if (row.hold_until != null && row.hold_until > today) return "dated";
  const from = dayMs(row.hold_set ?? row.since);
  if (row.hold_until == null && Number.isFinite(from) && Math.floor((now - from) / 864e5) >= HOLD_AGE_DAYS) return "aged";
  return "live";
}

function options(text: string, suggest?: BuildInput["suggest"]) {
  const parsed = parseCalls(text);
  if (parsed.calls.some((c) => c.options.length)) return { ...parsed, options_source: "parsed" as const, recommended_answer: recommendedAnswer(parsed.calls) };
  const s = text.trim() && suggest ? suggest(text) : { status: "none" as const };
  if (s.status === "ok" && s.calls.length) return { preamble: parsed.preamble, calls: s.calls, options_source: "suggested" as const, recommended_answer: null };
  return { ...parsed, options_source: s.status === "pending" ? ("pending" as const) : ("none" as const), recommended_answer: null };
}

export function buildAsks(input: BuildInput): Ask[] {
  const now = input.now ?? Date.now();
  const escalateMs = input.escalateMs ?? ESCALATE_MS;
  const byId = new Map(input.tasks.map((t) => [t.id, t]));
  const workerById = new Map(input.workers.map((w) => [w.id, w]));
  const out: Ask[] = [];

  // A blocker counts as resolved only when the backlog has it and every row with that id is done.
  const backlogDone = (id: string) => { const t = byId.get(id); return Boolean(t && t.section === "done"); };
  const openTask = (id: string | null | undefined) => (id && byId.get(id)?.section !== "done" ? byId.get(id) ?? null : null);

  // ---- captain calls: backlog rows held for the captain ----
  for (const t of input.tasks) {
    const bucket = holdBucket({ ...t, blocked_by: t.depends_on }, backlogDone, now);
    if (!bucket) continue;
    const question = t.hold_reason ?? "";
    // A held work item is its own gate; a minted captain row gates the open task blocked by it, else its origin.
    const gated = t.kind !== "captain" ? t : input.tasks.find((x) => x.section !== "done" && x.depends_on.includes(t.id)) ?? openTask(t.hold_origin) ?? t;
    const live = bucket === "live";
    out.push({
      id: `hold:${t.id}`, kind: "captain_call", source: "backlog", title: t.title, question, ...options(question, input.suggest),
      needs_you: live, owner: "captain",
      state: live ? "Needs you" : bucket === "dated" ? `Deferred until ${t.hold_until}` : bucket === "blocked" ? "Waiting on another task first" : `Held ${HOLD_AGE_DAYS}+ days`,
      level: live ? "L3" : "L2",
      task: t.id, worker: null, session: null, mission: gated.mission ?? t.mission,
      place: { on: "task", id: gated.id },
      answer: { via: "fm-captain-hold", target: t.id, modes: t.kind === "captain" ? ["done", "release"] : ["release", "done"] },
      opened: Number.isFinite(dayMs(t.hold_set ?? t.since)) ? new Date(dayMs(t.hold_set ?? t.since)).toISOString() : null,
      read_only: null,
      hold: { kind: t.hold_kind, bucket, until: t.hold_until, set: t.hold_set, origin: t.hold_origin, secondmate: null },
      ref: { gates: gated.id !== t.id ? gated.id : null },
    });
  }

  // ---- secondmate holds: the captain's call, but routed through Firstmate for now ----
  for (const sm of input.secondmates ?? []) {
    const done = (id: string) => { const rs = sm.rows.filter((r) => r.id === id); return rs.length > 0 && rs.every((r) => r.section === "done"); };
    for (const r of sm.rows) {
      const reason = decodeHold(r.hold);
      const bucket = holdBucket({ ...r, hold_reason: reason }, done, now);
      if (!bucket) continue;
      const question = reason ?? "";
      const host = byId.get(sm.id) ?? null;
      out.push({
        id: `sm-hold:${sm.id}:${r.id}`, kind: "captain_call", source: "backlog", title: r.title, question, ...options(question, input.suggest),
        needs_you: bucket === "live", owner: "captain", state: bucket === "live" ? "Needs you: answer in Firstmate" : "Held in a secondmate home",
        level: bucket === "live" ? "L3" : "L2",
        task: r.id, worker: null, session: null, mission: host?.mission ?? null,
        place: host ? { on: "task", id: host.id } : { on: "hub", id: null },
        answer: { via: "none", target: null },
        opened: r.hold_set ? new Date(dayMs(r.hold_set)).toISOString() : null,
        read_only: `This call is held in secondmate ${sm.id}'s home. Answer it in Firstmate for now.`,
        hold: { kind: r.hold_kind, bucket, until: r.hold_until, set: r.hold_set, origin: r.hold_origin, secondmate: sm.id },
        ref: {},
      });
    }
  }

  // ---- crewmate decisions still open per the fold ----
  const fmStalled = !input.firstmate.running || (Number.isFinite(ms(input.firstmate.wake_oldest)) && now - ms(input.firstmate.wake_oldest) >= escalateMs);
  for (const t of input.tasks) {
    if (t.section === "done") continue;
    for (const d of t.decisions) {
      if (PLUMBING_KEYS.some((p) => d.key.startsWith(p))) continue;
      const opened = d.at ?? t.updated;
      const waited = Number.isFinite(ms(opened)) ? now - ms(opened) : 0;
      const escalated = fmStalled && waited >= escalateMs;
      const crew = input.workers.find((w) => w.owner?.tier === "crew" && w.owner.task === t.id) ?? null;
      out.push({
        id: `decision:${t.id}:${d.key}`, kind: "task_decision", source: "status", title: t.title, question: d.note, ...options(d.note, input.suggest),
        needs_you: escalated, owner: escalated ? "captain" : "firstmate",
        state: escalated ? (input.firstmate.running ? "Firstmate hasn't picked this up" : "Firstmate is stopped") : "Firstmate is deciding",
        level: escalated ? "L3" : "L2",
        task: t.id, worker: crew?.id ?? null, session: crew?.session ?? null, mission: t.mission,
        place: { on: "task", id: t.id },
        answer: d.keyed ? { via: "fm-send-resolve-key", target: t.id, key: d.key } : { via: "fm-send", target: t.id },
        opened, read_only: null,
        decision: { key: d.key, verb: d.verb, keyed: d.keyed },
        ref: { escalate_after: Number.isFinite(ms(opened)) ? new Date(ms(opened) + escalateMs).toISOString() : null, unkeyed: !d.keyed ? "The worker closes an unkeyed decision itself once it acts on the answer." : null },
      });
    }
  }

  // ---- attention and guard: placed on the worker line, inside its task when it is crew ----
  const placeWorker = (workerId: string | null, session: string | null, mission: string | null) => {
    const w = (workerId && workerById.get(workerId)) || (session ? input.workers.find((x) => x.session === session || x.session?.endsWith(`:${session}`)) : undefined) || null;
    const task = w?.owner?.tier === "crew" ? w.owner.task : null;
    const m = w?.mission ?? mission ?? (task ? byId.get(task)?.mission ?? null : null);
    const place: Ask["place"] = w ? { on: "worker", id: w.id } : m ? { on: "idea", id: m } : { on: "hub", id: null };
    return { worker: w?.id ?? workerId, session: w?.session ?? session, task, mission: m, place };
  };
  for (const it of input.attention) {
    if (it.resolved || it.kind === "progress" || it.kind === "idle") continue;
    const rank = Number(it.level.slice(1));
    let kind: Ask["kind"] | null = null;
    if (it.kind === "guard") continue; // the guard request itself is the ask (below)
    if (rank >= 3) kind = "prompt";
    else if (rank === 2 && (it.kind === "review" || it.kind === "proposal")) kind = "review";
    else if (rank === 1 && it.kind === "nudge") kind = "nudge";
    if (!kind) continue;
    if (kind !== "prompt" && it.ref.acked_at) continue;
    const p = placeWorker(it.worker, it.session, it.mission);
    const w = input.workers.find((w) => w.id === p.worker);
    if (p.worker === "local:wH:p1" || w?.owner?.tier === "control") continue;
    if (it.kind === "approval" && w && w.status !== "blocked") continue;
    const place = kind === "nudge" ? (p.mission ? { on: "idea" as const, id: p.mission } : p.place) : kind === "review" && p.task ? { on: "task" as const, id: p.task } : p.place;
    out.push({
      id: `attention:${it.id}`, kind, source: "attention", title: it.title, question: it.why, preamble: "", calls: [], options_source: "none", recommended_answer: null,
      needs_you: kind === "prompt", owner: "captain",
      state: kind === "prompt" ? "Needs you" : kind === "review" ? "Ready for review" : "Still want this?",
      level: it.level as Level,
      task: p.task, worker: p.worker, session: p.session, mission: p.mission, place,
      answer: kind === "prompt" ? { via: it.kind === "approval" ? "answer_prompt" : "reply", target: p.worker ?? "" }
        : kind === "review" ? { via: "ack", target: it.id } : { via: "nudge", target: it.id, mission: p.mission },
      opened: it.opened, read_only: kind === "prompt" && !p.worker ? "No live worker to answer: open the session instead." : null,
      ref: { attention: it.id, attention_kind: it.kind },
    });
  }
  for (const g of input.guard) {
    if (g.decision !== "pending") continue;
    const att = input.attention.find((it) => it.kind === "guard" && !it.resolved && it.ref?.request === g.id) ?? null;
    const p = placeWorker(att?.worker ?? null, g.session, att?.mission ?? null);
    out.push({
      id: `guard:${g.id}`, kind: "approval", source: "guard", title: g.title, question: g.summary, preamble: "",
      calls: [{ n: null, question: g.summary, options: [{ id: "allow", label: "Allow", recommended: false }, { id: "deny", label: "Deny", recommended: false }] }],
      options_source: "parsed", recommended_answer: null,
      needs_you: true, owner: "captain", state: "Needs your approval", level: "L4",
      task: p.task, worker: p.worker, session: p.session, mission: p.mission, place: p.place,
      answer: { via: "approve_deny", target: g.id },
      opened: g.created, read_only: null,
      ref: { attention: att?.id ?? null, rule: g.rule, tool: g.tool, deadline: g.deadline },
    });
  }

  const order = (a: Ask) => (a.needs_you ? 0 : 1);
  return out.sort((a, b) => order(a) - order(b) || Number(b.level.slice(1)) - Number(a.level.slice(1)) || String(a.opened ?? "").localeCompare(String(b.opened ?? "")) || a.id.localeCompare(b.id));
}

/** Compare Joyride's open set with Firstmate's own home summary, when that summary is valid. */
export function crosscheck(asks: Ask[], summary: { valid: boolean; generated: string | null } | null, fm: { id: string; key: string; verb: string }[]): AsksCrosscheck {
  if (!summary?.valid) return { valid: false, generated: summary?.generated ?? null, agree: true, only_joyride: [], only_firstmate: [] };
  const ours = new Set(asks.filter((a) => a.source === "status" || (a.kind === "captain_call" && a.hold?.bucket === "live" && !a.hold.secondmate))
    .map((a) => (a.source === "status" ? `${a.task}|${a.decision!.key}` : `${a.task}|${a.task}`)));
  const theirs = new Set(fm.filter((d) => !PLUMBING_KEYS.some((p) => d.key.startsWith(p))).map((d) => `${d.id}|${d.key}`));
  const only_joyride = [...ours].filter((x) => !theirs.has(x)).sort();
  const only_firstmate = [...theirs].filter((x) => !ours.has(x)).sort();
  return { valid: true, generated: summary.generated, agree: !only_joyride.length && !only_firstmate.length, only_joyride, only_firstmate };
}
