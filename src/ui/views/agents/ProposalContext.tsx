// The expanded brief for one proposal: what the work was, why it was grouped,
// the sessions, files touched, commits and artifacts. Fetched on open; the
// brief itself may still be on its way (the daemon writes it in the background).
import { useState } from "react";
import { api, cleanTitle, useApi } from "../../lib/api";
import { href } from "../../lib/router";
import { TimeAgo, plural } from "../../components/primitives";

export type Outcome = "shipped" | "in progress" | "abandoned" | "exploration" | "unclear";
export type Brief = { summary: string; outcome: Outcome; worth_tracking: boolean; reason: string };
export type BriefStatus = "ready" | "stale" | "running" | "pending" | "failed" | "skipped";
export type BriefState = { brief: Brief | null; brief_status: BriefStatus; brief_at: string | null; brief_error: string | null };
export type SummaryItem = BriefState & { id: string; noise: boolean; noise_reason: string; running: boolean; files: number; commits: number; recommended: boolean | null };
export type Summary = { items: SummaryItem[]; batch: { running: boolean; total: number; done: number; calls: number; failed: number; started: string | null; finished: string | null; ms: number } };
type Live = "working" | "blocked" | "idle" | null;
type SessionCtx = {
  key: string; source: "claude" | "codex"; title: string; first_prompt: string; last_prompts: string[]; final_message: string;
  turns: number; tokens: number; started: string | null; updated: string | null; branch: string | null; live: Live; files: number; commits: number; missing: boolean;
};
export type ProposalContext = BriefState & {
  id: string; sessions: SessionCtx[]; files: { path: string; display: string; edits: number; sessions: number }[]; files_total: number;
  commits: { sha: string | null; subject: string; branch: string | null; session: string }[]; commits_total: number;
  artifacts: { id: string; title: string; url: string | null; kind: string; session: string | null }[];
  running: boolean; why: string[]; noise: boolean; noise_reason: string;
};

const enc = encodeURIComponent;
const OUTCOME: Record<Outcome, { label: string; cls: string }> = {
  shipped: { label: "Shipped", cls: "review" },
  "in progress": { label: "In progress", cls: "working" },
  abandoned: { label: "Abandoned", cls: "idle" },
  exploration: { label: "Exploration", cls: "idle plain" },
  unclear: { label: "Outcome unclear", cls: "idle plain" },
};
export function OutcomeChip({ outcome }: { outcome: Outcome }) {
  const o = OUTCOME[outcome] ?? OUTCOME.unclear;
  return <span className={`chip ${o.cls}`} data-outcome={outcome}>{o.label}</span>;
}
export function LiveChip({ live }: { live: Live }) {
  if (live === "working") return <span className="chip working">Running now</span>;
  if (live === "blocked") return <span className="chip blocked">Waiting on you</span>;
  if (live === "idle") return <span className="chip idle">Open, idle</span>;
  return null;
}

