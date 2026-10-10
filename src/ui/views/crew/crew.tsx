// Crew: Firstmate tasks projected from FM_HOME, each task's crew workers (by
// recorded pane or FM_TASK_ID), and the intents that reach Firstmate (create_task, steer_task,
// start). Used by the mission panel "crew" and the task sheet (#/task, views/task).
import { useDraft } from "../../lib/useDraft";
import { useState } from "react";
import { api, post, useApi } from "../../lib/api";
import { href } from "../../lib/router";
import type { Mission } from "../../lib/types";
import { EmptyState, StateChip, TimeAgo, shortPath } from "../../components/primitives";
import { AttachButton, AttachmentTray, DropZone, SentImages, useAttachments } from "../../components/ImageAttach";
import { canSendImages, noImagesReason } from "../../../shared/images";
import "./crew.css";
import type { PrimaryStatus } from "../../../shared/firstmate-primary";
import { isPrimaryIdle } from "../../../shared/firstmate-primary";
import { FirstmatePrimary } from "./FirstmatePrimary";

export type CrewWorker = { id: string; agent: string; status: string; title: string; cwd: string; controllable: boolean };
export type CrewTask = {
  id: string; title: string; status: string; kind: string; harness: string | null; worktree: string | null; branch: string | null;
  last_event: string; updated: string | null; report: string | null; depends_on: string[]; mission: string | null;
  section: "in_flight" | "queued" | "done" | null; repo: string | null; mode: string | null; window: string | null;
  hold: string | null; inbox_pending: number; workers: CrewWorker[];
  /** Who runs it, from the meta; the crewmate's Herdr pane; the brief's path. */
  model?: string | null; effort?: string | null; account?: string | null; pane?: string | null; brief?: string | null;
};
export type FirstmateStatus = {
  home: string; home_exists: boolean; configured: boolean; backend: string | null; running: boolean;
  pane: { machine: string; pane_id: string; worker: string; status: string } | null; herdr_connected: boolean;
  vendor: { path: string; present: boolean; head: string | null; pin: string; pinned: boolean };
  tasks: { total: number; in_flight: number; queued: number; done: number; for_missions: number };
  summary: { state: string; decisions_open: number } | null;
  setup: { missing_tools: string[]; notes: string[] }; errors: string[];
  primary?: PrimaryStatus;
};
export type IntentRec = { id: string; status: "pending" | "sent" | "acked" | "failed"; error: string | null; result?: any; payload?: { images?: string[] } };

export { firstmateStatus as statusOf } from "../../lib/firstmate-status";
import { firstmateStatus as statusOf } from "../../lib/firstmate-status";
export const KIND: Record<string, string> = { ship: "Ship", scout: "Scout", secondmate: "Secondmate", captain: "Captain", program: "Program" };

export function useFirstmate() {
  return useApi<FirstmateStatus>("/api/firstmate/status", ["tasks", "workers", "firstmate", "usage"]);
}

