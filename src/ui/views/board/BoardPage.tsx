// The Board (#/board): every note, list and link on the map in one place, off the canvas. Search every line and
// link title; filter by type, by place (Unfiled, a group, an idea, tasks and agents) and to items with todos still
// open; tick, edit, move and delete in place (Undo for the last move or delete); Show on map glides the chart to
// the item's card. Route: #/board?q=&type=&place=&open=1
import { useEffect, useMemo, useRef, useState } from "react";
import type { Route } from "../../lib/router";
import { href, parse } from "../../lib/router";
import { NoteCard, noteLabel } from "../../components/notes/NoteCard";
import { moveNote, restoreNote, useAllNotes, type Note } from "../../components/notes/notes";
import { usePlaces } from "../../components/notes/places";
import { openComposer } from "../../components/compose/ghost";
import { revealOnMap } from "../map/reveal";
import { parseNoteScope } from "../../../shared/notes";
import type { Landing } from "../../../shared/new-plan";
import { TYPE_FILTERS, boardCounts, filterBoard, groupBoard, type TypeFilter } from "./model";
import "../knowledge/knowledge.css";
import "../knowledge/knowledge-home.css";
import "../../components/notes/notes.css";
import "./board.css";

function setQuery(patch: Record<string, string | null>) {
  const qs = new URLSearchParams(parse().query);
  for (const [k, v] of Object.entries(patch)) { if (v) qs.set(k, v); else qs.delete(k); }
  const s = qs.toString();
  location.replace(href(`board${s ? `?${s}` : ""}`));
}

/** Where an item's card is on the map, for Show on map: its place when the card can't be found. */
function landingOf(n: Pick<Note, "id" | "scope">, shownIn: string): Landing | null {
  const a = parseNoteScope(shownIn);
  if (!a) return null;
  if (a.kind === "session") return null;
  if (a.kind === "task") return { kind: "task", id: a.id };
  const place: Landing = a.kind === "global" ? { kind: "hub" } : a.kind === "group" ? { kind: "region", id: `lens:${a.id}` } : { kind: "idea", id: a.id };
  return { kind: "item", id: n.id, zoom: "mid", place };
}

/** A place on the map: the hub (Unfiled), a group's region, or an idea. */
function sectionLanding(scope: string): Landing | null {
  const a = parseNoteScope(scope);
  if (!a || a.kind === "global") return { kind: "hub" };
  return a.kind === "group" ? { kind: "region", id: `lens:${a.id}` } : a.kind === "mission" ? { kind: "idea", id: a.id } : null;
}

type Undo = { text: string; run: () => Promise<unknown> };

/**
 * A filter kept in the URL (shareable, survives a reload) that answers at once: the page reads its own copy,
 * which follows the URL whenever the URL changes, so a click never flickers back while the hash catches up.
 */
function useQueryValue(route: Route, key: string, fallback: string): [string, (v: string | null) => void] {
  const fromUrl = route.query.get(key) ?? fallback;
  const [v, setV] = useState(fromUrl);
  useEffect(() => setV(fromUrl), [fromUrl]);
  return [v, (next) => { setV(next ?? fallback); setQuery({ [key]: next }); }];
}