/** "a/b/c/d/file.ts" -> dir "…/c/d/", base "file.ts": the name stays readable in a narrow column. */
function fileParts(p: string) {
  const parts = p.split("/");
  const base = parts.pop() ?? p;
  const dir = parts.length > 2 ? `…/${parts.slice(-2).join("/")}/` : parts.length ? `${parts.join("/")}/` : "";
  return { dir, base };
}
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M tokens` : n >= 1e3 ? `${Math.round(n / 1e3)}K tokens` : n ? `${n} tokens` : "");

export function ProposalContextPanel({ id }: { id: string }) {
  const { data, error, reload } = useApi<ProposalContext>(`/api/missions/proposals/${enc(id)}/context`, ["proposal_briefs"]);
  const [retrying, setRetrying] = useState(false);
  async function retry() {
    setRetrying(true);
    try { await api(`/api/missions/proposals/${enc(id)}/context?retry=1`); } catch {}
    finally { setRetrying(false); reload(); }
  }
  if (error && !data) return <div className="pc"><p className="inline-error" role="alert">The context can't load: {error}. Check that the daemon is running, then reopen this proposal.</p></div>;
  if (!data) return <div className="pc pc-loading" aria-busy="true"><p className="pc-wait">Reading the transcripts…</p></div>;
  const last = [...data.sessions].reverse().find((s) => s.final_message);

  return (
    <div className="pc" data-context={id}>
      <div className="pc-main">
        <BriefBlock c={data} onRetry={retry} retrying={retrying} />
        <section aria-labelledby={`why-${id}`}>
          <h4 className="pc-h" id={`why-${id}`}>Why these were grouped</h4>
          <p className="pc-why">{data.why.join(" ")}</p>
        </section>
        <section aria-labelledby={`ses-${id}`}>
          <h4 className="pc-h" id={`ses-${id}`}>{data.sessions.length === 1 ? "The session" : `${data.sessions.length} sessions, oldest first`}</h4>
          <ol className="pc-sessions">
            {data.sessions.map((s) => (
              <li key={s.key} className={s.missing ? "missing" : undefined}>
                <time className="pc-when" dateTime={s.started ?? undefined}>{when(s.started)}</time>
                <div className="pc-s">
                  <div className="pc-s-head">
                    {s.missing ? <span className="pc-s-title">{s.title}</span> : <a className="pc-s-title" href={href(`session/${enc(s.key)}`)}>{cleanTitle(s.title, s.key)}</a>}
                    <LiveChip live={s.live} />
                  </div>
                  {s.first_prompt ? <p className="pc-prompt">{cleanTitle(s.first_prompt)}</p> : null}
                  {!s.missing ? (
                    <p className="pc-s-meta">
                      <span>{s.source === "codex" ? "Codex" : "Claude Code"}</span>
                      <span>{plural(s.turns, "prompt")}</span>
                      {s.tokens ? <span>{tokens(s.tokens)}</span> : null}
                      {s.files ? <span>{plural(s.files, "file")} changed</span> : null}
                      {s.commits ? <span>{plural(s.commits, "commit")}</span> : null}
                      {s.live === null && s.updated && s.started && Date.parse(s.updated) - Date.parse(s.started) > 3600e3 ? <span>until <TimeAgo iso={s.updated} /></span> : null}
                    </p>
                  ) : null}
                  {s.last_prompts.length ? <p className="pc-later"><span className="pc-label">Later</span> {s.last_prompts.map((t) => cleanTitle(t)).join(" / ")}</p> : null}
                </div>
              </li>
            ))}
          </ol>
        </section>
        {last ? (
          <section aria-labelledby={`end-${id}`}>
            <h4 className="pc-h" id={`end-${id}`}>Where it ended</h4>
            <blockquote className="pc-final">{last.final_message}</blockquote>
          </section>
        ) : null}
      </div>

      <aside className="pc-side" aria-label="Changes">
        <section aria-labelledby={`files-${id}`}>
          <h4 className="pc-h" id={`files-${id}`}>Files touched</h4>
          {data.files.length ? (
            <ul className="pc-files">
              {data.files.map((f) => (
                <li key={f.path} title={f.path}>
                  <span className="pc-file">{fileParts(f.display).dir ? <span className="pc-dir">{fileParts(f.display).dir}</span> : null}{fileParts(f.display).base}</span>
                  <span className="pc-n">{plural(f.edits, "edit")}</span>
                </li>
              ))}
            </ul>
          ) : <p className="pc-none">No file edits in these transcripts.</p>}
          {data.files_total > data.files.length ? <p className="pc-more">and {plural(data.files_total - data.files.length, "more file")}</p> : null}
        </section>
        <section aria-labelledby={`commits-${id}`}>
          <h4 className="pc-h" id={`commits-${id}`}>{data.commits_total > data.commits.length ? `Latest commits, ${data.commits.length} of ${data.commits_total}` : "Commits"}</h4>
          {data.commits.length ? (
            <ul className="pc-commits">
              {data.commits.map((c, i) => (
                <li key={`${c.sha ?? c.subject}-${i}`}>
                  <span className={`pc-sha${c.sha ? "" : " none"}`} title={c.sha ? `${c.branch ?? ""} ${c.sha}`.trim() : "Committed with -q, so the transcript has no hash"}>{c.sha ? c.sha.slice(0, 7) : "no hash"}</span>
                  <span className="pc-subject" title={c.subject}>{c.subject}</span>
                </li>
              ))}
            </ul>
          ) : <p className="pc-none">No commits made from these sessions.</p>}
        </section>
        {data.artifacts.length ? (
          <section aria-labelledby={`arts-${id}`}>
            <h4 className="pc-h" id={`arts-${id}`}>Artifacts</h4>
            <ul className="pc-arts">
              {data.artifacts.map((a) => <li key={a.id}>{a.url ? <a href={a.url} target="_blank" rel="noreferrer">{a.title}</a> : <a href={href(`artifacts/${enc(a.id)}`)}>{a.title}</a>}</li>)}
            </ul>
          </section>
        ) : null}
      </aside>
    </div>
  );
}

/** The row already carries the summary and verdict; the panel only explains states the row can't. */
function BriefBlock({ c, onRetry, retrying }: { c: ProposalContext; onRetry: () => void; retrying: boolean }) {
  if (c.noise) return <p className="pc-note">Looks like noise: {c.noise_reason}. Nothing here needs tracking, so rejecting it is safe.</p>;
  if (c.brief_status === "running" || c.brief_status === "pending") {
    return <p className="pc-wait" role="status">{c.brief ? "Refreshing the brief with the newest activity…" : "Writing a brief from the transcripts. This takes about ten seconds."}</p>;
  }
  if (c.brief_status === "failed") {
    return <p className="inline-error" role="alert">{c.brief_error ?? "The brief could not be written."} <button type="button" className="btn link" onClick={onRetry} disabled={retrying}>{retrying ? "Trying again…" : "Try again"}</button></p>;
  }
  if (c.brief_status === "stale") return <p className="pc-note">The brief predates the newest activity in these sessions.</p>;
  return null;
}
