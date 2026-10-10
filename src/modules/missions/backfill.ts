// Backfill: turn unassigned session history into mission proposals.
//   1. recent unlinked sessions cluster by (repo or cwd, normalized branch), split on > 72h gaps
//   2. Jev suggests merging a cluster into an open mission in the same repo
//   3. the heavy LLM names new clusters in batches (task "mission_naming")
//   4. older sessions fold into one archive mission per repo (handled by the caller)
import path from "node:path";
import { llm } from "../../core/llm.ts";
import { jev, jevAvailable, pick, q } from "../../core/jev.ts";
import { registerLlmFake } from "../../core/fakes.ts";
import { repoName, sha256, truncate } from "../../core/util.ts";
import type { Mission } from "../../shared/schema.ts";
import type { SessionItem } from "../sessions/types.ts";

export const GAP_HOURS = 72;
export const NAMING_BATCH = 10;

export function normBranch(b: string | null | undefined): string {
  const t = (b ?? "").trim();
  return !t || t === "main" || t === "master" || t === "HEAD" ? "main" : t;
}

/**
 * Where a session ran, for clustering: the repo when it ran at the repo root (the
 * normal case), else the repo plus the first two folders below it. This keeps an
 * umbrella repo (say a git-tracked ~/Documents holding many project folders)
 * from merging unrelated work into one cluster. Sessions outside git use their cwd.
 */
export function placeOf(s: { repo: string | null; cwd: string }): string {
  if (!s.repo) return s.cwd;
  const rel = path.relative(s.repo, s.cwd);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return s.repo;
  return path.join(s.repo, ...rel.split(path.sep).slice(0, 2));
}

export type Cluster = {
  repo: string | null;
  place: string;
  cwd: string;
  branch: string; // normalized
  branches: string[]; // raw names seen
  sessions: SessionItem[];
  first: string;
  last: string;
};

/** Group by (repo or cwd, normalized branch), then split where consecutive sessions are more than `gapHours` apart. */
export function clusterSessions(sessions: SessionItem[], gapHours = GAP_HOURS): Cluster[] {
  const groups = new Map<string, SessionItem[]>();
  for (const s of sessions) {
    const k = `${placeOf(s)}\u0000${normBranch(s.branch)}`;
    const g = groups.get(k);
    if (g) g.push(s); else groups.set(k, [s]);
  }
  const gap = gapHours * 3600e3;
  const out: Cluster[] = [];
  for (const g of groups.values()) {
    g.sort((a, b) => a.started.localeCompare(b.started) || a.key.localeCompare(b.key));
    let cur: SessionItem[] = [];
    let end = 0;
    const flush = () => { if (cur.length) out.push(toCluster(cur)); cur = []; };
    for (const s of g) {
      const start = Date.parse(s.started);
      if (cur.length && start - end > gap) flush();
      cur.push(s);
      end = Math.max(end, Date.parse(s.updated), start);
    }
    flush();
  }
  return out.sort((a, b) => b.last.localeCompare(a.last));
}

function toCluster(ss: SessionItem[]): Cluster {
  const raw = [...new Set(ss.map((s) => s.branch).filter((b): b is string => Boolean(b)))];
  return {
    repo: ss[0].repo,
    place: placeOf(ss[0]),
    cwd: ss[0].cwd,
    branch: normBranch(ss[0].branch),
    branches: raw.length ? raw : [normBranch(ss[0].branch)],
    sessions: ss,
    first: ss.reduce((m, s) => (s.started < m ? s.started : m), ss[0].started),
    last: ss.reduce((m, s) => (s.updated > m ? s.updated : m), ss[0].updated),
  };
}

/** Deterministic proposal id: the same session set always maps to the same id. */
export const clusterId = (c: Cluster) => `mp-${sha256(c.sessions.map((s) => s.key).sort().join(",")).slice(0, 12)}`;

export const clusterLabel = (c: Cluster) =>
  c.repo ? (c.place === c.repo ? repoName(c.repo) : `${repoName(c.repo)}/${path.relative(c.repo, c.place)}`) : path.basename(c.cwd) || c.cwd || "no repo";

export function describeCluster(c: Cluster): string {
  const day = (iso: string) => iso.slice(0, 10);
  const span = day(c.first) === day(c.last) ? day(c.first) : `${day(c.first)} to ${day(c.last)}`;
  return `${c.sessions.length} session${c.sessions.length === 1 ? "" : "s"} in ${clusterLabel(c)} on ${c.branches.join(", ")}, ${span}`;
}

// ---------- Jev: does this cluster belong to an open mission? ----------

