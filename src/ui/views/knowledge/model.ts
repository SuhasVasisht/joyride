// Pure Search helpers: source filters, legacy bookmark redirects, date groups
// and saved-session resume commands.
import type { KnowledgeItem, KnowledgeRef, KnowledgeType } from "../../../shared/knowledge";

export type View = "all" | "artifacts";
export const VIEWS: [View, string][] = [["all", "All"], ["artifacts", "Artifacts"]];
export const viewOf = (param: string | undefined): View => param === "artifacts" ? "artifacts" : "all";
export const MODE = { all: "all" } as const;

export const TYPES: KnowledgeType[] = ["ideas", "tasks", "notes", "reports", "pages", "prs", "chats", "files", "sessions", "other"];
export const TYPE_LABEL: Record<KnowledgeType, string> = {
  ideas: "Ideas", tasks: "Tasks", notes: "Notes", reports: "Reports", pages: "Pages", prs: "Pull requests",
  chats: "Chats", files: "Files", sessions: "Sessions", other: "Links",
};
export const SOURCE_TYPES: KnowledgeType[] = ["reports", "pages", "prs", "chats", "files", "sessions", "other"];
const KIND_LABEL: Record<string, string> = {
  idea: "Idea", task: "Task", note: "Note", report: "Report", "claude-artifact": "Page",
  chatgpt: "ChatGPT", pr: "Pull request", file: "File", other: "Link", session: "Session",
};
const KIND_MARK: Record<string, string> = {
  idea: "◇", task: "▣", note: "✎", report: "▤", "claude-artifact": "◈", chatgpt: "◐", pr: "⌥", file: "▢", other: "↗", session: "⟲",
};
export const kindLabel = (kind: string) => KIND_LABEL[kind] ?? kind;
export const kindMark = (kind: string) => KIND_MARK[kind] ?? "▤";
/** A saved session record (an artifact of kind session) rather than a live or past session. */
export const isSavedSession = (item: Pick<KnowledgeItem, "ref" | "kind">) => item.ref.entity === "artifact" && item.kind === "session";

export const refKey = (ref: KnowledgeRef | { entity: string; id: string }) => `${ref.entity}:${ref.id}`;
/** `idea:<id>`, `artifact:<id>` or `session:<key>`; session keys keep their own colons. */
export function parseRef(value: string | null | undefined): KnowledgeRef | null {
  if (!value) return null;
  const at = value.indexOf(":");
  if (at < 1 || at === value.length - 1) return null;
  const entity = value.slice(0, at), id = value.slice(at + 1);
  return entity === "idea" || entity === "task" || entity === "artifact" || entity === "session" || entity === "note" ? { entity, id } : null;
}

// ---------- redirects from the legacy pages ----------
const SHELF_TYPES: Record<string, KnowledgeType[]> = {
  all: SOURCE_TYPES, reports: ["reports"], pages: ["pages", "other"], prs: ["prs"], chats: ["chats"], files: ["files"],
  sessions: ["sessions"],
};
function build(view: View, params: [string, string | null | undefined][]): string {
  const qs = new URLSearchParams();
  for (const [k, v] of params) if (v) qs.set(k, v);
  const s = qs.toString();
  return `knowledge${view === "all" ? "" : `/${view}`}${s ? `?${s}` : ""}`;
}
/**
 * Where a legacy Memory, Learnings or Artifacts hash lands in the knowledge
 * home. Every old deep link keeps working: an entry or artifact id opens its
 * sheet, tabs map to views, and shelves map to type filters.
 */
export function legacyTarget(name: string, params: string[], query: URLSearchParams): string {
  if (name === "artifacts") {
    const id = params[0];
    const shelf = query.get("shelf") ?? "all";
    return build("all", [["types", (SHELF_TYPES[shelf] ?? SOURCE_TYPES).join(",")], ["open", id ? `artifact:${id}` : null],
      ["register", query.get("register") === "1" ? "1" : null]]);
  }
  return "knowledge";
}

// ---------- filters ----------
export { applyFilters, typeCounts, anchorOptions, projectOptions, matchesAnchors, type Filters } from "../../../shared/knowledge-filters";
export function parseTypes(value: string | null): KnowledgeType[] {
  return (value ?? "").split(",").filter((t): t is KnowledgeType => (TYPES as string[]).includes(t));
}

// ---------- grouping ----------
const DAY = 864e5;
export function dateBucket(iso: string, now = new Date()): [number, string] {
  const t = new Date(iso).getTime();
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  if (t >= start.getTime()) return [0, "Today"];
  if (t >= start.getTime() - DAY) return [1, "Yesterday"];
  if (t >= start.getTime() - 6 * DAY) return [2, "This week"];
  if (t >= start.getTime() - 29 * DAY) return [3, "This month"];
  return [4, "Earlier"];
}
/** Newest first, in date buckets. Search results keep their rank order in one group instead. */
export function groupByDate(items: KnowledgeItem[], ranked: boolean, now = new Date()): { label: string; items: KnowledgeItem[] }[] {
  if (ranked) return items.length ? [{ label: "Best matches", items }] : [];
  const groups = new Map<number, { label: string; items: KnowledgeItem[] }>();
  for (const i of [...items].sort((a, b) => b.updated.localeCompare(a.updated))) {
    const [rank, label] = dateBucket(i.updated, now);
    const g = groups.get(rank) ?? { label, items: [] };
    g.items.push(i);
    groups.set(rank, g);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, g]) => g);
}
// ---------- saved sessions ----------
export type SavedSession = { summary: string; work_done: string; resume_context: string; command: string | null; cwd: string | null; saved_at: string | null };
/**
 * Reads the resume command from a saved session snapshot: the JSON record
 * fleet preservation writes (`resume.command`), or a markdown or text record
 * with a `Resume:` line.
 */
export function parseSavedSession(text: string): SavedSession {
  try {
    const j = JSON.parse(text);
    if (j && typeof j === "object") {
      const str = (v: unknown) => (typeof v === "string" ? v : "");
      return { summary: str(j.summary), work_done: str(j.work_done), resume_context: str(j.resume_context),
        command: str(j.resume?.command) || null, cwd: str(j.resume?.cwd) || null, saved_at: str(j.saved_at) || null };
    }
  } catch { /* not JSON: a markdown or text record */ }
  const line = text.match(/^\s*(?:[-*]\s*)?(?:\*\*)?resume(?: command)?(?:\*\*)?\s*:(?:\*\*)?\s*`?([^`\n]+?)`?\s*$/im)?.[1]?.trim() ?? null;
  return { summary: "", work_done: "", resume_context: "", command: line, cwd: null, saved_at: null };
}
