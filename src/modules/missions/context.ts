// Proposal context: what the work in a proposal's sessions actually was, so a
// proposal can be decided in seconds.
//   - session digests: prompts, final message, files edited and commits made,
//     read once from the transcript (plus tool.pre hook events) and cached by file size + mtime
//   - why grouped: plain-words replay of the clustering inputs (place, branch, gaps)
//   - noise: obvious non-missions (smoke tests, one quick exchange), no LLM
//   - brief: heavy-LLM task "proposal_brief", several proposals per call
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerLlmFake } from "../../core/fakes.ts";
import { repoName } from "../../core/util.ts";
import { humanPrompt } from "../sessions/claude.ts";
import { codexHumanText } from "../sessions/codex.ts";
import { argv, oneLine, parseJson, readLines } from "../sessions/lines.ts";
import type { SessionItem } from "../sessions/types.ts";
import { GAP_HOURS, normBranch, placeOf } from "./backfill.ts";

export const DIGEST_VERSION = 7;
const PROMPT_MAX = 400;
const FINAL_MAX = 700;
const LAST_PROMPTS = 3;

export type Commit = { sha: string | null; subject: string; branch: string | null };
export type SessionDigest = {
  v: number;
  prompt_count: number;
  first_prompt: string | null;
  /** The most recent human prompts, oldest first (at most four, may include the first). */
  last_prompts: string[];
  final_message: string;
  /** Absolute path -> number of edits. */
  files: Record<string, number>;
  commits: Commit[];
};

export const emptyDigest = (): SessionDigest => ({ v: DIGEST_VERSION, prompt_count: 0, first_prompt: null, last_prompts: [], final_message: "", files: {}, commits: [] });

// ---------- commands ----------

/** `git commit` where a shell would run it (start of a command, after ; && || | ( $( or a newline),
 * allowing `git -C dir`, `git -c k=v` and long options before the subcommand. Text that merely
 * mentions git commit (a test string, a heredoc body in quotes) does not count. */
