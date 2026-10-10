// Firstmate tasks on the chart, inside their idea. Mid zoom: one row per task (status, what it is doing
// now, ask badge). Near zoom: a card with what it is doing now and the asks that are the captain's call,
// with answer controls. A focused idea shows each card in full: who runs it (agent, model, effort,
// account), its last event, artifacts, every ask and its crew's worker lines.
// A task card or row is dragged (anywhere on it, or by its grip) to another idea (POST /api/missions/move
// {task, to}); its grip also opens Move to. A crewmate line inside a card carries the card: crew belong to the task.
import { href } from "../../lib/router";
import { VesselMark } from "../../components/Marks";
import { plural, TimeAgo } from "../../components/primitives";
import { FleetChips } from "../fleet/chips";
import type { Intention } from "../../lib/intentions";
import type { ZoomLevel } from "./layout";
import type { MapTaskW, MapWorker } from "./world";
import { ArtifactChips } from "./ArtifactChips";
import { AskBadge, AskCard } from "./AskCard";
import { readableAction, taskNow, whoRuns } from "./plane";
import { Replies } from "./ReplyNote";
import { MapSlot } from "./slots";
import { DragHandle } from "./DragHandle";
import { BUCKET_LABEL, taskBucket, workerBucket } from "./glance";

export type Intents = Map<string, Intention>;
export const STATUS_TEXT: Record<string, string> = { working: "Working", blocked: "Blocked", idle: "Idle", done: "Done", unknown: "Unknown", exited: "Exited" };
/** A worker's label on the map: its goal when Joyride knows it, else its title. */
export const goalOf = (intents: Intents, key: string | null | undefined) => (key ? intents.get(key)?.goal : undefined) || null;

import { firstmateStatus as statusOf } from "../../lib/firstmate-status";
const KIND: Record<string, string> = { ship: "Ship", scout: "Scout", secondmate: "Secondmate", captain: "Captain", program: "Program" };
const AGENT: Record<string, string> = { claude: "Claude Code", codex: "Codex" };

/**
 * A worker line. A crewmate's session title is Firstmate's brief boilerplate, so its line reads as
 * its goal when Joyride knows it, else as the agent on this task.
 */
export function WorkerLine({ w, goal, carried, crew = false, compact = false, oneLine = false }: { w: MapWorker; goal: string | null; carried: boolean; crew?: boolean; compact?: boolean; oneLine?: boolean }) {
  const title = goal ?? (crew ? `${AGENT[w.agent] ?? w.agent} crewmate` : w.title || w.id);
  const action = readableAction(w.current_action);
  const movable = !!w.session && !crew;
  const bucket = workerBucket(w);
  return (
    <li className={`wl s-${w.status}${movable ? " can-drag" : ""}${carried ? " carried" : ""}`} data-drag={movable ? `s:${w.session}` : undefined} data-worker={w.id}>
      <a href={href(`worker/${encodeURIComponent(w.id)}`)} title={goal ? `${w.title || w.id}: ${goal}` : w.title || undefined} draggable={false}>
        <span className="wl-head">
          <VesselMark status={w.status} agent={w.agent} />
          <span className={`wl-title${goal ? " is-goal" : ""}`}>{title}</span>
          <span className="wl-status">{bucket === "idle" ? STATUS_TEXT[w.status] ?? w.status : BUCKET_LABEL[bucket]}</span>
        </span>
        {compact ? null : <FleetChips w={w} className="wl-chips" />}
        {oneLine ? null : <span className={`wl-action${action ? "" : " none"}`}>{action || (w.status === "blocked" ? "Waiting at a prompt in its terminal" : "No action reported")}</span>}
        {w.last_message && !compact ? <span className="wl-msg">{w.last_message}</span> : null}
      </a>
      {compact ? null : <ArtifactChips list={w.artifacts} max={2} compact />}
      {compact ? null : <MapSlot name="worker-notes" worker={w.id} session={w.session} level="near" />}
      {movable ? <DragHandle label={title} /> : null}
    </li>
  );
}

function liveOf(t: MapTaskW, intents: Intents) {
  const w = t.crew.find((x) => readableAction(x.current_action)) ?? t.crew[0];
  return { action: readableAction(w?.current_action), goal: w ? goalOf(intents, w.session) : null };
}

/** What a task is doing now, unless that is only its raw status word (the status beside its title says it already). */
function nowLine(t: MapTaskW, intents: Intents): string | null {
  const now = taskNow(t, liveOf(t, intents));
  return now === t.status ? null : now;
}

/** Mid zoom: one row per task, and what it is doing now. */
export function TaskRow({ t, intents, carried, selected }: { t: MapTaskW; intents: Intents; carried: boolean; selected: boolean }) {
  const st = statusOf(t.status, t.last_event);
  return (
    <li className={`task-row tone-${st.tone}${carried ? " carried" : ""}${selected ? " selected" : ""} can-drag`} data-task={t.id} data-drag={`t:${t.id}`} aria-current={selected || undefined}>
      <span className="tr-head">
        <span className={`tc-dot tone-${st.tone}`} aria-hidden />
        <a className="tr-title" href={href(`task/${encodeURIComponent(t.id)}`)} title={`${t.id}: ${t.title}${t.crew.length ? `\n${whoRuns(t)}` : ""}`} draggable={false}>{t.title || t.id}</a>
        <span className="tr-status" title={st.reason}>{BUCKET_LABEL[taskBucket(t)]}</span>
        <DragHandle label={t.title || t.id} />
      </span>
      {nowLine(t, intents) ? <span className="tr-now">{nowLine(t, intents)}</span> : null}
      {t.asks.map((a) => <AskBadge key={a.id} ask={a} />)}
      <Replies list={t.replies} level="mid" />
    </li>
  );
}