export function BoardPage({ route }: { route: Route }) {
  const q = route.query.get("q") ?? "";
  const [typeValue, setType] = useQueryValue(route, "type", "all");
  const [place, setPlace] = useQueryValue(route, "place", "all");
  const [openValue, setOpen] = useQueryValue(route, "open", "");
  const type = typeValue as TypeFilter;
  const open = openValue === "1";
  const { data, error, loading } = useAllNotes();
  const places = usePlaces();
  const [draft, setDraft] = useState(q);
  const [undo, setUndo] = useState<Undo | null>(null);
  useEffect(() => setDraft(q), [q]);
  useEffect(() => {
    if (draft === q) return;
    const t = setTimeout(() => setQuery({ q: draft.trim() ? draft : null }), 200);
    return () => clearTimeout(t);
  }, [draft]);
  useEffect(() => { if (!undo) return; const t = setTimeout(() => setUndo(null), 12000); return () => clearTimeout(t); }, [undo]);
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === "/" && !(t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) { e.preventDefault(); search.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // #/board?item=<id> (from Knowledge): bring that card into view and mark it once it is drawn.
  const item = route.query.get("item");
  useEffect(() => {
    if (!item || !data || !places.ready) return;
    const el = document.querySelector<HTMLElement>(`.bd-page [data-board-item="${CSS.escape(item)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    el.dataset.settled = "";
    const t = setTimeout(() => { delete el.dataset.settled; setQuery({ item: null }); }, 1400);
    return () => clearTimeout(t);
  }, [item, data, places.ready]);

  // Sections wait for the groups, so an item never starts in Unfiled and jumps to its group.
  const all = places.ready ? data ?? [] : [];
  const counts = useMemo(() => boardCounts(all), [all]);
  const shown = useMemo(() => filterBoard(all, { q, type, place, open }, places), [all, q, type, place, open, places]);
  const sections = useMemo(() => groupBoard(shown, places), [shown, places]);
  // Places that hold something, for the place filter, plus every group and idea so an empty one can be picked.
  const placeOptions = places.options;
  const hasOther = all.some((n) => /^(task|session):/.test(places.shownIn(n.scope)));
  const filtered = Boolean(q.trim() || type !== "all" || place !== "all" || open);

  const onDeleted = (n: Note) => setUndo({ text: `Deleted “${noteLabel(n, 48)}”.`, run: () => restoreNote(n.id) });
  const onMoved = (n: Note, from: string) => setUndo({ text: `Moved “${noteLabel(n, 48)}” to ${places.label(n.scope)}.`, run: () => moveNote(n.id, parseNoteScope(from) ?? { kind: "global" }) });

  return (
    <div className="k-page bd-page" data-testid="board-page">
      <header className="k-head">
        <div>
          <h1>Board</h1>
          <p className="k-lede">Every note, list and link on the map, wherever it's pinned. Tick, edit and move them here; <strong>Show on map</strong> takes you to the card.</p>
        </div>
        <span className="spacer" />
        <button type="button" className="btn primary" onClick={() => openComposer()}>New note, list or link</button>
      </header>
      <div className="kn-search">
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M11 11 L14.5 14.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        <input ref={search} className="input" type="search" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Search notes, todos and links" aria-label="Search the board" data-testid="board-search" />
        <kbd aria-hidden>/</kbd>
      </div>
      <div className="kn-layout">
        <aside className="kn-facets bd-facets" aria-label="Filters">
          <ul className="kn-types" aria-label="Type">
            {TYPE_FILTERS.map((t) => (
              <li key={t.id}>
                <button type="button" className={type === t.id ? "on" : ""} aria-pressed={type === t.id} onClick={() => setType(t.id === "all" ? null : t.id)} data-type-filter={t.id}>
                  <span>{t.label}</span><span className="n">{counts.types[t.id]}</span>
                </button>
              </li>
            ))}
          </ul>
          <label className="k-check bd-open">
            <input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked ? "1" : null)} data-testid="board-open-todos" />
            Open todos only <span className="n">{counts.open}</span>
          </label>
          <label className="kn-facet-select">
            <span>Place</span>
            <select value={place} onChange={(e) => setPlace(e.target.value === "all" ? null : e.target.value)} aria-label="Place" data-testid="board-place">
              <option value="all">Every place</option>
              <option value="global">Unfiled</option>
              {places.groups.length ? <optgroup label="Groups">{placeOptions.filter((o) => o.kind === "group").map((o) => <option key={o.scope} value={o.scope}>{o.title}</option>)}</optgroup> : null}
              {places.ideas.length ? <optgroup label="Ideas">{placeOptions.filter((o) => o.kind === "idea").map((o) => <option key={o.scope} value={o.scope}>{o.title}</option>)}</optgroup> : null}
              {hasOther ? <option value="other">Tasks and agents</option> : null}
            </select>
          </label>
          {filtered ? <button type="button" className="btn small kn-clear" onClick={() => { setDraft(""); setType(null); setPlace(null); setOpen(null); setQuery({ q: null }); }}>Clear filters</button> : null}
          <p className="k-note kn-facet-help">Notes, lists and links live in Unfiled (on the hub), in a group or on an idea. Agents add them with <code>joyride map note</code>, <code>list</code> and <code>link</code>.</p>
        </aside>
        <div className="kn-main">
          {undo ? (
            <p className="bd-undo" role="status" data-testid="board-undo">
              {undo.text} <button type="button" className="btn link" onClick={async () => { const u = undo; setUndo(null); await u.run(); }}>Undo</button>
            </p>
          ) : null}
          {error ? <p className="k-err">The board can't load: {error}. Check that the daemon is running, then refresh.</p> : null}
          {(loading && !data) || (data && !places.ready) ? <p className="meta">Loading the board…</p> : null}
          {data && places.ready && !shown.length ? (
            <div className="bd-empty">
              <p>{filtered ? "Nothing on the board matches these filters." : "Nothing on the board yet."}</p>
              <p className="meta">{filtered ? "Clear the filters, or search for other words." : "Type “note: …”, “list: …” or paste a link into New, or press + on a group on the map."}</p>
            </div>
          ) : null}
          <div className="bd-sections">
            {sections.map((s) => {
              const kindWord = s.kind === "group" ? "Group" : s.kind === "idea" ? "Idea" : s.kind === "other" ? "" : "On the hub";
              const where = sectionLanding(s.scope);
              return (
                <section key={s.scope} className="bd-section" data-board-section={s.scope} aria-label={`${s.title}: ${s.items.length} ${s.items.length === 1 ? "item" : "items"}`}>
                  <header className="bd-sec-head">
                    <h2>{s.title}</h2>
                    {kindWord ? <span className="bd-kind">{kindWord}</span> : null}
                    <span className="bd-n">{s.items.length}</span>
                    <span className="spacer" />
                    {where ? <button type="button" className="btn link small" onClick={() => revealOnMap(where)}>Show on map</button> : null}
                  </header>
                  <ul className="bd-cards">
                    {s.items.map((n) => {
                      const land = landingOf(n, places.shownIn(n.scope));
                      return (
                        <li key={n.id}>
                          <NoteCard n={n} where="board" onDeleted={onDeleted} onMoved={onMoved}
                            extra={land ? <button type="button" className="btn small bd-show" onClick={() => revealOnMap(land)}>Show on map</button> : null} />
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