export const GIT_COMMIT = /(?:^|[;&|(\n`]|\$\()\s*(?:\w+=\S*\s+)*git(?:\s+(?:-C\s+\S+|-c\s+\S+|--[\w-]+(?:=\S+)?))*\s+commit\b/;
/** Character ranges of heredoc bodies (`<<'EOF' … EOF`): text there is file content, not commands. */
function heredocBodies(cmd: string): [number, number][] {
  const out: [number, number][] = [];
  const open = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n/g;
  let m: RegExpExecArray | null;
  while ((m = open.exec(cmd))) {
    const start = m.index + m[0].length;
    const close = new RegExp(`^\\s*${m[2]}\\s*$`, "m").exec(cmd.slice(start));
    const end = close ? start + close.index : cmd.length;
    out.push([start, end]);
    open.lastIndex = end;
  }
  return out;
}

/** Index of the executed `git commit` in a shell command, or -1. */
function commitIndex(cmd: string): number {
  const bodies = cmd.includes("<<") ? heredocBodies(cmd) : [];
  const re = new RegExp(GIT_COMMIT.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) {
    const at = m.index + m[0].indexOf("git");
    if (!bodies.some(([a, b]) => at >= a && at < b)) return at;
  }
  return -1;
}

/** The part of a shell command from its executed `git commit` on, or null. */
export function commitCommandAt(cmd: string): string | null {
  const at = commitIndex(cmd);
  return at < 0 ? null : cmd.slice(at);
}

/** A commit made in some other repo: the same command runs `git init` first, or it cds / -C's into
 * a shell variable, a tmp dir, or an absolute path outside the session's repo. */
export function commitElsewhere(cmd: string, repo: string | null): boolean {
  const at = commitIndex(cmd);
  if (at < 0) return false;
  const before = cmd.slice(0, at);
  if (/\bgit\s+init\b/.test(before)) return true;
  const targets = [...before.matchAll(/(?:^|[;&|(\s])cd\s+(["']?)([^\s"'&;|)]+)\1/g)].map((m) => m[2]);
  const c = cmd.slice(at).match(/^git(?:\s+-c\s+\S+)*\s+-C\s+(["']?)([^\s"']+)\1/);
  if (c) targets.push(c[2]);
  return targets.some((t) => {
    if (repo && (t === repo || t.startsWith(repo + "/"))) return false;
    return t.startsWith("$") || /^\/(private\/)?tmp\//.test(t) || (t.startsWith("/") && Boolean(repo));
  });
}
/** Shell commands inside a Codex tool call: JSON arguments ({cmd} / {command}) or JS code calling exec_command. */
export function commandsIn(input: string): string[] {
  const out: string[] = [];
  const j = parseJson(input);
  if (j && typeof j === "object") { const c = j.cmd ?? j.command; if (typeof c === "string") out.push(c); else if (Array.isArray(c)) out.push(argv(c)); }
  for (const m of input.matchAll(/["']?(?:cmd|command)["']?\s*:\s*"((?:[^"\\]|\\.)*)"/g)) { try { out.push(JSON.parse(`"${m[1]}"`)); } catch { out.push(m[1].replace(/\\"/g, '"')); } }
  return out;
}
/** First line git prints after a commit: `[main 1a2b3c4] subject`. */
const COMMIT_OUT = /^\[([^\]\s]+)(?: \(root-commit\))? ([0-9a-f]{7,40})\] (.+)$/gm;
const PATCH_FILE = /\*\*\* (?:Add|Update|Delete) File: ([^\n\\"]+)/g;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

const firstLine = (s: string) => oneLine(s.split("\n").find((l) => l.trim()) ?? "", 160);

/** The message of a `git commit -m …` command, including the `-m "$(cat <<'EOF' … EOF)"` form. */
export function commitMessageOf(full: string): string | null {
  const cmd = commitCommandAt(full) ?? full;
  const here = cmd.match(/(?:-m|--message)[\s=]+["']?\$\(cat\s+<<-?\s*['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\s*\1\b/);
  if (here) return firstLine(here[2]) || null;
  const m = cmd.match(/(?:\s-[a-zA-Z]*m|\s--message)(?:\s+|=)(?:"((?:[^"\\]|\\.)*)"?|'([^']*)'?|([^\s;&|]+))/);
  if (!m) return null;
  const msg = (m[1] ?? m[2] ?? m[3] ?? "").replace(/\\(["\\$`])/g, "$1").replace(/\\n/g, "\n");
  return firstLine(msg) || null;
}

/** Commits reported in a tool's output. */
export function commitsInOutput(out: string): Commit[] {
  const found: Commit[] = [];
  for (const m of out.matchAll(COMMIT_OUT)) found.push({ branch: m[1], sha: m[2].slice(0, 12), subject: oneLine(m[3], 160) });
  return found;
}

/** Same subject, or one is a clipped prefix of the other (hook events cut long commands). */
const sameSubject = (a: string, b: string) => {
  const x = a.replace(/…$/, ""), y = b.replace(/…$/, "");
  return x === y || (Math.min(x.length, y.length) >= 12 && (x.startsWith(y) || y.startsWith(x)));
};

function addCommit(d: SessionDigest, c: Commit) {
  if (!c.subject) return;
  if (c.sha && d.commits.some((x) => x.sha && (x.sha.startsWith(c.sha!) || c.sha!.startsWith(x.sha)))) return;
  if (!c.sha && d.commits.some((x) => sameSubject(x.subject, c.subject))) return;
  // A verified commit replaces an earlier unverified one with the same subject.
  if (c.sha) { const i = d.commits.findIndex((x) => !x.sha && sameSubject(x.subject, c.subject)); if (i >= 0) { d.commits[i] = c; return; } }
  d.commits.push(c);
}

/** Agent scratch space and agent config (scratchpads, ~/.claude, ~/.codex) is not the work itself. */
export function isScratchPath(f: string): boolean {
  const home = os.homedir();
  return f.includes("/scratchpad/") || f.startsWith(`${home}/.claude/`) || f.startsWith(`${home}/.codex/`);
}
const addFile = (files: Record<string, number>, f: unknown, n = 1) => {
  if (typeof f !== "string" || !f || isScratchPath(f)) return;
  files[f] = (files[f] ?? 0) + n;
};