/** Firstmate's own state, and the Start Firstmate button when it is not running. */
export function FirstmateBar({ status, onStarted }: { status: FirstmateStatus | null; onStarted?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!status) return <p className="meta" aria-busy="true">Checking Firstmate…</p>;
  async function start() {
    setBusy(true); setErr(null);
    try {
      const it = await post<IntentRec>("/api/firstmate/start");
      if (it.status === "failed") setErr(it.error ?? "Firstmate did not start.");
      else onStarted?.();
    } catch (e: any) { setErr(`Firstmate did not start: ${e.message}`); }
    finally { setBusy(false); }
  }
  return (
    <div className={`fm-bar ${status.running ? "on" : "off"}`} data-firstmate={status.running ? "running" : "stopped"}>
      <span className="fm-dot" aria-hidden />
      {status.running && status.pane ? (
        <p className="fm-text">Firstmate is running in its own Herdr pane <a className="mono" href={href(`worker/${encodeURIComponent(status.pane.worker)}`)}>{status.pane.pane_id}</a>.</p>
      ) : (
        <p className="fm-text">Firstmate is not running. It starts only when you ask, in its own Herdr pane.</p>
      )}
      <span className="spacer" />
      <FirstmatePrimary primary={status.primary} running={status.running} idle={isPrimaryIdle(status.pane?.status)} reload={() => onStarted?.()} />
      {!status.running ? (
        <button type="button" className="btn primary" onClick={start} disabled={busy || !status.herdr_connected}>{busy ? "Starting Firstmate" : "Start Firstmate"}</button>
      ) : null}
      {!status.running && !status.herdr_connected ? <p className="fm-hint">Herdr is not connected. Start Herdr, then start Firstmate.</p> : null}
      {err ? <p className="inline-error fm-hint" role="alert">{err}</p> : null}
      {!status.running && status.setup.notes.length ? (
        <details className="fm-setup">
          <summary>What Firstmate's first start asks for</summary>
          <ul>{status.setup.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
          <p className="meta">Home: <span className="mono">{shortPath(status.home, 4)}</span>, backend {status.backend ?? "not set"}, projects local-only.</p>
        </details>
      ) : null}
    </div>
  );
}

/** Images reach a crewmate as paths in its inbox message; it opens them with its own image reader. */
function crewImagesBlocked(task: CrewTask): string | null {
  const blind = task.workers.find((w) => !canSendImages(w.agent));
  return blind && !task.workers.some((w) => canSendImages(w.agent)) ? noImagesReason(blind.agent, "This task's crewmate") : null;
}

export function SteerBox({ task, onDone }: { task: CrewTask; onDone: () => void }) {
  const draft = useDraft({ kind: "task", id: task.id });
  const { text, setText } = draft;
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<IntentRec | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const att = useAttachments(crewImagesBlocked(task), draft.key);
  const images = att.paths;
  const ready = Boolean(text.trim() || images.length) && !att.uploading && !att.failed;
  async function send() {
    const t = text.trim();
    if (!ready || busy) return;
    setBusy(true); setErr(null);
    try {
      const it = await api<IntentRec>("/api/firstmate/send", { method: "POST", json: { task: task.id, text: t, ...(images.length ? { images } : {}) } }).catch((e) => ({ id: "", status: "failed" as const, error: e.message }));
      setRes(it);
      if (it.status !== "failed") { setText(""); att.clear(); onDone(); }
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }
  return (
    <DropZone att={att} className="steer">
      <AttachmentTray att={att} />
      <form className="reply-row" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <AttachButton att={att} />
        <textarea ref={draft.boxRef} className="input reply-input" rows={2} value={text} onChange={(e) => setText(e.target.value)} aria-label={`Steer ${task.title}`} onPaste={att.onPaste}
          placeholder="Tell the crew what to change. Firstmate records it in the task's inbox; Enter sends."
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
        <button type="submit" className="btn primary" disabled={busy || !ready}>{busy ? "Sending" : att.uploading ? "Uploading" : "Send to the crew"}</button>
      </form>
      {res ? (
        <div className={res.status === "failed" ? "inline-error" : "cap-ok"} role={res.status === "failed" ? "alert" : "status"}>
          {res.status === "failed" ? res.error : res.payload?.images?.length ? "Recorded in the task's inbox with the image paths. The crewmate opens them on its next turn." : "Recorded in the task's inbox. The crewmate picks it up on its next turn."}
          {res.status !== "failed" ? <SentImages paths={res.payload?.images} className="small" /> : null}
        </div>
      ) : null}
      {err ? <p className="inline-error" role="alert">{err}</p> : null}
    </DropZone>
  );
}

function Report({ id }: { id: string }) {
  const { data, error } = useApi<{ path: string; text: string }>(`/api/firstmate/tasks/${encodeURIComponent(id)}/report`);
  if (error) return <p className="inline-error">The report could not be read: {error}</p>;
  if (!data) return <p className="meta">Loading the report…</p>;
  return (
    <div className="task-report">
      <p className="meta mono">{shortPath(data.path, 4)}</p>
      <pre>{data.text}</pre>
    </div>
  );
}

/** A live task with a worktree or window takes steers through its inbox. */
export const isSteerable = (t: Pick<CrewTask, "section" | "window" | "worktree">) => t.section !== "done" && Boolean(t.window || t.worktree);

export function TaskCard({ t, showMission, onChanged }: { t: CrewTask; showMission?: string | null; onChanged: () => void }) {
  const [open, setOpen] = useState<"report" | "steer" | null>(null);
  const st = statusOf(t.status, t.last_event);
  const steerable = isSteerable(t);
  return (
    <li className={`task s-${st.chip}`} data-task={t.id}>
      <div className="task-head">
        <a className="task-title" href={href(`task/${encodeURIComponent(t.id)}`)} title="Open the task sheet">{t.title}</a>
        <StateChip state={st.chip} label={st.label} title={st.reason} />
      </div>
      <dl className="task-facts">
        <div><dt>Task</dt><dd className="mono">{t.id}</dd></div>
        {t.kind ? <div><dt>Kind</dt><dd>{KIND[t.kind] ?? t.kind}</dd></div> : null}
        {t.branch ? <div><dt>Branch</dt><dd className="mono">{t.branch}</dd></div> : null}
        {t.worktree ? <div><dt>Worktree</dt><dd className="mono" title={t.worktree}>{shortPath(t.worktree, 3)}</dd></div> : null}
        {t.mode ? <div><dt>Delivery</dt><dd>{t.mode}</dd></div> : null}
        {showMission ? <div><dt>Idea</dt><dd><a href={href(`mission/${encodeURIComponent(showMission)}`)}>{showMission}</a></dd></div> : null}
        {t.updated ? <div><dt>Updated</dt><dd><TimeAgo iso={t.updated} /></dd></div> : null}
      </dl>
      {t.last_event ? <p className="task-event">{t.last_event}</p> : null}
      {t.depends_on.length ? <p className="meta">Starts after {t.depends_on.map((d) => <span key={d} className="mono">{d} </span>)}</p> : null}
      {t.workers.length ? (
        <ul className="crew-workers" aria-label="Crew workers">
          {t.workers.map((w) => (
            <li key={w.id}>
              <a href={href(`worker/${encodeURIComponent(w.id)}`)}>{w.title || w.id}</a>
              <span className="meta">{w.agent === "codex" ? "Codex" : w.agent === "claude" ? "Claude Code" : w.agent}</span>
              <StateChip state={w.status} />
            </li>
          ))}
        </ul>
      ) : null}
      <div className="task-actions">
        {t.report ? <button type="button" className="btn small" aria-expanded={open === "report"} onClick={() => setOpen(open === "report" ? null : "report")}>{open === "report" ? "Hide report" : "Read report"}</button> : null}
        {steerable ? <button type="button" className="btn small" aria-expanded={open === "steer"} onClick={() => setOpen(open === "steer" ? null : "steer")}>Steer</button> : null}
        {t.inbox_pending ? <span className="meta">{t.inbox_pending === 1 ? "1 steer waiting in the inbox" : `${t.inbox_pending} steers waiting in the inbox`}</span> : null}
      </div>
      {open === "report" ? <Report id={t.id} /> : null}
      {open === "steer" ? <SteerBox task={t} onDone={onChanged} /> : null}
    </li>
  );
}

export function TaskList({ tasks, showMission, onChanged }: { tasks: CrewTask[]; showMission?: boolean; onChanged: () => void }) {
  const live = tasks.filter((t) => t.section !== "done");
  const done = tasks.filter((t) => t.section === "done");
  const [showDone, setShowDone] = useState(false);
  return (
    <>
      {live.length ? <ul className="task-list">{live.map((t) => <TaskCard key={t.id} t={t} showMission={showMission ? t.mission : null} onChanged={onChanged} />)}</ul> : null}
      {done.length ? (
        <div className="task-done">
          <button type="button" className="btn link" aria-expanded={showDone} onClick={() => setShowDone((s) => !s)}>{showDone ? "Hide" : "Show"} {done.length === 1 ? "1 finished task" : `${done.length} finished tasks`}</button>
          {showDone ? <ul className="task-list">{done.map((t) => <TaskCard key={t.id} t={t} showMission={showMission ? t.mission : null} onChanged={onChanged} />)}</ul> : null}
        </div>
      ) : null}
    </>
  );
}

function CreateTaskForm({ mission, running, onSent }: { mission: Mission; running: boolean; onSent: () => void }) {
  const [open, setOpen] = useState(false);
  const draft = useDraft({ kind: "composer", id: `task:${mission.id}` });
  const { text: brief, setText: setBrief } = draft;
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<IntentRec | null>(null);
  const att = useAttachments(null, draft.key);
  const images = att.paths;
  async function submit() {
    if (!brief.trim() || busy || att.uploading || att.failed) return;
    setBusy(true); setRes(null);
    try {
      const it = await post<IntentRec>("/api/intents", { kind: "create_task", target: mission.id, payload: { brief: brief.trim(), ...(images.length ? { images } : {}) } });
      setRes(it);
      if (it.status !== "failed") { setBrief(""); att.clear(); setOpen(false); onSent(); }
    } catch (e: any) { setRes({ id: "", status: "failed", error: `The request was not sent: ${e.message}` }); }
    finally { setBusy(false); }
  }
  if (!open) {
    return (
      <div className="create-task">
        <button type="button" className="btn primary" onClick={() => setOpen(true)}>Create a task with Firstmate</button>
        {res && res.status !== "failed" ? (
          <div className="cap-ok" role="status">
            Sent to Firstmate's inbox with this idea's marker{res.payload?.images?.length ? " and the image paths" : ""}, so nothing was typed over its input box. Firstmate reads it at its next check, and the task appears here once it is in the backlog.
            <SentImages paths={res.payload?.images} className="small" />
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <form className="create-task open sheet" onSubmit={(e) => { e.preventDefault(); submit(); }} aria-label="Create a task with Firstmate">
      <h3>Create a task with Firstmate</h3>
      <p className="meta">Firstmate gets the idea's goal, the done-when criteria, the evidence rule and local-only delivery (no push, no PR) with your brief. It decides the crew.</p>
      <label className="ct-label" htmlFor={`brief-${mission.id}`}>What should the crew do?</label>
      <DropZone att={att} className="ct-brief">
        <AttachmentTray att={att} />
        <div className="reply-row">
          <textarea ref={draft.boxRef} id={`brief-${mission.id}`} className="input" rows={3} value={brief} onChange={(e) => setBrief(e.target.value)} onPaste={att.onPaste} placeholder="For example: add the totals row to the CSV export and cover it with an e2e test. Paste or drop screenshots to attach them." />
          <AttachButton att={att} label="Attach images to the brief" />
        </div>
      </DropZone>
      {!running ? <p className="meta">Firstmate is stopped. The task waits in its inbox until Firstmate starts; Joyride never starts it on its own.</p> : null}
      <div className="row">
        <button type="submit" className="btn primary" disabled={busy || !brief.trim() || att.uploading || att.failed}>{busy ? "Sending" : att.uploading ? "Uploading" : "Create task"}</button>
        <button type="button" className="btn ghost" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {res?.status === "failed" ? <p className="inline-error" role="alert">{res.error}</p> : null}
      {res && res.status !== "failed" ? <p className="cap-ok" role="status">Sent to Firstmate with this idea's marker. The task appears here once Firstmate adds it to its backlog.</p> : null}
    </form>
  );
}

/** Mission panel "crew". */
export function CrewPanel({ mission }: { mission: Mission; missionId: string }) {
  const { data: status, reload: reloadStatus } = useFirstmate();
  const { data: tasks, error, reload } = useApi<CrewTask[]>(`/api/firstmate/tasks?mission=${encodeURIComponent(mission.id)}`, ["tasks", "workers"]);
  const refresh = () => { reload(); reloadStatus(); };
  return (
    <div className="panel-body crew-panel" data-testid="crew-panel">
      <FirstmateBar status={status} onStarted={refresh} />
      {error ? <p className="inline-error" role="alert">Firstmate's tasks could not be read: {error}</p> : null}
      {tasks && tasks.length ? <TaskList tasks={tasks} onChanged={refresh} /> : tasks ? (
        <EmptyState title="No Firstmate tasks for this idea yet">
          <p>Create one below. Firstmate plans the crew, works in its own worktree and reports back here.</p>
        </EmptyState>
      ) : null}
      <CreateTaskForm mission={mission} running={Boolean(status?.running)} onSent={refresh} />
    </div>
  );
}
