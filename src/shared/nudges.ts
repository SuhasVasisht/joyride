// Nudges (control plane CP6): small asks at the right moments, computed by the nudges module
// (/api/nudges) from Firstmate's tasks, ideas and fleet prune asks.
// Pure types, shared by the daemon and the map's components.
import type { Level } from "./schema.ts";

export type NudgeRule =
  | "task_done" // a task finished 2 h ago and nobody said how it landed: 👍 / 👎
  | "idea_quiet" // an idea with open tasks has been quiet for 5 days: keep, pause or drop
  | "prune" // fleet pruning proposes saving and closing an idle pane
  | "firstmate_waiting"; // Firstmate's own pane is blocked, waiting in its chat

export type NudgeAction = {
  id: string; // keep | pause | drop | undo | up | down | preserve | keep_open | open | dismiss | snooze
  label: string;
  /** The one action to take when the captain agrees with the nudge. */
  primary?: boolean;
  /** A link instead of a POST. */
  href?: string;
  /** The action takes optional words (feedback). */
  words?: boolean;
};

export type Nudge = {
  /** Stable per item and moment: task_done:<task>, idea_quiet:<idea>:<since>, prune:<id>, firstmate_waiting:<worker>. */
  id: string;
  rule: NudgeRule;
  level: Level;
  title: string;
  /** One plain line on why now. */
  why: string;
  place: { on: "task" | "idea" | "worker" | "hub"; id: string | null };
  task: string | null;
  mission: string | null;
  worker: string | null;
  opened: string;
  actions: NudgeAction[];
  ref: Record<string, unknown>;
};

export type NudgesResponse = {
  /** What the map and tray show, after rate limits: at most one per card, at most MAX_VISIBLE_L1 at L1. */
  nudges: Nudge[];
  /** Live but held back by a limit; the knowledge home's To review lists them. */
  overflow: Nudge[];
  counts: { visible: number; overflow: number; by_rule: Partial<Record<NudgeRule, number>> };
  generated: string;
};

export type IdeaBrief = {
  idea: string;
  headline: string;
  now: string;
  next: string;
  /** The signature of the idea's tasks' status lines this brief was written for. */
  sig: string;
  at: string;
  model: string;
  /** ok: current; stale: the tasks moved since and a new brief is queued; pending: none yet; failed. */
  status: "ok" | "stale" | "pending" | "failed";
  error?: string;
};

export type FeedbackVerdict = "up" | "down";
export type FeedbackResult = {
  note: string;
  learning: string | null;
  /** True when the 👎 also reached Firstmate's inbox. */
  told_firstmate: boolean;
  firstmate_error: string | null;
};

export const MAX_VISIBLE_L1 = 5;

/** A recent reversible map edit. Toasts never enter the nudge tray or its rate limits. */
export type UndoNotice = {
  id: string;
  title: string;
  why: string;
  ref: { run: string; commit: string | null; kind: string; key?: string };
};
