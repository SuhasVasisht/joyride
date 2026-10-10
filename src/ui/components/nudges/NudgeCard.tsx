// One nudge with its actions, answered in place. Feedback nudges open a one-line "why" field after 👍 or 👎.
import { useState } from "react";
import { href } from "../../lib/router";
import { TimeAgo } from "../primitives";
import { actOn, type Nudge } from "./api";
import { Pulse } from "./motion";

const enc = encodeURIComponent;

function Where({ n }: { n: Nudge }) {
  const links: { to: string; label: string }[] = [];
  if (n.task) links.push({ to: href(`task/${enc(n.task)}`), label: n.task });
  if (n.mission) links.push({ to: href(`mission/${enc(n.mission)}`), label: "Idea" });
  if (n.worker && n.rule !== "firstmate_waiting") links.push({ to: href(`worker/${enc(n.worker)}`), label: "Worker" });
  return (
    <p className="nd-where">
      <TimeAgo iso={n.opened} />
      {links.map((l) => <a key={l.to} href={l.to}>{l.label}</a>)}
    </p>
  );
}

export function NudgeCard({ n, onDone }: { n: Nudge; onDone?: (message: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<"up" | "down" | null>(null);
  const [words, setWords] = useState("");

  async function run(action: string, w?: string) {
    setBusy(action); setErr(null);
    try { const r = await actOn(n.id, action, w); onDone?.(r.message); }
    catch (e: any) { setErr(`That didn't go through: ${e.message}`); }
    finally { setBusy(null); }
  }

  const feedbackish = n.actions.some((a) => a.words);
  return (
    <Pulse as="li" value={[n.title, n.why]} tone={n.level === "L3" || n.level === "L4" ? "signal" : n.level === "L2" ? "review" : "working"}
      className={`nudge rule-${n.rule} lvl-${n.level}`}>
      <div data-nudge={n.id}>
        <div className="nd-head">
          <span className="nd-title">{n.title}</span>
        </div>
        <p className="nd-why">{n.why}</p>
        <Where n={n} />
        {verdict ? (
          <form className="nd-words" onSubmit={(e) => { e.preventDefault(); run(verdict, words); }}>
            <label className="nd-sr" htmlFor={`nd-w-${n.id}`}>{verdict === "up" ? "What went well (optional)" : "What didn't land (optional)"}</label>
            <input id={`nd-w-${n.id}`} className="input" autoFocus value={words} onChange={(e) => setWords(e.target.value)}
              placeholder={verdict === "up" ? "What went well? (optional)" : "What didn't land? Firstmate will read this"} />
            <div className="nd-actions">
              <button type="submit" className="btn small primary" disabled={!!busy}>{busy ? "Sending…" : verdict === "up" ? "Send 👍" : "Send 👎"}</button>
              <button type="button" className="btn small ghost" disabled={!!busy} onClick={() => { setVerdict(null); setWords(""); }}>Back</button>
            </div>
          </form>
        ) : (
          <div className="nd-actions">
            {n.actions.map((a) => a.href ? (
              <a key={a.id} className={`btn small${a.primary ? " primary" : ""}`} href={a.href}>{a.label}</a>
            ) : (
              <button key={a.id} type="button" className={`btn small${a.primary ? " primary" : ""}`} disabled={!!busy}
                aria-label={feedbackish && a.words ? `${a.label}: ${n.why}` : undefined}
                onClick={() => (a.words ? setVerdict(a.id as "up" | "down") : run(a.id))}>
                {a.id === "up" ? "👍 " : a.id === "down" ? "👎 " : ""}{busy === a.id ? "…" : a.label}
              </button>
            ))}
          </div>
        )}
        {err ? <p className="inline-error" role="alert">{err}</p> : null}
      </div>
    </Pulse>
  );
}
