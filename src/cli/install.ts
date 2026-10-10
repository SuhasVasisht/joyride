// Global footprint installer. Every change outside the repo goes through here:
// idempotent, backed up to .joyride/backups/<ts>/, logged to GLOBAL_CHANGES.md,
// and reversible with `joyride uninstall [component]`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { paths, DAEMON_URL } from "../shared/paths.ts";
import { ensureDir, now } from "../core/util.ts";
import { writeCompiled } from "../modules/guard/compile.ts";
import { extraComponents } from "./install-extra.ts";
import { seedHome } from "../modules/firstmate/seed.ts";
import { checkFirstmateVendor, describeFirstmateVendor } from "../modules/firstmate/vendor.ts";
import { fleetFeedStatus, installFleetFeed, uninstallFleetFeed } from "./fleet-feed.ts";
import { installMcpParity, uninstallMcpParity, mcpParityStatus } from "./mcp-parity.ts";
import { installSharedSkills, uninstallSharedSkills, sharedSkillsStatus } from "./shared-skills.ts";
import { installGuidance, uninstallGuidance, guidanceStatus } from "./guidance.ts";
import { codexHookStatus } from "./hook-status.ts";
import { installNoCaveman, uninstallNoCaveman, noCavemanStatus } from "./no-caveman.ts";

const HOME = os.homedir();
const BUN = fs.existsSync(path.join(HOME, ".bun/bin/bun")) ? path.join(HOME, ".bun/bin/bun") : "bun";
const HOOK = path.join(paths.code, "src/hooks/hook.ts");
const MARK = "joyride/src/hooks/hook.ts";
const CLAUDE_SETTINGS = path.join(paths.claudeDir, "settings.json");
const CODEX_HOOKS = path.join(paths.codexDir, "hooks.json");
const CHANGES = path.join(paths.root, "GLOBAL_CHANGES.md");

const CLAUDE_EVENTS: Record<string, number> = { SessionStart: 10, UserPromptSubmit: 10, PreToolUse: 330, PermissionRequest: 10, Notification: 10, Stop: 10, StopFailure: 10, SessionEnd: 10 };
const CODEX_EVENTS: Record<string, number> = { SessionStart: 10, UserPromptSubmit: 10, PreToolUse: 330, PermissionRequest: 10, Stop: 10, SessionEnd: 3 };

let backupDir: string | null = null;
function backup(file: string) {
  if (!fs.existsSync(file)) return null;
  backupDir ??= ensureDir(path.join(paths.runtime, "backups", now().replace(/[:.]/g, "-")));
  const dest = path.join(backupDir, file.replace(HOME, "~").replace(/[\/~]/g, "_"));
  fs.copyFileSync(file, dest);
  return dest;
}
export function logChange(component: string, action: "install" | "uninstall", lines: string[]) {
  const header = fs.existsSync(CHANGES) ? "" : `# Global changes made by Joyride\n\nEvery change Joyride makes outside this repo is applied by \`joyride install <component>\` and reversed by \`joyride uninstall <component>\`. Backups of edited files live in \`.joyride/backups/<timestamp>/\`.\n\n`;
  fs.appendFileSync(CHANGES, `${header}## ${now()} — ${action} \`${component}\`\n\n${lines.map((l) => `- ${l}`).join("\n")}\n\n`);
}
function sh(cmd: string, args: string[], opts: { allowFail?: boolean; cwd?: string } = {}) {
  try { return execFileSync(cmd, args, { encoding: "utf8", cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, JOYRIDE_GUARD: "off" } }).trim(); }
  catch (e: any) { if (opts.allowFail) return `ERR ${e.stderr || e.message}`; throw e; }
}
function readJson(file: string): any { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {}; }
function writeJson(file: string, v: any) { ensureDir(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(v, null, 2) + "\n"); }
const hookCmd = (agent: string, ev: string) => `"${BUN}" "${HOOK}" ${agent} ${ev}`;
const isOurs = (h: any) => typeof h?.command === "string" && h.command.includes(MARK);

function stripOurs(hooks: Record<string, any[]>) {
  for (const ev of Object.keys(hooks)) {
    hooks[ev] = (hooks[ev] ?? []).map((g: any) => ({ ...g, hooks: (g.hooks ?? []).filter((h: any) => !isOurs(h)) })).filter((g: any) => g.hooks.length);
    if (!hooks[ev].length) delete hooks[ev];
  }
  return hooks;
}

// ---------------------------------------------------------------- components
type Component = { describe: string; install(): string[]; uninstall(): string[]; status(): string; preview?(action: "install" | "uninstall"): string[] };

