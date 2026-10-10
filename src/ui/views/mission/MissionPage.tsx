// Mission pane: header (title, goal, state with done-gating, health), then the
// panels registered in `missionPanels`, ordered by the default panel order.
import { useState } from "react";
import { api, repoLabel, useApi } from "../../lib/api";
import { href, type Route } from "../../lib/router";
import { missionPanels } from "../../lib/registry";
import { HealthMark } from "../../components/Marks";
import { EmptyState, ErrorBoundary, TimeAgo, shortPath } from "../../components/primitives";
import { Sheet } from "../../components/Sheet";
import type { MissionH } from "../map/world";
import { DEFAULT_PANEL_ORDER, panelRank } from "./panelOrder";
import { Markdown } from "../knowledge/ui";
import { StartHereButton } from "../start/StartHereButton";
import "./mission.css";

const HEALTH_LABEL: Record<string, string> = { active: "Active", blocked: "Blocked", "needs-review": "Needs review", idle: "Idle" };
const STATES = [["open", "Open"], ["paused", "Paused"], ["done", "Done"], ["dropped", "Dropped"]] as const;

export function MissionRoute({ route }: { route: Route }) {
  const id = route.params[0] ?? "";
  const { data } = useApi<MissionH>(id ? `/api/missions/${encodeURIComponent(id)}` : null, ["missions"]);
  return (
    <Sheet label={`Idea: ${data?.title ?? id}`}>
      <MissionPage id={id} />
    </Sheet>
  );
}

export function MissionPage({ id }: { id: string }) {
  const { data: m, error, reload } = useApi<MissionH>(`/api/missions/${encodeURIComponent(id)}`, ["missions", "attention", "workers", "verdicts", "evidence"]);
  if (error && !m) {
    return (
      <EmptyState title="This idea isn't on the chart" action={<a className="btn" href={href("map")}>Back to the map</a>}>
        <p>{error}. It may have been renamed or removed; search for it with <kbd>⌘K</kbd>.</p>
      </EmptyState>
    );
  }
  if (!m) return <p className="meta" aria-busy="true">Loading the idea…</p>;
  const order = DEFAULT_PANEL_ORDER;
  const rank = (pid: string) => panelRank(order, pid);
  const panels = [...missionPanels].sort((a, b) => rank(a.id) - rank(b.id) || a.order - b.order);
  return (
    <article className="mission-page" data-mission-page={m.id}>
      <header className="mp-header">
        <p className="mp-crumbs"><a href={href("map")}>Map</a><span aria-hidden>/</span><span>{m.repos[0] ? repoLabel(m.repos[0]) : "No repo"}</span>{m.archive ? <><span aria-hidden>/</span><span>Archive</span></> : null}</p>
        <h1 className="mp-title">{m.title}</h1>
        <p className={`mp-health h-${m.health}`}>
          <HealthMark health={m.health} />
          <span className="mp-health-label">{HEALTH_LABEL[m.health] ?? m.health}</span>
          {m.health_why ? <span className="mp-health-why">{m.health_why}</span> : null}
        </p>
        {m.goal ? <div className="mp-goal"><Markdown text={m.goal} /></div> : <p className="mp-goal muted">No goal written yet.</p>}
        <div className="row mp-actions">
          <StartHereButton context={{ kind: "idea", id: m.id }} className="btn primary" />
          <a className="btn" href={`#/start-session?mission=${encodeURIComponent(m.id)}`}>Session options</a>
          <StateControl m={m} onChanged={reload} />
        </div>
        <dl className="mp-facts">
          <div><dt>Repos</dt><dd>{m.repos.length ? m.repos.map((r) => <span key={r} className="mono" title={r}>{shortPath(r)}</span>) : "None"}</dd></div>
          {m.branches.length ? <div><dt>Branches</dt><dd>{m.branches.map((b) => <span key={b} className="mono">{b}</span>)}</dd></div> : null}
          <div><dt>Sessions</dt><dd>{m.sessions.length}</dd></div>
          <div><dt>Updated</dt><dd><TimeAgo iso={m.updated} /></dd></div>
        </dl>
        {panels.length > 2 ? (
          <nav className="mp-toc" aria-label="Idea sections">
            {panels.map((p) => (
              <button key={p.id} type="button" className="btn link" onClick={() => document.getElementById(`panel-${p.id}`)?.scrollIntoView({ block: "start" })}>{p.title}</button>
            ))}
          </nav>
        ) : null}
      </header>
      {panels.map((p) => (
        <section key={p.id} id={`panel-${p.id}`} className="mpanel" aria-labelledby={`panel-h-${p.id}`} data-panel={p.id}>
          <h2 id={`panel-h-${p.id}`}>{p.title}</h2>
          <ErrorBoundary label={`The ${p.title.toLowerCase()} panel`}>
            <p.component mission={m} missionId={m.id} />
          </ErrorBoundary>
        </section>
      ))}
    </article>
  );
}

function StateControl({ m, onChanged }: { m: MissionH; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsReason, setNeedsReason] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  async function setState(state: string, why?: string) {
    setBusy(state); setError(null);
    try {
      await api(`/api/missions/${encodeURIComponent(m.id)}/state`, { method: "PUT", json: { state, ...(why ? { reason: why } : {}) } });
      setNeedsReason(null); setReason("");
      onChanged();
    } catch (e: any) {
      setError(e.message);
      if (state === "done") setNeedsReason(state);
    } finally { setBusy(null); }
  }
  return (
    <div className="mp-state">
      <div className="segmented" role="radiogroup" aria-label="Idea state">
        {STATES.map(([s, label]) => (
          <button key={s} type="button" role="radio" aria-checked={m.state === s} className={m.state === s ? "on" : ""} disabled={!!busy}
            onClick={() => { if (m.state !== s) setState(s); }}>{busy === s ? `${label}…` : label}</button>
        ))}
      </div>
      {m.override ? <p className="meta mp-override">Closed with an override: “{m.override.reason}” <TimeAgo iso={m.override.at} /></p> : null}
      {error ? (
        <div className="inline-error mp-gate" role="alert">
          <p>{error}</p>
          {needsReason ? (
            <form className="row" onSubmit={(e) => { e.preventDefault(); if (reason.trim()) setState("done", reason.trim()); }}>
              <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why it is done without a passing verdict" aria-label="Override reason" />
              <button className="btn primary" type="submit" disabled={!reason.trim() || !!busy}>Close with this reason</button>
            </form>
          ) : null}
        </div>
      ) : null}
      {m.done_when.length === 0 && m.state !== "done" ? <p className="meta">No done-when criteria yet, so closing needs no evidence.</p> : null}
    </div>
  );
}
