// One board item, opened: a note, a checklist, a link card or a mixed card (shared/board.ts), edited in place.
// Used on the map (the boards of Unfiled on the hub, each group and each idea), on the Board page and under
// a note chip.
//   note, link, mixed: click the text (or Edit) to edit every line; Enter saves, Shift+Enter starts a new
//     line, Esc cancels. A line can be a checkbox ("[ ] call Sam") or a link (an address, "[title](address)").
//     Checkboxes tick in place; links open (a Joyride artifact in Joyride, the rest in a new tab).
//   list: tick an item; click its text to rename it; × removes it; "Add an item" appends one.
// `compact` (the map at mid zoom) shows a few lines; ticks and links still work.
// On the map the grip (and Move to…) is picked up by the chart (data-drag); elsewhere Move to… opens here.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { TimeAgo } from "../primitives";
import { DragHandle } from "../../views/map/DragHandle";
import { LIST_TITLE, isListBullets, listItem, parseListItem } from "../../../shared/notes";
import { blockLine, itemKind, itemLabel, parseBlocks, todoCount, type Block, type ItemKind, type Link } from "../../../shared/board";
import { useApi } from "../../lib/api";
import { href as routeHref } from "../../lib/router";
import { archiveNote, cleanBullets, editNote, moveNote, tellFirstmate, type Note } from "./notes";
import { usePlaces, type PlaceOption } from "./places";
import { isArriving } from "./arriving";

/** What a note is called in one line: a list's name, a link's title, else its first line. */
export function noteLabel(n: Pick<Note, "bullets" | "title">, max = 60): string {
  return itemLabel(n, max);
}

export const KIND_GLYPH: Record<ItemKind, string> = { note: "✎", list: "☑", link: "↗", mixed: "✎" };
const LINK_GLYPH: Record<Link["type"], string> = { pdf: "PDF", artifact: "◈", url: "↗", file: "▤" };
const NOUN: Record<ItemKind, string> = { note: "note", list: "list", link: "link", mixed: "note" };

export type CardWhere = "map" | "board" | "chip";