export async function suggestMerge(c: Cluster, open: Mission[]): Promise<string | null> {
  if (!open.length || !jevAvailable()) return null;
  // "new" goes first so ties fall to a new mission.
  const criteria: Record<string, string> = { new: "None of these missions; this is separate work that needs its own mission." };
  for (const m of open) criteria[m.id] = `${m.title}. ${truncate(m.goal.replace(/\s+/g, " "), 300)}`;
  const state = {
    repo: clusterLabel(c),
    branch: c.branches.join(", "),
    sessions: c.sessions.slice(0, 12).map((s) => ({ title: s.title, first_prompt: truncate(s.first_prompt, 200) })),
  };
  try {
    const r = await jev(state, { mission: q.choice("These coding-agent sessions were not linked to a mission. Which open mission is this work part of? Choose new when none clearly fits.", criteria) }, { timeoutMs: 15000, retries: 1 });
    const choice = pick(r, "mission");
    return choice && choice !== "new" && open.some((m) => m.id === choice) ? choice : null;
  } catch {
    return null;
  }
}

// ---------- heavy LLM naming ----------

export const NAMING_SCHEMA = {
  type: "object",
  properties: {
    missions: {
      type: "array",
      items: {
        type: "object",
        properties: { index: { type: "integer" }, title: { type: "string" }, goal: { type: "string" } },
        required: ["index", "title", "goal"],
        additionalProperties: false,
      },
    },
  },
  required: ["missions"],
  additionalProperties: false,
};

function namingPrompt(batch: { index: number; c: Cluster }[]): string {
  const payload = batch.map(({ index, c }) => ({
    index,
    repo: clusterLabel(c),
    branch: c.branches.join(", "),
    sessions: c.sessions.slice(-12).map((s) => ({ title: s.title, first_prompt: truncate(s.first_prompt, 240) })),
  }));
  return [
    "You name missions in a developer's workspace. Each cluster below is a group of coding-agent sessions in one repo and branch.",
    "For every cluster, write:",
    "- title: 3 to 8 words, sentence case, naming the outcome (do not start with the repo name)",
    "- goal: one or two plain sentences describing what the work is trying to achieve",
    "Use only the session titles and first prompts given. Return one entry per cluster with its index.",
    "<clusters>",
    JSON.stringify(payload),
    "</clusters>",
  ].join("\n");
}

const fallbackName = (c: Cluster) => ({
  title: truncate(c.sessions[c.sessions.length - 1]?.title || `Work in ${clusterLabel(c)}`, 80),
  goal: `Work in ${clusterLabel(c)} on ${c.branches.join(", ")}.`,
});

/** Names clusters in batches of at most NAMING_BATCH per call; falls back to session titles on failure. */
export async function nameClusters(clusters: Cluster[], log?: (m: string) => void): Promise<{ names: { title: string; goal: string }[]; calls: number; fallbacks: number }> {
  const names = clusters.map(fallbackName);
  let calls = 0, fallbacks = 0;
  for (let i = 0; i < clusters.length; i += NAMING_BATCH) {
    const batch = clusters.slice(i, i + NAMING_BATCH).map((c, j) => ({ index: i + j, c }));
    try {
      calls++;
      const r = await llm<{ missions: { index: number; title: string; goal: string }[] }>(namingPrompt(batch), { task: "mission_naming", schema: NAMING_SCHEMA, timeoutMs: 240000 });
      const got = Array.isArray(r?.missions) ? r.missions : Array.isArray(r) ? (r as any[]) : [];
      const seen = new Set<number>();
      got.forEach((m, pos) => {
        const idx = Number.isInteger(m?.index) && m.index >= i && m.index < i + batch.length ? m.index : i + pos;
        if (idx >= i + batch.length || seen.has(idx) || typeof m?.title !== "string" || !m.title.trim()) return;
        seen.add(idx);
        names[idx] = { title: truncate(m.title.trim(), 100), goal: typeof m.goal === "string" && m.goal.trim() ? m.goal.trim() : names[idx].goal };
      });
      fallbacks += batch.length - seen.size;
    } catch (e: any) {
      fallbacks += batch.length;
      log?.(`missions: naming batch failed, using session titles: ${e.message}`);
    }
  }
  return { names, calls, fallbacks };
}

// Deterministic stand-in for tests (JOYRIDE_FAKE_MODELS=1): titles come from the cluster contents.
registerLlmFake("mission_naming", (prompt: string) => {
  const m = prompt.match(/<clusters>\n([\s\S]*?)\n<\/clusters>/);
  const clusters: any[] = m ? JSON.parse(m[1]) : [];
  return {
    missions: clusters.map((c) => ({
      index: c.index,
      title: `${c.repo}: ${c.sessions[c.sessions.length - 1]?.title ?? "work"}`.slice(0, 80),
      goal: `Finish the ${c.repo} work on ${c.branch}.`,
    })),
  };
});
