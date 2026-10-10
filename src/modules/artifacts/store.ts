import { normalizeUrl } from "../../shared/artifact-url.ts";
// Artifact registry files: artifacts/<id>.md. YAML frontmatter holds the
// Artifact schema fields (plus a few store-only fields); the markdown body
// preserves the original markdown body. Pure fs + parsing, so the MCP server
// can read the same authored files.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import YAML from "yaml";
import { z } from "zod";
import { Artifact } from "../../shared/schema.ts";
import { parseFrontmatter } from "../../shared/frontmatter.ts";

/** Where a Firstmate report came from and what the backlog says about it (see firstmate.ts). */
export const FirstmateOrigin = z.object({
  task: z.string(),
  final: z.boolean().default(false),
  task_title: z.string().nullable().default(null),
  heading: z.string().default(""),
  status: z.enum(["decision-open", "applying", "applied", "decided", "reported", "in-progress"]).default("reported"),
  decisions: z.array(z.object({ task: z.string(), title: z.string(), open: z.boolean(), question: z.string().nullable(), answer: z.string().nullable(), mode: z.string().nullable() })).default([]),
  followups: z.array(z.object({ task: z.string(), title: z.string(), done: z.boolean() })).default([]),
  modified: z.string().nullable().default(null),
});
export type FirstmateOrigin = z.infer<typeof FirstmateOrigin>;

export const StoredArtifact = Artifact.extend({
  updated: z.string().nullable().default(null),
  detected_from: z.enum(["manual", "transcript", "artifact-tool", "firstmate"]).default("manual"),
  source_key: z.string().nullable().default(null), // hash of a detached local source, for repeat registration
  project: z.string().nullable().default(null), // repo name, when the source says (Firstmate backlog "repo:")
  firstmate: FirstmateOrigin.nullable().default(null), // set for Firstmate reports
  content_type: z.string().nullable().default(null), // of the snapshot
  notes: z.string().default(""), // markdown body
});
export type StoredArtifact = z.infer<typeof StoredArtifact>;
export type ArtifactKind = StoredArtifact["kind"];

export const ID_RE = /^[a-z0-9][a-z0-9._-]{0,120}$/;
const PREFIX: Record<string, string> = { "claude-artifact": "cla", chatgpt: "gpt", pr: "pr", report: "rep", file: "file", other: "art", session: "ses" };

export function newArtifactId(kind: string, title: string, key: string) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36).replace(/-+$/, "") || "artifact";
  return `${PREFIX[kind] ?? "art"}-${slug}-${crypto.createHash("sha256").update(key).digest("hex").slice(0, 6)}`;
}

// ---------- URLs ----------

export const URL_PATTERNS: { kind: ArtifactKind; re: RegExp }[] = [
  { kind: "claude-artifact", re: /https?:\/\/claude\.ai\/(?:code\/)?(?:public\/)?artifacts?\/[A-Za-z0-9][A-Za-z0-9-]{5,}/g },
  { kind: "chatgpt", re: /https?:\/\/(?:chatgpt\.com|chat\.openai\.com)\/(?:g\/[A-Za-z0-9-]+\/)?(?:c|share|canvas)\/[A-Za-z0-9][A-Za-z0-9-]{5,}/g },
  { kind: "pr", re: /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g },
  { kind: "pr", re: /https?:\/\/bitbucket\.org\/[\w.-]+\/[\w.-]+\/pull-requests\/\d+/g },
];

export { normalizeUrl };

export function kindOfUrl(url: string): ArtifactKind {
  for (const p of URL_PATTERNS) { p.re.lastIndex = 0; if (p.re.test(url)) return p.kind; }
  return "other";
}

/** Every artifact-like link in free text: Claude artifacts, ChatGPT conversations/canvases, GitHub and Bitbucket PRs. */
export function findLinks(text: string): { url: string; kind: ArtifactKind }[] {
  if (!text || !/(claude\.ai|chatgpt\.com|chat\.openai\.com|github\.com|bitbucket\.org)/.test(text)) return [];
  const out = new Map<string, ArtifactKind>();
  for (const p of URL_PATTERNS) {
    p.re.lastIndex = 0;
    for (const m of text.matchAll(p.re)) out.set(normalizeUrl(m[0]), p.kind);
  }
  return [...out].map(([url, kind]) => ({ url, kind }));
}

