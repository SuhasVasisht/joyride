// The artifacts review list (#/knowledge/artifacts): every registered artifact,
// merged across the ways it was found, newest first, filtered and paged. Pure,
// so the daemon route and unit tests share it and the UI imports its types.
//   - one artifact found twice (a Claude page published from a local file and
//     the same file registered by hand, the claude.ai/artifact and
//     claude.ai/code/artifact links to one page, two copies of one report) is
//     one row: rows sharing a Claude artifact id, link, local file or snapshot merge

export type ReviewSource = "firstmate" | "claude" | "report" | "pr" | "chatgpt" | "file" | "link";
export const REVIEW_SOURCES: ReviewSource[] = ["claude", "report", "firstmate", "pr", "chatgpt", "file", "link"];
export const SOURCE_LABEL: Record<ReviewSource, string> = {
  claude: "Claude artifact", report: "Joyride report", firstmate: "Firstmate report", pr: "Pull request",
  chatgpt: "ChatGPT", file: "File", link: "Link",
};

/** The registry fields the review list reads (a StoredArtifact view satisfies it). */
export type ReviewInput = {
  private?: boolean;
  id: string; title: string; kind: string; url: string | null; local_source: string | null; snapshot_blob: string | null;
  content_type?: string | null; embeddable: boolean; created: string; updated?: string | null; summary: string;
  mission: string | null; session: string | null; session_title?: string | null; project?: string | null;
  detected_from?: string; firstmate?: { modified: string | null; task: string } | null;
};

export type ReviewItem = {
  private: boolean;
  id: string; ids: string[]; title: string; source: ReviewSource; sources: ReviewSource[]; kind: string;
  url: string | null; local: boolean; content_type: string | null; embeddable: boolean;
  at: string; created: string; summary: string; project: string | null;
  mission: string | null; mission_title: string | null; session: string | null; session_title: string | null;
  firstmate_task: string | null;
};

export type ReviewFilter = { source?: string; idea?: string; q?: string; offset?: number; limit?: number };
export type ReviewFacet = { id: string; title: string; n: number };
export type ReviewPage = {
  /** any_source: rows matching every filter but the source, the "All sources" count. */
  items: ReviewItem[]; total: number; offset: number; limit: number; all: number; any_source: number;
  sources: ReviewFacet[]; ideas: ReviewFacet[];
};

export const NO_IDEA = "none";
export const PAGE_SIZE = 50;
const MAX_LIMIT = 500;
const RANK: Record<string, number> = { firstmate: 3, "artifact-tool": 2, manual: 1, transcript: 0 };

export function sourceOf(a: Pick<ReviewInput, "kind" | "firstmate">): ReviewSource {
  if (a.firstmate) return "firstmate";
  switch (a.kind) {
    case "claude-artifact": return "claude";
    case "report": return "report";
    case "pr": return "pr";
    case "chatgpt": return "chatgpt";
    case "file": return "file";
    default: return "link";
  }
}

/** When the artifact was written, or last rewritten for a Firstmate report. */
const atOf = (a: ReviewInput) => a.firstmate?.modified ?? a.created;

/** The Claude artifact id in a claude.ai link (artifact, code/artifact and public forms alike), else null. */
export function claudeArtifactId(url: string): string | null {
  return url.match(/^https?:\/\/(?:www\.)?claude\.ai\/(?:code\/)?(?:public\/)?artifacts?\/([A-Za-z0-9][A-Za-z0-9-]{5,})/i)?.[1].toLowerCase() ?? null;
}

/** Every identity an artifact has: rows sharing any of them are the same artifact. */
export function identityKeys(a: Pick<ReviewInput, "url" | "local_source" | "snapshot_blob">): string[] {
  const keys: string[] = [];
  if (a.url) {
    const cla = claudeArtifactId(a.url);
    keys.push(cla ? `claude:${cla}` : `url:${a.url.replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase()}`);
  }
  if (a.local_source) keys.push(`file:${a.local_source}`);
  if (a.snapshot_blob) keys.push(`blob:${a.snapshot_blob}`);
  return keys;
}

/** A title worth showing: one the source gave, not the generated "Claude artifact from …". */
const generic = (t: string) => /^(Claude artifact|ChatGPT conversation|Shared ChatGPT conversation|ChatGPT canvas)\b/.test(t);

