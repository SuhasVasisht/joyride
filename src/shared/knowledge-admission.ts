import path from "node:path";
import os from "node:os";
import type { Config } from "./schema.ts";

export type KnowledgePolicy = Omit<Config["knowledge"], "pipeline">;
export type KnowledgeSource = {
  id?: string | null;
  url?: string | null;
  cwd?: string | null;
  session?: string | null;
  local_source?: string | null;
  private?: boolean;
  provenance?: { type: string; ref: string };
};

/** Git HTTPS/SSH remotes and forge links share one host/owner/repo identity. */
export function forgeRepo(raw: string): string | null {
  const ssh = raw.match(/^(?:[^@\s]+@)?(github\.com|bitbucket\.org):(.+)$/i);
  try {
    const u = new URL(ssh ? `https://${ssh[1]}/${ssh[2]}` : raw);
    if (!["github.com", "bitbucket.org"].includes(u.hostname.toLowerCase())) return null;
    const [owner, repo] = u.pathname.split("/").filter(Boolean);
    return owner && repo ? `${u.hostname}/${owner}/${repo.replace(/\.git$/, "")}`.toLowerCase() : null;
  } catch { return null; }
}

export function sourceKey(raw: string): string {
  if (!URL.canParse(raw)) return raw;
  try {
    const u = new URL(raw);
    u.search = ""; u.hash = ""; u.protocol = "https:";
    u.pathname = u.pathname.replace(/(\/(?:pull|pull-requests|issues)\/\d+).*/, "$1").replace(/\/$/, "");
    return u.toString().replace(/\/$/, "").toLowerCase();
  } catch { return raw; }
}

/** Accept both native paths and Claude's encoded project/scratchpad paths. */
export function privatePath(raw: string | null | undefined, policy: KnowledgePolicy): boolean {
  if (!raw) return false;
  const slug = (s: string) => s.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+$/, "");
  return policy.private_paths.some(p => {
    const expanded = p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
    const normalized = path.resolve(expanded);
    return raw === normalized || raw.startsWith(`${normalized}/`) ||
      ((raw.startsWith("-") || raw.includes("/projects/") || raw.includes("/scratchpad/")) && (`${slug(raw)}-`).includes(`${slug(normalized)}-`));
  });
}

export function privateSource(source: KnowledgeSource, policy: KnowledgePolicy): boolean {
  return Boolean(source.private || (source.session && policy.private_sessions.includes(source.session)) ||
    privatePath(source.cwd, policy) || privatePath(source.local_source, policy));
}

export function tombstoned(source: KnowledgeSource, policy: KnowledgePolicy): boolean {
  const keys = [source.id, source.url, source.local_source].filter((s): s is string => Boolean(s)).map(sourceKey);
  return policy.tombstones.some(t => keys.includes(sourceKey(t.source)));
}

/** One gate for source discovery and aggregate Search. */
export function admitKnowledge(source: KnowledgeSource, policy: KnowledgePolicy): boolean {
  if (privateSource(source, policy) || tombstoned(source, policy)) return false;
  if (source.provenance) {
    const p = source.provenance;
    for (const ref of p.ref.split(";").map(s => s.trim()).filter(Boolean)) {
      if (!admitKnowledge({ id: ref, local_source: p.type === "imported" ? ref : null,
        session: p.type === "session" || p.type === "trace" ? ref : null }, policy)) return false;
    }
  }
  if (!source.url) return true;
  const repo = forgeRepo(source.url);
  if (!repo) return true;
  return policy.owned_repos.some(r => (forgeRepo(r) ?? r.toLowerCase()) === repo) ||
    policy.owned_orgs.some(o => repo.startsWith(`${o.toLowerCase().replace(/\/$/, "")}/`));
}