export function titleForUrl(url: string, kind: ArtifactKind, context?: string | null): string {
  const ctx = context ? ` from “${context.length > 60 ? context.slice(0, 59) + "…" : context}”` : "";
  try {
    const p = new URL(url);
    const parts = p.pathname.split("/").filter(Boolean);
    if (kind === "pr") {
      const n = parts[parts.length - 1];
      return `${parts[0]}/${parts[1]} pull request #${n}`;
    }
    if (kind === "claude-artifact") return `Claude artifact${ctx}`;
    if (kind === "chatgpt") return `${parts.includes("canvas") ? "ChatGPT canvas" : parts.includes("share") ? "Shared ChatGPT conversation" : "ChatGPT conversation"}${ctx}`;
    return `${p.hostname}${p.pathname}`;
  } catch { return url; }
}

// ---------- local sources ----------
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf", ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".json": "application/json", ".csv": "text/csv; charset=utf-8",
};
export const localSourceKey = (file: string) => crypto.createHash("sha256").update(path.resolve(file)).digest("hex");
export const matchesLocalSource = (a: Pick<StoredArtifact, "local_source" | "source_key">, file: string) =>
  a.local_source === file || a.source_key === localSourceKey(file);

export const contentTypeOf = (file: string) => TYPES[path.extname(file).toLowerCase()] ?? null;
export const kindOfLocal = (file: string): ArtifactKind => (/\.(html?|md|markdown|pdf)$/i.test(file) ? "report" : "file");

/** The <title> of an HTML file, else null. */
export function htmlTitle(text: string): string | null {
  const m = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const t = m?.[1]?.replace(/\s+/g, " ").trim();
  return t ? decodeEntities(t) : null;
}
function decodeEntities(s: string) {
  return s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}
/** Readable text of an HTML document (scripts and styles dropped). */
export function htmlToText(html: string): string {
  return decodeEntities(html
    .replace(/<(script|style|noscript|svg|title|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|table|ul|ol|header|footer|br)\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .split("\n").map((l) => l.replace(/[ \t\f\v]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------- files ----------
const FRONT = ["private", "id", "title", "kind", "url", "source", "session", "mission", "local_source", "source_key", "snapshot_blob", "content_type", "embeddable", "summary", "detected_from", "project", "firstmate", "created", "updated"] as const;

export function serializeArtifact(a: StoredArtifact): string {
  const front: Record<string, unknown> = {};
  for (const k of FRONT) front[k] = (a as any)[k];
  return `---\n${YAML.stringify(front, { lineWidth: 0 })}---\n\n${(a.notes ?? "").trim()}\n`;
}

export function parseArtifactText(text: string, fallbackId: string): StoredArtifact | null {
  try {
    const { data, content } = parseFrontmatter(text);
    const r = StoredArtifact.safeParse({ ...data, id: data.id ?? fallbackId, notes: content.trim(), created: data.created ?? new Date(0).toISOString() });
    return r.success ? r.data : null;
  } catch { return null; }
}

export function artifactFile(dir: string, id: string) {
  if (!ID_RE.test(id)) throw new Error(`invalid artifact id "${id}"`);
  return path.join(dir, `${id}.md`);
}

type CacheRow = { mtimeMs: number; size: number; a: StoredArtifact | null };
const cache = new Map<string, CacheRow>();
export function loadArtifacts(dir: string): StoredArtifact[] {
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".md")); } catch { return []; }
  const out: StoredArtifact[] = [];
  for (const n of names) {
    const file = path.join(dir, n);
    let st: fs.Stats;
    try { st = fs.statSync(file); } catch { continue; }
    let row = cache.get(file);
    if (!row || row.mtimeMs !== st.mtimeMs || row.size !== st.size) {
      let a: StoredArtifact | null = null;
      try { a = parseArtifactText(fs.readFileSync(file, "utf8"), n.slice(0, -3)); } catch { a = null; }
      row = { mtimeMs: st.mtimeMs, size: st.size, a };
      cache.set(file, row);
    }
    if (row.a) out.push(structuredClone(row.a));
  }
  return out;
}

export function readArtifact(dir: string, id: string): StoredArtifact | null {
  if (!ID_RE.test(id)) return null;
  const file = path.join(dir, `${id}.md`);
  try { return parseArtifactText(fs.readFileSync(file, "utf8"), id); } catch { return null; }
}

export function writeArtifact(dir: string, a: StoredArtifact): string {
  const v = StoredArtifact.parse(a);
  const file = artifactFile(dir, v.id);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, serializeArtifact(v));
  fs.renameSync(tmp, file);
  return file;
}
