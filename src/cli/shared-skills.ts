// Local skill unification. No provider CLI, network or credentials are involved.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export type SkillHome = { name: string; dir: string };
/** `source` is the editable canonical tree; `bundled` holds skills shipped with the code, linked but never imported into. */
export type SharedSkillsOptions = { source: string; bundled?: string; runtime: string; homes: SkillHome[]; accepted?: string };
type SavedLink = { dest: string; target: string; backup: string | null };
type State = { links: SavedLink[] };
const stat = (p: string) => { try { return fs.lstatSync(p); } catch (e: any) { if (e.code === "ENOENT") return null; throw e; } };
const sameLink = (p: string, target: string) => stat(p)?.isSymbolicLink() && fs.readlinkSync(p) === target;
const read = <T>(p: string, fallback: T): T => stat(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : fallback;
function write(p: string, value: unknown) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const temp = p + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temp, p);
}

/** Fingerprint all content, empty directories and executable bits. Follow only the root link. */
export function skillFingerprint(root: string): string {
  const hash = createHash("sha256");
  function walk(dir: string, rel: string) {
    for (const name of fs.readdirSync(dir).sort()) {
      if (name === ".git") continue; // Local repository bookkeeping is backed up, never shared.
      const p = path.join(dir, name), r = rel ? `${rel}/${name}` : name, s = fs.lstatSync(p);
      if (s.isSymbolicLink()) throw new Error(`Skill contains an internal symlink: ${p}. Make a self-contained copy before installing.`);
      hash.update(`${r}\0${s.isDirectory() ? "d" : "f"}\0${s.mode & 0o111}\0`);
      if (s.isDirectory()) walk(p, r);
      else if (s.isFile()) { hash.update(fs.readFileSync(p)); hash.update("\0"); }
      else throw new Error(`Skill contains a special file: ${p}`);
    }
  }
  walk(root, "");
  return hash.digest("hex");
}
function containsSkill(root: string): boolean {
  if (fs.existsSync(path.join(root, "SKILL.md"))) return true;
  return fs.readdirSync(root, { withFileTypes: true }).some(e => e.isDirectory() && !e.name.startsWith(".") && containsSkill(path.join(root, e.name)));
}
function units(dir: string, skip: (p: string) => boolean = () => false): string[] {
  if (!stat(dir)) return [];
  if (!fs.statSync(dir).isDirectory()) throw new Error(`Skills location is not a directory: ${dir}`);
  return fs.readdirSync(dir).sort().filter(n => !n.startsWith(".") && !skip(path.join(dir, n)) && fs.statSync(path.join(dir, n)).isDirectory() && containsSkill(path.join(dir, n)));
}
const stateFile = (o: SharedSkillsOptions) => path.join(o.runtime, "install", "shared-skills.json");

export function sharedSkillsPlan(o: SharedSkillsOptions) {
  // Preflight the entire operation before creating a backup or changing any home.
  for (const h of o.homes) if (stat(h.dir)?.isSymbolicLink()) throw new Error(`Skills root is a symlink: ${h.dir}. Use a real directory with per-skill links before installing.`);
  for (const h of o.homes) if (path.resolve(h.dir) === path.resolve(o.source)) throw new Error("The source and a provider skills directory must be different.");
  const accepted = read<Record<string, string[]>>(o.accepted ?? path.join(o.source, "..", "install", "skills-snapshots.json"), {});
  const existing = read<State>(stateFile(o), { links: [] });
  const managed = new Map(existing.links.map(l => [l.dest, l]));
  // Link target per skill name, and the copy its content is compared against.
  const targets = new Map(units(o.source).map(n => [n, path.join(o.source, n)]));
  if (o.bundled && path.resolve(o.bundled) !== path.resolve(o.source)) for (const n of units(o.bundled)) {
    if (targets.has(n)) throw new Error(`Skill ${n} is in both ${o.source} and ${o.bundled}. Keep one copy before installing.`);
    targets.set(n, path.join(o.bundled, n));
  }
  const copies = new Map(targets);
  for (const source of copies.values()) skillFingerprint(source);
  const imports: { from: string; to: string }[] = [], links: SavedLink[] = [], moves: SavedLink[] = [];
  // Our own links, even dangling after the canonical tree moved, are retargeted below.
  const ours = (p: string) => !!sameLink(p, managed.get(p)?.target ?? "");
  for (const h of o.homes) for (const n of units(h.dir, ours)) {
    const from = path.join(h.dir, n), to = path.join(o.source, n);
    if (!copies.has(n)) { copies.set(n, from); targets.set(n, to); imports.push({ from, to }); }
    else if (!sameLink(from, targets.get(n)!)) {
      const a = skillFingerprint(from), b = skillFingerprint(copies.get(n)!);
      if (a !== b && !accepted[n]?.includes(a)) throw new Error(`Different copies of ${n}: ${from} and ${copies.get(n)}. Review and preserve both before installing; no home was changed.`);
    }
  }
  for (const h of o.homes) for (const n of [...targets.keys()].sort()) {
    const dest = path.join(h.dir, n), target = targets.get(n)!, own = managed.get(dest);
    if (sameLink(dest, target)) { if (own && own.target !== target) moves.push({ ...own, target }); continue; }
    if (own) {
      if (!sameLink(dest, own.target)) throw new Error(`Managed skill changed: ${dest}. Restore its Joyride link before reinstalling; your replacement was kept.`);
      moves.push({ ...own, target }); // the canonical tree moved; the original backup still applies
      continue;
    }
    if (stat(dest) && !fs.statSync(dest).isDirectory()) throw new Error(`Skill path is occupied: ${dest}. Move it aside before installing.`);
    links.push({ dest, target, backup: null });
  }
  return { imports, links, moves, names: [...targets.keys()].sort(), existing };
}

