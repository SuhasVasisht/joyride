// Claude Code transcript reader: ~/.claude/projects/<slug>/<uuid>.jsonl.
// Parsing is incremental: the accumulator is JSON-serializable and carries the
// byte offset, so an appended file only costs the new bytes.
import { parseJson, clip, oneLine, readLines, toolSummary } from "./lines.ts";
import { pushStep, type QueuedText, type TranscriptState, type Turn } from "./types.ts";

export type ClaudeAcc = {
  v: 1;
  offset: number;
  id: string;
  cwd: string | null;
  branch: string | null;
  started: string | null;
  updated: string | null;
  aiTitle: string | null;
  customTitle: string | null;
  summary: string | null;
  firstPrompt: string | null;
  firstCommand: string | null;
  turns: number;
  tokens: number;
  model: string | null;
  /** Recent assistant message ids with the tokens already counted (streamed records repeat ids). */
  recent: [string, number][];
};

export const newClaudeAcc = (id: string): ClaudeAcc => ({
  v: 1, offset: 0, id, cwd: null, branch: null, started: null, updated: null, aiTitle: null, customTitle: null,
  summary: null, firstPrompt: null, firstCommand: null, turns: 0, tokens: 0, model: null, recent: [],
});

const NOT_HUMAN = /^(<(task-notification|local-command-stdout|local-command-stderr|local-command-caveat|bash-stdout|bash-stderr|system-reminder|user-memory-input)\b|\[Request interrupted)/;

/** A human-entered prompt or command, or null for tool results, meta records and notifications. */
export function humanPrompt(r: any): { text: string; command: boolean } | null {
  if (!r || r.type !== "user" || r.isMeta || r.isSidechain || r.toolUseResult !== undefined) return null;
  const kind = r.origin?.kind;
  if (kind && kind !== "human") return null;
  const c = r.message?.content;
  let text = "";
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) {
    if (c.some((b: any) => b?.type === "tool_result")) return null;
    text = c.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("\n");
    if (!text.trim() && c.some((b: any) => b?.type === "image")) text = "[image]";
  } else return null;
  text = text.trim();
  if (!text || NOT_HUMAN.test(text)) return null;
  const cmd = text.match(/<command-name>([^<]*)<\/command-name>/);
  if (cmd) {
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
    return { text: `${cmd[1].trim()}${args ? " " + args : ""}`, command: true };
  }
  if (text.startsWith("<command-message>")) return null;
  const bash = text.match(/^<bash-input>([\s\S]*?)<\/bash-input>/);
  if (bash) return { text: `! ${bash[1].trim()}`, command: true };
  return { text, command: false };
}

function usageTokens(u: any): number {
  if (!u || typeof u !== "object") return 0;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  return n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens) + n(u.output_tokens);
}

export function feedClaude(acc: ClaudeAcc, line: string) {
  const r = parseJson(line);
  if (!r || typeof r !== "object") return;
  switch (r.type) {
    case "ai-title": if (typeof r.aiTitle === "string" && r.aiTitle.trim()) acc.aiTitle = r.aiTitle.trim(); return;
    case "custom-title": if (typeof r.customTitle === "string" && r.customTitle.trim()) acc.customTitle = r.customTitle.trim(); return;
    case "summary": if (typeof r.summary === "string" && r.summary.trim()) acc.summary = r.summary.trim(); return;
    case "user": case "assistant": break;
    default: return;
  }
  if (r.isSidechain) return;
  const ts = typeof r.timestamp === "string" ? r.timestamp : null;
  if (ts) {
    if (!acc.started || ts < acc.started) acc.started = ts;
    if (!acc.updated || ts > acc.updated) acc.updated = ts;
  }
  if (!acc.cwd && typeof r.cwd === "string" && r.cwd) acc.cwd = r.cwd;
  if (typeof r.gitBranch === "string" && r.gitBranch) acc.branch = r.gitBranch;
  if (r.type === "user") {
    const p = humanPrompt(r);
    if (!p) return;
    acc.turns++;
    if (p.command) { if (!acc.firstCommand) acc.firstCommand = clip(p.text, 1000); }
    else if (!acc.firstPrompt) acc.firstPrompt = clip(p.text, 1000);
    return;
  }
  const m = r.message;
  if (!m) return;
  if (typeof m.model === "string" && m.model && !m.model.startsWith("<")) acc.model = m.model;
  const t = usageTokens(m.usage);
  if (!t) return;
  const mid = String(m.id ?? r.requestId ?? r.uuid ?? "");
  const hit = mid ? acc.recent.find((x) => x[0] === mid) : undefined;
  if (hit) { acc.tokens += t - hit[1]; hit[1] = t; return; }
  acc.tokens += t;
  if (mid) { acc.recent.push([mid, t]); if (acc.recent.length > 64) acc.recent.splice(0, acc.recent.length - 64); }
}

export type ClaudeSummary = {
  title: string; first_prompt: string; cwd: string; branch: string | null; started: string | null; updated: string | null;
  turns: number; tokens: number; model: string | null;
};
export function summarizeClaude(acc: ClaudeAcc): ClaudeSummary {
  const first = acc.firstPrompt ?? acc.firstCommand ?? "";
  return {
    title: oneLine(acc.customTitle ?? acc.aiTitle ?? acc.summary ?? (first || "Untitled session"), 120),
    first_prompt: oneLine(first, 500),
    cwd: acc.cwd ?? "",
    branch: acc.branch,
    started: acc.started,
    updated: acc.updated,
    turns: acc.turns,
    tokens: acc.tokens,
    model: acc.model,
  };
}

