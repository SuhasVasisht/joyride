import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { execFileSync } from "node:child_process";
import type { Ctx } from "../../core/context.ts";
import { writeJsonAtomic } from "../../core/util.ts";
import { commitPaths } from "../../core/gitstore.ts";
import { knowledgePolicy } from "../../core/knowledge-policy.ts";
import { paths } from "../../shared/paths.ts";
import { tombstoned } from "../../shared/knowledge-admission.ts";
import { blobPath, isSha, putBlobBuffer } from "../evidence/blobs.ts";
import { localSourceKey, loadArtifacts, writeArtifact, type StoredArtifact } from "./store.ts";
import type { MissionsService } from "../missions/index.ts";

/** Snapshot-only sources survive teardown. Linked git worktrees need not live under .treehouse. */
export function disposableSource(file: string): boolean {
  if (/(?:^|\/)(?:\.treehouse|\.worktrees|worktrees|tmp)(?:\/|$)/i.test(file)) return true;
  let dir = path.dirname(file);
  while (dir !== path.dirname(dir)) {
    const git = path.join(dir, ".git");
    try {
      if (fs.statSync(git).isFile()) {
        const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: dir, encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }).trim();
        return path.resolve(dir, common) !== path.resolve(dir, fs.readFileSync(git, "utf8").replace(/^gitdir:\s*/, "").trim());
      }
      if (fs.statSync(git).isDirectory()) return false;
    } catch { /* A missing source still has a snapshot. */ }
    dir = path.dirname(dir);
  }
  return false;
}

