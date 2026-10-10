import type { SessionView } from "../../shared/schema.ts";

/** One condensed transcript turn for UI drill-in. */
export type Turn = {
  role: "user" | "assistant";
  ts: string | null;
  text: string;
  tools: { name: string; summary: string }[];
  more_tools?: number;
  /** Assistant turns: what it said and which tools it ran, in order (the chat view). */
  steps?: Step[];
  /** Steps left out after STEPS_MAX. */
  more_steps?: number;
  /** User turns: attached image paths. An empty slot means its source path is unavailable. */
  images?: string[];
};
/** A queued message: typed while the agent worked, not sent to the model yet. */
export type QueuedText = { text: string; ts: string | null };
export type TranscriptState = {
  turns: Turn[];
  /** Waiting in the agent's queue, oldest first. */
  queue: QueuedText[] | null;
  /** Popped back into the agent's input box (Up, or an interrupt) and not sent since. */
  pulled: QueuedText[] | null;
};
export type Step = { kind: "text"; text: string } | { kind: "tool"; name: string; summary: string };

/** Caps for the chat view's ordered steps. */
export const STEPS_MAX = 120;
export const STEP_TEXT_MAX = 6000;

/** Append a step to an assistant turn (adjacent text merges). */
export function pushStep(t: Turn, s: Step) {
  const steps = (t.steps ??= []);
  const last = steps[steps.length - 1];
  if (s.kind === "text" && last?.kind === "text") {
    if (last.text.length < STEP_TEXT_MAX) last.text = (last.text + "\n\n" + s.text).slice(0, STEP_TEXT_MAX);
    return;
  }
  if (steps.length >= STEPS_MAX) { t.more_steps = (t.more_steps ?? 0) + 1; return; }
  steps.push(s.kind === "text" ? { kind: "text", text: s.text.slice(0, STEP_TEXT_MAX) } : s);
}

/** SessionView plus reader extras. */
export type SessionItem = SessionView & { subagents: number };

export type ListOpts = { repo?: string; since?: string | number; mission?: string; q?: string; limit?: number; /** Only these session keys. */ keys?: string[] };

export type ScanStats = {
  files: number; parsed: number; incremental: number; cached: number; bytes: number; removed: number; ms: number; error?: string; via?: string;
};

export type SessionsService = {
  list(opts?: ListOpts): SessionItem[];
  get(keyOrId: string): SessionItem | null;
  transcript(keyOrId: string, opts?: { limit?: number }): Promise<Turn[] | null>;
  /** Turns plus the agent's own queue of messages typed while it works (Claude Code; null when the agent keeps none). */
  transcriptState(keyOrId: string, opts?: { limit?: number; fullText?: boolean }): Promise<TranscriptState | null>;
  reindex(opts?: { full?: boolean }): Promise<{ claude: ScanStats; codex: ScanStats; ms: number }>;
  ready(): Promise<void>;
  counts(): { total: number; visible: number; internal: number; hidden: number; claude: number; codex: number };
};