const sharedSkillsOptions = () => ({
  // Your skill library lives in the data home; Joyride's own worker skills ship with the code.
  source: path.join(paths.root, "skills"), bundled: path.join(paths.code, "skills"), runtime: paths.runtime,
  homes: [
    { name: "claude", dir: path.join(paths.claudeDir, "skills") },
    { name: "codex", dir: path.join(paths.codexDir, "skills") },
    { name: "codex-2", dir: path.join(process.env.JOYRIDE_CODEX_2_DIR ?? path.join(HOME, ".codex-2"), "skills") },
    { name: "cursor", dir: path.join(process.env.JOYRIDE_CURSOR_DIR ?? path.join(HOME, ".cursor"), "skills") },
    { name: "agents", dir: path.join(process.env.JOYRIDE_AGENTS_DIR ?? path.join(HOME, ".agents"), "skills") },
  ],
});
const guidanceOptions = () => ({ root: paths.root, runtime: paths.runtime,
  template: path.join(paths.code, "install", "guidance", "captain.md"),
  destinations: [path.join(paths.claudeDir, "CLAUDE.md"), path.join(paths.codexDir, "AGENTS.md")],
});
const noCavemanOptions = () => ({ settings: CLAUDE_SETTINGS, runtime: paths.runtime });

const symlinkSkill = (src: string, destDir: string, name = path.basename(src)) => {
  ensureDir(destDir);
  const dest = path.join(destDir, name);
  try { const st = fs.lstatSync(dest); if (st.isSymbolicLink()) fs.unlinkSync(dest); else return `skipped ${dest} (exists, not a symlink)`; } catch {}
  fs.symlinkSync(src, dest);
  return `symlink ${dest} -> ${src}`;
};
const unlinkIfOurs = (dest: string, prefix: string) => {
  try { const st = fs.lstatSync(dest); if (st.isSymbolicLink() && fs.readlinkSync(dest).startsWith(prefix)) { fs.unlinkSync(dest); return `removed ${dest}`; } } catch {}
  return null;
};

// ------------------------------------------------- C7: pstack, agents, evals, firstmate
// P-Stack is adapted (never edited in vendor/) into .joyride/pstack/skills by the
// data-driven patches in install/pstack-patches/patches.json, verified free of
// Cursor references, then symlinked. Anything already present that is not our
// symlink is reported as a collision and left alone.
const PSTACK_SRC = () => path.join(paths.vendorCheckout("cursor-plugins", process.env.JOYRIDE_CURSOR_PLUGINS_DIR), "pstack");
const PSTACK_PATCHES = () => path.join(paths.code, "install", "pstack-patches");
const PSTACK_OUT = () => path.join(paths.runtime, "pstack");
const EVALS_SRC = () => paths.vendorCheckout("evals-skills", process.env.JOYRIDE_EVALS_SKILLS_DIR);
export const EVALS_PIN = "80d5f7b0127c7572ed9e9339937adbfd7240ffeb";
const EVALS_SKILLS = ["error-discovery", "eval-audit", "evals-start", "validate-evaluator", "write-judge-prompt", "write-code-eval", "generate-synthetic-data", "build-review-interface", "evaluate-rag"];
const AGENT_MARK = "joyride-managed: pstack agent";
const manifestFile = (c: string) => path.join(paths.runtime, "install", `${c}.json`);
const readManifest = (c: string): { links: { path: string; target: string }[] } => { try { return JSON.parse(fs.readFileSync(manifestFile(c), "utf8")); } catch { return { links: [] }; } };
const writeManifest = (c: string, m: unknown) => { ensureDir(path.dirname(manifestFile(c))); fs.writeFileSync(manifestFile(c), JSON.stringify(m, null, 2) + "\n"); };

export type PstackReplacement = { id: string; find: string; replace: string; regex?: boolean; files?: string[] };
export type PstackPatches = {
  pin: string; skip: Record<string, string>; frontmatter_strip: string[]; frontmatter_set?: Record<string, Record<string, string>>; replace_files: Record<string, string>;
  models_note_template: string; preamble: { when: string; text: string; extra?: Record<string, string> };
  replacements: PstackReplacement[];
  agents: Record<string, { name: string; description: string; model: string; tools: string | null; body_replacements: { find: string; replace: string }[] }>;
  verify: { forbid: { id: string; regex: string; scope?: "frontmatter" }[] };
};
export const loadPstackPatches = (dir = PSTACK_PATCHES()): PstackPatches => JSON.parse(fs.readFileSync(path.join(dir, "patches.json"), "utf8"));
export const pstackVars = () => ({
  MODELS_NOTE: path.join(PSTACK_OUT(), "pstack-models.md"),
  CLAUDE_AGENTS: path.join(paths.claudeDir, "agents"),
  CLAUDE_SKILLS: path.join(paths.claudeDir, "skills"),
});
const fill = (s: string, vars: Record<string, string>) => s.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => vars[k] ?? m);

function walkFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== ".git") out.push(...walkFiles(p, base)); }
    else if (e.isFile()) out.push(path.relative(base, p));
  }
  return out;
}
const isText = (buf: Buffer) => !buf.subarray(0, 8000).includes(0);

