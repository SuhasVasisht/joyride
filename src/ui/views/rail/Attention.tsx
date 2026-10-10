// Needs you (open L3/L4), Review (L2) and Digest (L1) rail sections.
import { useNeedsYou, openNeedsYou } from "../../lib/needs-you";
import { AskCard } from "../map/AskCard";
import { ReplyBox } from "../../components/ReplyBox";
import { PromptAnswer } from "../../components/PromptAnswer";
import { useArrivals } from "./arrivals";
import { useIntentions } from "../../lib/intentions";
import { useState } from "react";
import { post, useApi } from "../../lib/api";
import { href } from "../../lib/router";
import type { AttentionItem, WorkerView } from "../../lib/types";
import { EmptyState, LevelBadge, TimeAgo } from "../../components/primitives";

const enc = encodeURIComponent;
type Labeled = AttentionItem & { ref: Record<string, any> };

async function label(id: string, kind: "ack" | "dismiss" | "snooze" | "override", extra: Record<string, unknown> = {}) {
  return post(`/api/attention/${enc(id)}/label`, { label: kind, ...extra });
}

function useWorkers() {
  const { data } = useApi<WorkerView[]>("/api/workers", ["workers"]);
  return new Map((data ?? []).map((w) => [w.id, w]));
}

function Actions({ a, compact }: { a: Labeled; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr(null);
    try { await fn(); } catch (e: any) { setErr(`That didn't save: ${e.message}`); } finally { setBusy(false); }
  };
  const { acknowledge } = useNeedsYou();
  return (
    <>
      <div className="att-actions">
        {!compact ? <button type="button" className="btn small" title="I have seen this and own the next step" disabled={busy} onClick={() => run(() => acknowledge(a.id))}>Got it</button> : null}
        {!compact ? <button type="button" className="btn small" disabled={busy} onClick={() => run(() => label(a.id, "snooze", { minutes: 60 }))}>Snooze 1h</button> : null}
        <button type="button" className="btn small" title="Close this item without agreeing with its classification" disabled={busy} onClick={() => run(() => label(a.id, "dismiss"))}>Dismiss</button>
        <select className="relevel" aria-label={`Change the level of: ${a.title}`} value="" disabled={busy}
          onChange={(e) => { const level = e.target.value; if (level) run(() => label(a.id, "override", { level, reason: "re-levelled in the rail" })); }}>
          <option value="">Re-level</option>
          {["L4", "L3", "L2", "L1", "L0"].filter((l) => l !== a.level).map((l) => <option key={l} value={l}>{l === "L0" ? "L0, hide it" : l}</option>)}
        </select>
      </div>
      {err ? <p className="inline-error" role="alert">{err}</p> : null}
    </>
  );
}

function Context({ a, workers }: { a: Labeled; workers: Map<string, WorkerView> }) {
  const w = a.worker ? workers.get(a.worker) : null;
  return (
    <p className="att-context">
      <TimeAgo iso={a.opened} />
      {a.worker ? <a href={href(`worker/${enc(a.worker)}`)}>{w?.title || "Open worker"}</a> : null}
      {a.mission ? <a href={href(`mission/${enc(a.mission)}`)}>Idea</a> : null}
      {!a.worker && a.session ? <a href={href(`session/${enc(a.session)}`)}>Session</a> : null}
    </p>
  );
}

