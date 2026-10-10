// The command-line tools Firstmate checks for on start (vendor/firstmate/bin/fm-bootstrap.sh),
// split into what a local-only project on the herdr backend needs and what it can skip, with
// the install method fm-bootstrap's install_cmd uses. Pure and dependency-light: imported by the
// installer (src/cli/install-extra.ts), the setup checklist and Firstmate's status.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ToolMethod = "brew" | "curl" | "npm" | "manual";
export type ToolSpec = {
  name: string;
  /** Sentence-case name for the setup page. */
  title: string;
  /** Plain-language reason, written for the setup page. */
  does: string;
  tier: "required" | "optional";
  method: ToolMethod;
  /** Installer script (curl) or instructions page (manual). */
  url?: string;
  /** fm-bootstrap runs `<tool> setup hooks` after the npm install (adds a SessionStart hook for Claude Code, Codex and OpenCode). */
  hooks?: boolean;
  /** Present on any Mac with Joyride already; checked together, not installed one by one. */
  basic?: boolean;
};

export const FM_TOOL_SPECS: ToolSpec[] = [
  { name: "git", title: "Git", does: "version control", tier: "required", method: "brew", basic: true },
  { name: "node", title: "Node", does: "runs Firstmate's helpers", tier: "required", method: "brew", basic: true },
  { name: "jq", title: "jq", does: "reads Herdr's JSON output", tier: "required", method: "brew", basic: true },
  { name: "herdr", title: "Herdr", does: "the terminal panes agents run in", tier: "required", method: "manual", url: "https://herdr.dev", basic: true },
  { name: "treehouse", title: "A separate checkout for each worker", does: "Gives each Firstmate worker its own copy of the project, so a worker never touches your main checkout.", tier: "required", method: "curl", url: "https://kunchenguid.github.io/treehouse/install.sh" },
  { name: "tasks-axi", title: "Firstmate's work queue", does: "Keeps Firstmate's work queue.", tier: "required", method: "npm" },
  { name: "quota-axi", title: "Usage limit checks", does: "Checks usage limits before Firstmate picks the model a worker runs on.", tier: "required", method: "npm" },
  { name: "chrome-devtools-axi", title: "Browser checks", does: "Lets Firstmate check UI changes in a real browser.", tier: "optional", method: "npm", hooks: true },
  { name: "lavish-axi", title: "Visual decision pages", does: "Shows Firstmate's decisions and reports as visual pages. Without it you get plain text.", tier: "optional", method: "npm", hooks: true },
  { name: "gh", title: "GitHub command line", does: "The GitHub command line. Only projects that ship through GitHub need it. Joyride's projects are local-only, so Firstmate listing it as missing on start is expected.", tier: "optional", method: "brew" },
  { name: "gh-axi", title: "GitHub tools for workers", does: "GitHub operations for Firstmate workers, for projects that ship through GitHub.", tier: "optional", method: "npm", hooks: true },
  { name: "no-mistakes", title: "Review-and-ship pipeline", does: "The review-and-ship pipeline for projects that ship through GitHub.", tier: "optional", method: "curl", url: "https://raw.githubusercontent.com/kunchenguid/no-mistakes/main/docs/install.sh" },
];
export const toolSpec = (name: string) => FM_TOOL_SPECS.find((t) => t.name === name) ?? null;
/** Tools that get their own installer component (`joyride install <name>`). */
export const INSTALLABLE_TOOLS = FM_TOOL_SPECS.filter((t) => !t.basic && t.method !== "manual").map((t) => t.name);

/** The command fm-bootstrap.sh's install_cmd prints for a tool. */
export function installCommand(t: ToolSpec): string {
  switch (t.method) {
    case "brew": return `brew install ${t.name}`;
    case "curl": return `curl -fsSL ${t.url} | sh`;
    case "npm": return `npm install -g ${t.name}${t.hooks ? ` && ${t.name} setup hooks` : ""}`;
    default: return `see ${t.url}`;
  }
}

const HOME = os.homedir();
/** Folders on PATH, then the usual install targets (the curl installers prefer ~/.local/bin). */
export function pathDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...new Set((env.PATH ?? "").split(":").filter(Boolean))];
}
export function searchDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = [path.join(HOME, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", path.join(HOME, ".no-mistakes", "bin"), path.join(HOME, "bin"), path.join(HOME, ".bun", "bin"), path.dirname(process.execPath)];
  return [...new Set([...pathDirs(env), ...extra])];
}

export type Found = { path: string; on_path: boolean };
/** Where a tool lives, and whether it is on PATH (Firstmate's `command -v` only sees PATH). */
export function findTool(name: string, dirs = searchDirs(), onPath = pathDirs()): Found | null {
  for (const d of dirs) {
    const p = path.join(d, name);
    try { const st = fs.statSync(p); if (st.isFile() && st.mode & 0o111) return { path: p, on_path: onPath.includes(d) }; } catch {}
  }
  return null;
}

// ---------- Node selection for npm tools (quota-axi and lavish-axi need Node 22+) ----------
export type Ver = [number, number, number];
export function parseVersion(s: string | null | undefined): Ver | null {
  const m = String(s ?? "").match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}
/** The lowest Node an `engines.node` range accepts (">=22.19", "^20 || >=22", ">=20"); null when it sets no floor. */
export function minNode(engines: string | null | undefined): Ver | null {
  const all = [...String(engines ?? "").matchAll(/(?:>=|\^|~)?\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/g)].map((m) => [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] as Ver);
  if (!all.length) return null;
  return all.sort(cmpVer)[0];
}
export function cmpVer(a: Ver, b: Ver) { return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]; }
/** First candidate (PATH's node comes first) whose version meets the floor. */
export function pickNode<T extends { version: Ver | null }>(floor: Ver | null, candidates: T[]): T | null {
  return candidates.find((c) => c.version && (!floor || cmpVer(c.version, floor) >= 0)) ?? null;
}