/** Near zoom: the card, what it is doing now and the captain's calls on it; `full` (a focused idea) shows everything. */
export function TaskCard({ t, intents, carried, carriedSession, selected, full = true }: { t: MapTaskW; intents: Intents; carried: boolean; carriedSession: string | null; selected: boolean; full?: boolean }) {
  const st = statusOf(t.status, t.last_event);
  const ev = t.last_event?.trim();
  const now = taskNow(t, liveOf(t, intents));
  const head = (
    <header className="tc-head">
      <span className={`tc-dot tone-${st.tone}`} aria-hidden />
      <a className="tc-title" href={href(`task/${encodeURIComponent(t.id)}`)} draggable={false} title={`Open task ${t.id}`}>{t.title || t.id}</a>
      <span className="tc-status" title={st.reason}>{KIND[t.kind] && full ? `${KIND[t.kind]} · ` : ""}{BUCKET_LABEL[taskBucket(t)]}</span>
      <DragHandle label={t.title || t.id} />
    </header>
  );
  const cls = `task-card can-drag tone-${st.tone}${t.asks.some((a) => a.needs_you) ? " needs-you" : ""}${carried ? " carried" : ""}${selected ? " selected" : ""}${full ? "" : " brief"}`;
  if (!full) {
    return (
      <article className={cls} data-task={t.id} data-drag={`t:${t.id}`} aria-current={selected || undefined} title={t.crew.length ? whoRuns(t) : undefined}>
        {head}
        {nowLine(t, intents) ? <p className="tc-now">{now}{t.updated ? <> · <TimeAgo iso={t.updated} /></> : null}</p> : null}
        <Replies list={t.replies} level="near" />
        {t.asks.map((a) => <AskCard key={a.id} ask={a} folded />)}
      </article>
    );
  }
  return (
    <article className={cls} data-task={t.id} data-drag={`t:${t.id}`} aria-current={selected || undefined}>
      {head}
      <p className="tc-who" data-who>
        <span className="mono tc-id">{t.id}</span> · {whoRuns(t)}
        {t.crew.length ? null : t.section === "queued" ? " · not started" : null}
      </p>
      <p className="tc-now"><span className="tc-k">Now</span> {now}{t.updated ? <> · <TimeAgo iso={t.updated} /></> : null}</p>
      {ev && !now.startsWith(ev.replace(/^[a-z-]+(?:\s*\[[^\]]*\])*:\s*/i, "").slice(0, 20)) ? <p className="tc-last" title={ev}><span className="tc-k">Last</span> {ev}</p> : null}
      <Replies list={t.replies} level="near" />
      <ArtifactChips list={t.artifacts} max={3} />
      {t.asks.map((a) => <AskCard key={a.id} ask={a} folded />)}
      {t.crew.length ? (
        <ul className="mn-workers tc-crew" aria-label={plural(t.crew.length, "crewmate")}>
          {t.crew.map((w) => <WorkerLine key={w.id} w={w} goal={goalOf(intents, w.session)} carried={!!w.session && w.session === carriedSession} crew />)}
        </ul>
      ) : null}
      <MapSlot name="task-notes" task={t.id} mission={t.mission} level="near" />
    </article>
  );
}

/** Landed tasks, folded into one line. */
export function Landed({ list }: { list: MapTaskW[] }) {
  if (!list.length) return null;
  const shown = list.slice(0, 3);
  return (
    <p className="tc-landed" data-landed={list.length} title={list.map((t) => t.title || t.id).join("\n")}>
      <span aria-hidden>✓</span> {plural(list.length, "landed task")}: {shown.map((t) => t.title || t.id).join(" · ")}{list.length > shown.length ? " …" : ""}
    </p>
  );
}

/** The task list inside an idea (or on the hub) at mid and near zoom. `selected` is the task whose sheet is open; `full` shows each card in full. */
export function TaskList({ tasks, level, intents, carriedTask, carriedSession, selected = null, full = false }: { tasks: MapTaskW[]; level: ZoomLevel; intents: Intents; carriedTask: string | null; carriedSession: string | null; selected?: string | null; full?: boolean }) {
  if (!tasks.length || level === "far") return null;
  if (level === "mid") return <ul className="task-rows">{tasks.map((t) => <TaskRow key={t.id} t={t} intents={intents} carried={carriedTask === t.id} selected={selected === t.id} />)}</ul>;
  return <div className="task-cards">{tasks.map((t) => <TaskCard key={t.id} t={t} intents={intents} carried={carriedTask === t.id} carriedSession={carriedSession} selected={selected === t.id} full={full} />)}</div>;
}
