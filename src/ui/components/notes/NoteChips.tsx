// Note chips: one ✎ chip per note (its first bullet as the label), one ☑ chip per list (its name and
// progress). A chip opens the note in place (NoteCard): edit it, tick it, Tell Firstmate, or Delete with Undo.
import { useState } from "react";
import { itemKind, todoCount } from "../../../shared/board";
import { KIND_GLYPH, NoteCard, noteLabel } from "./NoteCard";
import { restoreNote, type Note } from "./notes";

export function NoteChips({ notes, max = 6, label }: { notes: Note[] | null | undefined; max?: number; label?: string }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [archived, setArchived] = useState<Note | null>(null);
  if (!notes?.length && !archived) return null;
  const list = notes ?? [];
  const shown = all ? list : list.slice(0, max);
  const open = list.find((n) => n.id === openId) ?? null;
  return (
    <div className="note-chips-wrap">
      <ul className="note-chips" aria-label={label ?? `${list.length} ${list.length === 1 ? "note" : "notes"}`}>
        {shown.map((n) => {
          const kind = itemKind(n.bullets);
          const todos = todoCount(n.bullets);
          return (
            <li key={n.id}>
              <button type="button" className={`note-chip${openId === n.id ? " on" : ""}`} data-note={n.id} aria-expanded={openId === n.id}
                title={n.bullets.join("\n")} onClick={() => setOpenId(openId === n.id ? null : n.id)}>
                <span className="nchip-glyph" aria-hidden>{KIND_GLYPH[kind]}</span>
                <span className="nchip-text">{noteLabel(n, 48)}</span>
                {todos.total ? <span className="nchip-count" aria-label={`${todos.done} of ${todos.total} done`}>{todos.done}/{todos.total}</span>
                  : n.bullets.length > 1 ? <span className="nchip-count" aria-label={`${n.bullets.length} bullets`}>{n.bullets.length}</span> : null}
              </button>
            </li>
          );
        })}
        {list.length > shown.length ? (
          <li><button type="button" className="note-chip more" onClick={() => setAll(true)}>+{list.length - shown.length} more</button></li>
        ) : null}
      </ul>
      {open ? <NoteCard key={open.id} n={open} where="chip" onDeleted={(n) => { setOpenId(null); setArchived(n); }} /> : null}
      {archived ? (
        <p className="nc-status" role="status">
          Deleted “{noteLabel(archived)}”.{" "}
          <button type="button" className="btn link" onClick={async () => { try { await restoreNote(archived.id); } finally { setArchived(null); } }}>Undo</button>
        </p>
      ) : null}
    </div>
  );
}
