// Pure helpers for the task sheet, shared with unit tests.
import type { Ask } from "../../../shared/asks";
import type { TimelineEvent } from "../../../modules/timeline/build";

export type { TimelineEvent };

/**
 * The asks a task sheet shows. Pinned on top: every ask the asks module places on this task
 * (its decision, a hold on it or one its report raised, a prompt on its worker), needs-you
 * first. From its report: captain calls whose hold origin is this task; the Report tab lists
 * them, pointing at the pinned card when the call is already pinned.
 */
export function tasksForAsk(asks: Ask[], task: string) {
  const own = (a: Ask) => a.task === task || (a.place.on === "task" && a.place.id === task);
  const pinned = asks.filter(own).sort((a, b) => Number(b.needs_you) - Number(a.needs_you));
  const fromReport = asks.filter((a) => a.task !== task && (a.hold?.origin === task || a.ref.gates === task));
  return { pinned, fromReport };
}

import { firstmateStatus } from "../../lib/firstmate-status";

/** Who said it and what kind of moment it is, in the sheet's plain words. */
export function timelineLabel(e: TimelineEvent): { who: string; what: string } {
  switch (e.kind) {
    case "brief": return { who: "Firstmate", what: "Briefed the crew" };
    case "status": {
      const what = e.verb === "needs-decision" ? "Asked for a decision" : firstmateStatus(e.verb ?? "").label;
      const open = e.state === "open" ? " · still open" : "";
      return { who: "Crew", what: `${what}${e.key && e.key !== "default" ? ` (${e.key})` : ""}${open}` };
    }
    case "steer": return { who: "Steer", what: e.state === "read" ? "Read by the crew" : "Waiting in the inbox" };
    case "note": return { who: "You", what: "Note" };
    case "ask": return { who: e.needs_you ? "Needs you" : "Ask", what: e.needs_you ? "Waiting on your answer" : "Open" };
    case "report": return { who: "Crew", what: "Report landed" };
  }
}

/** The answer text the captain sends: picked labels per call, then their own words. One line for held tasks. */
export function composeAnswer(ask: Pick<Ask, "calls" | "kind">, picks: Record<number, string>, words: string, oneLine: boolean) {
  const parts: string[] = [];
  ask.calls.forEach((c, i) => {
    const o = c.options.find((x) => x.id === picks[i]);
    if (!o) return;
    parts.push(ask.calls.length > 1 ? `${c.n ?? i + 1} ${o.id}: ${o.label}` : o.label);
  });
  const w = oneLine ? words.replace(/\s+/g, " ").trim() : words.trim();
  if (w) parts.push(w);
  return parts.join(ask.calls.length > 1 || oneLine ? "; " : "\n\n");
}
