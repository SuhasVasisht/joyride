// Extra installer components: the always-on daemon (launchd), backpass's acpx
// dependency, and one component per Firstmate tool (gh, treehouse, tasks-axi, ...)
// installed the way Firstmate's own bootstrap would. Registered into the main
// component table in install.ts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { paths } from "../shared/paths.ts";
import { ensureDir, now } from "../core/util.ts";
import { FM_TOOL_SPECS, INSTALLABLE_TOOLS, findTool, installCommand, minNode, parseVersion, pickNode, type ToolSpec, type Ver } from "../modules/system/tools.ts";

const HOME = os.homedir();
import { installService, uninstallService, serviceStatus } from "./service.ts";


function sh(cmd: string, args: string[], allowFail = true, env?: NodeJS.ProcessEnv) {
  try { return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, JOYRIDE_GUARD: "off", ...(env ?? {}) } }).trim(); }
  catch (e: any) { if (allowFail) return `ERR ${(e.stderr || e.message || "").toString().trim()}`; throw e; }
}
function node22Bin(): string | null {
  const root = path.join(HOME, ".nvm", "versions", "node");
  try {
    const v = fs.readdirSync(root).filter((x) => /^v(2[2-9]|[3-9]\d)\./.test(x)).sort().reverse()[0];
    return v ? path.join(root, v, "bin") : null;
  } catch { return null; }
}

// ------------------------------------------------------------ Firstmate tools
// Output of the package managers streams straight through (stdio inherit), so a caller that
// runs `joyride install <tool>` as a child process (the setup page) sees progress live.
type ToolManifest = { tool: string; method: string; preexisting: string | null; bin: string | null; node_dir?: string; wrapper?: string; hooks?: boolean; backups?: string[]; at: string };
const toolManifest = (t: string) => path.join(paths.runtime, "install", `tool-${t}.json`);
const readToolManifest = (t: string): ToolManifest | null => { try { return JSON.parse(fs.readFileSync(toolManifest(t), "utf8")); } catch { return null; } };
const writeToolManifest = (m: ToolManifest) => { ensureDir(path.dirname(toolManifest(m.tool))); fs.writeFileSync(toolManifest(m.tool), JSON.stringify(m, null, 2) + "\n"); };
const LOCAL_BIN = path.join(HOME, ".local", "bin");

function stream(cmd: string, args: string[], env: NodeJS.ProcessEnv = {}): number {
  process.stdout.write(`$ ${[cmd, ...args].join(" ")}\n`);
  const r = spawnSync(cmd, args, { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, JOYRIDE_GUARD: "off", ...env } });
  if (r.error) { process.stdout.write(`${r.error.message}\n`); return 127; }
  return r.status ?? 1;
}
let toolBackupDir: string | null = null;
function backupFile(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  toolBackupDir ??= ensureDir(path.join(paths.runtime, "backups", now().replace(/[:.]/g, "-")));
  const dest = path.join(toolBackupDir, file.replace(HOME, "~").replace(/[\/~]/g, "_"));
  fs.copyFileSync(file, dest);
  return dest;
}
function nodeCandidates(): { dir: string; version: Ver | null }[] {
  const out: { dir: string; version: Ver | null }[] = [];
  const add = (dir: string) => {
    if (out.some((c) => c.dir === dir) || !fs.existsSync(path.join(dir, "node"))) return;
    out.push({ dir, version: parseVersion(sh(path.join(dir, "node"), ["--version"])) });
  };
  const onPath = findTool("node");
  if (onPath) add(path.dirname(fs.realpathSync(onPath.path)));
  const nvm = path.join(HOME, ".nvm", "versions", "node");
  try { for (const v of fs.readdirSync(nvm).sort((a, b) => (parseVersion(b)?.[0] ?? 0) - (parseVersion(a)?.[0] ?? 0))) add(path.join(nvm, v, "bin")); } catch {}
  add("/opt/homebrew/bin");
  return out;
}
/** Strip SessionStart (or other) hook entries whose command mentions the tool, from the Claude and Codex hook files. */
function stripToolHooks(tool: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`(^|[^A-Za-z0-9_-])${tool.replace(/[-]/g, "\\-")}([^A-Za-z0-9_-]|$)`);
  for (const f of [path.join(paths.claudeDir, "settings.json"), path.join(paths.codexDir, "hooks.json")]) {
    if (!fs.existsSync(f)) continue;
    let j: any;
    try { j = JSON.parse(fs.readFileSync(f, "utf8")); } catch { continue; }
    let n = 0;
    for (const ev of Object.keys(j.hooks ?? {})) {
      j.hooks[ev] = (j.hooks[ev] ?? []).map((g: any) => ({ ...g, hooks: (g.hooks ?? []).filter((h: any) => { const hit = typeof h?.command === "string" && re.test(h.command); if (hit) n++; return !hit; }) })).filter((g: any) => g.hooks.length);
      if (!j.hooks[ev].length) delete j.hooks[ev];
    }
    if (n) { const b = backupFile(f); fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n"); out.push(`removed ${n} ${tool} hook${n > 1 ? "s" : ""} from ${f}${b ? ` (backup ${b})` : ""}`); }
  }
  return out;
}

