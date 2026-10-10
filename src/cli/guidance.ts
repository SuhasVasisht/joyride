import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { commitPaths } from "../core/gitstore.ts";

export type GuidanceOptions = { root: string; runtime: string; template: string; destinations: string[] };
const Undo = z.object({ source: z.string(), links: z.array(z.object({ file: z.string(), original: z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent") }),
  z.object({ kind: z.literal("file"), backup: z.string(), mode: z.number() }),
  z.object({ kind: z.literal("link"), target: z.string() }),
]) })) });
const source = (o: GuidanceOptions) => path.join(o.root, "guidance", "captain.md");
const manifest = (o: GuidanceOptions) => path.join(o.runtime, "install", "guidance.json");
function stat(file: string) { try { return fs.lstatSync(file); } catch (e) { if (e instanceof Error && "code" in e && e.code === "ENOENT") return null; throw e; } }
function readUndo(o: GuidanceOptions) { return fs.existsSync(manifest(o)) ? Undo.parse(JSON.parse(fs.readFileSync(manifest(o), "utf8"))) : null; }
function checkLinks(undo: z.infer<typeof Undo>) {
  for (const { file } of undo.links) {
    if (!stat(file)?.isSymbolicLink() || fs.readlinkSync(file) !== undo.source) throw new Error(`Guidance link changed at ${file}. Restore the Joyride link before uninstalling; your replacement was kept.`);
  }
}
export function installGuidance(o: GuidanceOptions, dryRun = false): string[] {
  const prior = readUndo(o);
  if (prior && prior.source !== source(o) && stat(source(o))?.isFile()) return relocateGuidance(o, prior, dryRun);
  if (prior) {
    checkLinks(prior);
    if (!stat(prior.source)?.isFile()) throw new Error(`Canonical guidance is missing: ${prior.source}. Restore it or uninstall guidance.`);
    return ["guidance links already installed; canonical edits kept"];
  }
  const file = source(o);
  if (stat(file) && !stat(file)?.isFile()) throw new Error(`Guidance must be a regular file: ${file}`);
  // Preflight both homes before touching either one. Never hide existing global instructions.
  for (const dest of o.destinations) {
    if (stat(dest) && (!fs.statSync(dest).isFile() || fs.readFileSync(dest, "utf8").trim())) throw new Error(`Global instructions already exist at ${dest}. Merge them into ${file} and empty the original before installing guidance.`);
  }
  if (dryRun) return [`would seed ${file} if absent, back up and link ${o.destinations.join(", ")}`];
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(o.template, file);
    commitPaths([file], "guidance: seed captain preferences");
  }
  const backupDir = path.join(o.runtime, "backups", `guidance-${randomUUID()}`);
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const undo: z.infer<typeof Undo> = { source: file, links: o.destinations.map((dest, i) => {
    const st = stat(dest);
    if (!st) return { file: dest, original: { kind: "absent" } };
    if (st.isSymbolicLink()) return { file: dest, original: { kind: "link", target: fs.readlinkSync(dest) } };
    const backup = path.join(backupDir, `${i}.md`);
    fs.copyFileSync(dest, backup); fs.chmodSync(backup, 0o600);
    return { file: dest, original: { kind: "file", backup, mode: st.mode & 0o777 } };
  }) };
  fs.mkdirSync(path.dirname(manifest(o)), { recursive: true });
  fs.writeFileSync(manifest(o), JSON.stringify(undo, null, 2) + "\n", { mode: 0o600 });
  const changed: z.infer<typeof Undo>["links"] = [];
  try {
    for (const link of undo.links) {
      fs.mkdirSync(path.dirname(link.file), { recursive: true });
      changed.push(link);
      if (stat(link.file)) fs.unlinkSync(link.file);
      fs.symlinkSync(file, link.file);
    }
  } catch (error) {
    for (const link of changed) restoreLink(link);
    fs.unlinkSync(manifest(o));
    throw error;
  }
  return [`guidance ${file}; backups ${backupDir}`, ...o.destinations.map(dest => `symlink ${dest} -> ${file}`), "undo with ./bin/joyride uninstall guidance; canonical guidance is kept"];
}
/** The canonical file moved (a new data home): point the installed links at it. Originals and backups are untouched. */
function relocateGuidance(o: GuidanceOptions, prior: z.infer<typeof Undo>, dryRun: boolean): string[] {
  checkLinks(prior);
  const file = source(o);
  if (dryRun) return prior.links.map(l => `would retarget ${l.file} -> ${file}`);
  const done: string[] = [];
  try {
    for (const { file: dest } of prior.links) { fs.unlinkSync(dest); done.push(dest); fs.symlinkSync(file, dest); }
  } catch (error) {
    for (const dest of done) { fs.rmSync(dest, { force: true }); fs.symlinkSync(prior.source, dest); }
    throw error;
  }
  fs.writeFileSync(manifest(o), JSON.stringify({ ...prior, source: file }, null, 2) + "\n", { mode: 0o600 });
  return prior.links.map(l => `retarget ${l.file} -> ${file}`);
}
function restoreLink({ file, original }: z.infer<typeof Undo>["links"][number]) {
  if (stat(file)) fs.unlinkSync(file);
  if (original.kind === "file") { fs.copyFileSync(original.backup, file); fs.chmodSync(file, original.mode); }
  if (original.kind === "link") fs.symlinkSync(original.target, file);
}
export function uninstallGuidance(o: GuidanceOptions, dryRun = false): string[] {
  const undo = readUndo(o);
  if (!undo) return ["no guidance links to undo"];
  checkLinks(undo);
  for (const { original } of undo.links) if (original.kind === "file" && !fs.existsSync(original.backup)) throw new Error(`Guidance backup is missing: ${original.backup}. Restore it before uninstalling.`);
  if (dryRun) return [`would restore ${undo.links.map(l => l.file).join(", ")}; keep canonical guidance and backups`];
  for (const link of undo.links) restoreLink(link);
  fs.unlinkSync(manifest(o));
  return ["restored original global instruction files; kept canonical guidance and backups"];
}
export function guidanceStatus(o: GuidanceOptions): string {
  const n = o.destinations.filter(dest => stat(dest)?.isSymbolicLink() && fs.readlinkSync(dest) === source(o)).length;
  return n ? `${n}/${o.destinations.length} guidance links installed` : "absent";
}