/** A commit command whose output has no `[branch sha]` line: kept by its message unless the output says it failed. */
const FAILED = /nothing to commit|nothing added to commit|no changes added to commit|^(error|fatal):|hook .*failed|Process exited with code [1-9]|"exit_code":\s*[1-9]/im;
function commitFromCommand(d: SessionDigest, cmd: string, out: string, failed = false) {
  const found = commitsInOutput(out);
  if (found.length) { found.forEach((c) => addCommit(d, c)); return; }
  if (failed || FAILED.test(out)) return;
  const msg = commitMessageOf(cmd);
  if (msg) addCommit(d, { sha: null, subject: msg, branch: null });
}

function addPrompt(d: SessionDigest, text: string) {
  const t = oneLine(text, PROMPT_MAX);
  if (!t) return;
  d.prompt_count++;
  if (!d.first_prompt) d.first_prompt = t;
  d.last_prompts.push(t);
  if (d.last_prompts.length > LAST_PROMPTS + 1) d.last_prompts.shift();
}

const textOfOutput = (c: unknown): string => {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b: any) => (typeof b === "string" ? b : typeof b?.text === "string" ? b.text : "")).join("\n");
  if (c && typeof c === "object" && typeof (c as any).output === "string") return (c as any).output;
  return "";
};

// ---------- Claude ----------

/** `sub` reads a subagent transcript: only its edits and commits count (its prompts come from the parent). */
async function digestClaude(file: string, repo: string | null, sub = false, d = emptyDigest()): Promise<SessionDigest> {
  const pending = new Map<string, string>(); // tool_use id -> git commit command
  await readLines(file, 0, (line) => {
    const assistant = line.includes('"type":"assistant"');
    const result = !assistant && line.includes('"tool_use_id"');
    if (result) {
      if (!pending.size) return;
      let hit = false;
      for (const id of pending.keys()) if (line.includes(id)) { hit = true; break; }
      if (!hit) return;
    } else if (!assistant && !line.includes('"type":"user"')) return;
    const r = parseJson(line);
    if (!r || (r.isSidechain && !sub)) return;
    if (r.type === "user") {
      if (!result) { const p = sub || r.isCompactSummary ? null : humanPrompt(r); if (p) addPrompt(d, p.text); return; }
      for (const b of Array.isArray(r.message?.content) ? r.message.content : []) {
        if (b?.type !== "tool_result" || !pending.has(b.tool_use_id)) continue;
        const out = textOfOutput(b.content) + "\n" + textOfOutput(r.toolUseResult?.stdout);
        commitFromCommand(d, pending.get(b.tool_use_id)!, out, b.is_error === true);
        pending.delete(b.tool_use_id);
      }
      return;
    }
    if (r.type !== "assistant" || !Array.isArray(r.message?.content)) return;
    for (const b of r.message.content) {
      if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) { if (!sub) d.final_message = oneLine(b.text, FINAL_MAX); }
      else if (b?.type === "tool_use") {
        const name = String(b.name ?? ""), input = b.input ?? {};
        if (EDIT_TOOLS.has(name)) addFile(d.files, input.file_path ?? input.notebook_path);
        else if (name === "Bash" && typeof input.command === "string" && commitCommandAt(input.command) && !commitElsewhere(input.command, repo)) pending.set(String(b.id), input.command);
      }
    }
  });
  // Commits whose result never arrived (interrupted session): keep the message, without a sha.
  for (const cmd of pending.values()) { const msg = commitMessageOf(cmd); if (msg) addCommit(d, { sha: null, subject: msg, branch: null }); }
  return d;
}

// ---------- Codex ----------

type Chan = { prompts: string[]; count: number; final: string };
const newChan = (): Chan => ({ prompts: [], count: 0, final: "" });
const cmdText = (c: unknown) => (Array.isArray(c) ? argv(c) : typeof c === "string" ? c : "");