export function NeedsYou() {
  const { items: asks, ready, error, undoAck } = useNeedsYou();
  const { data: history } = useApi<Labeled[]>("/api/attention?open=0&limit=2000", ["attention"]);
  const seen = (history ?? []).filter((a) => a.resolution === "acknowledged");
  const [undoError, setUndoError] = useState<string | null>(null);
  const { data } = useApi<Labeled[]>("/api/attention?open=1&limit=2000", ["attention"]);
  const byId = new Map((data ?? []).map((a) => [a.id, a]));
  const items = asks.flatMap((ask) => {
    const a = typeof ask.ref.attention === "string" && ask.source === "attention" ? byId.get(ask.ref.attention) : undefined;
    return a ? [a] : [];
  });
  const arrivals = useArrivals("needs-you", data ? items.map((a) => a.id) : null);
  const workers = useWorkers();
  const sessionOf = (a: Labeled) => a.session ?? (a.worker ? workers.get(a.worker)?.session : null) ?? null;
  const intents = useIntentions(items.map(sessionOf));
  return (
    <section className={`rail-sec needs-you${ready && asks.length ? " has-items" : ""}`} data-rail="attention" aria-labelledby="rail-needs" tabIndex={-1}>
      <h3 id="rail-needs">Needs you {ready && asks.length ? <button className="count btn link" onClick={openNeedsYou}>{asks.length}</button> : null}</h3>
      {error ? <p className="inline-error">Attention items can't load: {error}. Check that the daemon is running.</p> : null}
      {ready && asks.length ? (
        <ul className="rail-list">
          {asks.map((ask) => {
            const a = typeof ask.ref.attention === "string" && ask.source === "attention" ? byId.get(ask.ref.attention) : undefined;
            if (!a) return <li key={ask.id} data-needs-you={ask.id}><AskCard ask={ask} /></li>;
            const i = items.indexOf(a);
            const w = a.worker ? workers.get(a.worker) : null;
            // One blocked worker can have several open items; its prompt is answered once, on the first.
            const answerHere = !!(a.worker && w?.controllable && w.status === "blocked") && !items.slice(0, i).some((b) => b.worker === a.worker);
            return (
              <li key={a.id} className={`att lvl-${a.level}${arrivals.has(a.id) ? " arrive" : ""}${a.ref?.acked_at ? " acked" : ""}`} data-attention={a.id} data-needs-you={ask.id}>
                <div className="att-head"><LevelBadge level={a.level} /><span className="att-title">{a.title}</span></div>
                {(() => { const goal = intents.get(sessionOf(a) ?? "")?.goal; return goal ? <p className="att-goal" title="What this agent is working toward"><span>Goal</span> {goal}</p> : null; })()}
                {a.why ? <p className="att-why">{a.why}</p> : null}
                <Context a={a} workers={workers} />
                {answerHere && a.worker ? (
                  <PromptAnswer worker={a.worker} name={w?.title || undefined} attention={a.id} compact />
                ) : a.worker && w?.controllable && w.status === "blocked" ? (
                  <p className="meta att-same">Same prompt as above; answering it there clears this too.</p>
                ) : a.worker && (!w || w.controllable) ? (
                  <ReplyBox worker={a.worker} agent={w?.agent} attention={a.id} label={`Reply to ${w?.title || a.worker}`} placeholder={`Reply to ${w?.title || "the agent"}`} />
                ) : a.worker ? <p className="meta">This agent runs outside Herdr. <a href={href(`worker/${enc(a.worker)}`)}>Get its resume command</a></p> : null}
                <Actions a={a} />
              </li>
            );
          })}
        </ul>
      ) : ready ? (
        <EmptyState title="No one is waiting on you">
          <p>When an agent asks a question, hits a permission prompt or crashes, it lands here with a reply box.</p>
        </EmptyState>
      ) : null}
      {seen.length ? <details data-rail="seen">
        <summary>Seen <span className="count">{seen.length}</span></summary>
        <ul className="rail-list">{seen.map((a) => <li key={a.id} data-seen={a.id}>
          <span className="att-title">{a.title}</span>
          <Context a={a} workers={workers} />
          <button className="btn small" onClick={async () => {
            setUndoError(null);
            try { await undoAck(a.id); } catch (e) { setUndoError(`Undo didn't save: ${e instanceof Error ? e.message : String(e)}. Try again.`); }
          }}>Undo</button>
        </li>)}</ul>
        {undoError ? <p role="alert" className="inline-error">{undoError}</p> : null}
      </details> : null}
    </section>
  );
}

export function Review() {
  const { data } = useApi<Labeled[]>("/api/attention?open=1&level=L2&limit=100", ["attention"]);
  const workers = useWorkers();
  const items = data ?? [];
  return (
    <section className="rail-sec review" data-rail="review" aria-labelledby="rail-review">
      <h3 id="rail-review">Review {items.length ? <span className="count">{items.length}</span> : null}</h3>
      {items.length ? (
        <ul className="rail-list">
          {items.map((a) => (
            <li key={a.id} className="att lvl-L2" data-attention={a.id}>
              <div className="att-head"><LevelBadge level="L2" /><span className="att-title">{a.title}</span></div>
              {a.why ? <p className="att-why">{a.why}</p> : null}
              <Context a={a} workers={workers} />
              <Actions a={a} />
            </li>
          ))}
        </ul>
      ) : data ? (
        <EmptyState title="Nothing to review"><p>Finished work with evidence, and agents editing the same files, show up here.</p></EmptyState>
      ) : null}
    </section>
  );
}

export function Digest() {
  const { data } = useApi<Labeled[]>("/api/attention?open=1&level=L1&limit=100", ["attention"]);
  const items = data ?? [];
  const [busy, setBusy] = useState(false);
  return (
    <section className="rail-sec digest" data-rail="digest">
      <details>
        <summary><h3>Digest {items.length ? <span className="count">{items.length}</span> : null}</h3></summary>
        {items.length ? (
          <>
            <ul className="digest-list">
              {items.map((a) => (
                <li key={a.id} data-attention={a.id}>
                  <span className="dg-title">{a.title}</span>
                  {a.why ? <span className="dg-why">{a.why}</span> : null}
                  <span className="dg-meta"><TimeAgo iso={a.opened} /><button type="button" className="btn link" onClick={() => label(a.id, "dismiss")}>Dismiss</button></span>
                </li>
              ))}
            </ul>
            <button type="button" className="btn small" disabled={busy} onClick={async () => { setBusy(true); await Promise.allSettled(items.map((a) => label(a.id, "dismiss"))); setBusy(false); }}>Dismiss all</button>
          </>
        ) : <EmptyState title="Quiet so far"><p>Progress notes and nudges collect here instead of interrupting you.</p></EmptyState>}
      </details>
    </section>
  );
}
