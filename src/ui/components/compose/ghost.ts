// The ghost card's model (control plane CP5): one captain request from the New box (views/new) to the task it becomes.
//   placing → placed (counts down AUTO_SEND_MS, then sends) | choose (Jev unsure: the captain picks)
//   → sending → sent (Firstmate's receipts: Sent · Read · Became task) | steered (more work for a task) | failed
// A note or a list (shared/compose.ts) never reaches Firstmate: placed → saving → saved, on the idea it was
// typed into, else the current group, else Unfiled; once saved it is a landing flight into its card
// (LandingGhost). Text that only mentions notes or lists is placed with Jev's kind question too.
// A shared store keeps every ghost alive across pages; sent ghosts survive a reload so they keep tracking.
import { useSyncExternalStore } from "react";
import { addInFlightCheck } from "../../lib/build";
import { readCompose, recast, type ComposeKind } from "../../../shared/compose";
import { LIST_TITLE, listItem } from "../../../shared/notes";
import type { NoteAnchor } from "../notes/notes";
import type { Place } from "../../../shared/new-plan";

export const AUTO_SEND_MS = 2500;
/** A ghost that became a task stays this long, morphed into the task card, then leaves. */
export const SETTLED_MS = 12_000;

export type Target =
  | { kind: "task"; id: string; title: string; idea: string | null; p: number }
  | { kind: "idea"; id: string; title: string; p: number }
  | { kind: "new"; title: string | null; p: number };
export type Placement = {
  choice: Target | null; auto: boolean; options: Target[]; via: string; error?: string;
  /** Asked only for unsure text: Jev's task, note or list. */
  kind?: { choice: ComposeKind; p: number; auto: boolean };
};
export type Progress = {
  stage: "sent" | "read" | "replied" | "task" | "unknown";
  note: { id: string; at: string | null; acknowledged: boolean } | null;
  reply: { at: string | null; body: string } | null;
  task: { id: string; title: string; mission: string | null; status: string } | null;
  unread_too_long: boolean;
  firstmate_running: boolean;
};
export type Phase = "placing" | "placed" | "choose" | "sending" | "sent" | "steered" | "saving" | "saved" | "failed";
export type Rect = { x: number; y: number; w: number; h: number };
export type Ghost = {
  id: string;
  text: string;
  draftKey?: string;
  /** Opened from an idea's "+ Add to this idea": placed there for certain. */
  idea?: string;
  ideaTitle?: string;
  /** What it becomes: a task request for Firstmate (the default), or a note or a list saved on the map. */
  as?: ComposeKind;
  /** The words alone didn't settle task, note or list: placing also asks Jev. */
  unsure?: boolean;
  /** A note's bullets or a list's items, and a list's name. */
  lines?: string[];
  title?: string | null;
  /** The saved note's id. */
  saved?: string;
  created: number;
  phase: Phase;
  placement?: Placement;
  target?: Target;
  /** The create_task or steer_task intent id (the request marker). */
  intent?: string;
  mission?: { id: string; title: string };
  progress?: Progress;
  error?: string;
  /** Confirmed in the New box's preview: a note or list saves at once instead of counting down. */
  confirmed?: boolean;
  /** Where the ghost flew from (the composer's text box), for the first FLIP. */
  from?: Rect;
  /**
   * A board item New already saved: the ghost is only its flight, from the box into the item's card on the
   * chart (or a quiet fade off the chart), and then it goes. Never kept across a reload.
   */
  landing?: { place: Place; label: string; bullets: string[] };
  settledAt?: number;
};

export const targetKey = (t: Target) => (t.kind === "new" ? "new" : `${t.kind}:${t.id}`);

/** What the card says about where the request goes. */
export function targetLabel(t: Target, mission?: { title: string }): { verb: string; name: string } {
  if (t.kind === "task") return { verb: "More work for", name: t.title };
  if (t.kind === "idea") return { verb: "Adding to", name: t.title };
  return { verb: "Starting a new idea", name: mission?.title ?? t.title ?? "" };
}

/** The intent a target sends: a steer into a task in flight, or a task request into an idea (or a new one). */
export function intentFor(t: Target, text: string): { kind: string; target: string; payload: Record<string, unknown> } {
  if (t.kind === "task") return { kind: "steer_task", target: t.id, payload: { text } };
  return { kind: "create_task", target: t.kind === "new" ? "new" : t.id, payload: { brief: text, ...(t.kind === "new" && t.title ? { title: t.title } : {}) } };
}

export type Step = { id: "sent" | "read" | "task"; label: string; state: "done" | "current" | "todo" };
/** Sent · Read · Became task, from Firstmate's receipts. A reply counts as read. */
export function steps(p: Progress | undefined): Step[] {
  const rank = { unknown: 0, sent: 1, read: 2, replied: 2, task: 3 }[p?.stage ?? "unknown"];
  const mk = (id: Step["id"], n: number, label: string): Step => ({ id, label, state: rank >= n ? "done" : rank === n - 1 ? "current" : "todo" });
  return [mk("sent", 1, "Sent"), mk("read", 2, p?.stage === "replied" ? "Replied" : "Read"), mk("task", 3, p?.task ? `Task ${p.task.id}` : "Became task")];
}

