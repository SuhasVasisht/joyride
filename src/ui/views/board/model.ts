// The Board page's filters and grouping, kept pure so they are unit-tested apart from React.
import { itemKind, itemText, todoCount, type ItemKind } from "../../../shared/board";
import { parseNoteScope } from "../../../shared/notes";

export type BoardNote = { id: string; title: string; scope: string; bullets: string[]; created: string; updated?: string; verified_at?: string | null };
/** When an item last changed: its last save, else when it was made. */
export const changedAt = (n: Pick<BoardNote, "created" | "updated" | "verified_at">) => n.updated ?? n.verified_at ?? n.created;
export type TypeFilter = "all" | ItemKind;
export type BoardFilter = { q: string; type: TypeFilter; place: string; open: boolean };
export type PlaceInfo = { label(scope: string): string; shownIn(scope: string): string };

export const TYPE_FILTERS: { id: TypeFilter; label: string }[] = [
  { id: "all", label: "Everything" }, { id: "note", label: "Notes" }, { id: "list", label: "Lists" }, { id: "link", label: "Links" }, { id: "mixed", label: "Mixed" },
];

/** Items with a todo still to tick. */
export const hasOpenTodo = (n: Pick<BoardNote, "bullets">) => { const t = todoCount(n.bullets); return t.done < t.total; };

/** The scope an item is filed under on the board: its place, with a deleted group's items in Unfiled. */
const placeOf = (n: BoardNote, places: PlaceInfo) => places.shownIn(n.scope);

/** Items that match the search (every word, in any line or link title), the type, the place and "open todos". */
export function filterBoard<T extends BoardNote>(notes: T[], f: BoardFilter, places: PlaceInfo): T[] {
  const words = f.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return notes.filter((n) => {
    if (f.type !== "all" && itemKind(n.bullets) !== f.type) return false;
    if (f.open && !hasOpenTodo(n)) return false;
    if (f.place && f.place !== "all") {
      const at = placeOf(n, places);
      if (f.place === "other" ? !/^(task|session):/.test(at) : at !== f.place) return false;
    }
    if (!words.length) return true;
    const text = `${itemText(n)} ${places.label(placeOf(n, places)).toLowerCase()}`;
    return words.every((w) => text.includes(w));
  });
}

export type BoardSection<T extends BoardNote = BoardNote> = { scope: string; title: string; kind: "unfiled" | "group" | "idea" | "other"; items: T[] };
const RANK = { unfiled: 0, group: 1, idea: 2, other: 3 } as const;

/** Items by place: Unfiled first, then groups, ideas, and tasks and agents; newest item first in each. */
export function groupBoard<T extends BoardNote>(notes: T[], places: PlaceInfo): BoardSection<T>[] {
  const by = new Map<string, BoardSection<T>>();
  for (const n of notes) {
    const scope = placeOf(n, places);
    const a = parseNoteScope(scope);
    const kind = !a || a.kind === "global" ? "unfiled" : a.kind === "group" ? "group" : a.kind === "mission" ? "idea" : "other";
    if (!by.has(scope)) by.set(scope, { scope, title: places.label(scope), kind, items: [] });
    by.get(scope)!.items.push(n);
  }
  const newest = (s: BoardSection<T>) => s.items.reduce((m, n) => (changedAt(n) > m ? changedAt(n) : m), "");
  for (const s of by.values()) s.items.sort((x, y) => changedAt(y).localeCompare(changedAt(x)) || x.id.localeCompare(y.id));
  return [...by.values()].sort((x, y) => RANK[x.kind] - RANK[y.kind] || newest(y).localeCompare(newest(x)) || x.title.localeCompare(y.title));
}

/** Counts for the filters: by type, and how many have open todos. */
export function boardCounts(notes: BoardNote[]) {
  const types: Record<TypeFilter, number> = { all: notes.length, note: 0, list: 0, link: 0, mixed: 0 };
  let open = 0;
  for (const n of notes) { types[itemKind(n.bullets)]++; if (hasOpenTodo(n)) open++; }
  return { types, open };
}