export function NoteCard({ n, compact = false, onDeleted, where = "map", onMoved, extra }: {
  n: Note; compact?: boolean; onDeleted: (n: Note) => void;
  /** On the map the chart carries the card (grip, Move to); on the Board page and under a chip it moves itself. */
  where?: CardWhere;
  onMoved?: (n: Note, from: string) => void;
  /** More actions for the card's bar (the Board page's Show on map). */
  extra?: ReactNode;
}) {
  // The card's own copy of the lines, so a tick or an edit shows at once. Saves go one at a time, in order,
  // and only the newest one's answer (or a refresh while none is pending) replaces the copy: quick ticks and
  // renames never undo each other.
  const [bullets, setBullets] = useState(n.bullets);
  const seq = useRef(0);
  const pending = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => { if (!pending.current) setBullets(n.bullets); }, [n.bullets.join("\n")]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ bad: boolean; text: string } | null>(null);
  const [moving, setMoving] = useState(false);
  const kind = itemKind(bullets);
  const list = kind === "list" && isListBullets(bullets);

  function put(next: string[]): Promise<void> {
    const prev = bullets, mine = ++seq.current;
    setBullets(next); setMsg(null);
    pending.current++;
    const done = queue.current.then(() => editNote(n.id, next)).then(
      (r) => { if (mine === seq.current) setBullets(r.bullets); },
      (e: any) => { if (mine === seq.current) { setBullets(prev); setMsg({ bad: true, text: `That change was not saved: ${e.message}` }); } },
    ).finally(() => { pending.current--; });
    queue.current = done;
    return done;
  }
  async function tell() {
    setBusy("tell"); setMsg(null);
    const r = await tellFirstmate(n.id);
    setBusy(null);
    setMsg(r.status === "failed" ? { bad: true, text: `Firstmate wasn't told: ${r.error}` } : { bad: false, text: "Firstmate has it in its inbox." });
  }
  async function remove() {
    setBusy("delete"); setMsg(null);
    try { await archiveNote(n.id); onDeleted(n); }
    catch (e: any) { setMsg({ bad: true, text: `It was not deleted: ${e.message}` }); }
    finally { setBusy(null); }
  }
  async function moveTo(o: PlaceOption) {
    setMoving(false);
    if (o.scope === n.scope) return;
    setBusy("move"); setMsg(null);
    try { const r = await moveNote(n.id, o.anchor); onMoved?.(r, n.scope); }
    catch (e: any) { setMsg({ bad: true, text: `It was not moved: ${e.message}` }); }
    finally { setBusy(null); }
  }

  const items = list ? bullets.map(parseListItem) : [];
  const todos = todoCount(bullets);
  const label = itemLabel({ title: n.title, bullets });
  const blocks = parseBlocks(bullets);
  const soleLink = kind === "link" && blocks.length === 1 ? (blocks[0] as Extract<Block, { kind: "link" }>).link : null;
  const name = list ? (n.title && n.title !== LIST_TITLE ? n.title : "List") : kind === "link" ? (soleLink ? (soleLink.type === "pdf" ? "PDF" : soleLink.type === "artifact" ? "Artifact" : "Link") : n.title && n.title !== "Note" && blocks.length > 1 ? n.title : `${blocks.length} links`) : "Note";
  const onMap = where === "map";
  return (
    <article className={`note-card bk-${kind}${list ? " is-list" : ""}${compact ? " compact" : ""}`} data-note-card={n.id} data-board-item={n.id} data-kind={kind} data-arriving={isArriving(n.id) ? "" : undefined}
      data-drag={onMap ? `n:${n.id}` : undefined} data-drag-label={onMap ? label : undefined} data-drag-from={onMap ? n.scope : undefined}
      aria-label={`${kind === "list" ? "List" : kind === "link" ? "Link" : "Note"}: ${label}`}>
      <header className="nk-head">
        <span className="nk-glyph" aria-hidden>{KIND_GLYPH[kind]}</span>
        <span className="nk-name">{name}</span>
        {todos.total ? <span className="nk-progress" data-progress={`${todos.done}/${todos.total}`}>{todos.done} of {todos.total} done</span> : null}
        {!compact ? <span className="nk-when meta"><TimeAgo iso={n.updated ?? n.verified_at ?? n.created} /></span> : null}
        {onMap ? <DragHandle label={label} /> : null}
      </header>
      {list
        ? <ListBody items={items} compact={compact} onChange={(next) => put(next.map((i) => listItem(i.text, i.done)))} />
        : <LinesBody bullets={bullets} compact={compact} onSave={put} />}
      {!compact ? (
        <div className="nk-bar">
          {extra}
          <span className="nk-actions">
            {onMap
              ? <button type="button" className="btn small" data-drag-handle aria-haspopup="dialog" aria-label={`Move ${label} to…`} disabled={!!busy}>Move to…</button>
              : <button type="button" className="btn small" aria-haspopup="dialog" aria-expanded={moving} disabled={!!busy} onClick={() => setMoving((m) => !m)}>{busy === "move" ? "Moving…" : "Move to…"}</button>}
            <button type="button" className="btn small" disabled={!!busy} onClick={tell}>{busy === "tell" ? "Telling Firstmate…" : "Tell Firstmate"}</button>
            <button type="button" className="btn small ghost" disabled={!!busy} onClick={remove} aria-label={`Delete this ${NOUN[kind]}`}>{busy === "delete" ? "Deleting…" : "Delete"}</button>
          </span>
        </div>
      ) : null}
      {moving ? <PlacePicker current={n.scope} onPick={moveTo} onClose={() => setMoving(false)} /> : null}
      {msg ? <p className={`nc-status${msg.bad ? " bad" : ""}`} role="status">{msg.text}</p> : null}
    </article>
  );
}

