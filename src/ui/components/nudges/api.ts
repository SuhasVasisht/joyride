// Client side of the nudges module: the live list, acting on a nudge, feedback and idea briefs.
import { post, useApi } from "../../lib/api";
import type { FeedbackResult, FeedbackVerdict, IdeaBrief, Nudge, NudgesResponse } from "../../../shared/nudges";

export type { FeedbackResult, FeedbackVerdict, IdeaBrief, Nudge, NudgesResponse };
export type ActResult = { nudge: string; action: string; message: string; result?: any };

const enc = encodeURIComponent;

export function useNudges() {
  return useApi<NudgesResponse>("/api/nudges", ["nudges", "ideas", "tasks", "missions", "asks"]);
}

export const actOn = (id: string, action: string, words?: string) =>
  post<ActResult>(`/api/nudges/${enc(id)}/act`, { action, ...(words?.trim() ? { words: words.trim() } : {}), origin: "captain" });

export const sendFeedback = (task: string, verdict: FeedbackVerdict, words?: string) =>
  post<FeedbackResult>("/api/nudges/feedback", { task, verdict, ...(words?.trim() ? { words: words.trim() } : {}), origin: "captain" });

export function useIdeaBrief(idea: string | null) {
  return useApi<IdeaBrief>(idea ? `/api/nudges/briefs/${enc(idea)}` : null, ["idea_briefs", "tasks", "missions"]);
}

export function useIdeaBriefs() {
  return useApi<Record<string, IdeaBrief>>("/api/nudges/briefs", ["idea_briefs", "tasks", "missions"]);
}

/** The visible nudges pinned to one card (task, idea or worker), for the map to badge. */
export const nudgesOn = (list: Nudge[] | undefined, on: Nudge["place"]["on"], id: string) =>
  (list ?? []).filter((n) => n.place.on === on && n.place.id === id);
