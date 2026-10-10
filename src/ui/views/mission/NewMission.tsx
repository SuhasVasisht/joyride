// New mission: title, goal, repo (picked from repos your sessions ran in) and
// done-when criteria with their evidence kind. POST /api/missions, then open it.
import { useMemo, useState } from "react";
import { api, repoLabel, timeAgo, useApi } from "../../lib/api";
import { go, type Route } from "../../lib/router";
import type { SessionView } from "../../lib/types";
import { Sheet, closeOverlay } from "../../components/Sheet";
import { shortPath } from "../../components/primitives";
import "./mission.css";

const KINDS: [string, string][] = [["test", "Test"], ["e2e", "End-to-end"], ["screenshot", "Screenshot"], ["review", "Review"], ["other", "Other"]];
type Crit = { key: number; text: string; kind: string };
const OTHER = "__other__";

export function NewMissionRoute(_: { route: Route }) {
  return <Sheet label="New idea"><NewMissionForm /></Sheet>;
}

export function NewMissionForm() {
  const { data: sessions } = useApi<SessionView[]>("/api/sessions?limit=500", []);
  const repos = useMemo(() => {
    const by = new Map<string, { repo: string; n: number; last: string }>();
    for (const s of sessions ?? []) {
      if (!s.repo) continue;
      const r = by.get(s.repo) ?? { repo: s.repo, n: 0, last: "" };
      r.n++; if ((s.updated ?? "") > r.last) r.last = s.updated ?? "";
      by.set(s.repo, r);
    }
    return [...by.values()].sort((a, b) => b.last.localeCompare(a.last));
  }, [sessions]);
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [repo, setRepo] = useState("");
  const [otherRepo, setOtherRepo] = useState("");
  const [crits, setCrits] = useState<Crit[]>([{ key: 1, text: "", kind: "test" }]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const nextKey = () => Math.max(0, ...crits.map((c) => c.key)) + 1;
  const chosenRepo = repo === OTHER ? otherRepo.trim() : repo;

  async function submit() {
    if (!title.trim() || busy) return;
    setBusy(true); setErr(null);
    const done_when = crits.filter((c) => c.text.trim()).map((c, i) => ({ id: `c${i + 1}`, text: c.text.trim(), kind: c.kind }));
    try {
      const m = await api<{ id: string }>("/api/missions", { method: "POST", json: { title: title.trim(), goal: goal.trim(), repos: chosenRepo ? [chosenRepo] : [], done_when } });
      go(`mission/${encodeURIComponent(m.id)}`);
    } catch (e: any) {
      setErr(`The idea was not created: ${e.message}`);
      setBusy(false);
    }
  }

  return (
    <article className="pane-page new-mission" data-testid="new-mission">
      <header className="mp-header">
        <p className="mp-crumbs"><a href="#/map">Map</a><span aria-hidden>/</span><span>New idea</span></p>
        <h1 className="mp-title">New idea</h1>
        <p className="nm-lede">An idea is a goal you track across sessions and agents. Say what done looks like, and Jev judges the evidence against it.</p>
      </header>
      <form className="nm-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <label className="nm-field">
          <span>Title</span>
          <input className="input nm-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="For example: CSV export for the report page" required data-autofocus />
        </label>
        <label className="nm-field">
          <span>Goal</span>
          <textarea className="input" rows={4} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="What should be true when this is done, and why it matters." />
        </label>
        <div className="nm-field">
          <label htmlFor="nm-repo">Repo</label>
          <select id="nm-repo" className="input" value={repo} onChange={(e) => setRepo(e.target.value)}>
            <option value="">No repo yet</option>
            {repos.map((r) => <option key={r.repo} value={r.repo}>{repoLabel(r.repo)}, {shortPath(r.repo, 3)} ({r.n} {r.n === 1 ? "session" : "sessions"}, last {timeAgo(r.last)})</option>)}
            <option value={OTHER}>Another folder…</option>
          </select>
          {repo === OTHER ? <input className="input" value={otherRepo} onChange={(e) => setOtherRepo(e.target.value)} placeholder="/absolute/path/to/the/repo" aria-label="Repo path" /> : null}
          <p className="meta">Sessions in this repo can then be linked from the idea. {repos.length ? `${repos.length} repos are known from your sessions.` : ""}</p>
        </div>
        <fieldset className="nm-field nm-crits">
          <legend>Done when</legend>
          <ol>
            {crits.map((c, i) => (
              <li key={c.key} className="nm-crit">
                <input className="input" value={c.text} aria-label={`Criterion ${i + 1}`} placeholder={i === 0 ? "For example: the export test passes with a totals row" : "Another check an agent can prove"}
                  onChange={(e) => setCrits((cs) => cs.map((x) => (x.key === c.key ? { ...x, text: e.target.value } : x)))} />
                <select className="input" value={c.kind} aria-label={`Evidence kind for criterion ${i + 1}`} onChange={(e) => setCrits((cs) => cs.map((x) => (x.key === c.key ? { ...x, kind: e.target.value } : x)))}>
                  {KINDS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                </select>
                <button type="button" className="btn ghost small" aria-label={`Remove criterion ${i + 1}`} disabled={crits.length === 1 && !c.text}
                  onClick={() => setCrits((cs) => (cs.length === 1 ? [{ key: nextKey(), text: "", kind: "test" }] : cs.filter((x) => x.key !== c.key)))}>Remove</button>
              </li>
            ))}
          </ol>
          <button type="button" className="btn small" onClick={() => setCrits((cs) => [...cs, { key: nextKey(), text: "", kind: "test" }])}>Add a criterion</button>
          <p className="meta">Closing the idea needs a passing verdict on these, or a written reason. You can add more later.</p>
        </fieldset>
        {err ? <p className="inline-error" role="alert">{err}</p> : null}
        <div className="row nm-actions">
          <button type="submit" className="btn primary" disabled={!title.trim() || busy}>{busy ? "Creating" : "Create idea"}</button>
          <button type="button" className="btn ghost" onClick={closeOverlay}>Cancel</button>
        </div>
      </form>
    </article>
  );
}
