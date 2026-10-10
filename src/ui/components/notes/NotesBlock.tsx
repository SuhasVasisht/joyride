// The notes for one place, ready to mount: chips for what is there plus the quick composer.
//   variant "panel" (idea page, task sheet): the field stays open, chips below it.
//   variant "strip" (worker pane, map cards): chips inline with an "Add note" button.
// `also` lists other anchors whose notes apply here (a crewmate's task), shown read-only by label.
// MapBoard is the map's version for Unfiled (the hub), each group and each idea: every board item as its own card.
import { useState } from "react";
import { BoardChip, NoteCard, noteLabel } from "./NoteCard";
import { NoteChips } from "./NoteChips";
import { NoteComposer } from "./NoteComposer";
import { anchorKey, restoreNote, useAllNotes, useNotes, type Note, type NoteAnchor } from "./notes";
import { parseNoteScope } from "../../../shared/notes";

const anchorOf = (scope: string): NoteAnchor => (parseNoteScope(scope) as NoteAnchor | null) ?? { kind: "global" };
import { usePlaces } from "./places";
import { placedAt } from "./arriving";
import { revealOnMap } from "../../views/map/reveal";
import { href } from "../../lib/router";
import type { ZoomLevel } from "../../views/map/layout";
import "./notes.css";

export function NotesBlock({ anchor, place, variant = "panel", also }: {
  anchor: NoteAnchor;
  place: string;
  variant?: "panel" | "strip";
  also?: { anchor: NoteAnchor; label: string } | null;
}) {
  const { data: notes, error } = useNotes(anchor);
  const { data: extra } = useNotes(also?.anchor ?? null);
  return (
    <div className={`notes-block nb-${variant}`} data-notes={anchorKey(anchor)}>
      {variant === "panel" ? (
        <>
          <NoteComposer anchor={anchor} place={place} collapsible={false} />
          {error ? <p className="inline-error" role="alert">Notes could not be loaded: {error}</p> : null}
          {notes && !notes.length ? <p className="meta nb-empty">No notes yet. What you note here reaches every agent briefed on {place}.</p> : null}
          <NoteChips notes={notes} max={12} />
        </>
      ) : (
        <>
          <div className="nb-row">
            <NoteChips notes={notes} max={4} />
            <NoteComposer anchor={anchor} place={place} />
          </div>
          {error ? <p className="inline-error" role="alert">Notes could not be loaded: {error}</p> : null}
        </>
      )}
      {also && extra?.length ? (
        <div className="nb-also" data-notes-also={anchorKey(also.anchor)}>
          <span className="meta">{also.label}</span>
          <NoteChips notes={extra} max={4} />
        </div>
      ) : null}
    </div>
  );
}

/** "✎ 3": a count for compact surfaces (map cards at mid zoom). */
export function NoteCount({ anchor }: { anchor: NoteAnchor }) {
  const { data } = useNotes(anchor);
  if (!data?.length) return null;
  return <span className="note-count" title={`${data.length} ${data.length === 1 ? "note" : "notes"}`} data-note-count={data.length}><span aria-hidden>✎</span> {data.length}</span>;
}

/**
 * A place's board on the map: every note, list and link pinned to Unfiled (the hub), a group or an idea, above
 * its tasks so they aren't lost among them. Far: one line of chips (a click zooms to the item). Mid: compact
 * cards (ticks and links still work). Near: full cards, edited in place, Move to, Delete with Undo, and the quick
 * composer under them (each line a bullet, a "[ ] todo" or a link).
 * Every board reads the one shared list of notes and keeps its own: a deleted group's items show in Unfiled.
 */
export function MapBoard({ scope, place, level, composer = true }: { scope: string; place: string; level: ZoomLevel; composer?: boolean }) {
  const { data, error } = useAllNotes();
  const places = usePlaces();
  const [deleted, setDeleted] = useState<Note | null>(null);
  // Newest first, an item just moved here or asked for (Show on map) counting as new, so a full board draws it.
  const list = (data ?? []).filter((n) => places.shownIn(n.scope) === scope).sort((a, b) => placedAt(b) - placedAt(a));
  const near = level === "near", far = level === "far";
  if (!list.length && !deleted && !error && (!near || !composer)) return null;
  // The newest few stay on the chart, so a full board never pushes its ideas out of sight; the rest are a
  // click away on the Board, filtered to this place.
  const max = far ? 4 : near ? 4 : 3;
  const shown = list.slice(0, max);
  const more = list.length - shown.length;
  return (
    <section className={`note-board nbd-${level}`} aria-label={`Board items in ${place}`} data-note-board={scope} data-count={list.length}>
      {list.length ? (
        far ? (
          <ul className="nbd-chips">
            {shown.map((n) => <li key={n.id}><BoardChip n={n} onOpen={() => revealOnMap({ kind: "item", id: n.id, zoom: "mid" })} /></li>)}
            {more > 0 ? <li><a className="board-chip more" href={href(`board?place=${encodeURIComponent(scope)}`)} aria-label={`${more} more in ${place}, on the Board`}>+{more}</a></li> : null}
          </ul>
        ) : (
          <ul className="nbd-cards">
            {shown.map((n) => <li key={n.id}><NoteCard n={n} compact={!near} onDeleted={(x) => setDeleted(x)} /></li>)}
          </ul>
        )
      ) : null}
      {!far && more > 0 ? <a className="btn link nbd-more" href={href(`board?place=${encodeURIComponent(scope)}`)}>{more} more on the Board</a> : null}
      {deleted ? (
        <p className="nc-status" role="status" data-note-deleted={deleted.id}>
          Deleted “{noteLabel(deleted)}”.{" "}
          <button type="button" className="btn link" onClick={async () => { try { await restoreNote(deleted.id); } finally { setDeleted(null); } }}>Undo</button>
        </p>
      ) : null}
      {error ? <p className="inline-error" role="alert">Board items could not be loaded: {error}</p> : null}
      {near && composer ? <NoteComposer anchor={anchorOf(scope)} place={place} /> : null}
    </section>
  );
}

/** Kept for the idea page and other callers: one anchor's board. */
export function NoteBoard({ anchor, place, level }: { anchor: NoteAnchor; place: string; level: "mid" | "near" }) {
  return <MapBoard scope={anchorKey(anchor) || "global"} place={place} level={level} />;
}
