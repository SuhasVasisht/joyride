// Asks: everything the captain owes, projected by the asks module (/api/asks) from
// Firstmate's backlog holds and status decisions, attention items and guard requests.
// The types and the option parser are pure, so the map can share them.
import type { Level } from "./schema.ts";

export type AskKind =
  | "captain_call" // a backlog row held for the captain (fm-captain-hold.sh)
  | "task_decision" // a crewmate's open needs-decision/blocked, per Firstmate's fold
  | "prompt" // an attention item at L3/L4: a permission prompt, a question at a prompt, a crash
  | "approval" // a pending guard request
  | "review" // an L2 review: done with evidence, report landed
  | "nudge"; // an L1 nudge on an idea

export type AskOption = { id: string; label: string; recommended: boolean };
/** One call in an ask. A hold reason with "1) … 2) …" holds several; n is null when it isn't numbered. */
export type AskCall = { n: number | null; question: string; options: AskOption[] };

/** How an answer reaches the owner. CP1's answer_ask intent executes it; the projection only names it. */
export type AskAnswer =
  | { via: "fm-captain-hold"; target: string; modes: ("done" | "release")[] } // `answers --source joyride-map`, then a wake note
  | { via: "fm-send-resolve-key"; target: string; key: string } // fm-send.sh <task> --resolve-key <key> <answer>
  | { via: "fm-send"; target: string } // a plain steer; the worker closes an unkeyed decision itself
  | { via: "answer_prompt" | "reply"; target: string } // the worker id
  | { via: "prune"; target: string }
  | { via: "approve_deny"; target: string } // the guard request id
  | { via: "ack"; target: string } // the attention item id
  | { via: "nudge"; target: string; mission: string | null }
  | { via: "none"; target: string | null }; // read-only here

export type AskPlace = { on: "task" | "worker" | "idea" | "hub"; id: string | null };

export type Ask = {
  /** Stable: hold:<task>, decision:<task>:<key>, attention:<id>, guard:<id>, sm-hold:<secondmate>:<task>. */
  id: string;
  kind: AskKind;
  source: "backlog" | "status" | "attention" | "guard" | "fleet";
  title: string;
  /** The whole question: the decoded hold reason, the decision note, or the attention "why". */
  question: string;
  /** Context before the first numbered call. */
  preamble: string;
  calls: AskCall[];
  /** parsed: from the text; suggested: a cached ask_options extraction; pending: extraction queued; none. */
  options_source: "parsed" | "suggested" | "pending" | "none";
  /** "Use all recommendations" as one answer text, when the text marks recommendations. */
  recommended_answer: string | null;
  /** True only for calls the captain owns now: the signal orange. */
  needs_you: boolean;
  /** Who acts next: the captain, or Firstmate (a crewmate's decision it hasn't handed up). */
  owner: "captain" | "firstmate";
  /** Plain words for the card's state, e.g. "Firstmate is deciding". */
  state: string;
  level: Level;
  task: string | null;
  worker: string | null;
  session: string | null;
  mission: string | null;
  place: AskPlace;
  answer: AskAnswer;
  opened: string | null;
  /** Why the ask can't be answered here, else null. */
  read_only: string | null;
  hold?: { kind: string | null; bucket: HoldBucket; until: string | null; set: string | null; origin: string | null; secondmate: string | null };
  decision?: { key: string; verb: "needs-decision" | "blocked"; keyed: boolean };
  ref: Record<string, unknown>;
};

/** Firstmate's hold buckets (bin/fm-fleet-snapshot.sh): only "live" is captain-actionable. */
export type HoldBucket = "live" | "blocked" | "dated" | "aged";

export type AsksCrosscheck = {
  /** Firstmate's own summary is valid and was compared; when false, Joyride's fold is the only source. */
  valid: boolean;
  generated: string | null;
  agree: boolean;
  only_joyride: string[];
  only_firstmate: string[];
};

export type AsksResponse = {
  asks: Ask[];
  counts: { total: number; needs_you: number; by_kind: Partial<Record<AskKind, number>> };
  crosscheck: AsksCrosscheck;
  firstmate: { running: boolean; wake_pending: number; wake_oldest: string | null };
  generated: string;
};

