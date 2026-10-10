// Nudge rules and rate limits, pure so they are unit-tested without a daemon.
//   candidates(input)  every nudge the moment calls for (design §7, "Nudges at the right moments")
//   limit(cands, state) what the captain sees: dismissed and snoozed items drop out, each rule has a
//                       daily budget of new nudges, each card gets at most one, and at most
//                       MAX_VISIBLE_L1 L1 nudges show; the rest wait in overflow (Knowledge › To review).
import type { Ask } from "../../shared/asks.ts";
import { MAX_VISIBLE_L1, type Nudge, type NudgeRule } from "../../shared/nudges.ts";
import type { Level } from "../../shared/schema.ts";

const H = 36e5, D = 24 * H;

export const THRESHOLDS = {
  doneAfterMs: 2 * H, // a done task nobody looked at for this long asks how it landed
  doneWithinMs: 7 * D, // older done tasks never ask
  quietMs: 5 * D, // an idea with open tasks and no activity for this long asks "still want this?"
};

export const LIMITS = {
  /** New nudges a rule may show per rolling day; the rest wait in overflow until the budget frees. */
  perRulePerDay: { task_done: 6, idea_quiet: 3, prune: 10, firstmate_waiting: 6 } satisfies Record<NudgeRule, number>,
  maxVisibleL1: MAX_VISIBLE_L1,
  maxVisible: 10,
  snoozeMs: 7 * D,
};

export type RuleTask = { id: string; title: string; section: string | null; status: string; updated: string | null; mission: string | null; last_event: string };
export type RuleIdea = { id: string; title: string; state: string; archive: boolean; last_activity: string | null };
export type RuleInput = {
  now: number;
  tasks: RuleTask[];
  ideas: RuleIdea[];
  prunes: Ask[];
  /** Firstmate's own pane when it is blocked, and since when Joyride has seen it blocked. */
  firstmate: { worker: string; title: string; since: string } | null;
  /** Tasks the captain already gave feedback on. */
  feedback: Set<string>;
};

export type NudgeState = {
  dismissed: Record<string, string>;
  snoozed: Record<string, string>; // id → until (ISO)
  /** When each nudge first became visible: the daily budget counts these. */
  shown: Record<string, string>;
};
export const emptyState = (): NudgeState => ({ dismissed: {}, snoozed: {}, shown: {} });

const OPEN_SECTIONS = new Set(["in_flight", "queued"]);
const clip = (s: string, n: number) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };
const iso = (ms: number) => new Date(ms).toISOString();
const ms = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);

