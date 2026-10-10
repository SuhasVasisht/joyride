// Search spans ideas, tasks, authored notes, artifact snapshots and sessions.
// Results have source and place filters, pagination and related-item sheets.
// The Artifacts view keeps newest-first cards and saved-session resume commands.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Route } from "../../lib/router";
import { go, href, parse } from "../../lib/router";
import { api, timeAgo, useApi } from "../../lib/api";
import type { KnowledgeItem, KnowledgeSearch, KnowledgeType } from "../../../shared/knowledge";
import { RegisterForm, StatusPill, type ArtifactView } from "../artifacts/ArtifactsPage";
import { plural, useAction } from "./ui";
import {
  MODE, TYPES, TYPE_LABEL, VIEWS, groupByDate, isSavedSession,
  kindLabel, kindMark, parseRef, parseTypes, viewOf, type Filters, type View,
} from "./model";
import { openArtifact } from "../artifacts/ArtifactOverlay";
import { ItemSheet } from "./ItemSheet";
import { ResumeLine } from "./Resume";
import { ArtifactsReview } from "./ArtifactsReview";
import "./knowledge.css";
import "./knowledge-home.css";

/**
 * Rewrites the current knowledge hash, keeping the view. Empty values drop out.
 * Reads the live hash rather than the rendered route, so two quick changes in a
 * row never undo each other.
 */
function setQuery(_route: Route, patch: Record<string, string | null>, replace = false) {
  const route = parse();
  const qs = new URLSearchParams(route.query);
  for (const [k, v] of Object.entries(patch)) { if (v) qs.set(k, v); else qs.delete(k); }
  const s = qs.toString();
  const path = `knowledge${route.params[0] ? `/${route.params[0]}` : ""}${s ? `?${s}` : ""}`;
  if (replace) location.replace(href(path)); else go(path);
}