async function digestCodex(file: string, repo: string | null): Promise<SessionDigest> {
  const ch = { A: newChan(), B: newChan(), C: newChan() };
  const userIn = (c: Chan, t: string | null) => { if (!t) return; c.count++; c.prompts.push(t); if (c.prompts.length > LAST_PROMPTS + 1) c.prompts.splice(1, 1); };
  const filesA: Record<string, number> = {}, filesC: Record<string, number> = {};
  const pending = new Map<string, string>(); // call_id -> command text
  const d = emptyDigest();
  const patchFiles = (s: string) => { for (const m of s.matchAll(PATCH_FILE)) addFile(filesC, m[1].trim()); };

  await readLines(file, 0, (line) => {
    let want = line.includes("git commit") || line.includes('"FileChange"') || line.includes("*** ") || line.includes('_message"') || line.includes('Message"') || line.includes('"role":"');
    if (!want && pending.size) for (const id of pending.keys()) if (line.includes(id)) { want = true; break; }
    if (!want) return;
    const r = parseJson(line);
    const p = r?.payload;
    if (!p || typeof p !== "object") return;
    if (r.type === "event_msg") {
      if (p.type === "user_message") userIn(ch.B, typeof p.message === "string" && p.message.trim() ? p.message.trim() : null);
      else if (p.type === "agent_message" && typeof p.message === "string" && p.message.trim()) ch.B.final = p.message;
      else if (p.type === "item_completed" && p.item) {
        const it = p.item;
        if (it.type === "UserMessage") userIn(ch.A, codexHumanText(it.content));
        else if (it.type === "AgentMessage") { const t = textOfOutput(it.content).trim(); if (t) ch.A.final = t; }
        else if (it.type === "FileChange") for (const f of Object.keys(it.changes ?? {})) addFile(filesA, f);
        else if (it.type === "CommandExecution" && commitCommandAt(cmdText(it.command)) && !commitElsewhere(cmdText(it.command), repo)) {
          const code = it.exit_code == null ? null : Number(it.exit_code);
          commitFromCommand(d, cmdText(it.command), String(it.aggregated_output ?? it.stdout ?? it.formatted_output ?? ""), code !== null && code !== 0);
        }
      }
      return;
    }
    if (r.type !== "response_item") return;
    if (p.type === "message") {
      if (p.role === "user") userIn(ch.C, codexHumanText(p.content));
      else if (p.role === "assistant") { const t = textOfOutput(p.content).trim(); if (t) ch.C.final = t; }
    } else if (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call") {
      const input = typeof p.arguments === "string" ? p.arguments : typeof p.input === "string" ? p.input : JSON.stringify(p.action ?? p.arguments ?? p.input ?? "");
      if (input.includes("*** ")) patchFiles(input.replace(/\\n/g, "\n"));
      const cmd = input.includes("commit") ? commandsIn(input).find((c) => commitCommandAt(c) && !commitElsewhere(c, repo)) : undefined;
      if (cmd && p.call_id) pending.set(String(p.call_id), cmd);
    } else if ((p.type === "function_call_output" || p.type === "custom_tool_call_output") && p.call_id && pending.has(p.call_id)) {
      commitFromCommand(d, pending.get(p.call_id)!, textOfOutput(p.output).replace(/\\n/g, "\n"));
      pending.delete(p.call_id);
    }
  });

  const hasA = ch.A.count > 0, hasB = ch.B.count > 0;
  const use = hasA ? ch.A : hasB ? ch.B : ch.C;
  d.prompt_count = use.count;
  for (const t of use.prompts) { const o = oneLine(t, PROMPT_MAX); if (!d.first_prompt) d.first_prompt = o; d.last_prompts.push(o); }
  d.final_message = oneLine(hasA ? ch.A.final : hasB ? (ch.C.final || ch.B.final) : ch.C.final, FINAL_MAX);
  // FileChange items and patch text describe the same edits; take the larger count per file.
  for (const f of new Set([...Object.keys(filesA), ...Object.keys(filesC)])) d.files[f] = Math.max(filesA[f] ?? 0, filesC[f] ?? 0);
  for (const cmd of pending.values()) { const msg = commitMessageOf(cmd); if (msg) addCommit(d, { sha: null, subject: msg, branch: null }); }
  return d;
}

