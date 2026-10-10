// "Show on map" from anywhere: the chart pans to where something landed (an idea, a group, a task's idea,
// the hub) and marks it for a moment. A request made from another page waits until the map mounts.
import type { Landing } from "../../../shared/new-plan";
import { go, parse } from "../../lib/router";
import { markPlaced } from "../../components/notes/arriving";

let pending: Landing | null = null;
const subs = new Set<() => void>();

export function revealOnMap(l: Landing) {
  if (l.kind === "item") markPlaced(l.id);
  pending = l;
  if (parse().name !== "map") go("map");
  subs.forEach((f) => f());
}
/** The landing waiting to be shown, once. */
export function takeReveal(): Landing | null { const l = pending; pending = null; return l; }
export function onReveal(f: () => void) { subs.add(f); return () => { subs.delete(f); }; }
