// Pure verdict helpers: evidence summaries for Jev, the per-criterion
// question, deterministic guard rails and aggregation.
import type { EvidenceItem } from "../../shared/schema.ts";
import { q, type JevQuestion } from "../../core/jev.ts";
import { outcomeOf, type Outcome } from "./parse.ts";
import { loadJudge } from "../../core/judges.ts";

export type V = "pass" | "fail" | "insufficient";
export type Criterion = { id: string; text: string; kind: "test" | "e2e" | "screenshot" | "review" | "other" };
export type CriterionResult = { id: string; criterion: string; kind: Criterion["kind"]; verdict: V; p?: number; probabilities?: Record<string, number>; reason: string; captions?: string[]; caption_p?: number | null };

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export const outcome = (ev: EvidenceItem): Outcome => outcomeOf(ev.exit_code, ev.assertions);

/** What Jev sees about one evidence record. */
export function summarize(ev: EvidenceItem) {
  const tail = (ev.log_tail ?? "").trim();
  return {
    name: ev.name,
    mode: ev.mode,
    command: clip(ev.command ?? "", 240),
    exit_code: ev.exit_code,
    outcome: outcome(ev),
    assertions: ev.assertions,
    claim: clip(ev.claim ?? "", 400),
    log_tail: tail.length > 700 ? "…" + tail.slice(-700) : tail,
    screenshots: ev.screenshots.map((s) => (s.caption ? `${s.name}: ${s.caption}` : s.name)),
  };
}

/** Latest record per name (re-runs replace earlier runs), newest first, capped. */
export function latestPerName(items: EvidenceItem[], cap = 12): EvidenceItem[] {
  const seen = new Map<string, EvidenceItem>();
  for (const it of [...items].sort((a, b) => b.created.localeCompare(a.created))) if (!seen.has(it.name)) seen.set(it.name, it);
  return [...seen.values()].slice(0, cap);
}

export const VERDICT_CRITERIA: Record<V, string> = {
  insufficient: "Nothing shown speaks to this requirement, or what is shown covers only part of it, so it cannot be judged yet.",
  fail: "A relevant check shows the requirement is not met: its outcome is fail (non-zero exit status or failing tests).",
  pass: "Relevant checks show the requirement is met: their outcome is pass (zero exit status, no failing tests) and they cover the whole requirement.",
};

/** The evidence judge (config/judges/evidence.yaml; hill-climb target "judge:evidence"). */
export type EvidenceJudge = {
  version: number;
  verdict: { instructions: string; criteria: Record<V, string> };
  caption: { instructions: string; true: string; false: string };
};
export const DEFAULT_EVIDENCE_JUDGE: EvidenceJudge = {
  version: 1,
  verdict: { instructions: "Judge whether the recorded checks prove this done-when requirement of a software mission. Test results and exit codes decide; a claim with no run behind it proves nothing.", criteria: VERDICT_CRITERIA },
  caption: { instructions: "The screenshot captions show something that contradicts the requirement (a broken, empty or wrong screen where the requirement expects it to work).", true: "A caption contradicts the requirement", false: "The captions are consistent with the requirement or say nothing about it" },
};
export function evidenceJudge(): EvidenceJudge { return loadJudge("evidence", DEFAULT_EVIDENCE_JUDGE, (v) => Boolean(v?.verdict?.criteria && v?.caption?.instructions)); }

export function verdictQuestion(judge: EvidenceJudge = evidenceJudge()): Record<string, JevQuestion> {
  return { verdict: q.choice(judge.verdict.instructions, judge.verdict.criteria) };
}
export function captionQuestion(judge: EvidenceJudge = evidenceJudge()): Record<string, JevQuestion> {
  return { contradicts: q.noul(judge.caption.instructions, judge.caption.true, judge.caption.false) };
}

/** Deterministic guard rails: a pass needs a successful run (test/e2e) or a screenshot (screenshot). */
export function guardPass(c: Criterion, evidence: EvidenceItem[]): string | null {
  if ((c.kind === "test" || c.kind === "e2e") && !evidence.some((e) => outcome(e) === "pass")) return "no successful test run was recorded";
  if (c.kind === "screenshot" && !evidence.some((e) => e.screenshots.length > 0)) return "no screenshot was recorded";
  return null;
}

/**
 * Evidence relevant to one criterion. A mission with many criteria accumulates many records,
 * so each criterion is judged on its own best matches: records whose name or claim carries the
 * criterion's label (e.g. "C3", or its id) first, then by word overlap; newest wins ties.
 */
export function relevantFor(c: Criterion, evidence: EvidenceItem[], cap = 8): EvidenceItem[] {
  const words = (s: string) => new Set((s.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? []).filter((w) => !STOP.has(w)));
  const label = (c.text.match(/^\s*([A-Za-z]+\d+)\s*[:.)-]/)?.[1] ?? "").toLowerCase();
  const ids = new Set([c.id.toLowerCase(), label].filter(Boolean));
  const cw = words(c.text);
  const scored = evidence.map((ev) => {
    const hay = `${ev.name} ${ev.claim ?? ""}`;
    const head = (ev.name.match(/^\s*([A-Za-z]+\d+)\b/)?.[1] ?? "").toLowerCase();
    let score = head && ids.has(head) ? 100 : 0;
    const ew = words(`${hay} ${ev.command ?? ""}`);
    for (const w of cw) if (ew.has(w)) score += 1;
    // A record explicitly labelled for a different criterion is not evidence for this one.
    if (head && ids.size && !ids.has(head) && /^[a-z]+\d+$/.test(head) && label) score = Math.min(score, 0);
    return { ev, score };
  });
  const hits = scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score || b.ev.created.localeCompare(a.ev.created));
  return (hits.length ? hits.map((x) => x.ev) : [...evidence].sort((a, b) => b.created.localeCompare(a.created))).slice(0, cap);
}
const STOP = new Set(["that", "with", "this", "from", "have", "into", "when", "they", "their", "then", "than", "each", "every", "work", "works", "show", "shows", "joyride"]);

/** Overall: pass only if every criterion passes; any fail fails; otherwise insufficient. */
export function aggregate(results: { verdict: V }[]): V {
  if (!results.length) return "insufficient";
  if (results.some((r) => r.verdict === "fail")) return "fail";
  if (results.every((r) => r.verdict === "pass")) return "pass";
  return "insufficient";
}
