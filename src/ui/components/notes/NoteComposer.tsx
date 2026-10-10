// Quick-note composer: fast bullets saved against an idea, a task, an agent or nothing.
//   Enter saves. Shift+Enter starts the next bullet. ⌘Enter (Ctrl+Enter) saves and tells Firstmate.
//   Backspace on an empty bullet joins it to the one above; a multi-line paste becomes bullets.
// "Save" is passive: the note waits where agents read it (task context, Search, joyride notes).
// "Save and tell Firstmate" also files a captain inbox note that points at it.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { cleanBullets, pasteLines, saveNote, tellFirstmate, type Note, type NoteAnchor } from "./notes";

type Outcome = { kind: "saved" | "told" | "untold"; note: Note; error?: string };

export function NoteComposer({ anchor, place, collapsible = true, autoFocus = false, onSaved }: {
  anchor: NoteAnchor;
  /** Where the note goes, in words: "this idea", "this agent". */
  place: string;
  /** Start as an "Add note" button that opens the field (strips); false keeps the field open (panels). */
  collapsible?: boolean;
  autoFocus?: boolean;
  onSaved?: (n: Note) => void;
}) {
  const [open, setOpen] = useState(!collapsible);
  const [lines, setLines] = useState<string[]>([""]);
  const [busy, setBusy] = useState<"save" | "tell" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const focusTo = useRef<{ i: number; at?: number } | null>(autoFocus || collapsible ? { i: 0 } : null);

  useEffect(() => {
    const f = focusTo.current;
    if (!f || !open) return;
    focusTo.current = null;
    const el = refs.current[f.i];
    if (!el) return;
    el.focus();
    const at = f.at ?? el.value.length;
    el.setSelectionRange(at, at);
  });
  useEffect(() => { if (!outcome || outcome.kind === "untold") return; const t = setTimeout(() => setOutcome(null), 6000); return () => clearTimeout(t); }, [outcome]);

  const bullets = cleanBullets(lines);
  const set = (i: number, v: string) => setLines((ls) => ls.map((l, k) => (k === i ? v : l)));

  async function submit(tell: boolean) {
    if (!bullets.length || busy) return;
    setBusy(tell ? "tell" : "save"); setError(null); setOutcome(null);
    let note: Note;
    try { note = await saveNote(anchor, bullets); }
    catch (e: any) { setBusy(null); setError(`The note was not saved: ${e.message}`); return; }
    setLines([""]);
    focusTo.current = { i: 0 };
    onSaved?.(note);
    if (!tell) { setBusy(null); setOutcome({ kind: "saved", note }); return; }
    const r = await tellFirstmate(note.id);
    setBusy(null);
    setOutcome(r.status === "failed" ? { kind: "untold", note, error: r.error ?? "unknown error" } : { kind: "told", note });
  }

  async function retryTell(note: Note) {
    setBusy("tell");
    const r = await tellFirstmate(note.id);
    setBusy(null);
    setOutcome(r.status === "failed" ? { kind: "untold", note, error: r.error ?? "unknown error" } : { kind: "told", note });
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>, i: number) {
    const el = e.currentTarget;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(true); return; }
    if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
      const at = el.selectionStart ?? el.value.length;
      setLines((ls) => [...ls.slice(0, i), el.value.slice(0, at), el.value.slice(at), ...ls.slice(i + 1)]);
      focusTo.current = { i: i + 1, at: 0 };
      return;
    }
    if (e.key === "Enter") { e.preventDefault(); submit(false); return; }
    if (e.key === "Backspace" && i > 0 && el.selectionStart === 0 && el.selectionEnd === 0) {
      e.preventDefault();
      const prev = lines[i - 1];
      setLines((ls) => [...ls.slice(0, i - 1), prev + ls[i], ...ls.slice(i + 1)]);
      focusTo.current = { i: i - 1, at: prev.length };
      return;
    }
    if (e.key === "ArrowUp" && i > 0) { e.preventDefault(); focusTo.current = { i: i - 1 }; setLines((ls) => [...ls]); return; }
    if (e.key === "ArrowDown" && i < lines.length - 1) { e.preventDefault(); focusTo.current = { i: i + 1 }; setLines((ls) => [...ls]); return; }
    if (e.key === "Escape" && collapsible) {
      e.preventDefault();
      e.stopPropagation(); // keep the sheet open; Esc only folds the composer
      if (!bullets.length) setOpen(false);
      else { setLines([""]); focusTo.current = { i: 0 }; }
    }
  }

  const status = outcome ? (
    <p className={`nc-status${outcome.kind === "untold" ? " bad" : ""}`} role="status" data-note-outcome={outcome.kind}>
      {outcome.kind === "saved" ? <>Saved on {place}. Agents working here read it.</> : null}
      {outcome.kind === "told" ? <>Saved, and Firstmate has it in its inbox.</> : null}
      {outcome.kind === "untold" ? (
        <>Saved, but Firstmate wasn't told: {outcome.error} <button type="button" className="btn link" disabled={!!busy} onClick={() => retryTell(outcome.note)}>Tell Firstmate again</button></>
      ) : null}
    </p>
  ) : null;

  if (!open) {
    return (
      <div className="note-composer closed">
        <button type="button" className="btn small nc-open" onClick={() => { setOpen(true); focusTo.current = { i: 0 }; }} aria-label={`Add a note on ${place}`}>
          <span aria-hidden>✎</span> Add note
        </button>
        {status}
      </div>
    );
  }
  return (
    <form className="note-composer" aria-label={`New note on ${place}`} onSubmit={(e) => { e.preventDefault(); submit(false); }}>
      <ul className="nc-lines">
        {lines.map((l, i) => (
          <li key={i}>
            <span className="nc-dot" aria-hidden>•</span>
            <input
              ref={(el) => { refs.current[i] = el; }}
              className="nc-input"
              value={l}
              disabled={!!busy}
              aria-label={lines.length > 1 ? `Bullet ${i + 1}` : "Note"}
              placeholder={i === 0 ? `Note on ${place}…` : "Next bullet…"}
              onChange={(e) => set(i, e.target.value)}
              onKeyDown={(e) => onKey(e, i)}
              onPaste={(e) => {
                const el = e.currentTarget;
                const r = pasteLines(lines, i, el.value.slice(0, el.selectionStart ?? 0), el.value.slice(el.selectionEnd ?? el.value.length), e.clipboardData.getData("text"));
                if (!r) return;
                e.preventDefault();
                setLines(r.lines);
                focusTo.current = { i: r.focus };
              }}
            />
          </li>
        ))}
      </ul>
      <div className="nc-bar">
        <span className="nc-hint">Enter saves · Shift+Enter adds a bullet · ⌘Enter also tells Firstmate</span>
        <span className="nc-actions">
          {collapsible ? <button type="button" className="btn small ghost" onClick={() => { setOpen(false); setLines([""]); setError(null); }}>Cancel</button> : null}
          <button type="button" className="btn small" disabled={!bullets.length || !!busy} onClick={() => submit(true)}>
            {busy === "tell" ? "Telling Firstmate…" : "Save and tell Firstmate"}
          </button>
          <button type="submit" className="btn small primary" disabled={!bullets.length || !!busy}>{busy === "save" ? "Saving…" : "Save"}</button>
        </span>
      </div>
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
      {status}
    </form>
  );
}
