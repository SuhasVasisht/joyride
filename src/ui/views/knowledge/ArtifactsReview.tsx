// The artifacts view of Knowledge (#/knowledge/artifacts): every artifact from
// Joyride (its reports, Firstmate's reports, registered links and files) and
// Claude (pages captured from sessions), one row each however it was found,
// newest first, a page at a time from /api/artifacts/review. A row opens its
// content in the shared reader, with a truthful fallback for remote-only content.
// Query: q (the knowledge search box), source, idea, open=<artifact id>.
import { useEffect, useMemo, useState } from "react";
import type { Route } from "../../lib/router";
import { href } from "../../lib/router";
import { timeAgo, useApi } from "../../lib/api";
import { NO_IDEA, PAGE_SIZE, SOURCE_LABEL, type ReviewItem, type ReviewPage, type ReviewSource } from "../../../shared/artifact-review";
import { openArtifact } from "../artifacts/ArtifactOverlay";
import { plural } from "../knowledge/ui";
import { dateBucket } from "./model";

type SetQuery = (patch: Record<string, string | null>) => void;
const MARK: Record<ReviewSource, string> = { claude: "◈", report: "▤", firstmate: "▤", pr: "⌥", chatgpt: "◐", file: "▢", link: "↗" };
const openLabel = (i: ReviewItem) => (!i.url ? null : i.source === "claude" ? "Open in Claude" : i.source === "pr" ? "Open the pull request" : i.source === "chatgpt" ? "Open in ChatGPT" : "Open link");
const fullDate = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function groups(items: ReviewItem[]): { label: string; items: ReviewItem[] }[] {
  const out = new Map<number, { label: string; items: ReviewItem[] }>();
  for (const i of items) {
    const [rank, label] = dateBucket(i.at);
    const g = out.get(rank) ?? { label, items: [] };
    g.items.push(i);
    out.set(rank, g);
  }
  return [...out.entries()].sort((a, b) => a[0] - b[0]).map(([, g]) => g);
}

export function ArtifactsReview({ route, setQuery }: { route: Route; setQuery: SetQuery }) {
  const q = route.query.get("q") ?? "";
  const source = route.query.get("source") ?? "";
  const idea = route.query.get("idea") ?? "";
  const open = route.query.get("artifact") ?? route.query.get("open")?.replace(/^artifact:/, "") ?? null;
  const [pages, setPages] = useState(1);
  const filterKey = `${q}|${source}|${idea}`;
  useEffect(() => setPages(1), [filterKey]);
  const params = new URLSearchParams({ limit: String(PAGE_SIZE * pages) });
  if (q.trim()) params.set("q", q);
  if (source) params.set("source", source);
  if (idea) params.set("idea", idea);
  const { data, error, loading } = useApi<ReviewPage>(`/api/artifacts/review?${params}`, ["artifacts", "missions"]);
  const [last, setLast] = useState<ReviewPage | null>(null);
  useEffect(() => { if (data) setLast(data); }, [data]);
  const page = data ?? last; // keep the rows on screen while the next page loads
  const items = page?.items ?? [];
  const shown = useMemo(() => groups(items), [items]);
  const openItem = items.find((i) => i.id === open || i.ids.includes(open ?? ""));
  const filtered = Boolean(q.trim() || source || idea);

  return (
    <div className="kn-layout" data-testid="artifacts-review">
      <aside className="kn-facets" aria-label="Artifact filters">
        <div className="k-label">Source</div>
        <ul className="kn-types" data-testid="artifact-source-filter">
          <li><button type="button" className={!source ? "on" : ""} aria-pressed={!source} onClick={() => setQuery({ source: null, open: null })}>
            <span>All sources</span><span className="n">{page?.any_source ?? ""}</span>
          </button></li>
          {(page?.sources ?? []).map((s) => (
            <li key={s.id}><button type="button" className={s.id === source ? "on" : ""} aria-pressed={s.id === source} onClick={() => setQuery({ source: s.id === source ? null : s.id, open: null })}>
              <span>{s.title}</span><span className="n">{s.n}</span>
            </button></li>
          ))}
        </ul>
        <label className="kn-facet-select" style={{ marginTop: 14 }}>Idea
          <select className="k-select" value={idea} onChange={(e) => setQuery({ idea: e.target.value || null, open: null })} aria-label="Filter by idea" data-testid="artifact-idea-filter">
            <option value="">Any idea</option>
            {idea && !page?.ideas.some((i) => i.id === idea) ? <option value={idea}>{idea === NO_IDEA ? "No idea" : idea}</option> : null}
            {(page?.ideas ?? []).map((i) => <option key={i.id} value={i.id}>{i.title} ({i.n})</option>)}
          </select>
        </label>
        {source || idea ? <button type="button" className="btn ghost kn-clear" onClick={() => setQuery({ source: null, idea: null, unreviewed: null, open: null })}>Clear filters</button> : null}
        <p className="k-note kn-facet-help">Joyride and Firstmate reports, registered links and files, and the Claude pages your sessions published. One row each, however Joyride found it.</p>
      </aside>
      <div className="kn-main">
        {error ? <p className="k-err">Could not load artifacts: {error}. Check that the daemon is running, then refresh.</p> : null}
        {!page && loading ? <p className="k-skeleton">Loading artifacts…</p> : null}
        {page ? (
          <p className="k-note kn-art-count" data-testid="artifact-count">
            {page.total === page.all ? plural(page.total, "artifact") : `${page.total} of ${plural(page.all, "artifact")}`}, newest first
          </p>
        ) : null}
        {page && !items.length ? (
          <div className="kn-empty" data-testid="artifacts-empty">
            <p>{filtered ? "No artifact matches these filters." : "No artifacts yet. Pages your sessions publish, Firstmate's reports and anything you register show up here."}</p>
          </div>
        ) : null}
        <div className="kn-groups">
          {shown.map((g) => (
            <section key={g.label} className="kn-group">
              <h3>{g.label} <span className="n">{g.items.length}</span></h3>
              <ul className="kn-list">
                {g.items.map((i) => <ArtifactRow key={i.id} item={i} on={openItem?.id === i.id}
                  onOpen={() => openArtifact(i.id)} />)}
              </ul>
            </section>
          ))}
        </div>
        {page && page.total > items.length ? (
          <div className="kn-more">
            <button type="button" className="btn" disabled={loading} onClick={() => setPages((p) => p + 1)} data-testid="artifacts-more">
              {loading ? "Loading…" : `Show ${Math.min(PAGE_SIZE, page.total - items.length)} more`}
            </button>
            <span className="k-note">Showing {items.length} of {page.total}</span>
          </div>
        ) : null}
      </div>

    </div>
  );
}