function installTool(t: ToolSpec): string[] {
  const before = findTool(t.name);
  const lines: string[] = [];
  const fail = (msg: string) => { process.exitCode = 1; return [...lines, `failed: ${msg}`]; };
  const prev = readToolManifest(t.name);
  const m: ToolManifest = { tool: t.name, method: t.method, preexisting: prev ? prev.preexisting : before?.path ?? null, bin: null, at: now() };
  if (t.method === "brew") {
    const brew = findTool("brew");
    if (!brew) return fail("Homebrew is not installed. Install it from https://brew.sh, then try again.");
    const code = stream(brew.path, ["install", t.name]);
    lines.push(`brew install ${t.name}: exit ${code}`);
    if (code !== 0) return fail(`brew install ${t.name} exited ${code}`);
  } else if (t.method === "curl") {
    // The upstream scripts install into ~/.local/bin when it is on PATH (no sudo), else /usr/local/bin with sudo.
    ensureDir(LOCAL_BIN);
    const code = stream("/bin/sh", ["-c", `curl -fsSL ${t.url} | sh`], { PATH: `${LOCAL_BIN}:${process.env.PATH ?? ""}` });
    lines.push(`curl -fsSL ${t.url} | sh (PATH starts with ${LOCAL_BIN}): exit ${code}`);
    if (code !== 0) return fail(`the ${t.name} install script exited ${code}`);
  } else if (t.method === "npm") {
    const engines = sh("npm", ["view", t.name, "engines.node"]);
    const floor = engines.startsWith("ERR") ? null : minNode(engines);
    const cands = nodeCandidates();
    const node = pickNode(floor, cands);
    if (!node) return fail(`${t.name} needs Node ${floor?.join(".") ?? "(any)"} or newer, and none was found (PATH, ~/.nvm, Homebrew). Run \`nvm install 22\`, then try again.`);
    const env = { PATH: `${node.dir}:${process.env.PATH ?? ""}` };
    const code = stream(path.join(node.dir, "npm"), ["install", "-g", t.name], env);
    lines.push(`${node.dir}/npm install -g ${t.name} (Node ${node.version?.join(".")}${floor ? `, needs ${floor.join(".")}+` : ""}): exit ${code}`);
    if (code !== 0) return fail(`npm install -g ${t.name} exited ${code}`);
    m.node_dir = node.dir;
    const pathNode = cands[0];
    if (pathNode && pathNode.dir !== node.dir) {
      // The Node on PATH is too old for this tool: a small launcher in ~/.local/bin runs it with the newer Node.
      ensureDir(LOCAL_BIN);
      const wrapper = path.join(LOCAL_BIN, t.name);
      fs.writeFileSync(wrapper, `#!/bin/sh\n# joyride-managed launcher: ${t.name} needs Node ${floor?.join(".") ?? "22"}+, the Node on PATH is older.\nexec "${node.dir}/node" "${node.dir}/${t.name}" "$@"\n`, { mode: 0o755 });
      m.wrapper = wrapper;
      lines.push(`wrote launcher ${wrapper} -> ${node.dir}/node ${node.dir}/${t.name}`);
    }
    if (t.hooks) {
      const backups = [path.join(paths.claudeDir, "settings.json"), path.join(paths.codexDir, "hooks.json")].map(backupFile).filter(Boolean) as string[];
      const hc = stream(path.join(node.dir, t.name), ["setup", "hooks"], env);
      m.hooks = hc === 0; m.backups = backups;
      lines.push(`${t.name} setup hooks (SessionStart hook for Claude Code, Codex and OpenCode): exit ${hc}${backups.length ? `; backups ${backups.join(", ")}` : ""}`);
    }
  }
  const after = findTool(t.name);
  m.bin = after?.path ?? null;
  writeToolManifest(m);
  if (!after) return fail(`${t.name} is still not found after the install (looked on PATH and in ~/.local/bin, /opt/homebrew/bin, /usr/local/bin)`);
  const v = sh(after.path, ["--version"]).split("\n")[0];
  lines.push(`${t.name} now at ${after.path}${after.on_path ? "" : " (that folder is not on PATH: add it in ~/.zshrc so Firstmate can find it)"}: ${v.slice(0, 120)}`);
  if (m.preexisting) lines.push(`${t.name} was already at ${m.preexisting} before Joyride installed it; uninstall leaves it in place`);
  return lines;
}