export function candidates(input: RuleInput): Nudge[] {
  const out: Nudge[] = [];
  const { now } = input;

  for (const t of input.tasks) {
    const at = ms(t.updated);
    if (t.section !== "done" || !Number.isFinite(at) || input.feedback.has(t.id)) continue;
    if (now - at < THRESHOLDS.doneAfterMs || now - at > THRESHOLDS.doneWithinMs) continue;
    out.push({
      id: `task_done:${t.id}`, rule: "task_done", level: "L2", title: "Done: how did it land?", why: clip(t.title, 140),
      place: { on: "task", id: t.id }, task: t.id, mission: t.mission, worker: null, opened: iso(at + THRESHOLDS.doneAfterMs),
      actions: [{ id: "up", label: "Landed well", primary: true, words: true }, { id: "down", label: "Didn't land", words: true }, { id: "dismiss", label: "Not now" }],
      ref: { task: t.id, done: t.updated },
    });
  }

  for (const i of input.ideas) {
    if (i.archive || i.state !== "open") continue;
    const open = input.tasks.filter((t) => t.mission === i.id && OPEN_SECTIONS.has(t.section ?? ""));
    if (!open.length) continue;
    const last = Math.max(ms(i.last_activity) || 0, ...input.tasks.filter((t) => t.mission === i.id).map((t) => ms(t.updated) || 0));
    if (!last || now - last < THRESHOLDS.quietMs) continue;
    const days = Math.floor((now - last) / D);
    out.push({
      id: `idea_quiet:${i.id}`, rule: "idea_quiet", level: "L1", title: "Still want this?",
      why: `${clip(i.title, 80)} has been quiet for ${days} days with ${open.length} open ${open.length === 1 ? "task" : "tasks"}.`,
      place: { on: "idea", id: i.id }, task: null, mission: i.id, worker: null, opened: iso(last + THRESHOLDS.quietMs),
      actions: [{ id: "keep", label: "Keep", primary: true }, { id: "pause", label: "Pause" }, { id: "drop", label: "Drop" }],
      ref: { idea: i.id, last_activity: iso(last), open_tasks: open.map((t) => t.id) },
    });
  }

  for (const a of input.prunes) {
    out.push({
      id: `prune:${a.id}`, rule: "prune", level: "L2", title: a.title, why: clip(a.question || a.preamble, 200),
      place: { on: "worker", id: a.worker }, task: a.task, mission: a.mission, worker: a.worker, opened: a.opened ?? iso(now),
      actions: [{ id: "preserve", label: "Save and close", primary: true }, { id: "keep_open", label: "Keep it open" }],
      ref: { ask: a.id, ...a.ref },
    });
  }

  if (input.firstmate) {
    const f = input.firstmate;
    out.push({
      id: `firstmate_waiting:${f.worker}:${f.since}`, rule: "firstmate_waiting", level: "L3", title: "Firstmate is waiting in its chat",
      why: "Its pane is blocked on a question or a prompt. Open it to answer.", place: { on: "hub", id: null }, task: null, mission: null, worker: f.worker, opened: f.since,
      actions: [{ id: "open", label: "Open", primary: true, href: `#/worker/${encodeURIComponent(f.worker)}` }, { id: "dismiss", label: "Dismiss" }],
      ref: { worker: f.worker },
    });
  }
  return out;
}

const RANK: Record<Level, number> = { L4: 4, L3: 3, L2: 2, L1: 1, L0: 0 };
/** The card a nudge sits on. */
const cardOf = (n: Nudge) => (n.place.on === "hub" ? `hub:${n.rule}` : `${n.place.on}:${n.place.id}`);

/** Apply dismissals, snoozes and the limits. Returns the next state's `shown` map (it only grows by what became visible, and forgets after a day). */
export function limit(all: Nudge[], state: NudgeState, now: number): { nudges: Nudge[]; overflow: Nudge[]; shown: Record<string, string> } {
  const live = all.filter((n) => !state.dismissed[n.id] && !(ms(state.snoozed[n.id]) > now));
  const shown: Record<string, string> = {};
  for (const [id, at] of Object.entries(state.shown)) if (now - ms(at) < D || live.some((n) => n.id === id)) shown[id] = at;
  const ruleOf = (id: string) => id.split(":")[0] as NudgeRule;
  const spent = (rule: NudgeRule) => Object.entries(shown).filter(([id, at]) => ruleOf(id) === rule && now - ms(at) < D).length;

  // Most urgent first; within a level, what was already showing stays put, then newest.
  const ordered = [...live].sort((a, b) => RANK[b.level] - RANK[a.level] || Number(Boolean(shown[b.id])) - Number(Boolean(shown[a.id])) || b.opened.localeCompare(a.opened) || a.id.localeCompare(b.id));
  const nudges: Nudge[] = [], overflow: Nudge[] = [];
  const cards = new Set<string>();
  let l1 = 0;
  for (const n of ordered) {
    const card = cardOf(n);
    const fresh = !shown[n.id];
    const over = cards.has(card) || (n.level === "L1" && l1 >= LIMITS.maxVisibleL1) || nudges.length >= LIMITS.maxVisible
      || (fresh && spent(n.rule) >= (LIMITS.perRulePerDay[n.rule] ?? 5));
    if (over) { overflow.push(n); continue; }
    cards.add(card);
    if (n.level === "L1") l1++;
    if (fresh) shown[n.id] = new Date(now).toISOString();
    nudges.push(n);
  }
  return { nudges, overflow, shown };
}
