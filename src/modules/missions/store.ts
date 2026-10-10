// File formats for authored missions and lenses.
//   missions/<id>.md   YAML frontmatter (every Mission field except goal) + markdown body (the goal)
//   lenses/<id>.yaml   one Lens
// The `yaml` package (YAML 1.2 core schema) keeps ISO timestamps as strings.
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import YAML from "yaml";
import { z } from "zod";
import { Lens, Mission, MissionProposal, type SessionRef } from "../../shared/schema.ts";

const engines = {
  yaml: {
    parse: (s: string) => (YAML.parse(s) ?? {}) as object,
    stringify: (o: object) => YAML.stringify(o),
  },
};

export const ID_RE = /^[a-z0-9][a-z0-9._-]{0,95}$/;

export function parseMission(text: string, fallbackId: string): Mission {
  const f = matter(text, { engines });
  return Mission.parse({ ...f.data, id: f.data.id ?? fallbackId, goal: f.content.trim() });
}

export function renderMission(m: Mission): string {
  const { goal, ...front } = m;
  return matter.stringify(goal.trim() ? goal.trim() + "\n" : "", front, { engines });
}

export function readMissionDir(dir: string): { missions: Mission[]; errors: { file: string; error: string }[] } {
  const missions: Mission[] = [];
  const errors: { file: string; error: string }[] = [];
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".md")); } catch { return { missions, errors }; }
  for (const n of names.sort()) {
    const file = path.join(dir, n);
    try { missions.push(parseMission(fs.readFileSync(file, "utf8"), n.slice(0, -3))); }
    catch (e: any) { errors.push({ file, error: e?.issues ? JSON.stringify(e.issues).slice(0, 300) : String(e.message) }); }
  }
  return { missions, errors };
}

export function parseLens(text: string, fallbackId: string): Lens {
  const raw = (YAML.parse(text) ?? {}) as Record<string, unknown>;
  return Lens.parse({ ...raw, id: raw.id ?? fallbackId });
}
/** Empty session and project lists stay out of the file, so lenses written before groups held them read the same. */
export const renderLens = (l: Lens) => {
  const { sessions, projects, ...rest } = l;
  return YAML.stringify({ ...rest, ...(sessions?.length ? { sessions } : {}), ...(projects?.length ? { projects } : {}) });
};

export function readLensDir(dir: string): Lens[] {
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((n) => /\.ya?ml$/.test(n)); } catch { return []; }
  const out: Lens[] = [];
  for (const n of names.sort()) {
    try { out.push(parseLens(fs.readFileSync(path.join(dir, n), "utf8"), n.replace(/\.ya?ml$/, ""))); } catch { /* skip invalid lens */ }
  }
  return out;
}

/** Stored proposal: the shared schema plus bookkeeping fields. */
export const StoredProposal = MissionProposal.extend({
  created: z.string().optional(),
  decided_at: z.string().nullable().default(null),
  decision_reason: z.string().default(""),
  mission: z.string().nullable().default(null), // mission created or linked on accept
  created_mission: z.boolean().optional(), // true when the accept created `mission` (false: it linked into an existing one)
  /** Earlier decisions, oldest first: a reopen keeps them here so the record never loses what was decided. */
  history: z.array(z.object({
    status: z.enum(["accepted", "rejected"]), decided_at: z.string().nullable(), reason: z.string().default(""),
    mission: z.string().nullable().default(null), reopened_at: z.string(),
  })).default([]),
});
export type StoredProposal = z.infer<typeof StoredProposal>;

export const refKey = (r: SessionRef) => `${r.source}:${r.id}`;

export function dedupeRefs(refs: SessionRef[]): SessionRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => { const k = refKey(r); if (seen.has(k)) return false; seen.add(k); return true; });
}
