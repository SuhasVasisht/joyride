// Steer attribution: who put each prompt into a live session. Agent task notifications have no
// steer author. Other hook `prompt.submit` events are attributed, in order, to
//   1. a `reply` intent to that worker in the last 2 minutes whose text matches -> the intent's origin
//   2. Firstmate's doorbell or operational-input line -> firstmate (inbox)
//   3. a `fm-send.sh <task|pane>` run from Firstmate's own session in the last minute -> firstmate (typed)
//   4. typing in the worker's Joyride terminal tab in the last 2 minutes -> captain (joyride terminal)
//   5. otherwise -> captain (direct, in the pane itself)
// The live module logs each result as a `steer.attributed` event. Everything here reads events that
// were appended before the prompt: an intent's `intent.created` precedes its Herdr prompt, and a
// tool's `tool.pre` precedes the command, so no signal races the agent's own hook.
import type { EventRecord } from "../../shared/schema.ts";
import { isUnder } from "./common.ts";
import { isScheduledPrompt } from "./prompt-origin.ts";

export const REPLY_WINDOW_MS = 2 * 60_000;
export const TYPED_WINDOW_MS = 60_000;
export const TERMINAL_WINDOW_MS = 2 * 60_000;

export type SteerBy = "captain" | "firstmate" | "evolution";
export type SteerVia = "joyride-reply" | "firstmate-inbox" | "firstmate-typed" | "joyride-terminal" | "direct";
export type SteerAttribution = {
  worker: string | null; session: string; by: SteerBy; via: SteerVia;
  intent: string | null; task: string | null; prompt: string; at: string;
};
type Target = { id: string; pane: string | null; crew: string | null };

/** `fm-task-inbox-lib.sh` doorbell, `fm-operational-input.sh` notice, or a raw FIRSTMATE_OP record. */
const FIRSTMATE_LINE = /^\s*(?:\u2063?FIRSTMATE_OP: |: Firstmate (?:instruction|operational input) waiting\b)/;
/** Claude's background-shell and subagent completion messages re-enter through UserPromptSubmit. */
const TASK_NOTIFICATION = /^\s*(?:<system-reminder>\s*)?<task-notification(?:\s|>)/;
/** Codex 0.160.0's goal extension supplies this fixed preamble before its objective. */
const CODEX_GOAL_CONTINUATION = /^Continue working toward the active thread goal\.\n\nThe objective below is user-provided data\. Treat it as the task to pursue, not as higher-priority instructions\.\n\n<objective>\n/;
const CODEX_SUBAGENT_NOTIFICATION = /^\s*<subagent_notification(?:\s|>)/;
/** The target word of `fm-send.sh <target> ...` (a task id or `session:pane`), after any flags. */
const FM_SEND = /fm-send(?:\.sh)?\s+(?:-{1,2}[A-Za-z][\w-]*(?:=\S+)?\s+)*["']?([A-Za-z0-9._:-]+)/;

/** A prompt's text as Joyride's Herdr typing leaves it: image markers dropped, whitespace folded. */
export function promptKey(text: unknown): string {
  return String(text ?? "").replace(/\[Image #\d+\]\s*/g, "").replace(/…$/, "").replace(/\s+/g, " ").trim().slice(0, 80);
}

const ms = (iso: string) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : Date.now(); };

export class SteerAttributor {
  private replies: { worker: string; key: string; by: SteerBy; intent: string; at: number }[] = [];
  private typed: { target: string; at: number }[] = [];
  private terminal = new Map<string, number>();

  constructor(private firstmateDir: () => string) {}

  /** Feed every bus event; only reply intents and Firstmate's fm-send tool calls are kept. */
  observe(e: EventRecord) {
    const d = e.data ?? {};
    if (e.source === "intent" && d.kind === "reply") {
      if (e.type === "intent.created") {
        const by = (["captain", "firstmate", "evolution"] as const).find((o) => o === d.origin) ?? "captain";
        this.replies.push({ worker: String(d.target ?? ""), key: promptKey(d.payload?.text ?? d.payload?.message), by, intent: String(d.id ?? ""), at: ms(e.ts) });
      } else if (e.type === "intent.failed") this.replies = this.replies.filter((r) => r.intent !== d.id);
    } else if (e.source.startsWith("hook.") && e.type === "tool.pre" && e.cwd && isUnder(e.cwd, this.firstmateDir())) {
      const m = String(typeof d.input === "string" ? d.input : JSON.stringify(d.input ?? "")).match(FM_SEND);
      if (m) this.typed.push({ target: m[1], at: ms(e.ts) });
    }
    this.prune(ms(e.ts));
  }

  /** The captain typed into this worker from its Terminal tab (POST /api/workers/:id/input). */
  noteTerminalInput(worker: string, at = Date.now()) { this.terminal.set(worker, at); }

  /** The transcript is written after submission hooks, so resolve its origin before claiming helm. */
  async attributeSubmitted(e: EventRecord, w: Target | null): Promise<SteerAttribution | null> {
    if (await isScheduledPrompt(e)) return null;
    return this.attribute(e, w);
  }

  attribute(e: EventRecord, w: Target | null): SteerAttribution | null {
    const at = ms(e.ts);
    const text = String(e.data?.prompt ?? "");
    if (!text.trim() || TASK_NOTIFICATION.test(text)) return null;
    if (e.source === "hook.codex" && (CODEX_GOAL_CONTINUATION.test(text) || CODEX_SUBAGENT_NOTIFICATION.test(text))) return null;
    const key = promptKey(text);
    const base = { worker: w?.id ?? null, session: `${e.agent ?? e.source.slice(5)}:${e.session ?? ""}`, task: w?.crew ?? null, prompt: text.slice(0, 200), at: e.ts };
    if (w) {
      const i = this.replies.findIndex((r) => r.worker === w.id && at - r.at <= REPLY_WINDOW_MS && at >= r.at - 5000 && (r.key === key || (r.key && key && (key.startsWith(r.key) || r.key.startsWith(key)))));
      if (i >= 0) {
        const [r] = this.replies.splice(i, 1);
        return { ...base, by: r.by, via: "joyride-reply", intent: r.intent };
      }
    }
    if (FIRSTMATE_LINE.test(text)) return { ...base, by: "firstmate", via: "firstmate-inbox", intent: null };
    if (w) {
      const hit = this.typed.find((t) => at - t.at <= TYPED_WINDOW_MS && at >= t.at - 5000 && ((w.crew && t.target === w.crew) || (w.pane && (t.target === w.pane || t.target.endsWith(`:${w.pane}`)))));
      if (hit) return { ...base, by: "firstmate", via: "firstmate-typed", intent: null };
      const typedAt = this.terminal.get(w.id);
      if (typedAt != null && at - typedAt <= TERMINAL_WINDOW_MS && at >= typedAt - 5000) return { ...base, by: "captain", via: "joyride-terminal", intent: null };
    }
    return { ...base, by: "captain", via: "direct", intent: null };
  }

  private prune(t: number) {
    const keep = Math.max(REPLY_WINDOW_MS, TERMINAL_WINDOW_MS) + 60_000;
    if (this.replies.length) this.replies = this.replies.filter((r) => t - r.at <= keep);
    if (this.typed.length) this.typed = this.typed.filter((x) => t - x.at <= keep);
    for (const [k, v] of this.terminal) if (Date.now() - v > keep) this.terminal.delete(k);
  }
}