export function installSharedSkills(o: SharedSkillsOptions, dryRun = false): string[] {
  const plan = sharedSkillsPlan(o);
  const lines = [`${dryRun ? "would share" : "share"} ${plan.names.length} skill folders through ${o.source}${o.bundled ? ` and ${o.bundled}` : ""}`, ...plan.imports.map(i => `${dryRun ? "would copy" : "copy"} ${i.from} -> ${i.to}`), ...plan.links.map(l => `${dryRun ? "would link" : "link"} ${l.dest} -> ${l.target}`), ...plan.moves.map(l => `${dryRun ? "would retarget" : "retarget"} ${l.dest} -> ${l.target}`)];
  if (dryRun) return [...lines, "bundled .system skills and hidden archives stay in their provider homes"];
  if (plan.moves.length) retarget(o, plan.existing, plan.moves);
  if (!plan.links.length) return [...lines, "bundled .system skills and hidden archives stay in their provider homes"];
  const backups = path.join(o.runtime, "backups", `shared-skills-${randomUUID()}`);
  fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
  // Every original is backed up before the first replacement, including relative symlinks.
  for (const [i, l] of plan.links.entries()) if (stat(l.dest)) {
    l.backup = path.join(backups, String(i));
    fs.cpSync(l.dest, l.backup, { recursive: true, verbatimSymlinks: true });
  }
  for (const i of plan.imports) fs.cpSync(fs.realpathSync(i.from), i.to, { recursive: true, preserveTimestamps: true, filter: from => path.basename(from) !== ".git" });
  const before = read<State>(stateFile(o), { links: [] });
  const state: State = { links: [...before.links, ...plan.links] };
  write(stateFile(o), state); // Durable undo journal, also usable after interruption.
  const applied: SavedLink[] = [];
  try {
    for (const l of plan.links) {
      fs.mkdirSync(path.dirname(l.dest), { recursive: true });
      applied.push(l);
      fs.rmSync(l.dest, { recursive: true, force: true });
      fs.symlinkSync(l.target, l.dest);
    }
  } catch (error) {
    for (const l of applied.reverse()) {
      fs.rmSync(l.dest, { recursive: true, force: true });
      if (l.backup) fs.cpSync(l.backup, l.dest, { recursive: true, verbatimSymlinks: true });
    }
    write(stateFile(o), before);
    throw error;
  }
  return [...lines, `originals backed up to ${backups}; undo with ./bin/joyride uninstall shared-skills`, "bundled .system skills and hidden archives stayed in their provider homes"];
}

/** Point managed links at a moved canonical tree. All or nothing; originals and backups are untouched. */
function retarget(o: SharedSkillsOptions, existing: State, moves: SavedLink[]) {
  const done: { dest: string; previous: string }[] = [];
  try {
    for (const m of moves) {
      const previous = fs.readlinkSync(m.dest);
      if (previous === m.target) continue;
      done.push({ dest: m.dest, previous });
      fs.unlinkSync(m.dest);
      fs.symlinkSync(m.target, m.dest);
    }
  } catch (error) {
    for (const d of done.reverse()) { fs.rmSync(d.dest, { force: true }); fs.symlinkSync(d.previous, d.dest); }
    throw error;
  }
  const moved = new Map(moves.map(m => [m.dest, m]));
  write(stateFile(o), { links: existing.links.map(l => moved.get(l.dest) ?? l) });
}

export function uninstallSharedSkills(o: SharedSkillsOptions, dryRun = false): string[] {
  const state = read<State>(stateFile(o), { links: [] });
  for (const l of state.links) {
    if (stat(l.dest) && !sameLink(l.dest, l.target)) throw new Error(`Managed skill changed: ${l.dest}. Your replacement was kept; restore its Joyride link before uninstalling.`);
    if (l.backup && !stat(l.backup)) throw new Error(`Missing skill backup: ${l.backup}. Restore it before uninstalling.`);
  }
  if (dryRun) return state.links.map(l => `would restore ${l.dest}${l.backup ? ` from ${l.backup}` : " to absent"}`);
  for (const l of state.links) {
    fs.rmSync(l.dest, { recursive: true, force: true });
    if (l.backup) fs.cpSync(l.backup, l.dest, { recursive: true, verbatimSymlinks: true });
  }
  if (state.links.length) write(stateFile(o), { links: [] });
  return [`restored ${state.links.length} original skill paths; kept canonical skills and backups`];
}

export function sharedSkillsStatus(o: SharedSkillsOptions): string {
  const state = read<State>(stateFile(o), { links: [] });
  return state.links.length ? `${state.links.filter(l => sameLink(l.dest, l.target)).length}/${state.links.length} managed links present` : "absent";
}