/** Reads one transcript into a digest. Missing or unreadable files give an empty digest. */
/** `repo` (the session's repo or cwd) tells commits in the work's repo from commits in throwaway repos. */
export async function digestTranscript(source: "claude" | "codex", file: string | null | undefined, subagentFiles: string[] = [], repo: string | null = null): Promise<SessionDigest> {
  if (!file) return emptyDigest();
  let d: SessionDigest;
  try { d = source === "claude" ? await digestClaude(file, repo) : await digestCodex(file, repo); }
  catch { return emptyDigest(); }
  // Subagents' edits and commits are part of the session's work (Claude keeps them in <id>/subagents/).
  for (const f of subagentFiles) { try { await digestClaude(f, repo, true, d); } catch {} }
  return d;
}

/** Claude subagent transcripts that belong to a session transcript. */
export function subagentFilesOf(transcript: string | null | undefined, id: string): string[] {
  if (!transcript) return [];
  const dir = path.join(path.dirname(transcript), id, "subagents");
  try { return fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort().map((n) => path.join(dir, n)); } catch { return []; }
}

/** Merge tool.pre hook events (clipped JSON input) into a digest: edits and commit commands. */
export function mergeHookEvents(d: SessionDigest, events: { tool?: string; input?: string }[]) {
  const seen: Record<string, number> = {};
  for (const e of events) {
    const input = typeof e.input === "string" ? e.input : JSON.stringify(e.input ?? "");
    if (e.tool && EDIT_TOOLS.has(e.tool)) {
      const m = input.match(/"(?:file_path|notebook_path)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (m) { try { addFile(seen, JSON.parse(`"${m[1]}"`)); } catch {} }
    } else if (e.tool === "Bash") {
      const m = input.match(/"command"\s*:\s*"((?:[^"\\]|\\.)*)/);
      let cmd = "";
      try { cmd = JSON.parse(`"${m?.[1] ?? ""}"`); } catch { cmd = (m?.[1] ?? "").replace(/\\"/g, '"').replace(/\\n/g, "\n"); }
      if (cmd && commitCommandAt(cmd) && !commitElsewhere(cmd, null)) { const msg = commitMessageOf(cmd); if (msg) addCommit(d, { sha: null, subject: msg, branch: null }); }
    }
  }
  for (const [f, n] of Object.entries(seen)) d.files[f] = Math.max(d.files[f] ?? 0, n);
  return d;
}

// ---------- noise ----------

const SMOKE_WORD = "(ok|okay|hi|hello|hey|yes|pong|ping|test|testing|done|ready|working|alive)";
const SMOKE: RegExp[] = [
  new RegExp(`^(please )?(just )?(reply|respond|answer|say|print|output|return|type|echo|write)( back)?( with)?( only| just| exactly)?( the)?( single)?( word| words| text| string| token)?[\\s:"'“‘]*${SMOKE_WORD}["'”’.!]*( and nothing else| only)?[.!]*$`, "i"),
  new RegExp(`^${SMOKE_WORD}[.!?]*$`, "i"),
  /^say (hi|hello|hey)\b/i,
  /^(this is (a|just a) )?(smoke|sanity)[- ]?test\b/i,
  /^are you (there|alive|working)\??$/i,
];

/** Prompts that only check an agent responds, e.g. "reply with the word ok", "say hi", "smoke test". */
export function isSmokePrompt(text: string | null | undefined): boolean {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t || t.length > 120) return false;
  return SMOKE.some((re) => re.test(t)) || (/\bsmoke[- ]?test\b/i.test(t) && t.length < 60);
}

export type NoiseInput = { item: SessionItem; digest: SessionDigest };
export type Noise = { noise: boolean; reason: string };

const QUICK_MS = 15 * 60e3;

export function fmtSpan(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const unit = (n: number, u: string) => `${n} ${u}${n === 1 ? "" : "s"}`;
  if (ms < 90e3) return unit(Math.max(1, Math.round(ms / 1000)), "second");
  if (ms < 90 * 60e3) return unit(Math.round(ms / 60e3), "minute");
  if (ms < 48 * 3600e3) return unit(Math.round(ms / 3600e3), "hour");
  return unit(Math.round(ms / 864e5), "day");
}
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const promptsOf = (x: NoiseInput) => [x.digest.first_prompt ?? x.item.first_prompt, ...x.digest.last_prompts].filter((t): t is string => Boolean(t && t.trim()));

