// Worker pane: who it is and what it is trying to do (intent), then three tabs.
//   Chat (default): the live conversation, a prompt it is stuck on answered
//     inline, and the reply box pinned at the bottom.
//   Terminal: its Herdr pane in the browser (type straight into it; no terminal app).
//   Details: current action, last message and recent tools.
import { SessionArtifacts } from "../artifacts/ArtifactsPanel";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { cleanTitle, repoLabel, useApi } from "../../lib/api";
import { href, type Route } from "../../lib/router";
import type { AttentionItem, GuardRequest, SessionView, WorkerView } from "../../lib/types";
import { VesselMark } from "../../components/Marks";
import { CopyButton, EmptyState, LevelBadge, StateChip, TimeAgo, shortPath } from "../../components/primitives";
import { ReplyBox } from "../../components/ReplyBox";
import { FleetChips } from "../fleet/chips";
import { MoveToHerdr, OpenInHerdr } from "../../components/HerdrActions";
import { PromptAnswer } from "../../components/PromptAnswer";
import { Sheet } from "../../components/Sheet";
import { InlineMd } from "../../components/InlineMd";
import { ChatLog, useTranscript } from "../../components/ChatLog";
import { IntentPanel } from "../../components/IntentPanel";
import { NotesBlock } from "../../components/notes/NotesBlock";
import { ApprovalCard, guardSessionKey } from "../rail/Approvals";
import { useWorld } from "../map/world";
import "../mission/mission.css";
import "./worker.css";

const TerminalView = lazy(() => import("../../components/TerminalView"));
const enc = encodeURIComponent;
type Tab = "chat" | "terminal" | "details";
const asTab = (t: string | null | undefined): Tab => (t === "terminal" || t === "details" ? t : "chat");
const agentName = (a: string) => (a === "codex" ? "Codex" : a === "claude" ? "Claude" : a);
/** "Herdr pane w1:p2", "Process 4242 on devvm"; the machine only when it isn't this one. */
const where = (w: WorkerView) => {
  const what = w.pane ? `Herdr pane ${w.pane}` : w.pid ? `Process ${w.pid}` : "";
  const machine = w.machine && w.machine !== "local" ? w.machine : "";
  return what && machine ? `${what} on ${machine}` : what || (machine ? `On ${machine}` : "");
};