/** Groups artifacts that are the same thing; each group keeps its input order. */
export function groupDuplicates<T extends ReviewInput>(list: T[]): T[][] {
  const parent = list.map((_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const owner = new Map<string, number>();
  list.forEach((a, i) => {
    for (const k of identityKeys(a)) {
      const j = owner.get(k);
      if (j === undefined) owner.set(k, i);
      else { const ri = find(i), rj = find(j); if (ri !== rj) parent[Math.max(ri, rj)] = Math.min(ri, rj); }
    }
  });
  const groups = new Map<number, T[]>();
  list.forEach((a, i) => { const r = find(i); groups.set(r, [...(groups.get(r) ?? []), a]); });
  return [...groups.values()];
}

/** One review row from a group of duplicates: the best-found member (then a Claude page, then one with a snapshot, then the newest) leads; the rest fill gaps. */
export function mergeGroup(group: ReviewInput[], missionTitle: (id: string) => string | null = () => null): ReviewItem {
  const lead = [...group].sort((a, b) =>
    (RANK[b.detected_from ?? "manual"] ?? 0) - (RANK[a.detected_from ?? "manual"] ?? 0)
    || Number(Boolean(b.url && claudeArtifactId(b.url))) - Number(Boolean(a.url && claudeArtifactId(a.url)))
    || Number(Boolean(b.snapshot_blob)) - Number(Boolean(a.snapshot_blob))
    || atOf(b).localeCompare(atOf(a)))[0];
  const first = <K extends keyof ReviewInput>(k: K): ReviewInput[K] | null => (lead[k] ?? group.find((a) => a[k])?.[k] ?? null) as ReviewInput[K] | null;
  const title = !generic(lead.title) ? lead.title : group.find((a) => !generic(a.title))?.title ?? lead.title;
  const urlOwner = lead.url ? lead : group.find((a) => a.url && claudeArtifactId(a.url)) ?? group.find((a) => a.url);
  const snap = lead.snapshot_blob ? lead : group.find((a) => a.snapshot_blob) ?? lead;
  const mission = first("mission") as string | null;
  const at = group.map(atOf).sort().pop()!;
  const created = group.map((a) => a.created).sort()[0];
  const summary = (group.find((a) => a.summary.trim())?.summary ?? "").replace(/(^|\s)#{1,6}\s+/g, "$1").replace(/\s+/g, " ").trim();
  return {
    private: group.some(a => a.private),
    id: lead.id, ids: group.map((a) => a.id), title, source: sourceOf(lead),
    sources: [...new Set(group.map(sourceOf))], kind: lead.kind,
    url: urlOwner?.url ?? null, local: Boolean(snap.snapshot_blob), content_type: snap.content_type ?? null, embeddable: Boolean(snap.embeddable),
    at, created, summary: summary.length > 220 ? `${summary.slice(0, 219)}…` : summary,
    project: (first("project") as string | null) ?? null, mission, mission_title: mission ? missionTitle(mission) ?? mission : null,
    session: first("session") as string | null, session_title: (first("session_title") as string | null) ?? null,
    firstmate_task: group.find((a) => a.firstmate)?.firstmate?.task ?? null,
  };
}

/** Every artifact as review rows: saved session records left out, duplicates merged, newest first. */
export function mergeArtifacts(list: ReviewInput[], missionTitle?: (id: string) => string | null): ReviewItem[] {
  return groupDuplicates(list.filter((a) => a.kind !== "session"))
    .map((g) => mergeGroup(g, missionTitle))
    .sort((a, b) => b.at.localeCompare(a.at) || a.title.localeCompare(b.title));
}

const matchesQuery = (i: ReviewItem, q: string | undefined) => {
  const words = (q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${i.title} ${i.summary} ${i.url ?? ""} ${i.mission_title ?? ""} ${i.session_title ?? ""} ${i.project ?? ""} ${i.firstmate_task ?? ""} ${SOURCE_LABEL[i.source]}`.toLowerCase();
  return words.every((w) => hay.includes(w));
};
const matchesIdea = (i: ReviewItem, idea: string | undefined) => !idea || (idea === NO_IDEA ? !i.mission : i.mission === idea);
const matchesSource = (i: ReviewItem, source: string | undefined) => !source || i.sources.includes(source as ReviewSource);

/**
 * One page of the review list. Each facet counts the rows that match every
 * other filter, so picking a source never hides the other sources' counts.
 */
export function reviewPage(items: ReviewItem[], f: ReviewFilter = {}): ReviewPage {
  const base = items.filter((i) => matchesQuery(i, f.q));
  const sourceCounts = new Map<string, number>();
  const ideaCounts = new Map<string, ReviewFacet>();
  let anySource = 0;
  for (const i of base) {
    if (matchesIdea(i, f.idea)) { anySource++; for (const s of i.sources) sourceCounts.set(s, (sourceCounts.get(s) ?? 0) + 1); }
    if (matchesSource(i, f.source)) {
      const id = i.mission ?? NO_IDEA;
      const cur = ideaCounts.get(id) ?? { id, title: i.mission ? i.mission_title ?? i.mission : "No idea", n: 0 };
      cur.n++;
      ideaCounts.set(id, cur);
    }
  }
  const shown = base.filter((i) => matchesIdea(i, f.idea) && matchesSource(i, f.source));
  const offset = Math.max(0, Math.floor(f.offset ?? 0));
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(f.limit ?? PAGE_SIZE)));
  return {
    items: shown.slice(offset, offset + limit), total: shown.length, offset, limit, all: items.length, any_source: anySource,
    sources: REVIEW_SOURCES.filter((s) => sourceCounts.get(s) || s === f.source).map((s) => ({ id: s, title: SOURCE_LABEL[s], n: sourceCounts.get(s) ?? 0 })),
    ideas: [...ideaCounts.values()].sort((a, b) => Number(a.id === NO_IDEA) - Number(b.id === NO_IDEA) || b.n - a.n || a.title.localeCompare(b.title)),
  };
}
