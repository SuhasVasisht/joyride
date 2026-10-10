// Session pane: the conversation in the same chat view as a worker (read only;
// Resume in Herdr picks it up when nothing runs it), what it was trying to do,
// and a control to link the session to a mission.
import { useState } from "react";
import { api, cleanTitle, post, repoLabel, useApi } from "../../lib/api";
import { href, type Route } from "../../lib/router";
import type { SessionView } from "../../lib/types";
import { EmptyState, TimeAgo, plural, shortPath } from "../../components/primitives";
import { Sheet } from "../../components/Sheet";
import { ChatLog } from "../../components/ChatLog";
import { IntentPanel } from "../../components/IntentPanel";
import { SessionArtifacts } from "../artifacts/ArtifactsPanel";
import { NotesBlock } from "../../components/notes/NotesBlock";
import type { MissionH } from "../map/world";
import "../mission/mission.css";
import "./session.css";
import { ResumeInHerdr, OpenInHerdr } from "../../components/HerdrActions";
import { useApi as useApiLive } from "../../lib/api";

const enc = encodeURIComponent;
type Session = SessionView & { subagents?: number };

export function SessionRoute({ route }: { route: Route }) {
  const key = route.params.join("/");
  const { data } = useApi<Session>(key ? `/api/sessions/${enc(key)}` : null, ["sessions"]);
  return <Sheet label={`Session: ${cleanTitle(data?.title, key)}`} wide><SessionPane sessionKey={key} /></Sheet>;
}

function fmtTokens(n: number) { return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n); }

export function SessionPane({ sessionKey }: { sessionKey: string }) {
  const { data: s, error } = useApi<Session>(`/api/sessions/${enc(sessionKey)}`, ["sessions", "missions"]);
  if (error && !s) {
    return (
      <EmptyState title="This session isn't in the index" action={<a className="btn" href={href("map")}>Back to the map</a>}>
        <p>{error}</p>
      </EmptyState>
    );
  }
  if (!s) return <p className="meta" aria-busy="true">Loading the session…</p>;
  return (
    <article className="pane-page session-pane" data-session-pane={s.key}>
      <header className="mp-header">
        <p className="mp-crumbs"><a href={href("map")}>Map</a><span aria-hidden>/</span>{s.mission ? <><a href={href(`mission/${enc(s.mission)}`)}>Idea</a><span aria-hidden>/</span></> : null}<span>Session</span></p>
        <h1 className="mp-title sp-title">{cleanTitle(s.title || s.first_prompt, s.key)}</h1>
        <dl className="mp-facts">
          <div><dt>Agent</dt><dd>{s.source === "codex" ? "Codex" : "Claude Code"}{s.model ? <span className="mono">{s.model}</span> : null}</dd></div>
          <div><dt>Repo</dt><dd title={s.cwd}>{s.repo ? repoLabel(s.repo) : <span className="mono">{shortPath(s.cwd)}</span>}</dd></div>
          {s.branch ? <div><dt>Branch</dt><dd><span className="mono">{s.branch}</span></dd></div> : null}
          <div><dt>Turns</dt><dd>{s.turns}{s.subagents ? `, ${plural(s.subagents, "subagent")}` : ""}</dd></div>
          {s.tokens ? <div><dt>Tokens</dt><dd>{fmtTokens(s.tokens)}</dd></div> : null}
          <div><dt>Started</dt><dd><TimeAgo iso={s.started} /></dd></div>
          <div><dt>Last activity</dt><dd><TimeAgo iso={s.updated} /></dd></div>
        </dl>
        <MissionLink s={s} />
        <SessionLive s={s} />
        <SessionArtifacts session={s.key} />
        <IntentPanel sessionKey={s.key} compact />
        <div className="wp-notes"><NotesBlock variant="strip" anchor={{ kind: "session", id: s.key }} place="this session" /></div>
      </header>
      <section className="transcript" aria-label="Transcript">
        <ChatLog
          sessionKey={s.key}
          agent={s.source === "codex" ? "Codex" : "Claude"}
          root={s.cwd}
          initialLimit={120}
          className="session-chat"
          empty={<EmptyState title="Nothing in this transcript yet" />}
        />
      </section>
    </article>
  );
}

function MissionLink({ s }: { s: Session }) {
  const { data: missions } = useApi<MissionH[]>("/api/missions", ["missions"]);
  const [pick, setPick] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const current = s.mission ? (missions ?? []).find((m) => m.id === s.mission) : null;
  const choices = (missions ?? []).filter((m) => !m.archive && m.state !== "done" && m.state !== "dropped" && m.id !== s.mission);
  const link = async () => {
    setErr(null);
    try { await post(`/api/missions/${enc(pick)}/sessions`, { refs: [s.key] }); setPick(""); }
    catch (e: any) { setErr(`Could not link this session: ${e.message}`); }
  };
  const unlink = async () => {
    setErr(null);
    try { await api(`/api/missions/${enc(s.mission!)}/sessions/${enc(s.key)}`, { method: "DELETE" }); }
    catch (e: any) { setErr(`Could not unlink this session: ${e.message}`); }
  };
  const [moving, setMoving] = useState(false);
  return (
    <div className="sp-mission">
      {s.mission ? (
        <p className="row">
          <span className="meta">Part of</span>
          <a href={href(`mission/${enc(s.mission)}`)} className="sp-mission-link">{current?.title ?? s.mission}</a>
          <button type="button" className="btn small" onClick={unlink}>Unlink</button>
          {choices.length ? <button type="button" className="btn ghost small" aria-expanded={moving} onClick={() => setMoving((m) => !m)}>Move</button> : null}
        </p>
      ) : <p className="meta sp-none">Not part of an idea yet. Linking it puts its work on the map.</p>}
      {!s.mission || moving ? (
        <form className="row sp-link-form" onSubmit={(e) => { e.preventDefault(); if (pick) link().then(() => setMoving(false)); }}>
          <select className="input" value={pick} onChange={(e) => setPick(e.target.value)} aria-label={s.mission ? "Move to another idea" : "Link to an idea"}>
            <option value="">{s.mission ? "Choose an idea" : "Choose an idea to link"}</option>
            {choices.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
          </select>
          <button className="btn" type="submit" disabled={!pick}>{s.mission ? "Move" : "Link"}</button>
        </form>
      ) : null}
      {err ? <p className="inline-error" role="alert">{err}</p> : null}
    </div>
  );
}

/** Where this conversation is running now, with the matching Herdr action. */
function SessionLive({ s }: { s: any }) {
  const { data: workers } = useApiLive<any[]>("/api/workers", ["workers"]);
  const live = (workers ?? []).find((w) => w.session === s.key);
  if (live) {
    return (
      <p className="row sp-live">
        <span className="meta">Running now{live.controllable ? " in Herdr" : " in a plain terminal"}.</span>
        <a className="btn" href={`#/worker/${encodeURIComponent(live.id)}`}>Open its worker</a>
        {live.controllable ? <OpenInHerdr worker={live.id} /> : null}
      </p>
    );
  }
  return (
    <p className="row sp-live">
      <span className="meta">Not running. Pick it up where it left off:</span>
      <ResumeInHerdr session={s.key} cwd={s.cwd} agent={s.source === "codex" ? "codex" : "claude"} />
    </p>
  );
}
