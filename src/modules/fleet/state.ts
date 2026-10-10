// A fleet member's state in Firstmate's own words, inferred from what Joyride already sees (Herdr status,
// hooks, open attention). Watched sessions never write Firstmate status lines, so every state here is
// labelled inferred, the way evidence mined from transcripts is.
//   blocked         waiting at a prompt (Herdr blocked) or an open permission or gated-action item
//   needs-decision  an open question or decision for the captain (L3 and up)
//   failed          an open error: a crashed or failed turn
//   working         a turn is running
//   done            Herdr says done, or an open "done with evidence" review item (L2)
//   paused          at rest with nothing open
import type { AttentionItem, WorkerView } from "../../shared/schema.ts";

export type FleetState = "working" | "blocked" | "needs-decision" | "failed" | "done" | "paused";
/** Transitions Firstmate hears about; working and paused are left to `joyride fleet`. */
export const REPORTED_STATES: ReadonlySet<FleetState> = new Set(["blocked", "needs-decision", "failed", "done"]);

const rank = (l: string) => Number(String(l).slice(1)) || 0;

type Attn = Pick<AttentionItem, "level" | "kind" | "title" | "why" | "worker" | "session" | "resolved" | "snoozed_until">;

export function inferState(w: Pick<WorkerView, "id" | "status" | "session" | "current_action" | "last_message">, attention: Attn[], now = Date.now()): { state: FleetState; why: string } {
  const open = attention.filter((a) => !a.resolved && (a.worker === w.id || (w.session && a.session === w.session)) && !(a.snoozed_until && Date.parse(a.snoozed_until) > now));
  const find = (kinds: string[], min: number) => open.find((a) => kinds.includes(a.kind) && rank(a.level) >= min);
  const line = (a: Attn | undefined, fallback: string) => (a ? (a.why || a.title) : fallback) || fallback;
  const gate = find(["approval", "guard"], 3);
  if (w.status === "blocked" || gate) return { state: "blocked", why: line(gate, w.current_action || "Waiting at a prompt") };
  const ask = find(["question", "decision"], 3);
  if (ask) return { state: "needs-decision", why: line(ask, "Waiting on the captain") };
  const err = find(["error"], 3);
  if (err) return { state: "failed", why: line(err, "The last turn failed") };
  if (w.status === "working") return { state: "working", why: w.current_action || "Working" };
  const review = find(["review"], 2);
  if (w.status === "done" || review) return { state: "done", why: line(review, w.last_message || "Finished its turn") };
  return { state: "paused", why: w.last_message ? `Idle after: ${w.last_message.replace(/\s+/g, " ").slice(0, 140)}` : "Idle" };
}
