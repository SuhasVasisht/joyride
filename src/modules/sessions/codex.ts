// Codex reader: thread metadata from ~/.codex/state_5.sqlite (read-only, with a
// copy fallback when WAL locking gets in the way) and turn counts / condensed
// transcripts from the rollout JSONL files.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { argv, clip, oneLine, parseJson, readLines, toolSummary } from "./lines.ts";
import { pushStep, type Turn } from "./types.ts";

export type CodexThread = {
  id: string;
  rollout_path: string;
  created_ms: number;
  updated_ms: number;
  cwd: string;
  title: string;
  branch: string | null;
  first_user_message: string;
  tokens_used: number;
  model: string | null;
  archived: boolean;
  /** Parent thread id when this thread is a spawned subagent (excluded from the session list). */
  parent: string | null;
  subagent: boolean;
};

function mapRow(r: any): CodexThread {
  const ms = (msv: any, s: any) => (typeof msv === "number" && msv > 0 ? msv : typeof s === "number" ? s * 1000 : 0);
  const src = typeof r.source === "string" ? r.source : "";
  const subagent = (src.startsWith("{") && src.includes('"subagent"')) || r.thread_source === "subagent" || r.thread_source === "guardian_review";
  let parent: string | null = null;
  if (subagent) { const p = parseJson(src); parent = p?.subagent?.thread_spawn?.parent_thread_id ?? null; }
  const name = typeof r.name === "string" && r.name.trim() ? r.name : null;
  return {
    id: String(r.id),
    rollout_path: String(r.rollout_path ?? ""),
    created_ms: ms(r.created_at_ms, r.created_at),
    updated_ms: ms(r.updated_at_ms, r.updated_at),
    cwd: String(r.cwd ?? ""),
    title: name ?? String(r.title ?? ""),
    branch: r.git_branch ? String(r.git_branch) : null,
    first_user_message: String(r.first_user_message ?? ""),
    tokens_used: Number(r.tokens_used ?? 0) || 0,
    model: r.model ? String(r.model) : null,
    archived: Boolean(r.archived),
    parent,
    subagent,
  };
}

function query(db: Database.Database): CodexThread[] {
  return (db.prepare("SELECT * FROM threads").all() as any[]).map(mapRow);
}

