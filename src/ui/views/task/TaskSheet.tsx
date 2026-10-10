// #/task/<id>: a Firstmate task in the right-side sheet over the live map (control plane
// W4). Its open asks are pinned on top and answered in place; then four tabs:
//   Timeline (default): brief, status lines, steers, notes, asks and the report in order.
//   Brief: what Firstmate told the crew.   Report: the report and the calls it raised.
//   Crew: who runs it (agent, model, effort, account, pane) and its live workers.
// The steer box stays at the bottom.
// #/task with no id is the crew on the Agents page (agents/model.ts legacyTarget).
import type { ArtifactView } from "../artifacts/ArtifactsPage";
import { openArtifact } from "../artifacts/ArtifactOverlay";
import { useEffect, useState } from "react";
import { useApi } from "../../lib/api";
import { href, type Route } from "../../lib/router";
import type { Mission } from "../../lib/types";
import type { Ask, AsksResponse } from "../../../shared/asks";
import { Sheet } from "../../components/Sheet";
import { Markdown } from "../../components/Markdown";
import { VesselMark } from "../../components/Marks";
import { EmptyState, StateChip, TimeAgo, shortPath } from "../../components/primitives";
import { KIND, SteerBox, isSteerable, statusOf, type CrewTask } from "../crew/crew";
import { MapSlot } from "../map/slots";
import { filterPath } from "../agents/model";
import { AskCard } from "./AskCard";
import { tasksForAsk, timelineLabel, type TimelineEvent } from "./model";
import "../mission/mission.css";
import "../worker/worker.css";
import "../crew/crew.css";
import "./task.css";

const enc = encodeURIComponent;
type Tab = "timeline" | "brief" | "report" | "crew";
const TABS: Tab[] = ["timeline", "brief", "report", "crew"];
const asTab = (t: string | null | undefined): Tab => (TABS.includes(t as Tab) ? (t as Tab) : "timeline");
const WIDE_KEY = "joyride.taskSheet.wide";
const readWide = () => { try { return localStorage.getItem(WIDE_KEY) === "1"; } catch { return false; } };
const agentName = (a: string | null | undefined) => (a === "codex" ? "Codex" : a === "claude" ? "Claude Code" : a || "");

/** "Claude Code · claude-opus-5-5, high · claude-2": who runs the task, as its meta records it. */
export function whoRuns(t: Pick<CrewTask, "harness" | "model" | "effort" | "account">) {
  const model = t.model ? (t.model === "default" ? "default model" : t.model) : null;
  return [agentName(t.harness), [model, t.effort].filter(Boolean).join(", "), t.account].filter(Boolean).join(" · ");
}

export function TaskRoute({ route }: { route: Route }) {
  const id = route.params[0] ?? "";
  const [wide, setWide] = useState(readWide);
  const toggle = () => setWide((w) => { try { localStorage.setItem(WIDE_KEY, w ? "0" : "1"); } catch {} return !w; });
  // The map highlights the selected task's card while its sheet is open (CP3a reads data-sheet-task).
  useEffect(() => {
    if (!id) return;
    document.body.dataset.sheetTask = id;
    return () => { if (document.body.dataset.sheetTask === id) delete document.body.dataset.sheetTask; };
  }, [id]);
  useEffect(() => { if (!id) location.replace(`#/${filterPath({ owner: "crew" })}`); }, [id]);
  if (!id) return null;
  return (
    <Sheet label={`Task: ${id}`}>
      <TaskSheet id={id} tab={asTab(route.query.get("tab"))} wide={wide} onWide={toggle} />
    </Sheet>
  );
}

