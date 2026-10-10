// Drag-and-drop regrouping on the chart. What a drop means, kept apart from the pointer code:
//   a session dropped on a mission is assigned to that mission; dropped on a group it sits in the group
//   directly (leaving its mission); dropped on an Unfiled group it leaves its mission and any group;
//   a Firstmate task dropped on another mission moves there (it never goes back to Unfiled);
//   a mission dropped on a lens group joins that lens (and leaves the lens it came from), dropped on
//   "New group" starts a lens, and dropped on its own repo group leaves its lens.
// Repo and health groups are derived, so they never take a mission from elsewhere: the only
// authored groupings are a session's mission or lens and a mission's lens (missions/*.md, lenses/*.yaml).
// A board item (note, list, link) dropped on a group, an idea or the hub moves there (its note's scope);
// it never starts a group, and the hub is Unfiled.
import type { RegionIn } from "./layout";
import type { MapMission } from "./world";

export type DragItem =
  /** `from` is its idea; `lens` the group that names it directly; `region` the region it is charted in. */
  | { kind: "session"; key: string; label: string; from: string | null; lens?: string | null; region?: string }
  /** A Firstmate task card; `from` is the idea it sits in (null on the hub, before it is filed). */
  | { kind: "task"; id: string; label: string; from: string | null }
  /** `from` is the lens of the group it sits in; `explicit` when that lens names it (a rule match can't be left by a move). */
  | { kind: "mission"; id: string; label: string; from: string | null; home: string; explicit: boolean }
  /** A board item; `from` is its note's scope (global, group:<lens>, mission:<idea>). */
  | { kind: "note"; id: string; label: string; from: string };

export type DropTarget =
  | { kind: "mission"; id: string; title: string }
  | { kind: "unfiled" }
  | { kind: "lens"; id: string; title: string; region: string }
  | { kind: "home"; region: string; title: string }
  | { kind: "new-group" };

export const targetKey = (t: DropTarget | null) =>
  !t ? "" : t.kind === "mission" ? `mission:${t.id}` : t.kind === "lens" ? `region:${t.region}` : t.kind === "home" ? `region:${t.region}` : t.kind;

/** The region a mission is charted in when it is not in a lens: its first repo's group. */
export const homeRegion = (m: Pick<MapMission, "repos">) => `repo:${m.repos[0] || "none"}`;

/** The note scope a drop target means for a board item, or null when an item can't go there. */
export function noteScopeOf(t: DropTarget): string | null {
  return t.kind === "unfiled" ? "global" : t.kind === "lens" ? `group:${t.id}` : t.kind === "mission" ? `mission:${t.id}` : null;
}

/** What dropping `item` on region `r` would do, or null when the region doesn't take it. */
export function regionTarget(item: DragItem, r: Pick<RegionIn, "id" | "kind" | "title" | "lens">): DropTarget | null {
  if (item.kind === "note") {
    // The hub's board is Unfiled; a group's region takes it into the group's board.
    if (r.kind === "firstmate") return item.from === "global" ? null : { kind: "unfiled" };
    return r.lens && item.from !== `group:${r.lens}` ? { kind: "lens", id: r.lens, title: r.title, region: r.id } : null;
  }
  if (item.kind === "session") {
    if (r.kind === "unfiled") return item.from || item.lens ? { kind: "unfiled" } : null;
    if (!r.lens || (!item.from && item.region === r.id)) return null;
    return { kind: "lens", id: r.lens, title: r.title, region: r.id };
  }
  if (item.kind === "task") return null;
  if (r.lens) return r.lens === item.from ? null : { kind: "lens", id: r.lens, title: r.title, region: r.id };
  if (r.id === item.home && item.from && item.explicit) return { kind: "home", region: r.id, title: r.title };
  return null;
}

/**
 * Dropping a session or a task on a mission card assigns it; missions are not dropped on each other.
 * An archived idea takes no tasks (Firstmate would keep running them out of sight).
 */
export function missionTarget(item: DragItem, m: Pick<MapMission, "id" | "title"> & { archive?: boolean }): DropTarget | null {
  if (item.kind === "note") return !m.archive && item.from !== `mission:${m.id}` ? { kind: "mission", id: m.id, title: m.title } : null;
  if (item.kind === "task" && m.archive) return null;
  return (item.kind === "session" || item.kind === "task") && m.id !== item.from ? { kind: "mission", id: m.id, title: m.title } : null;
}

/** A row of the Move to menu: the target, and the group it sits in when that helps to tell ideas apart. */
export type MenuTarget = { target: DropTarget; where?: string };