/** Move to, off the chart: Unfiled, the groups and the ideas, with a find box when there are many. */
export function PlacePicker({ current, onPick, onClose }: { current: string; onPick: (o: PlaceOption) => void; onClose: () => void }) {
  const places = usePlaces();
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const needle = q.trim().toLowerCase();
  const opts = places.options.filter((o) => o.scope !== current && (!needle || o.title.toLowerCase().includes(needle)));
  useEffect(() => { ref.current?.querySelector<HTMLElement>(".pp-find, .pp-opt")?.focus(); }, []);
  useEffect(() => {
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [onClose]);
  const onKey = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const all = [...ref.current!.querySelectorAll<HTMLElement>(".pp-opt")];
      const i = all.indexOf(document.activeElement as HTMLElement);
      all[e.key === "ArrowDown" ? (i + 1) % all.length : i <= 0 ? all.length - 1 : i - 1]?.focus();
      e.preventDefault();
    }
    if (e.key === "Enter" && (e.target as HTMLElement).classList.contains("pp-find") && opts.length) { e.preventDefault(); onPick(opts[0]); }
  };
  const kindWord = { unfiled: "", group: "Group", idea: "Idea" };
  return (
    <div ref={ref} className="place-picker" role="dialog" aria-label="Move to" onKeyDown={onKey} data-testid="place-picker">
      {places.options.length > 7 ? <input className="pp-find input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a group or idea" aria-label="Find a group or idea" /> : null}
      <ul className="pp-list">
        {opts.map((o) => (
          <li key={o.scope}>
            <button type="button" className="pp-opt" onClick={() => onPick(o)}>
              <span className="pp-title">{o.title}</span>
              {kindWord[o.kind] ? <span className="pp-kind">{kindWord[o.kind]}</span> : null}
            </button>
          </li>
        ))}
        {!opts.length ? <li className="meta pp-empty">Nothing else matches.</li> : null}
      </ul>
    </div>
  );
}

/** A link's sign: its kind at a glance (PDF, artifact, web page, file). */
export function LinkGlyph({ link }: { link: Link }) {
  return <span className={`lk-glyph lk-${link.type}`} aria-hidden>{LINK_GLYPH[link.type]}</span>;
}

/** A Joyride artifact's registered title, once known. */
function useArtifactTitle(id: string | undefined) {
  const { data } = useApi<{ title?: string }>(id ? `/api/artifacts/${encodeURIComponent(id)}` : null);
  return data?.title ?? null;
}

const TYPE_WORD: Record<Link["type"], string> = { pdf: "PDF", artifact: "Artifact", url: "Page", file: "File" };