function ArtifactRow({ item: i, on, onOpen }: { item: ReviewItem; on: boolean; onOpen: () => void }) {
  const link = openLabel(i);
  const body = (
    <>
      <span className="k-kind" aria-hidden>{MARK[i.source]}</span>
      <span className="kn-kind" data-testid="artifact-source">{SOURCE_LABEL[i.source]}</span>
      <span className="t">{i.title}</span>
      <span className="right">{i.private ? <span className="k-pill quiet">Private</span> : null}<span className="when" title={`${i.firstmate_task ? "Report written" : "Created"} ${fullDate(i.at)}`}>{timeAgo(i.at)}</span></span>
      {i.summary && i.summary !== i.title ? <span className="one">{i.summary}</span> : null}
      <span className="sub">
        {i.mission ? <span className="kn-anchor" data-kind="idea" data-testid="artifact-idea">◇ {i.mission_title ?? i.mission}</span> : <span className="kn-anchor muted">No idea</span>}
        {i.session ? <span className="kn-anchor" data-kind="session">⟲ {i.session_title ?? i.session}</span> : null}
        {i.firstmate_task ? <span className="kn-anchor" data-kind="task">▣ {i.firstmate_task}</span> : null}
        {i.project ? <span className="kn-anchor" data-kind="repo">{i.project}</span> : null}
        {i.sources.length > 1 ? <span data-testid="artifact-also">Also {i.sources.filter((s) => s !== i.source).map((s) => SOURCE_LABEL[s].toLowerCase()).join(", ")}</span> : null}
      </span>
    </>
  );
  return (
    <li className={`kn-row kn-art${on ? " on" : ""}`} data-testid="artifact-row" data-id={i.id} data-source={i.source}>
      <button type="button" className="kn-row-main" onClick={onOpen} aria-current={on ? "true" : undefined}>{body}</button>
      <div className="kn-art-actions">
        {link ? <a className="btn kn-art-open" href={i.url!} target="_blank" rel="noreferrer">{link} ↗</a> : null}
      </div>
    </li>
  );
}
