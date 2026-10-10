// Pure guard matcher shared by the PreToolUse hook (bun) and the daemon.
// Kept dependency-free so the hook starts fast.
export type CompiledRule = { id: string; title: string; tools: string[]; match: string[]; unless: string[]; level: "gate" | "ambiguous" };
export type CompiledPolicy = { timeout_seconds: number; rules: CompiledRule[] };
export type GuardHit = { rule: string; title: string; level: "gate" | "ambiguous"; text: string };

/** `{{CMD}}` in a rule expands to "this word is in command position" (line start,
 * after ; && || | ( $( or a prefix like sudo/env/then), so prose that merely
 * mentions a command — commit messages, docs written via heredoc — doesn't match. */
export const CMD = "(?:^|[;&|(\\x60{]|\\$\\()\\s*(?:(?:then|do|else|exec|sudo|env|xargs|time|nohup|command)\\s+)*(?:[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*";
const reCache = new Map<string, RegExp>();
export function re(src: string): RegExp {
  let r = reCache.get(src);
  if (!r) {
    let flags = "m";
    let body = src.split("{{CMD}}").join(CMD);
    if (body.startsWith("(?i)")) { flags += "i"; body = body.slice(4); }
    r = new RegExp(body, flags);
    reCache.set(src, r);
  }
  return r;
}

const SHELLS = /(^|[\s;&|(])(ba|z|da|k)?sh(\s|$)|\bssh\b|\beval\b/;
/** Remove heredoc bodies that are data (cat/tee/python/...), keep ones fed to a shell. */
export function stripDataHeredocs(cmd: string): string {
  return cmd.replace(/^([^\n]*?)<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2([^\n]*)\n([\s\S]*?)\n[ \t]*\3[ \t]*(?=\n|$)/gm,
    (whole, before: string, _q, tag: string, after: string) => (SHELLS.test(before) ? whole : `${before}<<${tag}${after}\n${tag}`));
}
function globToRe(g: string) {
  return new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
}
export function toolMatches(patterns: string[], tool: string) {
  return patterns.some((p) => (p.includes("*") ? globToRe(p).test(tool) : p === tool));
}

/** The text a rule's regexes see: the shell command for shell tools, the tool name for MCP tools. */
export function guardText(tool: string, input: any): string {
  if (tool.startsWith("mcp__")) return tool.split("__").slice(2).join("__") || tool;
  if (input == null) return "";
  if (typeof input === "string") return input;
  const cmd = input.command ?? input.cmd ?? input.script;
  if (Array.isArray(cmd)) {
    // codex style ["bash","-lc","git push"] -> last element carries the script
    const tail = cmd[cmd.length - 1];
    return stripDataHeredocs(cmd.length >= 3 && /^(ba|z)?sh$/.test(String(cmd[0]).split("/").pop() ?? "") ? String(tail) : cmd.join(" "));
  }
  if (typeof cmd === "string") return stripDataHeredocs(cmd);
  return "";
}

export function matchGuard(policy: CompiledPolicy, tool: string, input: any): GuardHit | null {
  const text = guardText(tool, input);
  if (!text) return null;
  let ambiguous: GuardHit | null = null;
  for (const rule of policy.rules) {
    if (!toolMatches(rule.tools, tool)) continue;
    if (!rule.match.some((m) => re(m).test(text))) continue;
    if (rule.unless.some((u) => re(u).test(text))) continue;
    const hit: GuardHit = { rule: rule.id, title: rule.title, level: rule.level, text };
    if (rule.level === "gate") return hit;
    ambiguous ??= hit;
  }
  return ambiguous;
}