type Admission = ReturnType<typeof knowledgePolicy>;
const SnapshotSource = z.object({
  id: z.string().nullish(), url: z.string().nullish(), cwd: z.string().nullish(), session: z.string().nullish(),
  local_source: z.string().nullish(), private: z.boolean().optional(), source: z.string().optional(),
});
export function aggregateFilter(admission: Admission, artifacts: StoredArtifact[], privateIdeas: string[] = []) {
  const excluded = new Set<string>([...admission.policy.private_sessions, ...admission.policy.tombstones.map(t => t.source), ...privateIdeas]);
  for (const a of artifacts) if (!admission.admits({ ...a, url: a.detected_from === "transcript" ? a.url : null })) {
    excluded.add(a.id);
    if (a.url) excluded.add(a.url);
    if (a.local_source) excluded.add(a.local_source);
  }
  // JSON inventories often spell session identities as separate source/id fields.
  for (const key of [...excluded]) if (/^(claude|codex):/.test(key)) excluded.add(key.slice(key.indexOf(":") + 1));
  const blocked = (text: string): boolean => {
    for (const key of excluded) if (key && text.includes(key)) return true;
    for (const match of text.matchAll(/(?:claude|codex):[a-zA-Z0-9-]+/g)) if (!admission.admits({ session: match[0] })) return true;
    for (const match of text.matchAll(/(?:~\/|\/)[^\s"'`<>|,;)}\]]+/g)) if (admission.private({ local_source: match[0] })) return true;
    for (const match of text.matchAll(/https?:\/\/[^\s"'`<>|)\]]+/g)) {
      if (tombstoned({ url: match[0] }, admission.policy) || (/\/(?:pull|pull-requests)\/\d+/.test(match[0]) && !admission.admits({ url: match[0] }))) return true;
    }
    return false;
  };
  const remember = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    if ("id" in value && typeof value.id === "string") excluded.add(value.id);
  };
  const rejected = (value: unknown) => {
    const parsed = SnapshotSource.safeParse(value);
    if (parsed.success) {
      const source = parsed.data;
      const session = (source.source === "claude" || source.source === "codex") && source.id ? `${source.source}:${source.id}` : source.session;
      if (!admission.admits({ ...source, session })) return true;
    }
    return blocked(JSON.stringify(value));
  };
  function scrub(value: unknown): unknown {
    if (Array.isArray(value)) return value.filter(v => {
      if (!rejected(v)) return true;
      remember(v);
      return false;
    }).map(scrub);
    if (value && typeof value === "object") {
      if (("id" in value || "session" in value || "cwd" in value || "provenance" in value || "private" in value || "url" in value) && rejected(value)) { remember(value); return null; }
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]));
    }
    return typeof value === "string" && blocked(value) ? null : value;
  }
  function dossier(raw: string): string | null {
    // Transcript excerpts can contain unclosed code fences and nested headings.
    // The generator's heading + Session/Cwd record is the boundary, not excerpt Markdown.
    const sections = [...raw.matchAll(/^#{1,6} [^\n]+\n\s*\nSession:\s*`?((?:claude|codex):[a-zA-Z0-9-]+)[^\n]*Cwd:\s*`([^`]+)`[^\n]*/gm)];
    if (!sections.length) return null;
    const admitted = sections.filter(s => admission.admits({ session: s[1], cwd: s[2] }));
    if (admitted.length === sections.length) return raw;
    let clean = raw.slice(0, sections[0].index).replace(/These \d+ sessions/, `These ${admitted.length} sessions`);
    for (let i = 0; i < sections.length; i++) if (admission.admits({ session: sections[i][1], cwd: sections[i][2] })) {
      clean += raw.slice(sections[i].index, sections[i + 1]?.index ?? raw.length);
    }
    return clean;
  }
  function markdown(raw: string): string {
    // Parse JSON before headings so a rejected proposal's id also removes its prose decision section.
    let text = raw.replace(/^(`{3,}|~{3,})(?:json)?\s*\n([\s\S]*?)^\1\s*$/gm, (block, fence: string, body: string) => {
      try {
        const parsed: unknown = JSON.parse(body);
        const clean = scrub(parsed);
        return JSON.stringify(parsed) === JSON.stringify(clean) ? block : `${fence}json\n${JSON.stringify(clean, null, 2)}\n${fence}`;
      } catch { return blocked(body) ? "" : block; }
    });
    // A heading that names a private source owns its whole subtree. Table rows and
    // prose paragraphs are independent units; don't discard their unrelated siblings.
    const out: string[] = [];
    let skipLevel: number | null = null;
    let inFence = false;
    for (const block of text.split(/\n\n+/)) {
      const blockLines = block.split("\n");
      let paragraph: string[] = [];
      let table: string[] = [];
      const flushTable = () => { if (table.length) out.push(table.join("\n")); table = []; };
      const flush = () => { if (paragraph.length && !blocked(paragraph.join("\n"))) out.push(paragraph.join("\n")); paragraph = []; };
      for (const line of blockLines) {
        if (/^(`{3,}|~{3,})/.test(line)) inFence = !inFence;
        const h = !inFence && line.match(/^(#{1,6})\s+(.*)/);
        if (h) {
          flushTable();
          flush();
          if (skipLevel !== null && h[1].length <= skipLevel) skipLevel = null;
          if (skipLevel === null && blocked(h[2])) skipLevel = h[1].length;
        }
        if (skipLevel !== null) continue;
        if (!inFence && /^\|/.test(line)) { flush(); if (!blocked(line)) table.push(line); }
        else { flushTable(); paragraph.push(line); }
      }
      flushTable();
      flush();
    }
    return out.join("\n\n");
  }
  return {
    text(raw: string, type = "text/markdown"): string {
      if (/text\/html/.test(type)) return raw.replace(/(<script\b[^>]*\btype=["']application\/json["'][^>]*>)([\s\S]*?)(<\/script>)/gi, (block, open: string, body: string, close: string) => {
        try {
          const parsed: unknown = JSON.parse(body);
          const clean = scrub(parsed);
          return JSON.stringify(parsed) === JSON.stringify(clean) ? block : `${open}${JSON.stringify(clean).replace(/</g, "\\u003c")}${close}`;
        } catch { return blocked(body) ? `${open}null${close}` : block; }
      });
      if (/application\/json/.test(type)) {
        try { const value: unknown = JSON.parse(raw); const clean = scrub(value); return JSON.stringify(value) === JSON.stringify(clean) ? raw : JSON.stringify(clean, null, 2); }
        catch { return blocked(raw) ? "" : raw; }
      }
      const saved = dossier(raw);
      if (saved !== null) return saved;
      const clean = markdown(raw);
      // Keep byte-identical snapshots when no source was removed.
      return clean.replace(/\s/g, "") === raw.replace(/\s/g, "") ? raw : clean + "\n";
    },
  };
}

export function artifactFilter(ctx: Ctx, artifacts = loadArtifacts(paths.artifacts)) {
  const missions = ctx.services.has("missions") ? ctx.service<MissionsService>("missions").list() : [];
  return aggregateFilter(knowledgePolicy(ctx), artifacts, missions.filter(m => m.private).map(m => m.id));
}

const textSnapshot = (a: StoredArtifact) => /^(text\/(?:html|markdown|plain|csv)|application\/json)/.test(a.content_type ?? "");

/** Repeatable startup repair. Missing sources are retried on the next startup. */
export function repairArtifactSnapshots(ctx: Ctx) {
  const artifacts = loadArtifacts(paths.artifacts);
  const admission = knowledgePolicy(ctx);
  const filter = artifactFilter(ctx, artifacts);
  const files: string[] = [];
  const cleanupFile = path.join(paths.state, "knowledge-retired-blobs.json");
  const retired = new Set<string>();
  try {
    const pending = z.array(z.string().refine(isSha)).safeParse(JSON.parse(fs.readFileSync(cleanupFile, "utf8")));
    if (pending.success) for (const sha of pending.data) retired.add(sha);
  } catch { /* No previous cleanup, or an unreadable queue; current snapshots still get repaired. */ }
  const rewritten = new Map<string, string>();
  let redacted = 0, repointed = 0;
  for (const a of artifacts) {
    let dirty = false;
    if (!a.private && admission.private(a)) { a.private = true; dirty = true; }
    if (admission.admits({ ...a, url: a.detected_from === "transcript" ? a.url : null }) && textSnapshot(a)) {
      const replacements = new Map<string, string>();
      for (const sha of new Set([a.snapshot_blob])) {
        if (!sha || !isSha(sha)) continue;
        try {
          const raw = fs.readFileSync(blobPath(sha), "utf8");
          const clean = filter.text(raw, a.content_type ?? undefined);
          if (raw !== clean) { const next = putBlobBuffer(clean); replacements.set(sha, next); rewritten.set(sha, next); retired.add(sha); }
        } catch (e) { ctx.log(`artifacts: hygiene could not read ${a.id} snapshot ${sha}: ${e instanceof Error ? e.message : String(e)}`); }
      }
      if (replacements.size) {
        a.snapshot_blob = a.snapshot_blob ? replacements.get(a.snapshot_blob) ?? a.snapshot_blob : null;
        // Stop subsequent source refreshes from restoring the unredacted original.
        if (a.local_source) a.source_key = localSourceKey(a.local_source);
        a.local_source = null;
        a.summary = filter.text(a.summary).trim();
        a.notes = filter.text(a.notes).trim();
        const body = a.snapshot_blob ? fs.readFileSync(blobPath(a.snapshot_blob), "utf8") : "";
        const count = body.match(/^Session:/gm)?.length;
        if (count !== undefined) {
          a.summary = a.summary.replace(/for \d+ historical sessions/, `for ${count} historical sessions`);
          a.notes = a.notes.replace(/for \d+ historical sessions/, `for ${count} historical sessions`);
        }
        redacted++; dirty = true;
      }
    }
    if (a.local_source && disposableSource(a.local_source) && (a.snapshot_blob || a.url)) {
      a.source_key = localSourceKey(a.local_source);
      a.local_source = null; repointed++; dirty = true;
    }
    if (dirty) { a.updated = new Date().toISOString(); files.push(writeArtifact(paths.artifacts, a)); }
  }
  // Recovery inventories embed registry records. Follow rewritten hashes there too,
  // so those inventories cannot reopen a retired, unredacted aggregate.
  const resolve = (sha: string) => {
    const seen = new Set<string>();
    while (rewritten.has(sha) && !seen.has(sha)) { seen.add(sha); sha = rewritten.get(sha)!; }
    return sha;
  };
  for (let pass = 0; pass < artifacts.length && rewritten.size; pass++) {
    let changed = false;
    for (const a of artifacts) {
      if (!textSnapshot(a) || !admission.admits({ ...a, url: a.detected_from === "transcript" ? a.url : null })) continue;
      const replacements = new Map<string, string>();
      for (const sha of new Set([a.snapshot_blob])) {
        if (!sha || !isSha(sha)) continue;
        try {
          const raw = fs.readFileSync(blobPath(sha), "utf8");
          const clean = raw.replace(/\b[a-f0-9]{64}\b/g, token => {
            const next = resolve(token);
            return next === sha ? token : next;
          });
          if (raw !== clean) {
            const next = putBlobBuffer(clean);
            replacements.set(sha, next); rewritten.set(sha, next); retired.add(sha); changed = true;
          }
        } catch { /* Missing snapshots remain available for a later repair. */ }
      }
      if (!replacements.size) continue;
      a.snapshot_blob = a.snapshot_blob ? replacements.get(a.snapshot_blob) ?? a.snapshot_blob : null;
      if (a.local_source) a.source_key = localSourceKey(a.local_source);
      a.local_source = null;
      a.updated = new Date().toISOString();
      files.push(writeArtifact(paths.artifacts, a));
    }
    if (!changed) break;
  }
  // Commit first. A failed commit must never destroy the old snapshots.
  const commit = files.length ? commitPaths([...new Set(files)], "knowledge: remove private sources from aggregate snapshots") : null;
  const authoredReferences = (sha: string, dir: string): boolean => {
    let names: fs.Dirent[];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    for (const entry of names) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && authoredReferences(sha, file)) return true;
      if (entry.isFile()) {
        try { if (fs.readFileSync(file).includes(Buffer.from(sha))) return true; } catch { return true; }
      }
    }
    return false;
  };
  const pending: string[] = [];
  for (const sha of retired) {
    const references = artifacts.some(a => a.snapshot_blob === sha);
    const embedded = artifacts.some(a => {
      if (JSON.stringify(a).includes(sha)) return true;
      if (!textSnapshot(a)) return false;
      return [...new Set([a.snapshot_blob])].some(ref => {
        if (!ref || !isSha(ref)) return false;
        try { return fs.readFileSync(blobPath(ref), "utf8").includes(sha); } catch { return true; }
      });
    });
    // Evidence and event logs can retain blob references even when registry records don't.
    const logged = ctx.db.prepare("SELECT 1 FROM events WHERE json LIKE ? LIMIT 1").get(`%${sha}%`);
    if (!references && !embedded && !logged && ![paths.artifacts, paths.missions, paths.proposals, paths.events].some(dir => authoredReferences(sha, dir))) {
      try { fs.rmSync(blobPath(sha), { force: true }); } catch { pending.push(sha); }
    } else pending.push(sha);
  }
  if (retired.size) writeJsonAtomic(cleanupFile, pending);
  if (files.length) ctx.bus.change({ entity: "artifacts" });
  return { redacted, repointed, commit };
}
