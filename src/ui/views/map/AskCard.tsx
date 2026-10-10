// An ask pinned to its card, answered in place through the captain-only answer_ask intent
// (POST /api/intents). The map folds the question and recommendation into a reading line;
// Answer opens its controls in place. The rail keeps its controls open. Signal orange only when the call is the
// captain's now (ask.needs_you); a crewmate's decision reads "Firstmate is deciding" in navy.
import { useDraft } from "../../lib/useDraft";
import { useId, useState } from "react";
import { post } from "../../lib/api";
import { href } from "../../lib/router";
import { canRecheck, type Ask } from "../../../shared/asks";
import { composeAnswer, recommendedPicks } from "./plane";

type IntentRec = { id: string; status: "pending" | "sent" | "acked" | "failed"; error: string | null; result?: any };

const KIND: Record<string, string> = { captain_call: "Call", task_decision: "Decision", prompt: "Prompt", approval: "Approval", review: "Review", nudge: "Nudge" };
const short = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** The one-line badge at mid zoom: what is asked, and whose move it is. */
export function AskBadge({ ask }: { ask: Ask }) {
  return (
    <span className={`ask-badge${ask.needs_you ? " needs-you" : ""}`} data-ask={ask.id} title={ask.question}>
      <span className="ab-bar" aria-hidden />
      <span className="ab-kind">{ask.needs_you ? "Needs you" : ask.state}</span>
      <span className="ab-text">{short(ask.calls.length > 1 ? `${ask.calls.length} calls: ${ask.title}` : ask.calls[0]?.question || ask.title, 80)}</span>
    </span>
  );
}

/** Fixed answers for asks whose owner takes a choice, not words. */
function fixedChoices(ask: Ask): { label: string; answer: string; primary?: boolean }[] | null {
  switch (ask.answer.via) {
    case "answer_prompt": return [{ label: "Allow", answer: "allow", primary: true }, { label: "Always allow", answer: "allow_always" }, { label: "Deny", answer: "deny" }];
    case "approve_deny": return [{ label: "Approve", answer: "approve", primary: true }, { label: "Deny", answer: "deny" }];
    case "prune": return [{ label: "Preserve and close", answer: "approve", primary: true }, { label: "Keep the pane open", answer: "deny" }];
    case "ack": return [{ label: "Mark reviewed", answer: "Reviewed on the map", primary: true }];
    case "nudge": return [{ label: "Got it", answer: "Seen on the map", primary: true }];
    default: return null;
  }
}