export function TaskSheet({ id, tab: initial = "timeline", wide, onWide }: { id: string; tab?: Tab; wide?: boolean; onWide?: () => void }) {
  const [tab, setTab] = useState<Tab>(initial);
  useEffect(() => { setTab(initial); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const { data: artifacts } = useApi<ArtifactView[]>("/api/artifacts?kind=report", ["artifacts"]);
  const registeredReport = artifacts?.find(a => a.firstmate?.task === id) ?? null;
  const { data: t, error, reload } = useApi<CrewTask>(`/api/firstmate/tasks/${enc(id)}`, ["tasks", "workers"]);
  const { data: asks, reload: reloadAsks } = useApi<AsksResponse>("/api/asks", ["asks", "tasks"]);
  const { data: missions } = useApi<Mission[]>("/api/missions", ["missions"]);
  const { data: timeline, reload: reloadTimeline } = useApi<{ events: TimelineEvent[]; errors: string[] }>(`/api/timeline/task/${enc(id)}`, ["tasks", "notes", "asks"]);
  const refresh = () => { reload(); reloadAsks(); reloadTimeline(); };

  if (error && !t) {
    return (
      <article className="pane-page task-sheet peek">
        <EmptyState title="Firstmate has no task by this name" action={<a className="btn" href={href(filterPath({ owner: "crew" }))}>See every task</a>}>
          <p>{error} It may have been renamed or cleaned up; the crew on the Agents page shows what Firstmate has now.</p>
        </EmptyState>
      </article>
    );
  }
  if (!t) return <article className={`pane-page task-sheet${wide ? "" : " peek"}`}><p className="meta" aria-busy="true">Loading the task…</p></article>;
  const st = statusOf(t.status, t.last_event);
  const mission = t.mission ? missions?.find((m) => m.id === t.mission) : null;
  const { pinned, fromReport } = tasksForAsk(asks?.asks ?? [], t.id);
  const steerable = isSteerable(t);
  const who = whoRuns(t);
  const shown: Tab = tab === "report" && !t.report && !registeredReport && !fromReport.length ? "timeline" : tab;
  return (
    <article className={`pane-page task-sheet${wide ? "" : " peek"}`} data-task-sheet={t.id}>
      <header className="mp-header">
        <p className="mp-crumbs">
          <a href={href("map")}>Map</a><span aria-hidden>/</span>
          {t.mission ? <><a href={href(`mission/${enc(t.mission)}`)}>{mission?.title ?? t.mission}</a><span aria-hidden>/</span></> : <><a href={href(filterPath({ owner: "crew" }))}>Crew</a><span aria-hidden>/</span></>}
          <span>Task</span>
        </p>
        <h1 className="ts-title">{t.title}</h1>
        <p className="wp-status ts-status">
          <StateChip state={st.chip} label={st.label} title={st.reason} />
          {t.kind ? <span>{KIND[t.kind] ?? t.kind}</span> : null}
          {who ? <span data-who>{who}</span> : null}
          <span className="mono">{t.id}</span>
          {t.updated ? <span>Updated <TimeAgo iso={t.updated} /></span> : null}
        </p>
        {t.last_event ? <p className="task-event ts-now">{t.last_event}</p> : null}
        <div className="row ts-actions">
          {onWide ? <button type="button" className="btn ghost small" onClick={onWide} aria-pressed={Boolean(wide)}>{wide ? "Narrow to peek" : "Widen"}</button> : null}
        </div>
      </header>

      {pinned.length ? (
        <section className="ts-asks" aria-label="Waiting on an answer">
          {pinned.map((a) => <AskCard key={a.id} ask={a} compact={!wide} onAnswered={refresh} />)}
        </section>
      ) : null}

      <MapSlot name="task-sheet" task={t.id} mission={t.mission ?? null} />

      <div className="wp-tabbar">
        <div className="wp-tabs" role="tablist" aria-label="Task views">
          {TABS.filter((x) => x !== "report" || t.report || registeredReport || fromReport.length).map((x) => (
            <button key={x} type="button" role="tab" id={`ts-tab-${x}`} aria-selected={shown === x} aria-controls={`ts-panel-${x}`} className={shown === x ? "on" : ""} onClick={() => setTab(x)}>
              {{ timeline: "Timeline", brief: "Brief", report: "Report", crew: "Crew" }[x]}
              {x === "report" && fromReport.length ? <span className="ts-count">{fromReport.length}</span> : null}
            </button>
          ))}
        </div>
      </div>

      <div role="tabpanel" id={`ts-panel-${shown}`} aria-labelledby={`ts-tab-${shown}`} className="ts-panel">
        {shown === "timeline" ? <Timeline events={timeline?.events ?? null} errors={timeline?.errors ?? []} /> : null}
        {shown === "brief" ? <Brief id={t.id} /> : null}
        {shown === "report" ? <Report id={t.id} report={registeredReport} has={Boolean(t.report)} calls={fromReport} pinned={new Set(pinned.map((a) => a.id))} onAnswered={refresh} /> : null}
        {shown === "crew" ? <Crew t={t} /> : null}
      </div>

      <footer className="ts-steer" aria-label="Steer this task">
        {steerable ? <SteerBox task={t} onDone={refresh} /> : (
          <p className="meta">{t.section === "done" ? "This task is finished, so it takes no more steers." : "This task has no worktree or window yet, so it can't take steers until Firstmate starts it."}</p>
        )}
        {t.inbox_pending ? <p className="meta ts-pending">{t.inbox_pending === 1 ? "1 steer is waiting in the task's inbox." : `${t.inbox_pending} steers are waiting in the task's inbox.`}</p> : null}
      </footer>
    </article>
  );
}

function Timeline({ events, errors }: { events: TimelineEvent[] | null; errors: string[] }) {
  if (!events) return <p className="meta" aria-busy="true">Loading the timeline…</p>;
  return (
    <>
      {errors.map((e, i) => <p key={i} className="inline-error" role="alert">{e}</p>)}
      {events.length ? (
        <ol className="ts-timeline">
          {events.map((e) => {
            const l = timelineLabel(e);
            return (
              <li key={e.id} className={`tl tl-${e.kind}${e.verb ? ` v-${e.verb}` : ""}${e.state ? ` st-${e.state}` : ""}${e.needs_you ? " needs-you" : ""}`} data-tl={e.kind}>
                <span className="tl-time">{e.at ? <TimeAgo iso={e.at} /> : null}</span>
                <span className="tl-who">{l.who}</span>
                <div className="tl-body">
                  <span className="tl-what">{l.what}</span>
                  {e.text ? <p className="tl-text">{e.text}</p> : null}
                </div>
              </li>
            );
          })}
        </ol>
      ) : <EmptyState title="Nothing has happened yet"><p>Status lines, steers, notes and asks appear here as the task moves.</p></EmptyState>}
    </>
  );
}

function Brief({ id }: { id: string }) {
  const { data, error } = useApi<{ path: string; text: string }>(`/api/timeline/task/${enc(id)}/brief`, ["tasks"]);
  if (error) return <p className="meta">{error}</p>;
  if (!data) return <p className="meta" aria-busy="true">Loading the brief…</p>;
  return (
    <div className="ts-doc">
      <p className="meta mono">{shortPath(data.path, 4)}</p>
      <Markdown text={data.text} className="md" />
    </div>
  );
}

const toAsk = (id: string) => document.querySelector<HTMLElement>(`[data-ask="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });

function Report({ id, report, has, calls, pinned, onAnswered }: { id: string; report: ArtifactView | null; has: boolean; calls: Ask[]; pinned: Set<string>; onAnswered: () => void }) {
  const { data, error } = useApi<{ path: string; text: string }>(has ? `/api/firstmate/tasks/${enc(id)}/report` : null, ["tasks"]);
  return (
    <div className="ts-doc">
      {report ? <button type="button" className="btn" onClick={() => openArtifact(report.id)}>Read report</button> : null}
      {calls.length ? (
        <section className="ts-calls" aria-label="Calls this report raised">
          <h2>{calls.length === 1 ? "1 call from this report" : `${calls.length} calls from this report`}</h2>
          {calls.map((a) => pinned.has(a.id) ? (
            <p key={a.id} className={`ts-call-ref${a.needs_you ? " needs-you" : ""}`} data-call={a.id}>
              <strong>{a.title}</strong> <span className="meta">{a.needs_you ? "Needs you" : a.state}</span>
              <button type="button" className="btn link" onClick={() => toAsk(a.id)}>Answer it above</button>
            </p>
          ) : <AskCard key={a.id} ask={a} onAnswered={onAnswered} />)}
        </section>
      ) : null}
      {!has ? null : error ? <p className="inline-error">The report could not be read: {error}</p> : !data ? <p className="meta" aria-busy="true">Loading the report…</p> : (
        <>
          <p className="meta mono">{shortPath(data.path, 4)}</p>
          <Markdown text={data.text} className="md" />
        </>
      )}
    </div>
  );
}

function Crew({ t }: { t: CrewTask }) {
  return (
    <>
      <dl className="mp-facts ts-facts">
        <div><dt>Agent</dt><dd>{agentName(t.harness) || "Not recorded"}</dd></div>
        <div><dt>Model</dt><dd>{t.model ? <span className="mono">{t.model}</span> : "Not recorded"}{t.effort ? `, ${t.effort}` : ""}</dd></div>
        <div><dt>Account</dt><dd>{t.account ?? "Default login"}</dd></div>
        {t.pane ? <div><dt>Pane</dt><dd className="mono">{t.pane}</dd></div> : t.window ? <div><dt>Window</dt><dd className="mono">{t.window}</dd></div> : null}
        {t.branch ? <div><dt>Branch</dt><dd className="mono">{t.branch}</dd></div> : null}
        {t.worktree ? <div><dt>Worktree</dt><dd className="mono" title={t.worktree}>{shortPath(t.worktree, 3)}</dd></div> : null}
        {t.mode ? <div><dt>Delivery</dt><dd>{t.mode}</dd></div> : null}
        {t.repo ? <div><dt>Repo</dt><dd>{t.repo}</dd></div> : null}
        {t.depends_on.length ? <div><dt>Starts after</dt><dd className="mono">{t.depends_on.join(", ")}</dd></div> : null}
      </dl>
      <h2 className="ts-h2">Workers</h2>
      {t.workers.length ? (
        <ul className="ts-workers" aria-label="Crew workers">
          {t.workers.map((w) => (
            <li key={w.id}>
              <VesselMark status={w.status} agent={w.agent} size={14} />
              <a href={href(`worker/${enc(w.id)}`)}>{w.title || w.id}</a>
              <span className="meta">{agentName(w.agent)}</span>
              <StateChip state={w.status} />
              <span className="spacer" />
              <a className="btn small" href={href(`worker/${enc(w.id)}?tab=chat`)}>Open session</a>
            </li>
          ))}
        </ul>
      ) : <p className="meta">{t.section === "done" ? "Its crew has finished." : "No live worker on this task right now. Firstmate starts one when the task runs."}</p>}
    </>
  );
}