/** Obvious noise, decided without a model. Errs towards keeping real work. */
export function noiseOf(list: NoiseInput[]): Noise {
  if (!list.length) return { noise: false, reason: "" };
  const prompts = list.map(promptsOf);
  if (prompts.every((ps) => ps.length > 0 && ps.every(isSmokePrompt))) {
    return { noise: true, reason: `Smoke test: “${oneLine(prompts[0][0], 60)}”` };
  }
  const turns = (x: NoiseInput) => x.digest.prompt_count || (x.item.turns ?? 0);
  if (list.every((x) => turns(x) === 0 && !promptsOf(x).length)) return { noise: true, reason: "No prompts were sent in this session" };
  if (list.length === 1) {
    const x = list[0];
    const n = turns(x);
    const span = Date.parse(x.item.updated) - Date.parse(x.item.started);
    const edits = Object.keys(x.digest.files).length;
    if (n <= 2 && !edits && !x.digest.commits.length && span <= QUICK_MS) {
      return { noise: true, reason: `One quick exchange: ${plural(Math.max(n, 1), "prompt")} over ${fmtSpan(Math.max(span, 1000))}, no files changed` };
    }
  }
  return { noise: false, reason: "" };
}

// ---------- why grouped ----------

export function placeText(s: { repo: string | null; cwd: string } | null, fallbackRepo: string | null): string {
  if (!s) return fallbackRepo ? `in ${repoName(fallbackRepo)}` : "outside any repo";
  if (!s.repo) return `in ${s.cwd.replace(os.homedir(), "~") || "an unknown folder"}, which is not a git repo`;
  const place = placeOf(s);
  if (place === s.repo) return `in ${repoName(s.repo)}`;
  return `in ${path.relative(s.repo, place)}, a folder inside the ${repoName(s.repo)} repo`;
}

function branchText(branches: string[]): string {
  const raw = [...new Set(branches.filter(Boolean))];
  const norm = [...new Set(raw.map(normBranch))];
  if (norm.length === 1 && norm[0] === "main" && raw.some((b) => b !== "main")) {
    const others = raw.filter((b) => b !== "main");
    return `the default branch (${others.join(" and ")} ${others.length === 1 ? "counts" : "count"} as main)`;
  }
  return `branch ${norm.join(", ") || "main"}`;
}

/** Plain-words account of why backfill grouped these sessions. */
export function whyGrouped(p: { repos: string[]; branches: string[]; merge_into: string | null }, items: SessionItem[], mergeTitle?: string | null): string[] {
  const where = placeText(items[0] ?? null, p.repos[0] ?? null);
  const branch = branchText(items.length ? items.map((s) => s.branch ?? "main") : p.branches);
  const out: string[] = [];
  if (items.length <= 1) {
    out.push(`One session ${where}, on ${branch}.`);
    out.push(`No other unassigned session ran there on that branch within ${GAP_HOURS} hours of it, so it stands alone.`);
  } else {
    out.push(`${items.length === 2 ? "Both sessions" : `All ${items.length} sessions`} ran ${where}, on ${branch}.`);
    const sorted = [...items].sort((a, b) => a.started.localeCompare(b.started));
    let end = Date.parse(sorted[0].updated), maxGap = 0;
    for (const s of sorted.slice(1)) {
      maxGap = Math.max(maxGap, Date.parse(s.started) - end);
      end = Math.max(end, Date.parse(s.updated));
    }
    out.push(maxGap <= 0
      ? "They overlapped in time, so they read as one stretch of work."
      : `Each one started within ${fmtSpan(maxGap)} of the one before it; backfill starts a new group after a ${GAP_HOURS}-hour gap.`);
  }
  if (p.merge_into) out.push(`Jev thinks it continues “${mergeTitle ?? p.merge_into}”, an open mission in the same repo.`);
  return out;
}

// ---------- brief (heavy LLM) ----------

export const BRIEF_VERSION = 2;
export const BRIEF_BATCH = 4;
export const BRIEF_CONCURRENCY = 3;
export const OUTCOMES = ["shipped", "in progress", "abandoned", "exploration", "unclear"] as const;
export type Outcome = (typeof OUTCOMES)[number];
export type Brief = { summary: string; outcome: Outcome; worth_tracking: boolean; reason: string };

