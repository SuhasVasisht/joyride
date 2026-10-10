// Notes on the UI side: where a note hangs (an anchor), loading the notes on one, saving
// (optionally telling Firstmate), and the pure helpers the composer and timeline use.
// The daemon API is /api/notes (CONTRACTS.md); live updates come over the `notes` bus entity.
import { api, post, useApi } from "../../lib/api";
import { LIST_TITLE, isListBullets } from "../../../shared/notes";

export type NoteAnchor = { kind: "global" } | { kind: "group" | "mission" | "task" | "session"; id: string };
export type Note = {
  id: string; kind: "note"; title: string; body: string; scope: string; status: string;
  created: string; updated?: string; verified_at?: string | null; anchor: NoteAnchor; bullets: string[];
};
export type TellResult = { status: string; error: string | null; result?: { inbox_note?: string; outcome?: string; announced?: boolean | null } | null };

export const anchorScope = (a: NoteAnchor) => (a.kind === "global" ? "global" : `${a.kind}:${a.id}`);
export const anchorKey = (a: NoteAnchor | null) => (a ? anchorScope(a) : "");

/** The query that lists one anchor's notes. */
export function notesPath(a: NoteAnchor): string {
  const enc = encodeURIComponent;
  if (a.kind === "global") return "/api/notes?global=1";
  return `/api/notes?${a.kind === "mission" ? "idea" : a.kind}=${enc(a.id)}`;
}

/** Active notes on an anchor (newest first), refreshed whenever any note changes. */
export function useNotes(a: NoteAnchor | null) {
  return useApi<Note[]>(a ? notesPath(a) : null, ["notes"]);
}

/**
 * Every active note, newest first: the map's boards read this one list and pick their own, so a chart with
 * many groups and ideas makes one request, not one per place.
 */
export function useAllNotes() {
  return useApi<Note[]>("/api/notes?limit=2000", ["notes"]);
}

/** Bullets as the composer keeps them: trimmed, list markers dropped, empty lines gone. Mirrors shared/notes.ts toBullets. */
export function cleanBullets(lines: string[]): string[] {
  return lines.flatMap((l) => l.split(/\r?\n/))
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/**
 * Lines after pasting `text` into bullet `i` at the caret: a multi-line paste becomes one bullet per line.
 * Returns null for a single-line paste (the input handles it).
 */
export function pasteLines(lines: string[], i: number, before: string, after: string, text: string): { lines: string[]; focus: number } | null {
  const parts = text.split(/\r?\n/).filter((p, k, all) => p.trim() || (k > 0 && k < all.length - 1));
  if (parts.length < 2) return null;
  const strip = (p: string) => p.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "");
  const added = parts.map(strip);
  added[0] = before + added[0];
  added[added.length - 1] += after;
  const next = [...lines.slice(0, i), ...added, ...lines.slice(i + 1)];
  return { lines: next, focus: i + added.length - 1 };
}

export async function saveNote(anchor: NoteAnchor, bullets: string[], title?: string): Promise<Note> {
  return post<Note>("/api/notes", { bullets, scope: anchorScope(anchor), ...(title ? { title } : {}), provenance: { type: "human", ref: "map" } });
}
/** Move a note to another place; resolves to the note as it is now. */
export async function moveNote(id: string, to: NoteAnchor) { return api<Note>(`/api/notes/${encodeURIComponent(id)}`, { method: "PUT", json: { scope: anchorScope(to) } }); }

/** "Tell Firstmate": files a captain inbox note about the saved note (intent tell_note). */
export async function tellFirstmate(noteId: string): Promise<TellResult> {
  try { return await post<TellResult>(`/api/notes/${encodeURIComponent(noteId)}/tell`); }
  catch (e: any) { return { status: "failed", error: e.message }; }
}

export async function archiveNote(id: string) { return post<Note>(`/api/notes/${encodeURIComponent(id)}/archive`); }
export async function restoreNote(id: string) { return post<Note>(`/api/notes/${encodeURIComponent(id)}/restore`); }
export async function editNote(id: string, bullets: string[]) { return api<Note>(`/api/notes/${encodeURIComponent(id)}`, { method: "PUT", json: { bullets } }); }

/** What a timeline shows for a note: one entry when it was written. */
export type NoteTimelineEntry = { ts: string; kind: "note"; text: string; detail?: string; noteId: string };
export function noteTimelineEntries(notes: Note[] | null | undefined): NoteTimelineEntry[] {
  return (notes ?? []).map((n) => {
    if (isListBullets(n.bullets)) {
      const name = n.title && n.title !== LIST_TITLE ? `: “${n.title}”` : "";
      return { ts: n.created, kind: "note", noteId: n.id, text: `You made a list${name}`, detail: `${n.bullets.length} ${n.bullets.length === 1 ? "item" : "items"}` };
    }
    const first = n.bullets[0] ?? n.title;
    const more = n.bullets.length - 1;
    return { ts: n.created, kind: "note", noteId: n.id, text: `You noted: “${first.length > 120 ? first.slice(0, 119).trimEnd() + "…" : first}”`, ...(more > 0 ? { detail: `and ${more} more ${more === 1 ? "bullet" : "bullets"}` } : {}) };
  });
}