/** A ghost for what the captain typed: a sure note or list waits to be saved, anything else is placed first. */
export function ghostFrom(text: string, base: Pick<Ghost, "id" | "created" | "draftKey" | "idea" | "ideaTitle" | "from">): Ghost {
  const r = readCompose(text);
  const g: Ghost = { ...base, text, phase: "placing", as: r.kind };
  if (r.kind === "task") return r.sure ? g : { ...g, unsure: true };
  return { ...g, phase: "placed", lines: r.lines, title: r.title };
}

/** The same ghost as another kind ("Change" on the card). */
export function recastGhost(g: Ghost, kind: ComposeKind): Partial<Ghost> {
  const r = recast(g.text, kind);
  return { as: kind, unsure: false, lines: r.lines, title: r.title };
}

/** Where a note or list goes: the idea it was typed into, else the current group on the map, else Unfiled (the hub). */
export function notePlace(g: Pick<Ghost, "idea" | "ideaTitle">, current: { id: string; title: string } | null = null): { anchor: NoteAnchor; name: string; place: Place } {
  if (g.idea) return { anchor: { kind: "mission", id: g.idea }, name: g.ideaTitle ?? g.idea, place: { kind: "idea", id: g.idea, title: g.ideaTitle ?? g.idea } };
  if (current) return { anchor: { kind: "group", id: current.id }, name: current.title, place: { kind: "group", ...current } };
  return { anchor: { kind: "global" }, name: "Unfiled", place: { kind: "unfiled" } };
}

/** What a note or list saves: bullets, and a list's checkbox items under its name. */
export function noteInput(g: Pick<Ghost, "as" | "lines" | "title">): { bullets: string[]; title?: string } {
  const lines = (g.lines ?? []).filter((l) => l.trim());
  if (g.as !== "list") return { bullets: lines };
  return { bullets: lines.map((l) => listItem(l)), title: g.title?.trim() || LIST_TITLE };
}

/** Percent as the card shows it. */
export const pct = (p: number) => `${Math.round(p * 100)}%`;

// ---------- store ----------

const KEY = "joyride:compose:ghosts";
let ghosts: Ghost[] = load();
const subs = new Set<() => void>();

function load(): Ghost[] {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
    const list: Ghost[] = raw ? JSON.parse(raw) : [];
    return list.filter((g) => g.phase === "sent" && Date.now() - g.created < 7 * 864e5).map((g) => ({ ...g, from: undefined }));
  } catch { return []; }
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(ghosts.filter((g) => g.phase === "sent"))); } catch { /* storage unavailable */ }
}
function emit() { save(); subs.forEach((f) => f()); }

export const ghostStore = {
  list: () => ghosts,
  add(g: Ghost) { ghosts = [...ghosts, g]; emit(); },
  update(id: string, patch: Partial<Ghost>) { ghosts = ghosts.map((g) => (g.id === id ? { ...g, ...patch } : g)); emit(); },
  remove(id: string) { ghosts = ghosts.filter((g) => g.id !== id); emit(); },
  subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
};
// Only sent ghosts survive a reload; the rest would be lost, so they hold off an automatic one.
addInFlightCheck("ghosts", () => ghosts.some((g) => g.phase !== "sent" && g.phase !== "steered" && g.phase !== "saved"));
export const useGhosts = () => useSyncExternalStore(ghostStore.subscribe, ghostStore.list);

// ---------- hook-up points for other surfaces ----------

/** What New is opened on: an idea ("+ Add to this idea"), or a board (a group's or the hub's "+"); `text` fills the box. */
export type OpenRequest = { idea?: string; text?: string; board?: { kind: "group"; id: string; title: string } | { kind: "unfiled" } };
let pendingOpen: OpenRequest | null = null;
/**
 * Open the New box (top of the rail) from anywhere: `openComposer()` for the whole map, `openComposer({ idea })`
 * for "+ Add to this idea", `openComposer({ board })` for a group's or the hub's "+". The rail opens first when
 * it is closed; the box takes the request when it mounts.
 */
export function openComposer(opts: OpenRequest = {}) {
  pendingOpen = opts;
  window.dispatchEvent(new CustomEvent("joyride:open-rail"));
  window.dispatchEvent(new CustomEvent("joyride:compose", { detail: opts }));
}
/** The open request waiting for the New box, once. */
export function takeOpenRequest(): OpenRequest | null { const o = pendingOpen; pendingOpen = null; return o; }

/** `t` is undefined for a note or list, which the resolver places from the ghost itself. */
type TargetResolver = (t: Target | undefined, g: Ghost) => DOMRect | null;
const resolvers = new Set<TargetResolver>();
/**
 * The map registers where a target sits on screen (an idea island, a task card), so the ghost flies there
 * instead of settling in the tray. Returns an unregister function.
 */
export function registerGhostTarget(fn: TargetResolver) { resolvers.add(fn); subs.forEach((f) => f()); return () => { resolvers.delete(fn); subs.forEach((f) => f()); }; }
export function targetRect(t: Target | undefined, g: Ghost): DOMRect | null {
  if (!t && (g.as ?? "task") === "task") return null;
  for (const f of resolvers) { try { const r = f(t, g); if (r) return r; } catch { /* a resolver that throws is skipped */ } }
  return null;
}