/** One link as a row: its sign, a readable title, where it lives; it opens on click. A local path copies. */
export function LinkRow({ link, note, compact }: { link: Link; note?: string; compact?: boolean }) {
  const registered = useArtifactTitle(link.derived ? link.artifact : undefined);
  const title = registered ?? link.title;
  const [copied, setCopied] = useState(false);
  const local = !/^(https?:|#\/)/i.test(link.href);
  const target = link.artifact ? routeHref(`artifacts/${encodeURIComponent(link.artifact)}`) : link.href;
  const body = (
    <>
      <LinkGlyph link={link} />
      <span className="lk-text">
        <span className="lk-title">{title}</span>
        {!compact || !link.derived ? <span className="lk-where">{TYPE_WORD[link.type]}{link.where ? ` · ${link.where}` : ""}{note ? ` · ${note}` : ""}</span> : null}
      </span>
    </>
  );
  if (local) {
    return (
      <button type="button" className="lk-row is-local" data-link-type={link.type} title={`${link.href}\nClick to copy the path; browsers can't open local files from Joyride.`}
        onClick={async () => { try { await navigator.clipboard.writeText(link.href); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* clipboard blocked */ } }}>
        {body}<span className="lk-open meta">{copied ? "Copied" : "Copy path"}</span>
      </button>
    );
  }
  return (
    <a className="lk-row" data-link-type={link.type} href={target} title={link.href} draggable={false}
      {...(link.artifact ? {} : { target: "_blank", rel: "noopener noreferrer" })}>
      {body}<span className="lk-open" aria-hidden>{link.artifact ? "→" : "↗"}</span>
    </a>
  );
}

function noteText(text: string): ReactNode {
  const heading = /^#{1,6}\s+(.+?)(?:\s+#+)?$/.exec(text);
  return heading ? <strong className="nk-heading">{heading[1]}</strong> : text;
}

/** A note, link or mixed card's lines: text, ticks and links as they are; click the text to edit every line. */
function LinesBody({ bullets, compact, onSave }: { bullets: string[]; compact: boolean; onSave: (b: string[]) => Promise<void> }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (draft !== null) { const el = area.current; el?.focus(); el?.setSelectionRange(el.value.length, el.value.length); } }, [draft === null]);
  const blocks = parseBlocks(bullets);
  const max = compact ? 4 : Infinity;
  const shown = blocks.slice(0, max);
  const edit = () => setDraft(bullets.join("\n"));
  const tick = (i: number) => {
    const b = blocks[i];
    if (b.kind !== "todo") return;
    void onSave(bullets.map((l, k) => (k === i ? blockLine({ ...b, done: !b.done }) : l)));
  };
  if (draft === null) {
    const onlyText = blocks.every((b) => b.kind === "text");
    const rows = shown.map((b, i) => (
      b.kind === "link" ? <li key={i} className="nk-link"><LinkRow link={b.link} note={b.note} compact={compact} /></li>
        : b.kind === "todo" ? (
          <li key={i} className={`nk-todo${b.done ? " done" : ""}`}>
            <input type="checkbox" className="nk-check" checked={b.done} aria-label={b.text} onChange={() => tick(i)} />
            <span className="nk-item-text">{b.text}</span>
          </li>
        ) : <li key={i} className="nk-line">{noteText(b.text)}</li>
    ));
    const body = onlyText && bullets.length === 1 ? <p className="nk-text">{noteText(bullets[0])}</p>
      : <ul className={`nk-blocks${onlyText ? " is-bullets" : ""}`}>{rows}</ul>;
    // Plain text edits on a click anywhere; a card with ticks or links edits from its text lines or Edit,
    // so a tick or a link never opens the editor.
    return (
      <>
        {compact ? body : onlyText ? (
          <div className="nk-edit-target" role="button" tabIndex={0} aria-label="Edit this note" title="Click to edit"
            onClick={edit} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); edit(); } }}>
            {body}
          </div>
        ) : (
          <div className="nk-edit-target is-mixed" onClick={(e) => { if ((e.target as HTMLElement).closest(".nk-line, .nk-todo .nk-item-text")) edit(); }}>
            {body}
            <button type="button" className="nk-edit btn link small" onClick={edit} aria-label="Edit this card's lines">Edit</button>
          </div>
        )}
        {blocks.length > shown.length ? <p className="nk-more meta">and {blocks.length - shown.length} more</p> : null}
      </>
    );
  }
  const plain = blocks.every((b) => b.kind === "text");
  async function save() {
    const next = cleanBullets([draft ?? ""]);
    if (!next.length) { setErr("A card needs at least one line. To get rid of it, delete it."); return; }
    setErr(null);
    await onSave(next);
    setDraft(null);
  }
  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); save(); }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setDraft(null); setErr(null); }
  }
  return (
    <div className="nk-editor">
      <textarea ref={area} className="nk-textarea" value={draft} rows={Math.min(8, Math.max(2, draft.split("\n").length))} aria-label={plain ? "Note text, one line per bullet" : "Card lines: text, [ ] for a checkbox, or an address for a link"}
        onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} />
      <div className="nk-editbar">
        <span className="nc-hint">One line each: text, [ ] for a todo, or a link · Enter saves · Shift+Enter adds a line · Esc cancels</span>
        <span className="nk-actions">
          <button type="button" className="btn small ghost" onClick={() => { setDraft(null); setErr(null); }}>Cancel</button>
          <button type="button" className="btn small primary" onClick={save}>Save</button>
        </span>
      </div>
      {err ? <p className="inline-error" role="alert">{err}</p> : null}
    </div>
  );
}

