// Where board items can live, by the names the captain sees: Unfiled (the hub), the authored groups, and
// the open ideas. Read once and shared by every card's Move to, the Board page's filters and labels.
import { useMemo } from "react";
import { useApi } from "../../lib/api";
import type { Lens, Mission } from "../../lib/types";
import { parseNoteScope } from "../../../shared/notes";
import type { NoteAnchor } from "./notes";

export type PlaceOption = { anchor: NoteAnchor; scope: string; title: string; kind: "unfiled" | "group" | "idea" };
export type Places = {
  groups: { id: string; title: string }[];
  ideas: { id: string; title: string }[];
  /** Every place an item can move to: Unfiled, then groups, then ideas. */
  options: PlaceOption[];
  /** A scope in words: "Unfiled", a group's or idea's title, "Task jr-12". */
  label(scope: string): string;
  /** The scope the map draws an item in: a deleted group's items show in Unfiled until the group comes back. */
  shownIn(scope: string): string;
  /** The groups have loaded: until then no group counts as deleted. */
  ready: boolean;
};

export function placesFrom(lenses: Pick<Lens, "id" | "title">[], missions: (Pick<Mission, "id" | "title" | "state"> & { archive?: boolean })[], ready = true): Places {
  const groups = lenses.map((l) => ({ id: l.id, title: l.title }));
  const ideas = missions.filter((m) => !m.archive && m.state !== "dropped" && m.state !== "done").map((m) => ({ id: m.id, title: m.title }));
  const groupTitle = new Map(groups.map((g) => [g.id, g.title]));
  const ideaTitle = new Map(missions.map((m) => [m.id, m.title]));
  const options: PlaceOption[] = [
    { anchor: { kind: "global" }, scope: "global", title: "Unfiled", kind: "unfiled" },
    ...groups.map((g): PlaceOption => ({ anchor: { kind: "group", id: g.id }, scope: `group:${g.id}`, title: g.title, kind: "group" })),
    ...ideas.map((i): PlaceOption => ({ anchor: { kind: "mission", id: i.id }, scope: `mission:${i.id}`, title: i.title, kind: "idea" })),
  ];
  return {
    groups, ideas, options, ready,
    label(scope) {
      const a = parseNoteScope(scope);
      if (!a || a.kind === "global") return "Unfiled";
      if (a.kind === "group") return groupTitle.get(a.id) ?? (ready ? "Unfiled" : a.id);
      if (a.kind === "mission") return ideaTitle.get(a.id) ?? a.id;
      return a.kind === "task" ? `Task ${a.id}` : "An agent";
    },
    shownIn(scope) {
      const a = parseNoteScope(scope);
      return ready && a?.kind === "group" && !groupTitle.has(a.id) ? "global" : scope;
    },
  };
}

export function usePlaces(): Places {
  const lenses = useApi<Lens[]>("/api/lenses", ["lenses"]);
  const missions = useApi<Mission[]>("/api/missions", ["missions"]);
  return useMemo(() => placesFrom(lenses.data ?? [], missions.data ?? [], Boolean(lenses.data)), [lenses.data, missions.data]);
}