export function AskCard({ ask, folded = false }: { ask: Ask; folded?: boolean }) {
  const group = useId();
  const [expanded, setExpanded] = useState(!folded);
  const [picks, setPicks] = useState<Record<number, string>>(() => recommendedPicks(ask));
  const draft = useDraft({ kind: "ask", id: ask.id });
  const { text: words, setText: setWords } = draft;
  const [showWords, setShowWords] = useState(false);
  const modes = ask.answer.via === "fm-captain-hold" ? ask.answer.modes : [];
  const [mode, setMode] = useState<"done" | "release" | undefined>(modes[0]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function send(answer: string) {
    if (!answer.trim()) { setResult({ ok: false, text: "Pick an option or type an answer first." }); return; }
    setBusy(true); setResult(null);
    try {
      const it = await post<IntentRec>("/api/intents", { kind: "answer_ask", target: ask.id, payload: { answer, ...(mode ? { mode } : {}) } });
      if (it.status === "failed") setResult({ ok: false, text: it.error ?? "The answer did not reach its owner." });
      else { draft.clear(); setResult({ ok: true, text: it.result?.replay ? "Already answered with these words." : "Sent. This card clears when the owner confirms." }); }
    } catch (e: any) { setResult({ ok: false, text: `The answer did not send: ${e.message}` }); }
    finally { setBusy(false); }
  }

  async function moot() {
    setBusy(true); setResult(null);
    try {
      const it = await post<IntentRec>("/api/intents", { kind: "recheck_ask", target: ask.id, origin: "captain", payload: words.trim() ? { words: words.trim() } : {} });
      if (it.status === "failed") setResult({ ok: false, text: it.error ?? "Firstmate was not asked to re-check this." });
      else setResult({ ok: true, text: "Asked Firstmate to re-check this. The card stays until Firstmate closes it." });
    } catch (e: any) { setResult({ ok: false, text: `Firstmate was not asked to re-check this: ${e.message}` }); }
    finally { setBusy(false); }
  }

  const fixed = fixedChoices(ask);
  const hasOptions = ask.calls.some((c) => c.options.length);
  const composed = composeAnswer(ask, picks, words);
  const reading = hasOptions ? ask.calls.map((c) => {
    const rec = c.options.find((o) => o.recommended);
    return `${c.question || ask.title}${rec ? ` → ${rec.label}` : ""}`;
  }).join(" · ") : ask.question || ask.title;
  const recommendation = !ask.calls.some((c) => c.options.some((o) => o.recommended)) ? ask.recommended_answer : null;
  const summary = `${reading}${recommendation ? ` → ${recommendation}` : ""}`;
  return (
    <section className={`ask-card${ask.needs_you ? " needs-you" : ""}${folded ? " reading" : ""}${expanded ? " expanded" : ""}`} data-ask={ask.id} data-ask-kind={ask.kind} aria-label={`${ask.needs_you ? "Needs you" : ask.state}: ${ask.title}`}
      onClick={(e) => e.stopPropagation()}>
      {folded ? <div className="ak-reading">
        <span className="ak-summary" title={summary}>{summary}</span>
        <button type="button" className="ak-answer" aria-expanded={expanded} aria-controls={`${group}-answer`} onClick={() => setExpanded((open) => !open)}>{expanded ? "Close" : ask.read_only ? "Read" : "Answer"}</button>
      </div> : null}
      {expanded ? <div className="ak-form" id={`${group}-answer`}>
      <header className="ak-head">
        <span className="ak-state">{ask.needs_you ? "Needs you" : ask.state}</span>
        <span className="ak-kind">{KIND[ask.kind] ?? ask.kind}{ask.calls.length > 1 ? ` · ${ask.calls.length} calls` : ""}</span>
        {ask.task ? <a className="ak-link" href={href(`task/${encodeURIComponent(ask.task)}`)} title="Open the task">▤ Task</a> : null}
      </header>
      {ask.preamble ? <p className="ak-pre">{short(ask.preamble, 200)}</p> : null}
      {hasOptions ? (
        <ol className="ak-calls">
          {ask.calls.map((c, i) => (
            <li key={i} className="ak-call">
              <p className="ak-q">{c.n != null ? <span className="ak-n">{c.n}</span> : null}{short(c.question || ask.title, 200)}</p>
              {c.options.length ? (
                <div className="ak-opts" role="radiogroup" aria-label={c.question || ask.title}>
                  {c.options.map((o) => (
                    <label key={o.id} className={`ak-opt${picks[i] === o.id ? " on" : ""}`}>
                      <input type="radio" name={`${group}:${i}`} checked={picks[i] === o.id} disabled={busy || !!ask.read_only} onChange={() => setPicks((p) => ({ ...p, [i]: o.id }))} />
                      <span>{o.label}{o.recommended ? <em className="ak-rec"> recommended</em> : null}</span>
                    </label>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      ) : <p className="ak-q">{short(ask.question || ask.title, 260)}</p>}
      {ask.options_source === "suggested" ? <p className="ak-note">Options are suggested from the question.</p> : null}
      {ask.read_only ? (
        <p className="ak-note">{ask.read_only}</p>
      ) : (
        <>
          {showWords || words.length > 0 || (!hasOptions && !fixed) ? (
            <textarea ref={draft.boxRef} className="ak-words" rows={2} value={words} placeholder={hasOptions ? "Add your own words (optional)" : "Your answer"} aria-label="Your answer"
              onChange={(e) => setWords(e.target.value)} disabled={busy}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(composed); } }} />
          ) : null}
          {modes.length > 1 ? (
            <label className="ak-mode">When sent
              <select value={mode} onChange={(e) => setMode(e.target.value as "done" | "release")} disabled={busy}>
                {modes.map((m) => <option key={m} value={m}>{m === "done" ? "close the call" : "let the work resume"}</option>)}
              </select>
            </label>
          ) : null}
          <div className="ak-actions">
            {fixed ? fixed.map((f) => (
              <button key={f.answer} type="button" className={`btn small${f.primary ? " primary" : ""}`} disabled={busy} onClick={() => send(f.answer)}>{f.label}</button>
            )) : (
              <>
                {ask.recommended_answer ? (
                  <button type="button" className="btn small" disabled={busy} onClick={() => send(words.trim() ? `${ask.recommended_answer}. ${words.trim()}` : ask.recommended_answer!)}>Use all recommendations</button>
                ) : null}
                <button type="button" className="btn small primary" disabled={busy || !composed.trim()} onClick={() => send(composed)}>{hasOptions ? "Send these choices" : "Send"}</button>
              </>
            )}
            {!showWords && (hasOptions || fixed) && !fixed ? <button type="button" className="btn small ghost" onClick={() => setShowWords(true)}>Add your own words</button> : null}
            {canRecheck(ask) ? <button type="button" className="btn small ghost ak-moot" disabled={busy} onClick={moot} title="Not an answer: Firstmate re-checks this call and closes it if it no longer applies">This looks moot</button> : null}
          </div>
        </>
      )}
      </div> : null}
      {result ? <p className={result.ok ? "ak-ok" : "inline-error ak-err"} role={result.ok ? "status" : "alert"}>{result.text}</p> : null}
    </section>
  );
}