/** Drop frontmatter keys (and their indented continuation lines) from a SKILL.md, then set overrides. */
export function stripFrontmatter(text: string, keys: string[], set: Record<string, string> = {}): string {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!m) return text;
  const out: string[] = [];
  let dropping = false;
  for (const line of m[1].split(/\r?\n/)) {
    const k = line.match(/^([A-Za-z0-9_-]+):/)?.[1];
    if (k) dropping = keys.includes(k) || k in set;
    else if (!/^\s/.test(line)) dropping = false;
    if (!dropping) out.push(line);
  }
  const head = [...Object.entries(set).map(([k, v]) => `${k}: ${v}`), ...out];
  return `---\n${head.join("\n")}\n---${m[2]}` + text.slice(m[0].length);
}

function insertPreamble(text: string, preamble: string): string {
  const fm = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  const head = fm ? fm[0] : "";
  const body = text.slice(head.length);
  const h1 = body.match(/^(\s*#\s+[^\n]*\n)/);
  return h1 ? `${head}${h1[1]}\n${preamble}\n${body.slice(h1[1].length)}` : `${head}${preamble}\n\n${body}`;
}

/** Apply ordered replacements to one file's text; counts hits per patch id. */
export function applyReplacements(rel: string, text: string, list: PstackReplacement[], vars: Record<string, string>, hits: Record<string, number> = {}): string {
  const md = rel.endsWith(".md");
  for (const r of list) {
    if (r.files ? !r.files.includes(rel) : !md) continue;
    const rep = fill(r.replace, vars);
    if (r.regex) {
      const re = new RegExp(r.find, "g");
      const n = (text.match(re) ?? []).length;
      if (n) { text = text.replace(re, rep); hits[r.id] = (hits[r.id] ?? 0) + n; }
    } else {
      const parts = text.split(r.find);
      if (parts.length > 1) { text = parts.join(rep); hits[r.id] = (hits[r.id] ?? 0) + parts.length - 1; }
    }
  }
  return text;
}

/** Build adapted skill copies under `out/skills`. Pure apart from writing into `out`. */
export function adaptPstack(o: { src?: string; out?: string; patchesDir?: string; vars?: Record<string, string> } = {}) {
  const src = o.src ?? PSTACK_SRC(), out = o.out ?? PSTACK_OUT(), dir = o.patchesDir ?? PSTACK_PATCHES();
  const patches = loadPstackPatches(dir);
  const vars = o.vars ?? pstackVars();
  const skillsSrc = path.join(src, "skills"), skillsOut = path.join(out, "skills");
  if (!fs.existsSync(skillsSrc)) throw new Error(`P-Stack is not vendored at ${src}. Run ./bin/joyride vendor cursor-plugins.`);
  fs.rmSync(skillsOut, { recursive: true, force: true });
  ensureDir(skillsOut);
  const hits: Record<string, number> = {};
  const skills: string[] = [];
  let files = 0;
  for (const name of fs.readdirSync(skillsSrc).sort()) {
    const from = path.join(skillsSrc, name);
    if (!fs.existsSync(path.join(from, "SKILL.md")) || patches.skip[name]) continue;
    skills.push(name);
    for (const rel of walkFiles(from)) {
      const relSkill = `${name}/${rel}`;
      const dest = path.join(skillsOut, name, rel);
      ensureDir(path.dirname(dest));
      const replacement = patches.replace_files[relSkill];
      const buf = replacement ? fs.readFileSync(path.join(dir, replacement)) : fs.readFileSync(path.join(from, rel));
      if (!isText(buf)) { fs.writeFileSync(dest, buf); fs.chmodSync(dest, fs.statSync(path.join(from, rel)).mode); files++; continue; }
      let text = buf.toString("utf8");
      if (replacement) text = fill(text, vars);
      if (rel === "SKILL.md") text = stripFrontmatter(text, patches.frontmatter_strip, patches.frontmatter_set?.[name]);
      text = applyReplacements(relSkill, text, patches.replacements, vars, hits);
      if (rel === "SKILL.md") {
        const extra = patches.preamble.extra?.[name];
        const wants = new RegExp(patches.preamble.when, "i").test(text);
        const pre = [wants ? fill(patches.preamble.text, vars) : null, extra ? fill(extra, vars) : null].filter(Boolean).join("\n>\n");
        if (pre) text = insertPreamble(text, pre);
      }
      fs.writeFileSync(dest, text);
      fs.chmodSync(dest, fs.statSync(path.join(from, rel)).mode);
      files++;
    }
  }
  const unused = patches.replacements.filter((r) => !hits[r.id]).map((r) => r.id);
  return { out: skillsOut, skills, skipped: patches.skip, files, hits, unused };
}

/** Lines in the adapted tree that still reference Cursor (paths, models, tools, plugins). */
export function verifyPstack(dir: string, patchesDir = PSTACK_PATCHES()) {
  const rules = loadPstackPatches(patchesDir).verify.forbid.map((f) => ({ ...f, re: new RegExp(f.regex) }));
  const found: { file: string; line: number; rule: string; text: string }[] = [];
  for (const rel of walkFiles(dir)) {
    const buf = fs.readFileSync(path.join(dir, rel));
    if (!isText(buf)) continue;
    const lines = buf.toString("utf8").split(/\r?\n/);
    const fmEnd = path.basename(rel) === "SKILL.md" && lines[0] === "---" ? lines.indexOf("---", 1) : -1;
    lines.forEach((l, i) => {
      for (const r of rules) {
        if (r.scope === "frontmatter" && !(i > 0 && i < fmEnd)) continue;
        if (r.re.test(l)) found.push({ file: rel, line: i + 1, rule: r.id, text: l.trim().slice(0, 160) });
      }
    });
  }
  return found;
}

/** Claude Code custom-agent file from a pstack agent (frontmatter rewritten, marker appended). */
export function adaptAgent(text: string, spec: PstackPatches["agents"][string], vars: Record<string, string>): string {
  let body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  for (const r of spec.body_replacements) body = body.split(r.find).join(fill(r.replace, vars));
  body = body.replace(/\bgeneralPurpose\b/g, "general-purpose");
  const fm = [`name: ${spec.name}`, `description: ${JSON.stringify(spec.description)}`, `model: ${spec.model}`, ...(spec.tools ? [`tools: ${spec.tools}`] : [])];
  return `---\n${fm.join("\n")}\n---\n${body.replace(/\s+$/, "")}\n\n<!-- ${AGENT_MARK} (joyride install agents); joyride uninstall agents removes this file -->\n`;
}

/** Symlink src into destDir/name unless something that is not ours is already there. */
function linkInto(src: string, destDir: string, name: string, ours: (target: string) => boolean, target = src): { line: string; created: boolean; collision: boolean } {
  ensureDir(destDir);
  const dest = path.join(destDir, name);
  let st: fs.Stats | null = null;
  try { st = fs.lstatSync(dest); } catch {}
  if (st) {
    if (!st.isSymbolicLink() || !ours(fs.readlinkSync(dest))) return { line: `skipped ${dest} (already exists and is not a Joyride link)`, created: false, collision: true };
    if (fs.readlinkSync(dest) === target) return { line: `kept ${dest} -> ${target}`, created: false, collision: false };
    fs.unlinkSync(dest);
  }
  fs.symlinkSync(target, dest);
  return { line: `symlink ${dest} -> ${target}`, created: true, collision: false };
}

function gitHead(dir: string): string | null { const h = sh("git", ["-C", dir, "rev-parse", "HEAD"], { allowFail: true }); return h.startsWith("ERR") ? null : h; }

const crewComponents: Record<string, Component> = {
  pstack: {
    describe: "P-Stack skills adapted for Claude Code and Codex (all but swarm, recall, correct, reflect), symlinked into ~/.claude/skills and ~/.codex/skills",
    install() {
      const out: string[] = [];
      const patches = loadPstackPatches();
      const head = gitHead(paths.vendorCheckout("cursor-plugins", process.env.JOYRIDE_CURSOR_PLUGINS_DIR));
      out.push(head === patches.pin ? `vendor/cursor-plugins at pin ${patches.pin.slice(0, 7)}` : `WARNING vendor/cursor-plugins is at ${head ?? "unknown"}, patches target ${patches.pin.slice(0, 7)}`);
      const note = pstackVars().MODELS_NOTE;
      ensureDir(path.dirname(note));
      if (!fs.existsSync(note)) { fs.writeFileSync(note, fs.readFileSync(path.join(PSTACK_PATCHES(), patches.models_note_template))); out.push(`wrote models note ${note} (every role: opus)`); }
      else out.push(`kept models note ${note}`);
      const r = adaptPstack();
      out.push(`adapted ${r.skills.length} skills (${r.files} files) into ${r.out}; skipped ${Object.entries(r.skipped).map(([k, v]) => `${k} (${v})`).join(", ")}`);
      if (r.unused.length) out.push(`patches that matched nothing (upstream changed?): ${r.unused.join(", ")}`);
      const bad = verifyPstack(r.out);
      if (bad.length) throw new Error(`pstack adaptation left ${bad.length} Cursor references; nothing was linked:\n${bad.slice(0, 20).map((b) => `  ${b.file}:${b.line} [${b.rule}] ${b.text}`).join("\n")}`);
      out.push("verified: no Cursor paths, model slugs, Task tool, cursor-team-kit, deslop or control-cli/ui references remain");
      const ours = (t: string) => t.startsWith(r.out + path.sep);
      const collisions: string[] = [];
      let created = 0;
      for (const name of r.skills) {
        for (const dir of [path.join(paths.claudeDir, "skills"), path.join(paths.codexDir, "skills")]) {
          const l = linkInto(path.join(r.out, name), dir, name, ours);
          if (l.collision) collisions.push(path.join(dir, name));
          if (l.created) created++;
        }
      }
      out.push(`linked ${r.skills.length} skills into ${path.join(paths.claudeDir, "skills")} and ${path.join(paths.codexDir, "skills")} (${created} new symlinks)`);
      out.push(collisions.length ? `collisions skipped: ${collisions.join(", ")}` : "collisions skipped: none");
      return out;
    },
    uninstall() {
      const out: string[] = [];
      const prefix = path.join(PSTACK_OUT(), "skills") + path.sep;
      for (const dir of [path.join(paths.claudeDir, "skills"), path.join(paths.codexDir, "skills")]) {
        if (!fs.existsSync(dir)) continue;
        for (const n of fs.readdirSync(dir)) { const r = unlinkIfOurs(path.join(dir, n), prefix); if (r) out.push(r); }
      }
      out.push(`kept the adapted copies in ${PSTACK_OUT()} (local runtime)`);
      return out;
    },
    status() {
      const dir = path.join(paths.claudeDir, "skills");
      const prefix = path.join(PSTACK_OUT(), "skills") + path.sep;
      let n = 0;
      try { for (const x of fs.readdirSync(dir)) { try { if (fs.readlinkSync(path.join(dir, x)).startsWith(prefix)) n++; } catch {} } } catch {}
      return n ? `${n} skills linked` : "absent";
    },
  },

  agents: {
    describe: "P-Stack agents (poteto-agent, comment-sicko) as Claude Code custom agents in ~/.claude/agents",
    install() {
      const patches = loadPstackPatches(), vars = pstackVars();
      const dir = path.join(paths.claudeDir, "agents");
      ensureDir(dir);
      const out: string[] = [];
      for (const [file, spec] of Object.entries(patches.agents)) {
        const dest = path.join(dir, `${spec.name}.md`);
        if (fs.existsSync(dest) && !fs.readFileSync(dest, "utf8").includes(AGENT_MARK)) { out.push(`skipped ${dest} (already exists and is not Joyride's)`); continue; }
        fs.writeFileSync(dest, adaptAgent(fs.readFileSync(path.join(PSTACK_SRC(), "agents", file), "utf8"), spec, vars));
        out.push(`wrote ${dest} (from pstack agents/${file}; model ${spec.model}; tools ${spec.tools ?? "inherited"})`);
      }
      return out;
    },
    uninstall() {
      const dir = path.join(paths.claudeDir, "agents");
      const out: string[] = [];
      for (const spec of Object.values(loadPstackPatches().agents)) {
        const f = path.join(dir, `${spec.name}.md`);
        try { if (fs.readFileSync(f, "utf8").includes(AGENT_MARK)) { fs.unlinkSync(f); out.push(`removed ${f}`); } } catch {}
      }
      return out;
    },
    status() {
      const dir = path.join(paths.claudeDir, "agents");
      const n = Object.values(loadPstackPatches().agents).filter((s) => { try { return fs.readFileSync(path.join(dir, `${s.name}.md`), "utf8").includes(AGENT_MARK); } catch { return false; } }).length;
      return n ? `${n} agents installed` : "absent";
    },
  },

  evals: {
    describe: "ai-evals-course/evals-skills: add write-code-eval to ~/.claude/skills and link all nine into ~/.codex/skills",
    install() {
      const out: string[] = [];
      const src = EVALS_SRC();
      if (!fs.existsSync(path.join(src, "skills"))) {
        sh("git", ["clone", "-q", "https://github.com/ai-evals-course/evals-skills", src]);
        sh("git", ["-C", src, "checkout", "-q", EVALS_PIN]);
        out.push(`cloned evals-skills into ${src} at ${EVALS_PIN.slice(0, 7)}`);
      }
      const head = gitHead(src);
      out.push(head === EVALS_PIN ? `vendor/evals-skills at pin ${EVALS_PIN.slice(0, 7)}` : `WARNING vendor/evals-skills is at ${head ?? "unknown"}, pin is ${EVALS_PIN.slice(0, 7)}`);
      const claude = path.join(paths.claudeDir, "skills"), codex = path.join(paths.codexDir, "skills");
      const manifest = readManifest("evals");
      const drift: string[] = [];
      for (const name of EVALS_SKILLS) {
        const vendored = path.join(src, "skills", name);
        const l = linkInto(vendored, claude, name, (t) => t.startsWith(path.join(src, "skills") + path.sep));
        if (l.created) { out.push(l.line); manifest.links.push({ path: path.join(claude, name), target: vendored }); }
        else if (l.collision) {
          try { if (fs.readFileSync(path.join(claude, name, "SKILL.md"), "utf8") !== fs.readFileSync(path.join(vendored, "SKILL.md"), "utf8")) drift.push(name); } catch {}
        }
      }
      out.push(drift.length ? `kept your existing copies in ${claude} that differ from the pin (not replaced): ${drift.join(", ")}` : `existing copies in ${claude} match the pin`);
      // Follow the existing convention: ~/.codex/skills/<name> -> ../../.claude/skills/<name>.
      for (const name of EVALS_SKILLS) {
        const rel = path.relative(codex, path.join(claude, name));
        const mine = manifest.links.some((m) => m.path === path.join(codex, name));
        const l = linkInto(path.join(claude, name), codex, name, (t) => mine && t === rel, rel);
        if (l.created) { out.push(l.line); if (!mine) manifest.links.push({ path: path.join(codex, name), target: rel }); }
        else if (l.collision) out.push(`collision skipped: ${path.join(codex, name)} already exists`);
      }
      writeManifest("evals", manifest);
      return out;
    },
    uninstall() {
      const out: string[] = [];
      const manifest = readManifest("evals");
      for (const m of manifest.links) {
        try { const st = fs.lstatSync(m.path); if (st.isSymbolicLink() && fs.readlinkSync(m.path) === m.target) { fs.unlinkSync(m.path); out.push(`removed ${m.path}`); } } catch {}
      }
      writeManifest("evals", { links: [] });
      return out.length ? out : ["nothing to remove"];
    },
    status() {
      const codex = path.join(paths.codexDir, "skills"), claude = path.join(paths.claudeDir, "skills");
      const inClaude = EVALS_SKILLS.filter((n) => fs.existsSync(path.join(claude, n, "SKILL.md"))).length;
      const inCodex = EVALS_SKILLS.filter((n) => fs.existsSync(path.join(codex, n, "SKILL.md"))).length;
      return `claude ${inClaude}/9, codex ${inCodex}/9`;
    },
  },

  firstmate: {
    describe: "Firstmate pin check and FM_HOME skeleton (.joyride/firstmate: herdr backend, Claude crew, local-only, joyride-evidence brief rules)",
    install() {
      const out: string[] = [];
      out.push(describeFirstmateVendor(checkFirstmateVendor(paths.firstmateDir)));
      const r = seedHome(paths.firstmateHome, { evidenceBin: path.join(paths.code, "bin", "joyride-evidence") });
      out.push(`FM_HOME ${r.home}: created ${r.created.join(", ") || "nothing"}${r.kept.length ? `; kept ${r.kept.join(", ")}` : ""}`);
      out.push("no global files changed: Firstmate runs only when started from Joyride (POST /api/firstmate/start), in its own Herdr pane");
      const feed = fleetFeedStatus(r.home);
      out.push(`fleet ${feed}${feed === "feed bound and registered" ? "" : ": bind it with ./bin/joyride install firstmate-feed"}`);
      return out;
    },
    uninstall() { return [`kept FM_HOME ${paths.firstmateHome} (local runtime state with Firstmate's backlog; delete it by hand for a clean home)`]; },
    status() {
      const home = paths.firstmateHome;
      const backend = (() => { try { return fs.readFileSync(path.join(home, "config", "backend"), "utf8").trim(); } catch { return null; } })();
      const v = checkFirstmateVendor(paths.firstmateDir);
      const pin = v.state === "pinned" ? `pinned${v.applied.length ? ` + ${v.applied.length} local patch${v.applied.length > 1 ? "es" : ""}` : ""}` : v.state === "unpatched" ? `pinned, missing patches ${v.missing.join(", ")}` : v.state === "missing" ? "missing" : "pin mismatch";
      return `${pin} ${v.head?.slice(0, 7) ?? ""}`.trim() + `, FM_HOME ${backend ? `backend ${backend}` : "not seeded"}, ${fleetFeedStatus(home)}`;
    },
  },

  // The joyride-fleet-feed Firstmate extension (src/cli/fleet-feed.ts): fleet events reach Firstmate as
  // process-event results. The package copy under ~/.local/share is the only file outside the repo.
  "firstmate-feed": {
    describe: "joyride-fleet-feed: Firstmate extension that brings fleet events (watched sessions needing attention, helm changes) to Firstmate",
    install() {
      const r = installFleetFeed({ home: paths.firstmateHome, firstmateDir: paths.firstmateDir, daemonUrl: DAEMON_URL });
      return r.lines;
    },
    uninstall() { return uninstallFleetFeed({ firstmateDir: paths.firstmateDir }); },
    status() { return fleetFeedStatus(paths.firstmateHome); },
  },
};

export const components: Record<string, Component> = {
  guidance: {
    describe: "Captain guidance linked into Claude and Codex global instructions, backed up and reversible",
    install: () => installGuidance(guidanceOptions()),
    uninstall: () => uninstallGuidance(guidanceOptions()),
    status: () => guidanceStatus(guidanceOptions()),
    preview: action => action === "install" ? installGuidance(guidanceOptions(), true) : uninstallGuidance(guidanceOptions(), true),
  },
  "mcp-parity": {
    describe: "Joyride MCP manifest rendered into Claude Code, both Codex homes and Cursor; independent authentication",
    install: () => installMcpParity(),
    uninstall: () => uninstallMcpParity(),
    status: mcpParityStatus,
    preview: (action) => action === "install" ? installMcpParity({ dryRun: true }) : uninstallMcpParity({ dryRun: true }),
  },
  hooks: {
    describe: "Claude Code + Codex hooks (event capture, PreToolUse blast-radius guard, task notes at SessionStart)",
    install() {
      writeCompiled();
      const out: string[] = [];
      const b1 = backup(CLAUDE_SETTINGS);
      const s = readJson(CLAUDE_SETTINGS);
      s.hooks = stripOurs(s.hooks ?? {});
      for (const [ev, timeout] of Object.entries(CLAUDE_EVENTS)) {
        (s.hooks[ev] ??= []).push({ ...(ev === "PreToolUse" || ev === "PermissionRequest" ? { matcher: "*" } : {}), hooks: [{ type: "command", command: hookCmd("claude", ev), timeout }] });
      }
      writeJson(CLAUDE_SETTINGS, s);
      out.push(`edited ${CLAUDE_SETTINGS}: hooks ${Object.keys(CLAUDE_EVENTS).join(", ")} -> ${HOOK}${b1 ? ` (backup ${b1})` : ""}`);
      const b2 = backup(CODEX_HOOKS);
      const c = readJson(CODEX_HOOKS);
      c.hooks = stripOurs(c.hooks ?? {});
      for (const [ev, timeout] of Object.entries(CODEX_EVENTS)) (c.hooks[ev] ??= []).push({ hooks: [{ type: "command", command: hookCmd("codex", ev), timeout }] });
      writeJson(CODEX_HOOKS, c);
      out.push(`edited ${CODEX_HOOKS}: hooks ${Object.keys(CODEX_EVENTS).join(", ")}${b2 ? ` (backup ${b2})` : ""}`);
      out.push("Codex requires trusting new hooks once: run `/hooks` inside Codex and approve the joyride entries");
      out.push(`compiled guard policy -> ${paths.guardCompiled}`);
      return out;
    },
    uninstall() {
      const out: string[] = [];
      for (const f of [CLAUDE_SETTINGS, CODEX_HOOKS]) {
        if (!fs.existsSync(f)) continue;
        backup(f);
        const s = readJson(f);
        s.hooks = stripOurs(s.hooks ?? {});
        writeJson(f, s);
        out.push(`removed joyride hooks from ${f}`);
      }
      return out;
    },
    status() {
      const s = readJson(CLAUDE_SETTINGS), c = readJson(CODEX_HOOKS);
      const count = (h: any) => Object.values(h ?? {}).flat().flatMap((g: any) => g.hooks ?? []).filter(isOurs).length;
      return `claude hooks: ${count(s.hooks)}/${Object.keys(CLAUDE_EVENTS).length}, codex hooks: ${count(c.hooks)}/${Object.keys(CODEX_EVENTS).length}`;
    },
  },

  mcp: {
    describe: "Remove the retired joyride-memory MCP registration from Claude Code and Codex",
    preview: () => ["Back up Claude and Codex config files, then run claude mcp remove --scope user joyride-memory and codex mcp remove joyride-memory; log removal in GLOBAL_CHANGES.md"],
    install() { throw new Error("Joyride memory was retired. Run joyride uninstall mcp to remove old registrations."); },
    uninstall() {
      const backups = [path.join(process.env.JOYRIDE_MCP_HOME ?? HOME, ".claude.json"), CLAUDE_SETTINGS, path.join(paths.codexDir, "config.toml")].flatMap(file => { const saved = backup(file); return saved ? [`backup ${file} -> ${saved}`] : []; });
      return [
        ...backups,
        `claude mcp remove joyride-memory: ${sh("claude", ["mcp", "remove", "--scope", "user", "joyride-memory"], { allowFail: true }).slice(0, 120)}`,
        `codex mcp remove joyride-memory: ${sh("codex", ["mcp", "remove", "joyride-memory"], { allowFail: true }).slice(0, 120)}`,
      ];
    },
    status() {
      return "retired; run joyride uninstall mcp to remove old registrations";
    },
  },

  skills: {
    describe: "Joyride worker skills (joyride-evidence, joyride-verify) for Claude Code and Codex",
    install() {
      if (sharedSkillsStatus(sharedSkillsOptions()) !== "absent") return ["shared skill links kept; use ./bin/joyride install shared-skills to update the shared set"];
      const out: string[] = [];
      for (const name of ["joyride-evidence", "joyride-verify"]) {
        const src = path.join(paths.code, "skills", name);
        if (!fs.existsSync(path.join(src, "SKILL.md"))) continue;
        out.push(symlinkSkill(src, path.join(paths.claudeDir, "skills")));
        out.push(symlinkSkill(src, path.join(paths.codexDir, "skills")));
      }
      return out;
    },
    uninstall() {
      if (sharedSkillsStatus(sharedSkillsOptions()) !== "absent") return ["shared skill links kept; use ./bin/joyride uninstall shared-skills to restore the original provider copies"];
      const out: string[] = [];
      for (const dir of [path.join(paths.claudeDir, "skills"), path.join(paths.codexDir, "skills")]) {
        if (!fs.existsSync(dir)) continue;
        for (const n of fs.readdirSync(dir)) { const r = unlinkIfOurs(path.join(dir, n), path.join(paths.code, "skills")); if (r) out.push(r); }
      }
      return out;
    },
    status() { return fs.existsSync(path.join(paths.claudeDir, "skills", "joyride-evidence")) ? "installed" : "absent"; },
  },

  "shared-skills": {
    describe: "One Joyride-owned skills tree, linked into Claude, both Codex logins, Cursor and .agents; backs up originals and restores them on uninstall",
    install() { return installSharedSkills(sharedSkillsOptions()); },
    uninstall() { return uninstallSharedSkills(sharedSkillsOptions()); },
    status() { return sharedSkillsStatus(sharedSkillsOptions()); },
    preview(action) { return action === "install" ? installSharedSkills(sharedSkillsOptions(), true) : uninstallSharedSkills(sharedSkillsOptions(), true); },
  },
  "no-caveman": {
    describe: "Disable Claude's caveman plugin and remove its status line with a backup and targeted undo",
    install() { return installNoCaveman(noCavemanOptions()); },
    uninstall() { return uninstallNoCaveman(noCavemanOptions()); },
    status() { return noCavemanStatus(noCavemanOptions()); },
    preview(action) { return action === "install" ? installNoCaveman(noCavemanOptions(), true) : uninstallNoCaveman(noCavemanOptions(), true); },
  },

  herdr: {
    describe: "Upgrade Herdr to the current stable release (0.9.1 -> 0.9.3+)",
    install() {
      const before = sh(paths.herdrBin, ["--version"], { allowFail: true });
      const r = sh("brew", ["upgrade", "herdr"], { allowFail: true });
      const after = sh(paths.herdrBin, ["--version"], { allowFail: true });
      return [`brew upgrade herdr: ${before} -> ${after}`, r.slice(-200)];
    },
    uninstall() { return ["herdr upgrade is not reverted automatically (brew has no downgrade); reinstall a pinned version manually if needed"]; },
    status() { return sh(paths.herdrBin, ["--version"], { allowFail: true }); },
  },
  ...crewComponents,
  ...extraComponents,
};

export function install(names: string[], dryRun = false) {
  // Reject unsupported previews before doing anything (including earlier components).
  if (dryRun) for (const n of names) if (!components[n]?.preview) throw new Error(`dry-run is not supported for ${n}; choose a component with a preview`);
  for (const n of names) {
    const comp = components[n];
    if (!comp) throw new Error(`unknown component ${n}; known: ${Object.keys(components).join(", ")}`);
    const lines = dryRun ? comp.preview!("install") : comp.install();
    if (!dryRun) logChange(n, "install", lines);
    console.log(`✓ ${n}\n  ${lines.join("\n  ")}`);
  }
}
export function uninstall(names: string[], dryRun = false) {
  if (dryRun) for (const n of names) if (!components[n]?.preview) throw new Error(`dry-run is not supported for ${n}; choose a component with a preview`);
  for (const n of names) {
    const comp = components[n];
    if (!comp) throw new Error(`unknown component ${n}`);
    const lines = dryRun ? comp.preview!("uninstall") : comp.uninstall();
    if (!dryRun) logChange(n, "uninstall", lines);
    console.log(`✓ removed ${n}\n  ${lines.join("\n  ")}`);
  }
}
export function status() {
  for (const [n, c] of Object.entries(components)) console.log(`${n.padEnd(10)} ${c.status()}`);
  console.log(codexHookStatus(paths.events));
  if (process.env.CODEX_HOME && path.resolve(process.env.CODEX_HOME) !== path.resolve(paths.codexDir)) {
    console.log(`Codex active home ${process.env.CODEX_HOME} differs from installer home ${paths.codexDir}. Inspect /hooks in that login; install there with JOYRIDE_CODEX_DIR="$CODEX_HOME" ./bin/joyride install hooks.`);
  }
}