type Item = { done: boolean; text: string };

function ListBody({ items, compact, onChange }: { items: Item[]; compact: boolean; onChange: (next: Item[]) => void }) {
  const [editing, setEditing] = useState<number | null>(null);
  const [adding, setAdding] = useState("");
  const shown = compact ? items.slice(0, 5) : items;
  const set = (i: number, patch: Partial<Item>) => onChange(items.map((it, k) => (k === i ? { ...it, ...patch } : it)));
  function add() {
    const t = adding.replace(/\s+/g, " ").trim();
    if (!t) return;
    onChange([...items, { done: false, text: t }]);
    setAdding("");
  }
  return (
    <>
      <ul className="nk-items">
        {shown.map((it, i) => (
          <li key={i} className={it.done ? "done" : undefined}>
            <input type="checkbox" className="nk-check" checked={it.done} aria-label={it.text} onChange={() => set(i, { done: !it.done })} />
            {editing === i ? (
              <ItemEditor text={it.text} onDone={(t) => { setEditing(null); if (t && t !== it.text) set(i, { text: t }); }} />
            ) : compact ? (
              <span className="nk-item-text">{it.text}</span>
            ) : (
              <button type="button" className="nk-item-text" title="Click to rename" aria-label={`Rename “${it.text}”`} onClick={() => setEditing(i)}>{it.text}</button>
            )}
            {!compact ? (
              <button type="button" className="nk-remove" aria-label={`Remove “${it.text}”`} disabled={items.length < 2}
                title={items.length < 2 ? "A list keeps at least one item. Delete the list instead." : "Remove"} onClick={() => onChange(items.filter((_, k) => k !== i))}>×</button>
            ) : null}
          </li>
        ))}
      </ul>
      {compact && items.length > shown.length ? <p className="nk-more meta">and {items.length - shown.length} more</p> : null}
      {!compact ? (
        <input className="nk-add" value={adding} placeholder="Add an item…" aria-label="Add an item"
          onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } if (e.key === "Escape") { e.stopPropagation(); setAdding(""); } }} />
      ) : null}
    </>
  );
}

function ItemEditor({ text, onDone }: { text: string; onDone: (t: string | null) => void }) {
  const [v, setV] = useState(text);
  const el = useRef<HTMLInputElement>(null);
  const closed = useRef(false);
  useEffect(() => { el.current?.focus(); el.current?.select(); }, []);
  const finish = (t: string | null) => { if (closed.current) return; closed.current = true; onDone(t); };
  return (
    <input ref={el} className="nk-item-input" value={v} aria-label="Item text" onChange={(e) => setV(e.target.value)}
      onBlur={() => finish(v.replace(/\s+/g, " ").trim() || null)}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); finish(v.replace(/\s+/g, " ").trim() || null); }
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(null); }
      }} />
  );
}

/** An item at far zoom: one line with its sign, its name and its ticks; it opens the item's place on click. */
export function BoardChip({ n, onOpen }: { n: Note; onOpen?: () => void }) {
  const kind = itemKind(n.bullets);
  const blocks = parseBlocks(n.bullets);
  const link = kind === "link" && blocks.length === 1 ? (blocks[0] as Extract<Block, { kind: "link" }>).link : null;
  const todos = todoCount(n.bullets);
  const label = itemLabel(n, 40);
  return (
    <button type="button" className={`board-chip bk-${kind}`} data-board-item={n.id} data-kind={kind} data-arriving={isArriving(n.id) ? "" : undefined} onClick={onOpen}
      title={n.bullets.join("\n")} aria-label={`${kind === "list" ? "List" : kind === "link" ? "Link" : "Note"}: ${label}${todos.total ? `, ${todos.done} of ${todos.total} done` : ""}`}>
      <span className="bc-glyph" aria-hidden>{link ? LINK_GLYPH[link.type] : KIND_GLYPH[kind]}</span>
      <span className="bc-text">{noteText(label)}</span>
      {todos.total ? <span className="bc-count">{todos.done}/{todos.total}</span> : null}
    </button>
  );
}
