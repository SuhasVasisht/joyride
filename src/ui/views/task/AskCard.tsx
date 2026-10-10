// One ask answered in place (control plane §3, W2/W3): the question, its calls with
// options, "Use all recommendations", the captain's own words, and Send. The answer is
// a captain-origin answer_ask intent; the asks module routes it to its owner. Reusable:
// the map's task cards can mount the same card (CP3a hook-up point).
import { useDraft } from "../../lib/useDraft";
import { useState } from "react";
import { post } from "../../lib/api";
import { canRecheck, type Ask } from "../../../shared/asks";
import { TimeAgo } from "../../components/primitives";
import { composeAnswer } from "./model";

type IntentRec = { id: string; status: "pending" | "sent" | "acked" | "failed"; error: string | null; result?: any };

export function AskCard({ ask, compact, onAnswered }: { ask: Ask; compact?: boolean; onAnswered?: () => void }) {
  const [picks, setPicks] = useState<Record<number, string>>({});
  const draft = useDraft({ kind: "ask", id: ask.id });
  const { text: words, setText: setWords } = draft;
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<IntentRec | null>(null);
  const held = ask.answer.via === "fm-captain-hold";
  const modes = ask.answer.via === "fm-captain-hold" ? ask.answer.modes : [];
  const [mode, setMode] = useState<"done" | "release" | undefined>(modes[0]);
  const answer = composeAnswer(ask, picks, words, held);
  const readOnly = ask.read_only ?? (ask.answer.via === "none" ? "Answer this in Firstmate." : null);

  async function send(text: string) {
    if (!text.trim() || busy) return;
    setBusy(true); setRes(null);
    try {
      const it = await post<IntentRec>("/api/intents", { kind: "answer_ask", target: ask.id, origin: "captain", payload: { answer: text, ...(held && mode ? { mode } : {}) } });
      setRes(it);
      if (it.status !== "failed") { draft.clear(); onAnswered?.(); }
    } catch (e: any) { setRes({ id: "", status: "failed", error: `The answer was not sent: ${e.message}` }); }
    finally { setBusy(false); }
  }
  async function moot() {
    if (busy) return;
    setBusy(true); setRes(null);
    try {
      const it = await post<IntentRec>("/api/intents", { kind: "recheck_ask", target: ask.id, origin: "captain", payload: words.trim() ? { words: words.trim() } : {} });
      setRes({ ...it, result: { ...(it.result ?? {}), recheck: true } });
    } catch (e: any) { setRes({ id: "", status: "failed", error: `Firstmate was not asked to re-check this: ${e.message}` }); }
    finally { setBusy(false); }
  }
  const recommend = () => {
    const p: Record<number, string> = {};
    ask.calls.forEach((c, i) => { const r = c.options.find((o) => o.recommended); if (r) p[i] = r.id; });
    setPicks(p);
  };

  return (
    <section className={`ask-card${ask.needs_you ? " needs-you" : ""}${compact ? " compact" : ""}`} data-ask={ask.id} aria-label={`Ask: ${ask.title}`}>
      <header className="ask-head">
        <span className="ask-state">{ask.needs_you ? "Needs you" : ask.state}</span>
        <strong className="ask-title">{ask.title}</strong>
        {ask.opened ? <span className="meta"><TimeAgo iso={ask.opened} /></span> : null}
      </header>
      {ask.needs_you && ask.state && ask.state !== "Needs you" ? <p className="ask-why meta">{ask.state}</p> : null}
      {ask.preamble ? <p className="ask-preamble">{ask.preamble}</p> : !ask.calls.length ? <p className="ask-preamble">{ask.question}</p> : null}
      {ask.calls.map((c, i) => (
        <fieldset key={i} className="ask-call" disabled={Boolean(readOnly) || busy}>
          <legend>{ask.calls.length > 1 ? <span className="ask-n">{c.n ?? i + 1}</span> : null}{c.question}</legend>
          {c.options.map((o) => (
            <label key={o.id} className={`ask-opt${picks[i] === o.id ? " on" : ""}`}>
              <input type="radio" name={`${ask.id}-${i}`} value={o.id} checked={picks[i] === o.id} onChange={() => setPicks({ ...picks, [i]: o.id })} />
              <span>{o.label}</span>
              {o.recommended ? <span className="ask-rec">recommended</span> : null}
            </label>
          ))}
        </fieldset>
      ))}
      {ask.options_source === "suggested" ? <p className="meta ask-src">Options suggested from the question's wording.</p> : null}
      {readOnly ? <p className="meta ask-ro">{readOnly}</p> : (
        <form className="ask-form" onSubmit={(e) => { e.preventDefault(); send(answer); }}>
          <textarea ref={draft.boxRef} className="input" rows={compact ? 1 : 2} value={words} onChange={(e) => setWords(e.target.value)} aria-label={`Your words for ${ask.title}`}
            placeholder={ask.calls.length ? "Add your own words (optional)" : "Type your answer"}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(answer); } }} />
          <div className="row ask-actions">
            {ask.recommended_answer ? <button type="button" className="btn small" onClick={recommend} disabled={busy}>Use all recommendations</button> : null}
            {modes.length > 1 ? (
              <select className="input small" value={mode} onChange={(e) => setMode(e.target.value as "done" | "release")} aria-label="When answered">
                <option value="done">Close the task</option>
                <option value="release">Release the work</option>
              </select>
            ) : null}
            {canRecheck(ask) ? <button type="button" className="btn small ghost ask-moot" onClick={moot} disabled={busy} title="Not an answer: Firstmate re-checks this call and closes it if it no longer applies">This looks moot</button> : null}
            <button type="submit" className="btn primary small" disabled={busy || !answer.trim()}>{busy ? "Sending" : modes[0] === "release" && modes.length === 1 ? "Send and release" : "Send answer"}</button>
          </div>
        </form>
      )}
      {res ? (
        <p className={res.status === "failed" ? "inline-error" : "cap-ok"} role={res.status === "failed" ? "alert" : "status"}>
          {res.status === "failed" ? res.error : res.result?.recheck ? "Asked Firstmate to re-check this. It stays here until Firstmate closes it." : "Answer sent. It closes here once its owner confirms."}
        </p>
      ) : null}
    </section>
  );
}