/** Reads every thread row. Returns null when the store does not exist. Never writes to ~/.codex. */
export function readThreads(codexDir: string): { rows: CodexThread[]; via: "direct" | "copy" } | null {
  const file = path.join(codexDir, "state_5.sqlite");
  if (!fs.existsSync(file)) return null;
  try {
    // A read-only open still creates -shm/-wal when they are missing; never create files in ~/.codex.
    if (process.env.JOYRIDE_CODEX_COPY === "1" || !fs.existsSync(file + "-shm")) throw new Error("use a copy");
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try { db.pragma("busy_timeout = 2000"); return { rows: query(db), via: "direct" }; } finally { db.close(); }
  } catch {
    // WAL locking or a missing -shm can block a read-only open: read a private copy instead.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "joyride-codex-"));
    try {
      const copy = path.join(tmp, "state_5.sqlite");
      fs.copyFileSync(file, copy);
      if (fs.existsSync(file + "-wal")) fs.copyFileSync(file + "-wal", copy + "-wal");
      const db = new Database(copy, { fileMustExist: true });
      try { return { rows: query(db), via: "copy" }; } finally { db.close(); }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

// ---------- rollout parsing ----------

const NOT_HUMAN = /^(<(environment_context|user_instructions|user_shell_command|task-notification|turn_aborted|local-command-stdout|local-command-stderr|subagent_notification)\b|# AGENTS\.md instructions|<\/?image\b|\[Request interrupted)/;

/** Human text from a list of content blocks (`input_text`, `text`, `Text`), or null. */
export function codexHumanText(content: unknown): string | null {
  if (typeof content === "string") return NOT_HUMAN.test(content.trim()) || !content.trim() ? null : content.trim();
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  let images = 0;
  for (const b of content as any[]) {
    if (!b) continue;
    if (typeof b.text === "string") {
      const t = b.text.trim();
      if (t && !NOT_HUMAN.test(t)) parts.push(t);
    } else if (/image/i.test(String(b.type))) images++;
  }
  if (!parts.length) return images ? "[image]" : null;
  const text = parts.join("\n");
  const cmd = text.match(/<command-name>([^<]*)<\/command-name>/);
  if (cmd) {
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
    return `${cmd[1].trim()}${args ? " " + args : ""}`;
  }
  return text;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as any[]).map((b) => (typeof b?.text === "string" ? b.text : "")).filter(Boolean).join("\n").trim();
}

export type CodexAcc = { v: 1; offset: number; evUser: number; icUser: number; riUser: number; model: string | null };
export const newCodexAcc = (): CodexAcc => ({ v: 1, offset: 0, evUser: 0, icUser: 0, riUser: 0, model: null });

/** Cheap counter pass: only lines that can carry a user message or a model are JSON-parsed. */
export function feedCodex(acc: CodexAcc, line: string) {
  if (!(line.includes('"user_message"') || line.includes('"UserMessage"') || line.includes('"role":"user"') || line.includes('"turn_context"'))) return;
  const r = parseJson(line);
  const p = r?.payload;
  if (!p || typeof p !== "object") return;
  if (r.type === "turn_context") { if (typeof p.model === "string" && p.model) acc.model = p.model; return; }
  if (r.type === "event_msg" && p.type === "user_message") { acc.evUser++; return; }
  if (r.type === "event_msg" && p.type === "item_completed" && p.item?.type === "UserMessage") { if (codexHumanText(p.item.content) != null) acc.icUser++; return; }
  if (r.type === "response_item" && p.type === "message" && p.role === "user") { if (codexHumanText(p.content) != null) acc.riUser++; }
}
export const codexTurns = (acc: CodexAcc) => acc.evUser || acc.icUser || acc.riUser;

type Entry = { ch: "A" | "B" | "C"; kind: "user" | "text" | "tool"; ts: string | null; text?: string; tool?: { name: string; summary: string }; images?: string[] };

/** Paths of images attached to a user message: local_image items, or the <image … path="…"> wrapper in the model input. (user_message events list them in local_images.) */
export function codexImages(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const b of content as any[]) {
    if (b?.type === "local_image" && typeof b.path === "string") out.push(b.path);
    else if (typeof b?.text === "string") { const m = b.text.match(/^<image\b[^>]*\bpath="([^"]+)"/); if (m) out.push(m[1]); }
  }
  return out;
}
const withImages = (e: Entry, content: unknown): Entry => {
  const paths = codexImages(content);
  const slots = Array.isArray(content) ? content.filter((b) => b?.type === "input_image").map(() => "") : [];
  const images = paths.length ? paths : slots;
  return images.length ? { ...e, images } : e;
};

const SKIP_ITEMS = new Set(["UserMessage", "AgentMessage", "Reasoning", "ContextCompaction", "SubAgentActivity"]);

function itemTool(it: any): { name: string; summary: string } | null {
  switch (it?.type) {
    case "CommandExecution": return { name: "shell", summary: oneLine(Array.isArray(it.command) ? argv(it.command) : String(it.command ?? ""), 160) };
    case "McpToolCall": return { name: `mcp__${it.server ?? "mcp"}__${it.tool ?? "tool"}`, summary: toolSummary(String(it.tool ?? ""), it.arguments) };
    case "FileChange": {
      const files = Object.keys(it.changes ?? {});
      return { name: "apply_patch", summary: oneLine(files.map((f) => path.basename(f)).join(", "), 160) };
    }
    case "WebSearch": return { name: "web_search", summary: oneLine(String(it.query ?? ""), 160) };
    default: return it?.type && !SKIP_ITEMS.has(it.type) ? { name: String(it.type), summary: "" } : null;
  }
}

/** Condensed turns from a rollout, choosing whichever record family the file uses. */
export async function codexTranscript(file: string, limit: number, opts: { fullText?: boolean } = {}): Promise<Turn[]> {
  const entries: Entry[] = [];
  await readLines(file, 0, (line) => {
    const r = parseJson(line);
    const p = r?.payload;
    if (!p || typeof p !== "object") return;
    const ts = typeof r.timestamp === "string" ? r.timestamp : null;
    if (r.type === "event_msg") {
      if (p.type === "user_message") {
        const t = typeof p.message === "string" ? p.message.trim() : "";
        const images = Array.isArray(p.local_images) ? p.local_images.filter((x: unknown): x is string => typeof x === "string") : [];
        if (t) entries.push({ ch: "B", kind: "user", ts, text: t, ...(images.length ? { images } : {}) });
      }
      else if (p.type === "agent_message") { const t = typeof p.message === "string" ? p.message.trim() : ""; if (t) entries.push({ ch: "B", kind: "text", ts, text: t }); }
      else if (p.type === "item_completed" && p.item) {
        const it = p.item;
        if (it.type === "UserMessage") { const t = codexHumanText(it.content); if (t) entries.push(withImages({ ch: "A", kind: "user", ts, text: t }, it.content)); }
        else if (it.type === "AgentMessage") { const t = textOf(it.content); if (t) entries.push({ ch: "A", kind: "text", ts, text: t }); }
        else { const tool = itemTool(it); if (tool) entries.push({ ch: "A", kind: "tool", ts, tool }); }
      }
      return;
    }
    if (r.type !== "response_item") return;
    if (p.type === "message") {
      if (p.role === "user") { const t = codexHumanText(p.content); if (t) entries.push(withImages({ ch: "C", kind: "user", ts, text: t }, p.content)); }
      else if (p.role === "assistant") { const t = textOf(p.content); if (t) entries.push({ ch: "C", kind: "text", ts, text: t }); }
    } else if (p.type === "function_call") entries.push({ ch: "C", kind: "tool", ts, tool: { name: String(p.name ?? "tool"), summary: toolSummary(String(p.name ?? ""), p.arguments) } });
    else if (p.type === "custom_tool_call") entries.push({ ch: "C", kind: "tool", ts, tool: { name: String(p.name ?? "tool"), summary: toolSummary(String(p.name ?? ""), p.input) } });
    else if (p.type === "local_shell_call") entries.push({ ch: "C", kind: "tool", ts, tool: { name: "shell", summary: toolSummary("shell", p.action) } });
    else if (p.type === "web_search_call") entries.push({ ch: "C", kind: "tool", ts, tool: { name: "web_search", summary: toolSummary("web_search", p.action) } });
  });

  const hasA = entries.some((e) => e.ch === "A" && e.kind === "user");
  const hasBUser = entries.some((e) => e.ch === "B" && e.kind === "user");
  const hasCText = entries.some((e) => e.ch === "C" && e.kind === "text");
  const keep = (e: Entry) =>
    hasA ? e.ch === "A"
      : hasBUser ? (e.ch === "B" && e.kind === "user") || (e.ch === "C" && e.kind !== "user") || (e.ch === "B" && e.kind === "text" && !hasCText)
      : e.ch === "C";

  const TEXT_MAX = opts.fullText ? Infinity : 2000, TOOLS_MAX = 40;
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  for (const e of entries) {
    if (!keep(e)) continue;
    if (e.kind === "user") { cur = null; turns.push({ role: "user", ts: e.ts, text: clip(e.text, TEXT_MAX), tools: [], ...(e.images ? { images: e.images } : {}) }); continue; }
    if (!cur) { cur = { role: "assistant", ts: e.ts, text: "", tools: [] }; turns.push(cur); }
    if (e.kind === "text") {
      if (cur.text.length <= TEXT_MAX) cur.text += (cur.text ? "\n\n" : "") + e.text;
      if (e.text) pushStep(cur, { kind: "text", text: e.text });
    } else if (e.kind === "tool" && e.tool) {
      if (cur.tools.length < TOOLS_MAX) cur.tools.push(e.tool);
      else cur.more_tools = (cur.more_tools ?? 0) + 1;
      pushStep(cur, { kind: "tool", ...e.tool });
    }
  }
  return turns.slice(-limit).map((t) => ({ ...t, text: clip(t.text, TEXT_MAX) }));
}

export { readLines };
