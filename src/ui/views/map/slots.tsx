// Mount points other phases fill without editing the map: notes chips (CP4b), "+ Add to this idea"
// (CP5a) and the nudge layer (CP6a), plus one in the task sheet (#/task/<id>). A feature registers a component for a slot from its
// own contribute.tsx (loaded at boot), and the map renders every component registered there.
//   registerMapSlot("task-notes", ({ task, level }) => <NotesChips scope={`task:${task}`} />)
import { Component, type ComponentType, type ReactNode } from "react";
import type { ZoomLevel } from "./layout";

export type SlotProps = {
  "hub-notes": { level: ZoomLevel };
  /** Beside an authored group's name: its "+" (add a note, list or link to the group). */
  "group-head": { group: string; title: string; level: ZoomLevel };
  /** Under an authored group's name, above its ideas: the group's board items. */
  "group-board": { group: string; title: string; level: ZoomLevel };
  "idea-composer": { mission: string; level: ZoomLevel };
  "idea-notes": { mission: string; level: ZoomLevel };
  "task-notes": { task: string; mission: string | null; level: ZoomLevel };
  "worker-notes": { worker: string; session: string | null; level: ZoomLevel };
  /** Nudge asks on an idea (kind "nudge"); CP6a renders Keep, Pause or Drop. */
  "idea-nudges": { mission: string; asks: import("../../../shared/asks").Ask[]; level: ZoomLevel };
  /** A layer over the whole chart, for toasts and pulses. */
  "map-overlay": { level?: ZoomLevel; focused?: boolean };
  /** Inside the task sheet, above its tabs. */
  "task-sheet": { task: string; mission: string | null };
};
export type SlotName = keyof SlotProps;

const slots = new Map<SlotName, ComponentType<any>[]>();
const listeners = new Set<() => void>();

export function registerMapSlot<N extends SlotName>(name: N, c: ComponentType<SlotProps[N]>): () => void {
  slots.set(name, [...(slots.get(name) ?? []), c]);
  listeners.forEach((l) => l());
  return () => { slots.set(name, (slots.get(name) ?? []).filter((x) => x !== c)); listeners.forEach((l) => l()); };
}
export const slotFilled = (name: SlotName) => (slots.get(name)?.length ?? 0) > 0;

/** A failing contribution never takes the chart down with it. */
class Guard extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? null : this.props.children; }
}

export function MapSlot<N extends SlotName>({ name, ...props }: { name: N } & SlotProps[N]) {
  const list = slots.get(name);
  if (!list?.length) return null;
  return <>{list.map((C, i) => <Guard key={i}><C {...props} /></Guard>)}</>;
}
