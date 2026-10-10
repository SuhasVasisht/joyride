import type { KnowledgeAnchor, KnowledgeItem, KnowledgeType } from "./knowledge.ts";

export type Filters = { types: KnowledgeType[]; idea: string; task: string; session: string; project?: string };
const anchored = (item: KnowledgeItem, kind: KnowledgeAnchor["kind"], id: string) =>
  !id || item.anchors.some((a) => a.kind === kind && a.id === id) || item.delivery.includes(`${kind}:${id}`);
const projectOf = (repo: string) => repo.split("/").filter(Boolean).pop() ?? repo;
const inProject = (item: KnowledgeItem, project: string | undefined) =>
  !project || item.anchors.some((a) => a.kind === "repo" && projectOf(a.id) === project);
/** Anchor filters (idea, task, session, project) apply to every item; the type filter is separate so its counts stay honest. */
export const matchesAnchors = (item: KnowledgeItem, f: Filters) =>
  anchored(item, "idea", f.idea) && anchored(item, "task", f.task) && anchored(item, "session", f.session) && inProject(item, f.project);
export function applyFilters(items: KnowledgeItem[], f: Filters): KnowledgeItem[] {
  return items.filter((i) => matchesAnchors(i, f) && (!f.types.length || f.types.includes(i.type)));
}
export function typeCounts(items: KnowledgeItem[], f: Filters): Map<KnowledgeType, number> {
  const out = new Map<KnowledgeType, number>();
  for (const i of items) if (matchesAnchors(i, f)) out.set(i.type, (out.get(i.type) ?? 0) + 1);
  return out;
}
/** The idea, task and session choices present in the results, by title. */
export function anchorOptions(items: KnowledgeItem[], kind: "idea" | "task" | "session"): { id: string; title: string; n: number }[] {
  const out = new Map<string, { id: string; title: string; n: number }>();
  for (const i of items) for (const a of i.anchors) if (a.kind === kind) {
    const old = out.get(a.id);
    out.set(a.id, { id: a.id, title: old && old.title !== old.id ? old.title : a.title, n: (old?.n ?? 0) + 1 });
  }
  return [...out.values()].sort((a, b) => b.n - a.n || a.title.localeCompare(b.title));
}

/** Projects (repo names) present in the results, most items first. */
export function projectOptions(items: KnowledgeItem[]): { id: string; title: string; n: number }[] {
  const out = new Map<string, number>();
  for (const i of items) for (const p of new Set(i.anchors.filter((a) => a.kind === "repo").map((a) => projectOf(a.id)))) out.set(p, (out.get(p) ?? 0) + 1);
  return [...out.entries()].map(([id, n]) => ({ id, title: id, n })).sort((a, b) => b.n - a.n || a.id.localeCompare(b.id));
}