const WS = /\s/;

/** Markers in order: the first marker numbered `start`, the next `start+1` after it, and so on. */
function sequence(markers: { n: number; at: number; end: number }[], start: number) {
  const out: typeof markers = [];
  let want = start, from = -1;
  for (const m of markers) if (m.n === want && m.at > from) { out.push(m); want++; from = m.end; }
  return out;
}

const tidy = (s: string) => s.replace(/\s+/g, " ").replace(/^[\s;,:-]+/, "").replace(/(?:[\s;,.]|\s(?:or|and))+$/i, "").trim();

/** Split one call's text into its question and "(A) …; (B, recommended) …" options (two or more, in letter order). */
export function parseOptions(text: string): { question: string; options: AskOption[] } {
  const re = /\(([A-Za-z])(?:\s*[,;]\s*(recommended|preferred))?\)/gi;
  const found: { n: number; at: number; end: number; rec: boolean; letter: string }[] = [];
  for (const m of text.matchAll(re)) {
    const at = m.index!;
    if (at > 0 && !WS.test(text[at - 1]) && !/[:;,]/.test(text[at - 1])) continue;
    found.push({ n: m[1].toLowerCase().charCodeAt(0) - 96, at, end: at + m[0].length, rec: Boolean(m[2]), letter: m[1].toUpperCase() });
  }
  const seq = sequence(found, 1) as typeof found;
  if (seq.length < 2) return { question: tidy(text), options: [] };
  const options = seq.map((m, i) => {
    let label = text.slice(m.end, seq[i + 1]?.at ?? text.length);
    let recommended = m.rec;
    if (/\((?:recommended|preferred)\)/i.test(label)) { recommended = true; label = label.replace(/\s*\((?:recommended|preferred)\)/gi, ""); }
    return { id: m.letter, label: tidy(label), recommended };
  });
  return { question: tidy(text.slice(0, seq[0].at)).replace(/:$/, ""), options };
}

/** Split a hold reason or decision note into numbered calls ("1) … 2) …"), each with its options. */
export function parseCalls(text: string): { preamble: string; calls: AskCall[] } {
  const t = (text ?? "").trim();
  if (!t) return { preamble: "", calls: [] };
  const markers: { n: number; at: number; end: number }[] = [];
  for (const m of t.matchAll(/(?:^|(?<=[\s:;.,]))\(?(\d{1,2})\)\s/g)) markers.push({ n: Number(m[1]), at: m.index!, end: m.index! + m[0].length });
  const seq = sequence(markers, 1);
  if (seq.length < 2) {
    const one = parseOptions(t);
    return { preamble: "", calls: [{ n: null, ...one }] };
  }
  const calls = seq.map((m, i) => ({ n: m.n, ...parseOptions(t.slice(m.end, seq[i + 1]?.at ?? t.length)) }));
  return { preamble: tidy(t.slice(0, seq[0].at)), calls };
}

/** One answer that takes every marked recommendation: "Go with your recommendations: 1 B, 2 A". */
export function recommendedAnswer(calls: AskCall[]): string | null {
  const picks = calls.map((c) => ({ n: c.n, pick: c.options.find((o) => o.recommended)?.id ?? null }));
  if (!picks.length || picks.some((p) => !p.pick)) return null;
  if (picks.length === 1) return `Go with your recommendation: ${picks[0].pick}`;
  return `Go with your recommendations: ${picks.map((p, i) => `${p.n ?? i + 1} ${p.pick}`).join(", ")}`;
}

/**
 * "This looks moot": Firstmate-owned calls (a captain hold, a crewmate's decision) can be sent back for a
 * re-check instead of an answer. Joyride never sends `reconcile` itself; Firstmate re-checks with its bound source.
 */
export const canRecheck = (a: Pick<Ask, "answer" | "read_only">) =>
  !a.read_only && (a.answer.via === "fm-captain-hold" || a.answer.via === "fm-send-resolve-key" || a.answer.via === "fm-send");
