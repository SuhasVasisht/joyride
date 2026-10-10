// What each agent is trying to do (the intentions module): goal, now, next and
// what it waits on, per session key. Live: refetched on "intentions" changes.
import { useMemo } from "react";
import { useApi } from "./api";

export type Intention = { key: string; goal: string; now: string; next: string; waiting_on: string | null; sig: string; generated: string };
export type IntentionView = { key: string; intention: Intention | null; pending: boolean; stale: boolean; error: string | null };

/** One session's intention; opening it asks for one if it is missing or stale. "unavailable" when the daemon can't say (no such session, older daemon). */
export function useIntention(key: string | null | undefined): IntentionView | "unavailable" | null {
  const { data, error } = useApi<IntentionView>(key ? `/api/intentions/${encodeURIComponent(key)}` : null, ["intentions"]);
  if (data && data.key === key) return data;
  return error ? "unavailable" : null;
}

/** Intentions for many sessions (map, rail), as a map from session key. */
export function useIntentions(keys: (string | null | undefined)[]): Map<string, Intention> {
  const list = useMemo(() => [...new Set(keys.filter(Boolean) as string[])].sort(), [keys.filter(Boolean).sort().join(",")]);
  const { data } = useApi<{ items: Record<string, Intention>; pending: string[] }>(list.length ? `/api/intentions?keys=${encodeURIComponent(list.join(","))}` : null, ["intentions"]);
  return useMemo(() => new Map(Object.entries(data?.items ?? {})), [data]);
}