export const BRIEF_SCHEMA = {
  type: "object",
  properties: {
    briefs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          summary: { type: "string" },
          outcome: { type: "string", enum: [...OUTCOMES] },
          worth_tracking: { type: "boolean" },
          reason: { type: "string" },
        },
        required: ["index", "summary", "outcome", "worth_tracking", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["briefs"],
  additionalProperties: false,
};

export type BriefInput = {
  index: number;
  place: string;
  branch: string;
  sessions: {
    title: string; first_prompt: string; later_prompts: string[]; final_message: string;
    prompts: number; active: string; files_changed: string[]; commits: string[]; still_running: boolean;
  }[];
};

export function briefPrompt(items: BriefInput[]): string {
  return [
    "You help a developer triage proposed missions in their agent workspace. Each proposal groups coding-agent sessions (Claude Code or Codex) from their history that are not tracked yet.",
    "A mission tracks a goal the developer keeps working toward, with criteria for when it is done. Recommend tracking when the work is unfinished or likely to continue, or when it is a substantial multi-session project whose record is worth keeping.",
    "Recommend against tracking finished one-off tasks (a report written, a review or audit delivered, a question answered), setup and housekeeping chores, routine recurring chores such as weekly reviews, and abandoned experiments.",
    "For every proposal write:",
    "- summary: what the work was and what came of it, at most 60 words, plain past tense, no preamble such as \"The user\" or \"This proposal\".",
    "- outcome: shipped (changes landed or a deliverable was produced), in progress (clearly unfinished or still running), abandoned (started, then dropped), exploration (questions, research or reviews without a deliverable), or unclear.",
    "- worth_tracking: true or false, by the rules above.",
    "- reason: why, at most 20 words.",
    "Use only the evidence given. Return one entry per proposal with its index.",
    "<proposals>",
    JSON.stringify(items),
    "</proposals>",
  ].join("\n");
}

const clampWords = (s: unknown, n: number) => {
  const words = String(s ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  return words.length > n ? words.slice(0, n).join(" ").replace(/[,;:]$/, "") + "…" : words.join(" ");
};

/** Validates one model entry; null when it is unusable. */
export function cleanBrief(x: any): Brief | null {
  if (!x || typeof x !== "object" || typeof x.summary !== "string" || !x.summary.trim()) return null;
  const outcome = OUTCOMES.includes(String(x.outcome ?? "").toLowerCase().replace(/_/g, " ") as Outcome) ? (String(x.outcome).toLowerCase().replace(/_/g, " ") as Outcome) : "unclear";
  return {
    summary: clampWords(x.summary, 60),
    outcome,
    worth_tracking: x.worth_tracking === true || x.worth_tracking === "true",
    reason: clampWords(x.reason, 20),
  };
}

/** Deterministic stand-in for tests (JOYRIDE_FAKE_MODELS=1): the brief follows the evidence. */
export function fakeProposalBrief(prompt: string) {
  const m = prompt.match(/<proposals>\n([\s\S]*?)\n<\/proposals>/);
  const items: BriefInput[] = m ? JSON.parse(m[1]) : [];
  return {
    briefs: items.map((it) => {
      const commits = it.sessions.flatMap((s) => s.commits);
      const files = it.sessions.flatMap((s) => s.files_changed);
      const running = it.sessions.some((s) => s.still_running);
      const outcome: Outcome = running ? "in progress" : commits.length ? "shipped" : files.length ? "in progress" : "exploration";
      const worth = it.sessions.length > 1 || commits.length > 0 || running;
      const lead = it.sessions[0];
      return {
        index: it.index,
        summary: `Worked ${it.place} on “${lead?.title ?? "untitled"}”: ${lead?.first_prompt ?? ""}`.slice(0, 300),
        outcome,
        worth_tracking: worth,
        reason: worth ? `${it.sessions.length} sessions${commits.length ? ` and ${commits.length} commits` : ""} of connected work.` : "A single short session with nothing landed.",
      };
    }),
  };
}
registerLlmFake("proposal_brief", fakeProposalBrief);