const TOOLS_MAX = 40;

/** Condensed turns: each human prompt, then one assistant turn with its text and tool calls. */
const IMAGE_SOURCE = /^\[Image: source: (\/.+)\]$/;

const promptText = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("\n") : "";

const imageSlots = (c: unknown): string[] => Array.isArray(c) ? c.flatMap((b) => b?.type === "image" ? [""] : []) : [];

export async function claudeTranscript(file: string, limit: number): Promise<Turn[]> {
  return (await claudeTranscriptState(file, limit)).turns;
}

/**
 * Turns plus Claude Code's queue. A message typed while it works goes to its queue
 * ("queue-operation" records). At the end of the turn it is dequeued and becomes a normal prompt;
 * between tool calls it is removed from the queue and handed to the running turn as a
 * "queued_command" attachment; Up (or an interrupt) pops the whole queue back into the input box
 * ("popAll"), one record per message.
 */
export async function claudeTranscriptState(file: string, limit: number, opts: { fullText?: boolean } = {}): Promise<TranscriptState & { queue: QueuedText[]; pulled: QueuedText[] }> {
  const turns: Turn[] = [];
  const TEXT_MAX = opts.fullText ? Infinity : 2000;
  const queue: QueuedText[] = [], pulled: QueuedText[] = [];
  let cur: Turn | null = null;
  await readLines(file, 0, (line) => {
    const r = parseJson(line);
    if (!r || r.isSidechain) return;
    if (r.type === "queue-operation") {
      const text = promptText(r.content).trim(), ts = r.timestamp ?? null;
      const at = text ? queue.findIndex((q) => q.text === text) : -1;
      if (r.operation === "enqueue") {
        if (!text) return;
        queue.push({ text, ts });
        // Pulled-back messages sent again (one queued message now) are no longer stranded.
        if (pulled.length) pulled.splice(0, pulled.length, ...pulled.filter((q) => !text.includes(q.text)));
      }
      else if (r.operation === "dequeue") queue.shift();
      else if (r.operation === "remove") { if (at >= 0) queue.splice(at, 1); }
      else if (r.operation === "popAll") { if (at >= 0) queue.splice(at, 1); if (text) pulled.push({ text, ts }); }
      return;
    }
    // A message queued mid-turn reaches the running turn as an attachment, not a user record.
    if (r.type === "attachment" && r.attachment?.type === "queued_command") {
      const a = r.attachment;
      if (a.commandMode !== "prompt" || (a.origin?.kind ?? "human") !== "human") return;
      const images = imageSlots(a.prompt);
      const text = promptText(a.prompt).trim() || (images.length ? "[image]" : "");
      if (!text) return;
      cur = null;
      turns.push({ role: "user", ts: a.timestamp ?? r.timestamp ?? null, text: clip(text, TEXT_MAX), tools: [], ...(images.length ? { images } : {}) });
      if (pulled.length) pulled.splice(0, pulled.length, ...pulled.filter((p) => !text.includes(p.text)));
      return;
    }
    if (r.type === "user") {
      // Claude Code records where each pasted image came from in a meta record right after the prompt.
      if (r.isMeta && Array.isArray(r.message?.content)) {
        const last = turns[turns.length - 1];
        const found = r.message.content.map((b: any) => (typeof b?.text === "string" ? b.text.match(IMAGE_SOURCE)?.[1] : null)).filter(Boolean);
        if (found.length && last?.role === "user") {
          const images = (last.images ??= []);
          for (const p of found) { const slot = images.indexOf(""); if (slot >= 0) images[slot] = p; else images.push(p); }
        }
        return;
      }
      const p = humanPrompt(r);
      if (p) {
        cur = null;
        const images = imageSlots(r.message?.content);
        turns.push({ role: "user", ts: r.timestamp ?? null, text: clip(p.text, TEXT_MAX), tools: [], ...(images.length ? { images } : {}) });
        if (pulled.length) pulled.splice(0, pulled.length, ...pulled.filter((q) => !p.text.includes(q.text)));
      }
      return;
    }
    if (r.type !== "assistant" || !Array.isArray(r.message?.content)) return;
    if (!cur) { cur = { role: "assistant", ts: r.timestamp ?? null, text: "", tools: [] }; turns.push(cur); }
    const t: Turn = cur;
    for (const b of r.message.content) {
      if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
        if (t.text.length <= TEXT_MAX) t.text += (t.text ? "\n\n" : "") + b.text.trim();
        pushStep(t, { kind: "text", text: b.text.trim() });
      } else if (b?.type === "tool_use") {
        const tool = { name: String(b.name ?? "tool"), summary: toolSummary(String(b.name ?? ""), b.input) };
        if (t.tools.length < TOOLS_MAX) t.tools.push(tool);
        else t.more_tools = (t.more_tools ?? 0) + 1;
        pushStep(t, { kind: "tool", ...tool });
      }
    }
  });
  return { turns: turns.slice(-limit).map((t) => ({ ...t, text: clip(t.text, TEXT_MAX) })), queue, pulled };
}