/**
 * Every place the Move to menu offers for `item`, the keyboard path to the same moves a drag makes:
 * open ideas for a session or task; for a session also the groups, Unfiled (when it is filed) and New
 * group; other groups, the idea's repo group and New group for an idea.
 */
export function menuTargets(
  item: DragItem,
  missions: (Pick<MapMission, "id" | "title"> & { archive?: boolean })[],
  lenses: { id: string; title: string }[],
  where: (missionId: string) => string | undefined = () => undefined,
  homeTitle?: string,
): MenuTarget[] {
  if (item.kind === "note") {
    const out: MenuTarget[] = item.from === "global" ? [] : [{ target: { kind: "unfiled" } }];
    for (const l of lenses) if (item.from !== `group:${l.id}`) out.push({ target: { kind: "lens", id: l.id, title: l.title, region: `lens:${l.id}` }, where: "Group" });
    for (const m of missions) { const t = missionTarget(item, m); if (t) out.push({ target: t, where: where(m.id) ?? "Idea" }); }
    return out;
  }
  if (item.kind === "mission") {
    const out: MenuTarget[] = lenses.filter((l) => l.id !== item.from).map((l) => ({ target: { kind: "lens", id: l.id, title: l.title, region: `lens:${l.id}` } }));
    if (item.from && item.explicit && homeTitle) out.push({ target: { kind: "home", region: item.home, title: homeTitle } });
    out.push({ target: { kind: "new-group" } });
    return out;
  }
  const out: MenuTarget[] = missions.filter((m) => !m.archive).map((m) => missionTarget(item, m)).filter((t): t is DropTarget => !!t)
    .map((t) => ({ target: t, where: t.kind === "mission" ? where(t.id) : undefined }));
  if (item.kind === "session") {
    for (const l of lenses) if (item.from || item.lens !== l.id) out.push({ target: { kind: "lens", id: l.id, title: l.title, region: `lens:${l.id}` }, where: "Group" });
    if (item.from || item.lens) out.push({ target: { kind: "unfiled" } });
    out.push({ target: { kind: "new-group" } });
  }
  return out;
}

/** The request body for POST /api/missions/move. A new group needs its name first. */
export function moveBody(item: DragItem, t: DropTarget, newName?: string): Record<string, unknown> | null {
  if (item.kind === "note") return null; // a board item moves through PUT /api/notes/:id (noteScopeOf)
  if (item.kind === "session") {
    if (t.kind === "mission") return { session: item.key, to: { mission: t.id } };
    if (t.kind === "unfiled") return { session: item.key, to: { mission: null } };
    if (t.kind === "lens") return { session: item.key, to: { lens: t.id } };
    if (t.kind === "new-group") return newName?.trim() ? { session: item.key, to: { new_lens: newName.trim() } } : null;
    return null;
  }
  if (item.kind === "task") return t.kind === "mission" ? { task: item.id, to: { mission: t.id } } : null;
  if (t.kind === "lens") return { mission: item.id, from: item.from, to: { lens: t.id } };
  if (t.kind === "home") return { mission: item.id, from: item.from, to: { lens: null } };
  if (t.kind === "new-group") return newName?.trim() ? { mission: item.id, from: item.from, to: { new_lens: newName.trim() } } : null;
  return null;
}

/** The line shown while dragging: what each kind of drop will do. */
export function dragHint(item: DragItem): string {
  if (item.kind === "session") return item.from || item.lens
    ? "Drop on an idea or a group to move this session there, or on Unfiled to take it out."
    : "Drop on an idea or a group to file this session there, or on New group to start one.";
  if (item.kind === "task") return "Drop on another idea to move this task there. Firstmate keeps running it; only the grouping changes.";
  if (item.kind === "note") return "Drop on a group or an idea to pin it there, or on Unfiled to take it out.";
  return "Drop on a group to move this idea there, or on New group to start one. Repo groups follow the idea's repo.";
}

/** What a target will do, in the words of the drop zone's label. */
export function targetLabel(t: DropTarget): string {
  switch (t.kind) {
    case "mission": return `Move to ${t.title}`;
    case "unfiled": return "Move to Unfiled";
    case "lens": return `Move to ${t.title}`;
    case "home": return `Back to ${t.title}`;
    case "new-group": return "New group…";
  }
}

/** What the carried item calls itself on the ghost and in the Move to menu. */
export const kindLabel = (item: DragItem) => (item.kind === "session" ? "Session" : item.kind === "task" ? "Task" : item.kind === "note" ? "Board item" : "Idea");
