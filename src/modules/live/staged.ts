// Replies sent from Joyride's chat view that the agent has not taken yet. The chat log is read from
// the agent's transcript, and a reply sent while the agent works has no transcript entry until the
// agent takes it (Claude Code at the end of its turn, or between tool calls; Codex after its next
// tool call). Until then the chat shows it from the reply intent, marked with where it stands:
//   sending    the relay is still typing it in
//   queued     the agent holds it until its current turn ends (Claude Code's queue lists it, or the
//              agent was working when it went in)
//   delivered  sent, and the agent should be taking it now
//   pulled     Claude Code popped it back into its input box (Up arrow, or an interrupt); it goes
//              nowhere until it is submitted again
//   unclaimed  the agent is idle and its transcript never showed it
//   failed     the relay refused it, and nothing was typed
// Once a transcript user turn after the reply holds its text, it is consumed: the intent is marked
// acked and the chat shows the transcript turn instead, so the message never shows twice.
import type { WorkerView } from "../../shared/schema.ts";
import { ReplyBinding } from "../../shared/schema.ts";
import type { QueuedText, TranscriptState, Turn } from "../sessions/types.ts";
import { matchReplies, normText } from "../../shared/replies.ts";
export { normText } from "../../shared/replies.ts";
import type { IntentRecord } from "./intents.ts";

export type StagedState = "sending" | "queued" | "delivered" | "pulled" | "unclaimed" | "failed";
export type StagedReply = {
  id: string; text: string; images: string[]; created: string; state: StagedState;
  error: string | null; cleared: string | null;
  binding?: ReplyBinding;
};

/** How long a sent reply may sit with an idle agent before the chat says it was never taken. */
export const UNCLAIMED_MS = 20_000;
/** Replies older than this are history, whatever happened to them. */
export const STAGED_WINDOW_MS = 24 * 3600_000;
/** An acked reply the transcript doesn't show yet stays visible this long (the file lags the agent). */
const ACKED_GRACE_MS = 30_000;
/** Transcript turns are clipped (sessions TEXT_MAX), so a long reply is matched on its start. */
const MATCH_MAX = 1000;
const wanted = (s: string) => normText(s).slice(0, MATCH_MAX);
const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

const replyText = (it: IntentRecord) => String(it.payload?.text ?? it.payload?.message ?? "").trim();
const replyImages = (it: IntentRecord): string[] => (Array.isArray(it.payload?.images) ? it.payload.images.map(String) : []);

/**
 * Which replies the transcript shows as taken. A user turn after the reply was sent holds its text;
 * one turn can hold several replies (Claude Code joins messages popped back out of its queue), and
 * each reply claims its own stretch of a turn, so two identical replies need two occurrences.
 */
export function consumedReplies(replies: IntentRecord[], turns: Turn[]): Set<string> {
  return new Set(matchReplies(replies.map((it) => ({ id: it.id, text: replyText(it), images: replyImages(it), created: it.created })), turns).map((m) => m.id));
}

const holds = (list: QueuedText[] | null | undefined, text: string) => {
  const want = wanted(text);
  return Boolean(want && list?.some((q) => normText(q.text).includes(want)));
};

/** Where each recent reply to a worker stands; consumed and dismissed ones are left out. */
export function stagedReplies(o: {
  replies: IntentRecord[]; worker: WorkerView | null; transcript: TranscriptState | null; now?: number;
}): { staged: StagedReply[]; consumed: string[] } {
  const now = o.now ?? Date.now();
  const w = o.worker;
  const recent = o.replies.filter((it) => it.kind === "reply" && !(it as any).dismissed && now - ms(it.created) < STAGED_WINDOW_MS
    // A pane can host a later conversation: keep replies that went to this worker's session (or had none yet).
    && (!w?.session || !(it.result as any)?.session || (it.result as any).session === w.session));
  const turns = o.transcript?.turns ?? [];
  const consumed = consumedReplies(recent.filter((it) => it.status === "sent" || it.status === "acked"), turns);
  const idleSince = w && w.status !== "working" ? Math.max(ms(w.updated) || 0, 0) : null;
  const staged: StagedReply[] = [];
  for (const it of recent) {
    if (consumed.has(it.id)) continue;
    const text = replyText(it), r = (it.result ?? {}) as Record<string, any>;
    let state: StagedState;
    if (it.status === "pending") state = "sending";
    else if (it.status === "failed") state = "failed";
    // Acked on a weaker sign (Herdr said the agent started working) and there is no transcript to
    // check: it lingers briefly while the agent writes, then goes. With a transcript, only it decides.
    else if (it.status === "acked" && !o.transcript) {
      if (now - ms(it.updated) > ACKED_GRACE_MS) continue;
      state = "delivered";
    } else if (holds(o.transcript?.queue, text)) state = "queued";
    else if (holds(o.transcript?.pulled, text)) state = "pulled";
    else if (!w) state = "unclaimed";
    else if (w.status === "working" || w.status === "blocked") state = r.queued || o.transcript?.queue == null ? "queued" : "delivered";
    else if (now - Math.max(ms(it.updated), idleSince ?? 0) <= UNCLAIMED_MS) state = "delivered";
    // No transcript to check against (no session linked yet): it can't be confirmed either way, so it goes quietly.
    else if (!o.transcript) continue;
    else state = "unclaimed";
    const binding = ReplyBinding.safeParse(it.payload.binding);
    staged.push({
      id: it.id, text, images: replyImages(it), created: it.created, state,
      ...(binding.success ? { binding: binding.data } : {}),
      error: it.status === "failed" ? it.error ?? "The reply failed." : null,
      cleared: typeof r.cleared === "string" ? r.cleared : null,
    });
  }
  staged.sort((a, b) => (a.created < b.created ? -1 : 1));
  return { staged, consumed: [...consumed].filter((id) => recent.find((it) => it.id === id)?.status === "sent") };
}