const shq = (s: string) => (/^[\w./@%+=:,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
/** Mirrors the daemon's resume hint (live/common.ts) so it can be shown before a reply fails. */
export function resumeCommandFor(w: WorkerView) {
  const id = w.session ? w.session.split(":").slice(1).join(":") : null;
  const cmd = w.agent === "codex" ? (id ? `codex resume ${id}` : "codex resume --last") : id ? `claude --resume ${id}` : "claude --continue";
  return `cd ${shq(w.cwd || "~")} && ${cmd}`;
}

export function WorkerRoute({ route }: { route: Route }) {
  const id = route.params[0] ?? "";
  const [tab, setTab] = useState<Tab>(asTab(route.query.get("tab")));
  useEffect(() => { setTab(asTab(route.query.get("tab"))); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const { data } = useApi<WorkerView>(id ? `/api/workers/${enc(id)}` : null, ["workers"]);
  return <Sheet label={`Worker: ${data?.title || id}`} wide={tab === "terminal"}><WorkerPane id={id} tab={tab} onTab={setTab} /></Sheet>;
}

export function WorkerPane({ id, tab: tabProp, onTab }: { id: string; tab?: Tab; onTab?: (t: Tab) => void }) {
  const [ownTab, setOwnTab] = useState<Tab>("chat");
  const tab = tabProp ?? ownTab;
  const setTab = onTab ?? setOwnTab;
  useEffect(() => {
    const on = (e: Event) => { const t: unknown = (e as CustomEvent).detail; if (t === "chat" || t === "terminal" || t === "context") setTab(t === "context" ? "details" : t); };
    window.addEventListener("joyride:worker-tab", on);
    return () => window.removeEventListener("joyride:worker-tab", on);
  }, [setTab]);
  const { data: w, error } = useApi<WorkerView>(`/api/workers/${enc(id)}`, ["workers"]);
  const sessionPath = w?.session ? `/api/sessions/${enc(w.session)}` : null;
  const { data: session } = useApi<SessionView>(sessionPath, ["sessions"]);
  const { data: pending } = useApi<GuardRequest[]>("/api/guard/pending", ["guard"]);
  const { data: open } = useApi<AttentionItem[]>("/api/attention?open=1&limit=200", ["attention"]);
  const world = useWorld();

  const missionId = w ? (w.mission ?? (w.session ? world.sessionMission.get(w.session) : null) ?? null) : null;
  const mission = missionId ? world.missions.find((m) => m.id === missionId) : null;
  // Firstmate's control session is the Firstmate node on the map; everyone else outside a mission is unfiled under its project.
  const isControl = world.firstmate.status?.pane?.worker === id || w?.owner?.tier === "control";
  const approvals = (pending ?? []).filter((r) => w?.session && guardSessionKey(r) === w.session);
  const items = (open ?? []).filter((a) => a.kind !== "guard" && (a.worker === id || (w?.session && a.session === w.session)));

  if (error && !w) {
    return (
      <EmptyState title="This worker has stopped" action={<a className="btn" href={href("map")}>Back to the map</a>}>
        <p>{error} Its sessions are still in the index; find them with <kbd>⌘K</kbd>.</p>
      </EmptyState>
    );
  }
  if (!w) return <p className="meta" aria-busy="true">Loading the worker…</p>;
  const canTerminal = Boolean(w.pane);
  const shownTab: Tab = tab === "terminal" && !canTerminal ? "chat" : tab;
  return (
    <article className={`pane-page worker-pane tab-${shownTab}${shownTab === "terminal" ? " wide" : ""}`} data-worker-pane={w.id}>
      <header className="mp-header">
        <p className="mp-crumbs">
          <a href={href("map")}>Map</a><span aria-hidden>/</span>
          {mission ? <><a href={href(`mission/${enc(mission.id)}`)}>{mission.title}</a><span aria-hidden>/</span></>
            : isControl ? <><span>Firstmate</span><span aria-hidden>/</span></>
            : <><a href={href("agents")}>Unfiled</a><span aria-hidden>/</span></>}
          <span>Worker</span>
        </p>
        <h1 className="mp-title wp-title"><VesselMark status={w.status} agent={w.agent} size={22} /> {w.title || w.id}</h1>
        <p className="wp-status">
          <StateChip state={w.status} />
          <span>{w.agent === "codex" ? "Codex" : w.agent === "claude" ? "Claude Code" : w.agent}</span>
          {where(w) ? <span>{where(w)}</span> : null}
          <span title={w.cwd}>{w.repo ? repoLabel(w.repo) : shortPath(w.cwd, 2)}{session?.branch ? <> on <span className="mono">{session.branch}</span></> : null}</span>
          <span>Updated <TimeAgo iso={w.updated} /></span>
          {isControl ? null : <FleetChips w={w} />}
        </p>
        <IntentPanel sessionKey={w.session} />
        <WorkerNotes w={w} />
        {w.session ? <SessionArtifacts session={w.session} /> : null}
      </header>

      <div className="wp-tabbar">
        <div className="wp-tabs" role="tablist" aria-label="Worker views">
          {(["chat", "terminal", "details"] as Tab[]).filter((t) => t !== "terminal" || canTerminal).map((t) => (
            <button key={t} type="button" role="tab" id={`wp-tab-${t}`} aria-selected={shownTab === t} aria-controls={`wp-panel-${t}`} className={shownTab === t ? "on" : ""} onClick={() => setTab(t)}>
              {{ chat: "Chat", terminal: "Terminal", details: "Details" }[t]}
            </button>
          ))}
        </div>
        <div className="row wp-actions">
          {w.controllable ? <OpenInHerdr worker={w.id} className="btn small" /> : w.pid ? <MoveToHerdr worker={w.id} title={w.title || undefined} /> : null}
        </div>
      </div>

      <div role="tabpanel" id={`wp-panel-${shownTab}`} aria-labelledby={`wp-tab-${shownTab}`} className="wp-panel">
        {shownTab === "chat" ? <ChatTab w={w} error={error} approvals={approvals} items={items} missionTitle={mission?.title ?? null} /> : null}
        {shownTab === "terminal" && w.pane ? (
          <Suspense fallback={<p className="meta" aria-busy="true">Opening the terminal…</p>}>
            <TerminalView worker={w.id} pane={w.pane} name={w.title || undefined} controllable={w.controllable} />
          </Suspense>
        ) : null}
        {shownTab === "details" ? (
          <>
            <dl className="mp-facts">
              <div><dt>Folder</dt><dd><span className="mono" title={w.cwd}>{shortPath(w.cwd, 4)}</span></dd></div>
              <div><dt>Repo</dt><dd>{w.repo ? repoLabel(w.repo) : "None"}</dd></div>
              <div><dt>Branch</dt><dd>{session?.branch ? <span className="mono">{session.branch}</span> : "Unknown"}</dd></div>
              <div><dt>Session</dt><dd>{w.session ? <a href={href(`session/${enc(w.session)}`)}>{cleanTitle(session?.title, "Open transcript")}</a> : "Not linked"}</dd></div>
              <div><dt>Idea</dt><dd>{mission ? <a href={href(`mission/${enc(mission.id)}`)}>{mission.title}</a> : "None yet"}</dd></div>
            </dl>
            <DetailsTab w={w} />
          </>
        ) : null}
      </div>
    </article>
  );
}

/** Notes on this agent (its session); a crewmate also shows its task's notes. With no session yet, notes go on its task. */
function WorkerNotes({ w }: { w: WorkerView }) {
  const task = w.crew ?? w.owner?.task ?? null;
  const anchor = w.session ? { kind: "session" as const, id: w.session } : task ? { kind: "task" as const, id: task } : null;
  if (!anchor) return null;
  const also = anchor.kind === "session" && task ? { anchor: { kind: "task" as const, id: task }, label: `On its task ${task}:` } : null;
  return <div className="wp-notes"><NotesBlock variant="strip" anchor={anchor} place={anchor.kind === "session" ? "this agent" : `task ${task}`} also={also} /></div>;
}

function ChatTab({ w, error, approvals, items, missionTitle }: { w: WorkerView; error: string | null; approvals: GuardRequest[]; items: AttentionItem[]; missionTitle: string | null }) {
  const [answered, setAnswered] = useState(false);
  useEffect(() => { if (w.status !== "blocked") return; setAnswered(false); }, [w.status]);
  const blocked = w.controllable && w.status === "blocked";
  const resume = resumeCommandFor(w);
  const who = w.title || "the agent";
  const unavailable = error ? `${error} Your draft is saved. Reopen the active conversation from the map before sending.`
    : !w.controllable && w.pane ? "Reconnecting to Herdr. Your draft is saved. You can keep typing and send when the connection returns."
    : w.owner.tier === "control" && !w.session ? "Waiting for Firstmate's conversation to be linked. Your draft is saved; send when the connection is ready."
    : null;
  const prompt = w.controllable && (blocked || answered) ? (
    <div className="wp-prompt" aria-labelledby="wp-prompt">
      <h2 id="wp-prompt" className="wp-prompt-title">{w.status === "blocked" ? "Answer its prompt" : "Prompt answered"}</h2>
      <p className="panel-meta">{w.status === "blocked" ? "It stopped at a prompt in its terminal. Pick an option here; Joyride types it into the Herdr pane." : "It is moving again. This is what its terminal shows now."}</p>
      <PromptAnswer worker={w.id} name={w.title || undefined} onAnswered={() => setAnswered(true)} />
    </div>
  ) : null;
  const footer = (
    <section className="wp-reply" aria-labelledby="wp-reply">
      <h2 id="wp-reply" className="visually-hidden">Reply</h2>
      {!w.pane ? (
        <div className="wp-outside">
          <p>This agent runs outside Herdr, so Joyride can't type into it. <strong>Move to Herdr</strong> (above) ends this process and resumes the same conversation in a Herdr tab, where you can reply here or in the Terminal tab. Or reply in its own terminal, or resume it yourself:</p>
          <div className="resume-cmd"><code>{resume}</code><CopyButton text={resume} label="Copy resume command" /></div>
        </div>
      ) : w.status === "blocked" ? (
        <p className="meta wp-reply-note">A reply reaches it once the prompt above is answered.</p>
      ) : null}
      {w.pane ? <ReplyBox worker={w.id} session={w.session} agent={w.agent} rows={2} staged unavailable={unavailable}
        binding={{ session: w.session, terminal_id: w.terminal_id, control: w.owner.tier === "control" }}
        label={`Reply to ${w.title || w.id}`} placeholder="Reply to the agent. Enter sends, Shift+Enter adds a line." /> : null}
    </section>
  );
  return (
    <>
      {approvals.length ? (
        <section className="wp-approvals" aria-labelledby="wp-approvals">
          <h2 id="wp-approvals">Waiting for your approval</h2>
          <ul className="rail-list">{approvals.map((r) => <ApprovalCard key={r.id} r={r} missionTitle={missionTitle} />)}</ul>
        </section>
      ) : null}
      {items.map((a) => (
        <div key={a.id} className={`wp-attn lvl-${a.level}`} data-attention={a.id}>
          <LevelBadge level={a.level} /> <strong>{a.title}</strong>
          {a.why ? <p>{a.why}</p> : null}
        </div>
      ))}
      <ChatLog
        sessionKey={w.session}
        worker={w.pane ? w.id : null}
        agent={agentName(w.agent)}
        root={w.cwd}
        tail={prompt}
        footer={footer}
        empty={w.session
          ? <EmptyState title="Nothing said yet"><p>Messages appear here as soon as {who} starts on its first prompt.</p></EmptyState>
          : <EmptyState title="No conversation linked"><p>Joyride hasn't matched this agent to a transcript yet, so there is nothing to show here. {w.pane ? "The Terminal tab shows its screen." : ""}</p></EmptyState>}
      />
    </>
  );
}

function DetailsTab({ w }: { w: WorkerView }) {
  const { turns } = useTranscript(w.session, 16);
  const tools = useMemo(() => {
    const out: { ts: string | null; name: string; summary: string }[] = [];
    for (const t of turns ?? []) for (const x of t.tools) out.push({ ts: t.ts, ...x });
    return out.reverse().slice(0, 14);
  }, [turns]);
  const lastAssistant = [...(turns ?? [])].reverse().find((t) => t.role === "assistant" && t.text.trim());
  return (
    <>
      <section className="mpanel wp-details" aria-labelledby="wp-now">
        <h2 id="wp-now">Now</h2>
        <div className="wp-now">
          <span className="wp-label">Current action</span>
          <code className="wp-action">{w.current_action || (w.status === "blocked" ? "Waiting at a prompt in its terminal" : "No action reported")}</code>
          <span className="wp-label">Last message</span>
          <blockquote className="wp-msg"><InlineMd text={w.last_message || lastAssistant?.text || "No message yet."} /></blockquote>
        </div>
      </section>
      <section className="mpanel" aria-labelledby="wp-tools">
        <h2 id="wp-tools">Recent tools</h2>
        {tools.length ? (
          <ol className="tool-list">
            {tools.map((t, i) => (
              <li key={i}><span className="tool-name">{t.name}</span><code className="tool-sum">{t.summary}</code>{t.ts ? <span className="meta"><TimeAgo iso={t.ts} /></span> : null}</li>
            ))}
          </ol>
        ) : <p className="meta">{w.session ? "No tool calls in the recent transcript." : "No session is linked, so there is no transcript to read tools from."}</p>}
        {w.session ? <p><a href={href(`session/${enc(w.session)}`)}>Read the full transcript</a></p> : null}
      </section>
    </>
  );
}
