// Pure attention helpers: level arithmetic, the deterministic fallback, the
// "why" line (always taken from the payload, never generated), and the single
// Jev request that classifies a turn.
import { LEVEL_RANK, Level, type AttentionItem, type EventRecord } from "../../shared/schema.ts";
import { q, type JevQuestion, type JevResult } from "../../core/jev.ts";
import { commandOf } from "../evidence/parse.ts";
import { loadJudge } from "../../core/judges.ts";

export type Kind = AttentionItem["kind"];
export const LEVELS: Level[] = ["L0", "L1", "L2", "L3", "L4"];
export const rank = (l: Level) => LEVEL_RANK[l];
export const maxLevel = (a: Level, b: Level): Level => (rank(a) >= rank(b) ? a : b);
export const isLevel = (x: unknown): x is Level => typeof x === "string" && Level.safeParse(x).success;

/** Jev may only raise a level above the floor, never lower it. */
export function finalLevel(floor: Level, jevLevel: Level | null | undefined): Level {
  return isLevel(jevLevel) ? maxLevel(floor, jevLevel) : floor;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** True when the message ends with a question (ignoring trailing markdown and quotes). */
export function endsWithQuestion(text: string | null | undefined): boolean {
  const t = (text ?? "").replace(/```[\s\S]*?```/g, "").trim().replace(/[\s*_`"'”’)\]]+$/u, "");
  return t.endsWith("?");
}

/** Deterministic rule used when Jev is unavailable: a trailing question blocks, anything else is progress. */
export function fallbackClassify(text: string | null | undefined): { level: Level; kind: Kind } {
  return endsWithQuestion(text) ? { level: "L3", kind: "question" } : { level: "L1", kind: "progress" };
}

/** The "why" line: the last paragraph of the assistant message, preferring its last question. */
export function whyFromMessage(text: string | null | undefined, n = 240): string {
  const t = (text ?? "").replace(/```[\s\S]*?```/g, " ").trim();
  if (!t) return "";
  const paras = t.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  let last = paras[paras.length - 1] ?? t;
  if (last.includes("?")) {
    const qs = last.match(/[^.!?\n]*\?/g);
    if (qs?.length) last = qs[qs.length - 1].trim();
  }
  return clip(last.replace(/\s+/g, " ").replace(/^[-*#>\s]+/, ""), n);
}

/** The "why" line for a tool call: tool name plus its command, path or input. */
export function whyFromTool(tool: unknown, input: unknown, n = 240): string {
  const name = String(tool ?? "tool");
  const cmd = commandOf(input);
  if (cmd) return clip(`${name}: ${cmd.replace(/\s+/g, " ")}`, n);
  let text = "";
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    text = String(o.file_path ?? o.path ?? o.url ?? o.pattern ?? JSON.stringify(input));
  } else if (typeof input === "string") {
    const m = input.match(/"(?:file_path|path|url|pattern)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    text = m ? m[1] : input;
  }
  return clip(text ? `${name}: ${text.replace(/\s+/g, " ")}` : name, n);
}

/** Session key `${agent}:${raw}` for an event (hook, guard and herdr events carry raw ids). */
export function sessionKeyOf(e: Pick<EventRecord, "session" | "agent" | "source">): string | null {
  if (!e.session) return null;
  if (/^(claude|codex):/.test(e.session)) return e.session;
  const agent = e.agent ?? (e.source?.startsWith("hook.") ? e.source.slice(5) : "claude");
  return `${agent}:${e.session}`;
}
/** Herdr's session_ref may be a key, a raw id, or {source, id}. */
export function sessionRefKey(ref: unknown, agent?: string): string | null {
  if (!ref) return null;
  if (typeof ref === "string") return /^(claude|codex):/.test(ref) ? ref : `${agent === "codex" ? "codex" : "claude"}:${ref}`;
  if (typeof ref === "object") {
    const r = ref as Record<string, unknown>;
    if (typeof r.key === "string") return r.key;
    if (typeof r.id === "string") return `${r.source === "codex" ? "codex" : "claude"}:${r.id}`;
  }
  return null;
}
export const rawSession = (key: string | null) => (key ? key.replace(/^(claude|codex):/, "") : null);

// ---------- Jev ----------
export const LEVEL_CRITERIA: Record<Level, string> = {
  L0: "Ambient: routine activity with nothing worth reporting; nobody needs to look.",
  L1: "Digest: progress worth a glance later; the agent finished a step or is idle with nothing pending.",
  L2: "Review: the agent says the work is finished or ready, and its result should be looked over.",
  L3: "Blocked on the human: the agent asks a question, needs a decision or permission, or hit a problem it cannot get past, and it cannot continue without a reply.",
  L4: "Urgent: something risky is about to happen or is happening now, such as runaway spending or a destructive action that proceeds or times out soon.",
};
export const KIND_CRITERIA: Record<string, string> = {
  question: "The agent asks the person a question and waits for the answer.",
  decision: "The agent lays out options and needs the person to choose one.",
  review: "The agent says the work is finished and ready to look over.",
  progress: "The agent reports progress and keeps going, or has nothing pending.",
  error: "The agent hit a failure it could not get past.",
  idle: "The agent is idle with nothing to report.",
};
export const JEV_KINDS = Object.keys(KIND_CRITERIA) as Kind[];

/** The attention judge (config/judges/attention.yaml). */
export type AttentionJudge = {
  version: number;
  level: { instructions: string; criteria: Record<Level, string> };
  needs_human: { instructions: string; true: string; false: string };
  kind: { instructions: string; criteria: Record<string, string> };
};
export const DEFAULT_ATTENTION_JUDGE: AttentionJudge = {
  version: 1,
  level: { instructions: "How urgently does the person supervising this coding agent need to look at it right now?", criteria: LEVEL_CRITERIA },
  needs_human: { instructions: "The agent cannot usefully continue until a human answers, approves or decides something.", true: "The agent is waiting on the human", false: "The agent can continue on its own or has nothing pending" },
  kind: { instructions: "What kind of moment is this for the person supervising the agent?", criteria: KIND_CRITERIA },
};
const validJudge = (v: any) => Boolean(v?.level?.criteria && v?.needs_human?.instructions && v?.kind?.criteria);
export function attentionJudge(): AttentionJudge { return loadJudge("attention", DEFAULT_ATTENTION_JUDGE, validJudge); }

export function attentionQuestions(judge: AttentionJudge = attentionJudge()): Record<string, JevQuestion> {
  return {
    level: q.choice(judge.level.instructions, judge.level.criteria),
    needs_human: q.noul(judge.needs_human.instructions, judge.needs_human.true, judge.needs_human.false),
    kind: q.choice(judge.kind.instructions, judge.kind.criteria),
  };
}

export type JevAttention = { level: Level | null; p_needs_human: number | null; probabilities: Record<string, number>; kind: Kind | null; kind_probabilities: Record<string, number> };
export function readAttention(r: JevResult): JevAttention {
  const lv = r.answers.level?.choice;
  const kd = r.answers.kind?.choice;
  return {
    level: isLevel(lv) ? lv : null,
    p_needs_human: typeof r.answers.needs_human?.noul === "number" ? r.answers.needs_human.noul : null,
    probabilities: r.answers.level?.probabilities ?? {},
    kind: kd && (JEV_KINDS as string[]).includes(kd) ? (kd as Kind) : null,
    kind_probabilities: r.answers.kind?.probabilities ?? {},
  };
}

// ---------- metrics ----------
/** Linear-interpolated quantile of an ascending array (numpy's default). */
export function quantile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export const KIND_TITLES: Record<Kind, string> = {
  question: "Asks a question",
  decision: "Needs a decision",
  approval: "Needs permission",
  review: "Reports done",
  error: "Stopped with an error",
  progress: "Made progress",
  idle: "Waiting for input",
  guard: "Approve a gated action",
  nudge: "Nudge",
  overlap: "Two sessions editing the same file",
  proposal: "Proposal",
};