function uninstallTool(t: ToolSpec): string[] {
  const m = readToolManifest(t.name);
  if (!m) return [`${t.name} was not installed by Joyride; left alone`];
  if (m.preexisting) return [`${t.name} was on this Mac before Joyride (${m.preexisting}); left alone`];
  const out: string[] = [];
  if (t.method === "brew") { const brew = findTool("brew"); out.push(`brew uninstall ${t.name}: ${brew ? sh(brew.path, ["uninstall", t.name]).slice(-160) : "brew not found"}`); }
  else if (t.method === "curl") {
    if (m.bin) { try { fs.unlinkSync(m.bin); out.push(`removed ${m.bin}`); } catch (e: any) { out.push(`could not remove ${m.bin}: ${e.message}`); } }
    if (t.name === "no-mistakes") out.push(`kept ${path.join(HOME, ".no-mistakes")} (its data); delete it by hand for a clean removal`);
  } else if (t.method === "npm") {
    const dir = m.node_dir ?? path.dirname(process.execPath);
    out.push(`npm uninstall -g ${t.name}: ${sh(path.join(dir, "npm"), ["uninstall", "-g", t.name], true, { PATH: `${dir}:${process.env.PATH ?? ""}` }).slice(-160) || "ok"}`);
    if (m.wrapper) { try { fs.unlinkSync(m.wrapper); out.push(`removed launcher ${m.wrapper}`); } catch {} }
    if (m.hooks) { out.push(...stripToolHooks(t.name)); out.push("OpenCode's hook (if any) is left in place"); }
  }
  try { fs.unlinkSync(toolManifest(t.name)); } catch {}
  return out;
}

export const toolComponents = Object.fromEntries(FM_TOOL_SPECS.filter((t) => INSTALLABLE_TOOLS.includes(t.name)).map((t) => [t.name, {
  describe: `Firstmate tool (${t.tier === "required" ? "needed for local-only projects" : "optional"}): ${t.name}, installed with \`${installCommand(t)}\`${t.method === "npm" ? " (with a newer Node from ~/.nvm when PATH's Node is too old)" : ""}`,
  install: () => installTool(t),
  uninstall: () => uninstallTool(t),
  status: () => { const f = findTool(t.name); return f ? `at ${f.path}${f.on_path ? "" : " (not on PATH)"}` : "not installed"; },
}]));

export const extraComponents = {
  service: {
    describe: "Optional: launchd user agent for the daemon in an unprotected folder. Installation refuses Documents, Desktop and Downloads; joyride up already starts a detached supervisor for crash recovery without new OS permissions.",
    install: () => installService(),
    uninstall: () => uninstallService(),
    status: () => serviceStatus(),
  },
  backpass: {
    describe: "backpass prerequisites: acpx (agent client) installed globally under Node 22 so the hill-climb engine can run backpass",
    install() {
      const bin = node22Bin();
      if (!bin) return ["Node 22 not found under ~/.nvm; run `nvm install 22` first"];
      const r = sh(path.join(bin, "npm"), ["install", "-g", "acpx"], true, { PATH: `${bin}:${process.env.PATH}` });
      const v = sh(path.join(bin, "acpx"), ["--version"], true, { PATH: `${bin}:${process.env.PATH}` });
      return [`${bin}/npm install -g acpx: ${r.split("\n").slice(-2).join(" ")}`, `acpx --version: ${v}`, "backpass itself runs from vendor/backpass (pinned in vendor/PINS.md); state lives in ~/.config/backpass/user"];
    },
    uninstall() {
      const bin = node22Bin();
      if (!bin) return ["Node 22 not found; nothing to remove"];
      return [`npm uninstall -g acpx: ${sh(path.join(bin, "npm"), ["uninstall", "-g", "acpx"], true, { PATH: `${bin}:${process.env.PATH}` }).slice(-120)}`];
    },
    status() {
      const bin = node22Bin();
      return bin && fs.existsSync(path.join(bin, "acpx")) ? `acpx at ${bin}/acpx` : "acpx not installed";
    },
  },
  ...toolComponents,
};
