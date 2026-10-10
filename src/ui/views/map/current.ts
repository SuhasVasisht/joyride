// The group the captain is working in on the map: the one under the pointer or holding the focused card.
// New saves a note, list or link there when the words don't name a place. Sticky: crossing open water keeps
// the last group; pointing at a place that isn't a group (the hub, a repo or Unfiled group) clears it.
import { useSyncExternalStore } from "react";

export type CurrentGroup = { id: string; title: string } | null;

let current: CurrentGroup = null;
const subs = new Set<() => void>();

export function setCurrentGroup(g: CurrentGroup) {
  if (current?.id === g?.id && current?.title === g?.title) return;
  current = g;
  subs.forEach((f) => f());
}
export const currentGroup = (): CurrentGroup => current;
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
export const useCurrentGroup = () => useSyncExternalStore(subscribe, currentGroup);
