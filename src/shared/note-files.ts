// Authored board items: one markdown document per note, with place and identity
// in frontmatter. No memory module, index or daemon is needed to read these files.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import matter from "gray-matter";
import YAML from "yaml";
import { z } from "zod";
import { parseNoteScope } from "./notes.ts";

export const NoteFile = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,120}$/i),
  kind: z.literal("note").default("note"),
  title: z.string(),
  scope: z.string().refine(s => parseNoteScope(s) !== null, "Use a note place such as global or mission:<idea>."),
  status: z.enum(["active", "archived"]).default("active"),
  created: z.string(),
  updated: z.string().nullable().default(null),
  provenance: z.object({ type: z.string(), ref: z.string() }),
  private: z.boolean().optional(),
  tags: z.array(z.string()).default([]),
  body: z.string(),
});
export type NoteFile = z.infer<typeof NoteFile>;
const engines = { yaml: { parse: (s: string) => YAML.parse(s), stringify: (v: object) => YAML.stringify(v) } };

export function parseNoteFile(text: string): NoteFile {
  const { data, content } = matter(text, { engines });
  return NoteFile.parse({ ...data, updated: data.updated ?? data.verified_at ?? null, body: content.trim() });
}
export function noteFile(dir: string, id: string): string {
  const checked = NoteFile.shape.id.parse(id);
  return path.join(dir, `${checked}.md`);
}
export function readNoteFile(dir: string, id: string): NoteFile | null {
  try { return parseNoteFile(fs.readFileSync(noteFile(dir, id), "utf8")); } catch { return null; }
}
export function loadNoteFiles(dir: string): { notes: NoteFile[]; errors: string[] } {
  const notes: NoteFile[] = [], errors: string[] = [];
  if (!fs.existsSync(dir)) return { notes, errors };
  let names: string[];
  try { names = fs.readdirSync(dir).filter(n => n.endsWith(".md")).sort(); }
  catch (e) { return { notes, errors: [`Could not read notes folder: ${e instanceof Error ? e.message : String(e)}`] }; }
  for (const name of names) {
    try {
      const note = parseNoteFile(fs.readFileSync(path.join(dir, name), "utf8"));
      if (`${note.id}.md` !== name) throw new Error("The file name must match the note id.");
      notes.push(note);
    } catch (e) { errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return { notes, errors };
}
export function writeNoteFile(dir: string, input: NoteFile): string {
  const note = NoteFile.parse(input);
  const { body, ...front } = note;
  const file = noteFile(dir, note.id);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `---\n${YAML.stringify(front, { lineWidth: 0 })}---\n\n${body.trim()}\n`);
  fs.renameSync(tmp, file);
  return file;
}
export function newNoteId(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "entry";
  return `note-${slug}-${crypto.randomBytes(3).toString("hex")}`;
}
/** Retain the existing HTTP shape while keeping memory lifecycle fields out of authored files. */
export function noteEntry(n: NoteFile) {
  return { ...n, confidence: 1, verified_at: n.updated, supersedes: [], superseded_by: null, anchors: [],
    support: [], source_hash: null, firstmate: null, stale: false, stale_commits: [], quarantined: false };
}

/** Copy legacy notes once. An existing destination, including an unreadable one,
 * always wins so a retained memory entry can never undo a captain's edit. */
export function migrateNoteFiles(legacyDir: string, dir: string): { files: string[]; errors: string[] } {
  const files: string[] = [], errors: string[] = [];
  if (!fs.existsSync(legacyDir)) return { files, errors };
  let names: string[];
  try { names = fs.readdirSync(legacyDir).filter(n => n.endsWith(".md")).sort(); }
  catch (e) { return { files, errors: [`Could not read legacy notes folder: ${e instanceof Error ? e.message : String(e)}`] }; }
  for (const name of names) {
    try {
      const text = fs.readFileSync(path.join(legacyDir, name), "utf8");
      const { data } = matter(text, { engines });
      if (data.kind !== "note") continue;
      const note = parseNoteFile(text);
      if (!fs.existsSync(noteFile(dir, note.id))) files.push(writeNoteFile(dir, note));
    } catch (e) { errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return { files, errors };
}