export function KnowledgePage({ route }: { route: Route }) {
  const view = viewOf(route.params[0]);
  const q = route.query.get("q") ?? "";
  const filters: Filters = {
    types: parseTypes(route.query.get("types")), idea: route.query.get("idea") ?? "",
    task: route.query.get("task") ?? "", session: route.query.get("session") ?? "", project: route.query.get("project") ?? "",
  };
  const open = parseRef(route.query.get("open"));
  const [draft, setDraft] = useState(q);
  useEffect(() => setDraft(q), [q]);
  // Typing updates the hash after a short pause, so the search is shareable and survives reloads.
  useEffect(() => {
    if (draft === q) return;
    const t = setTimeout(() => setQuery(route, { q: draft.trim() ? draft : null }, true), 220);
    return () => clearTimeout(t);
  }, [draft]);

  const artifactsView = view === "artifacts";
  const filterKey = JSON.stringify([q, view, filters]);
  const [pagination, setPagination] = useState({ key: filterKey, offset: 0 });
  const offset = pagination.key === filterKey ? pagination.offset : 0;
  const params = new URLSearchParams({ q, mode: artifactsView ? "all" : MODE[view], limit: "50", offset: String(offset),
    types: filters.types.join(","), idea: filters.idea, task: filters.task, session: filters.session, project: filters.project ?? "" });
  const { data, error, loading } = useApi<KnowledgeSearch>(artifactsView ? null : `/api/knowledge/search?${params}`, ["knowledge"]);
  const items = data?.items ?? [];
  // Artifact rows also show their Firstmate or distill status and project, from the artifact registry.
  const { data: artifactList } = useApi<ArtifactView[]>(artifactsView ? null : "/api/artifacts", ["artifacts"]);
  const artifacts = useMemo(() => new Map((artifactList ?? []).map((a) => [a.id, a])), [artifactList]);
  const counts = new Map(TYPES.map((type) => [type, data?.facets.types[type] ?? 0]));
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === "/" && !(t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) { e.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const openKey = (key: string | null) => key?.startsWith("artifact:") ? openArtifact(key.slice(9)) : setQuery(route, { open: key });

  return (
    <div className="k-page kn-page" data-testid="knowledge-page">
      <header className="k-head">
        <div>
          <h1>Search</h1>
          <p className="k-lede">Find ideas, notes, artifacts, sessions and tasks.</p>
        </div>
        <span className="spacer" />
        <button type="button" className="btn" onClick={() => setQuery(route, { register: route.query.get("register") === "1" ? null : "1" })}>Register an artifact</button>
      </header>
      <div className="kn-search">
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M11 11 L14.5 14.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        <input ref={searchRef} className="input" type="search" value={draft} onChange={(e) => setDraft(e.target.value)}
          placeholder={artifactsView ? "Search artifacts: titles, summaries, ideas, sessions, links" : "Search everything: ideas, notes, artifacts, sessions, tasks"} aria-label={artifactsView ? "Search artifacts" : "Search knowledge"} data-testid="knowledge-search" />
        <kbd aria-hidden>/</kbd>
      </div>
      <nav className="k-tabs" aria-label="Search views">
        {VIEWS.map(([v, label]) => {
          const qs = new URLSearchParams(route.query); qs.delete("open"); qs.delete("section");
          // Each side keeps only the filters it understands.
          for (const k of v === "artifacts" ? ["types", "task", "session", "project"] : ["source", "unreviewed"]) qs.delete(k);
          const s = qs.toString();
          return (
            <a key={v} href={href(`knowledge${v === "all" ? "" : `/${v}`}${s ? `?${s}` : ""}`)} className={v === view ? "on" : ""} aria-current={v === view ? "page" : undefined}>
              {label}
            </a>
          );
        })}
      </nav>
      {route.query.get("register") === "1" ? (
        <div className="kn-register"><RegisterForm onDone={(a) => setQuery(route, { register: null, open: a ? `artifact:${a.id}` : null })} /></div>
      ) : null}
      {artifactsView ? <ArtifactsReview route={route} setQuery={(patch) => setQuery(route, patch)} /> : <div className="kn-layout">
        <Facets route={route} facets={data?.facets} counts={counts} filters={filters} view={view} />
        <div className="kn-main">
          {error ? <p className="k-err">Could not search knowledge: {error}. Check that the daemon is running, then refresh.</p> : null}
          {data?.notices.length ? <p className="k-note" data-testid="knowledge-notices">{data.notices.join(" ")}</p> : null}
          <><Results view={view} items={items} artifacts={artifacts} ranked={Boolean(q.trim())} loading={loading && !data}
            open={open ? `${open.entity}:${open.id}` : null} onOpen={openKey} filtered={Boolean(filters.types.length || filters.idea || filters.task || filters.session || filters.project)} />
            {data && data.total > 50 ? <div className="row" aria-label="Knowledge pages">
              <button className="btn" disabled={loading || offset === 0} onClick={() => setPagination({ key: filterKey, offset: Math.max(0, offset - 50) })}>Previous</button>
              <span className="meta">Showing {offset + 1} to {Math.min(offset + 50, data.total)} of {data.total}</span>
              <button className="btn" disabled={loading || offset + 50 >= data.total} onClick={() => setPagination({ key: filterKey, offset: offset + 50 })}>Next</button>
            </div> : null}</>
        </div>
      </div>}
      {open && open.entity !== "artifact" && !artifactsView ? <ItemSheet key={`${open.entity}:${open.id}`} target={open} onClose={() => openKey(null)} onOpen={openKey} /> : null}
    </div>
  );
}

function Facets({ route, facets, counts, filters, view }: { route: Route; facets: KnowledgeSearch["facets"] | undefined; counts: Map<KnowledgeType, number>; filters: Filters; view: View }) {
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const toggleType = (t: KnowledgeType | null) => setQuery(route, { types: t ? t : null, open: null });
  const one = filters.types.length === 1 ? filters.types[0] : null;
  const many = filters.types.length > 1;
  const pick = (kind: "idea" | "task" | "session") => {
    const opts = [...(facets?.anchors[kind] ?? [])];
    const cur = filters[kind];
    if (cur && !opts.some((o) => o.id === cur)) opts.unshift({ id: cur, title: cur, n: 0 });
    return opts;
  };
  const select = (kind: "idea" | "task" | "session", label: string) => {
    const opts = pick(kind);
    return (
      <label key={kind} className="kn-facet-select">{label}
        <select className="k-select" value={filters[kind]} onChange={(e) => setQuery(route, { [kind]: e.target.value || null, open: null })} aria-label={`Filter by ${label.toLowerCase()}`} disabled={!opts.length}>
          <option value="">{opts.length ? `Any ${label.toLowerCase()}` : `No ${label.toLowerCase()}s here`}</option>
          {opts.map((o) => <option key={o.id} value={o.id}>{o.title}{o.n ? ` (${o.n})` : ""}</option>)}
        </select>
      </label>
    );
  };
  return (
    <aside className="kn-facets" aria-label="Filters">
      <div className="k-label">Type</div>
      <ul className="kn-types" data-testid="type-filter">
        <li><button type="button" className={!filters.types.length ? "on" : ""} aria-pressed={!filters.types.length} onClick={() => toggleType(null)}><span>All</span><span className="n">{total}</span></button></li>
        {many ? <li><button type="button" className="on" aria-pressed onClick={() => toggleType(null)}><span>{filters.types.map((t) => TYPE_LABEL[t]).join(", ")}</span><span className="n">{filters.types.reduce((a, t) => a + (counts.get(t) ?? 0), 0)}</span></button></li> : null}
        {TYPES.filter((t) => counts.get(t) || t === one).map((t) => (
          <li key={t}><button type="button" className={t === one ? "on" : ""} aria-pressed={t === one} onClick={() => toggleType(t === one ? null : t)}>
            <span>{TYPE_LABEL[t]}</span><span className="n">{counts.get(t) ?? 0}</span>
          </button></li>
        ))}
      </ul>
      <div className="k-label" style={{ marginTop: 18 }}>Anchored to</div>
      {select("idea", "Idea")}
      {select("task", "Task")}
      {select("session", "Session")}
      {(() => {
        const opts = facets?.projects ?? [];
        if (!opts.length && !filters.project) return null;
        return (
          <label className="kn-facet-select">Project
            <select className="k-select" value={filters.project} onChange={(e) => setQuery(route, { project: e.target.value || null, open: null })} aria-label="Filter by project">
              <option value="">Any project</option>
              {opts.map((o) => <option key={o.id} value={o.id}>{o.title} ({o.n})</option>)}
            </select>
          </label>
        );
      })()}
      {filters.idea || filters.task || filters.session || filters.project || filters.types.length ? (
        <button type="button" className="btn ghost kn-clear" onClick={() => setQuery(route, { types: null, idea: null, task: null, session: null, project: null, open: null })}>Clear filters</button>
      ) : null}
      {view === "all" ? <p className="k-note kn-facet-help">Filter results by type or by the idea, task, session or project they belong to.</p> : null}
    </aside>
  );
}

function Row({ item, on, onOpen, select, artifact }: { item: KnowledgeItem; on: boolean; onOpen: (key: string) => void; select?: ReactNode; artifact?: ArtifactView }) {
  const anchors = item.anchors.filter((a) => (a.direct || a.kind === "idea") && a.kind !== "repo").slice(0, 3);
  return (
    <li className={`kn-row${on ? " on" : ""}`} data-testid="knowledge-row" data-key={item.key} data-type={item.type}>
      {select}
      <button type="button" className="kn-row-main" onClick={() => onOpen(item.key)} aria-current={on ? "true" : undefined}>
        <span className="k-kind" data-kind={item.kind} aria-hidden>{kindMark(item.kind)}</span>
        <span className="kn-kind">{kindLabel(item.kind)}</span>
        <span className="t">{item.title}</span>
        <span className="right">
          {artifact ? <StatusPill a={artifact} /> : null}
          <span className="when">{timeAgo(item.updated)}</span>
        </span>
        {item.summary && item.summary !== item.title ? <span className="one">{item.summary.replace(/(^|\s)#{1,6}\s+/g, "$1").replace(/\s+/g, " ").slice(0, 220)}</span> : null}
        {anchors.length || artifact?.project || artifact?.firstmate ? <span className="sub">
          {artifact?.firstmate ? <span>Firstmate report</span> : null}
          {artifact?.project ? <span className="kn-anchor" data-kind="repo">{artifact.project}</span> : null}
          {anchors.map((a) => <span key={`${a.kind}:${a.id}`} className="kn-anchor" data-kind={a.kind}>{a.kind === "idea" ? "◇ " : a.kind === "task" ? "▣ " : a.kind === "session" ? "⟲ " : ""}{a.title}</span>)}
        </span> : null}
      </button>
      {isSavedSession(item) ? <div className="kn-row-extra"><ResumeLine id={item.ref.id} /></div> : null}
    </li>
  );
}

function Results({ view, items, artifacts, ranked, loading, open, onOpen, filtered }: {
  view: View; items: KnowledgeItem[]; artifacts: Map<string, ArtifactView>; ranked: boolean; loading: boolean; open: string | null; onOpen: (key: string | null) => void; filtered: boolean;
}) {
  const artifactOf = (i: KnowledgeItem) => (i.ref.entity === "artifact" ? artifacts.get(i.ref.id) : undefined);
  if (loading) return <p className="k-skeleton">Searching…</p>;
  if (!items.length) {
    return (
      <div className="kn-empty" data-testid="knowledge-empty">
        <p>{filtered ? "Nothing matches these filters." : ranked ? "Nothing matches that search." : "No results yet. Register a report or page, or save a note from the map."}</p>
      </div>
    );
  }
  return (
    <div className="kn-groups">
      {groupByDate(items, ranked).map((g) => (
        <section key={g.label} className="kn-group">
          <h3>{g.label} <span className="n">{g.items.length}</span></h3>
          <ul className="kn-list">{g.items.map((i) => <Row key={i.key} item={i} on={open === i.key} onOpen={onOpen} artifact={artifactOf(i)} />)}</ul>
        </section>
      ))}
    </div>
  );
}

