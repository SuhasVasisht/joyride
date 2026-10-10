// Pure formatting for the usage panel: reset times (local and relative), plan names, state labels.
import type { UsageState, UsageWindow } from "../../../shared/usage";

/** "in 3h 12m", "in 2d 4h", "in 9m", "in under a minute"; "now" once the reset has passed. */
export function relReset(iso: string | null, now: number): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "now";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "in under a minute";
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d) return `in ${d}d${h ? ` ${h}h` : ""}`;
  if (h) return `in ${h}h${mm ? ` ${mm}m` : ""}`;
  return `in ${mm}m`;
}

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
/** Local wall time: "today 18:46", "tomorrow 06:46", or "Sun 11 Oct, 06:46". */
export function localReset(iso: string | null, now: number): string {
  if (!iso) return "";
  const t = new Date(iso);
  if (!Number.isFinite(t.getTime())) return "";
  const time = t.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const today = new Date(now);
  if (sameDay(t, today)) return `today ${time}`;
  if (sameDay(t, new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1))) return `tomorrow ${time}`;
  return `${t.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}, ${time}`;
}

/**
 * Cursor's Plan & Usage wording: "Usage limits reset on Oct 25 (20 days left)".
 * The date is UTC, and a span of a day or more rounds up to whole days, matching Cursor's own screen.
 */
export function limitResetPhrase(iso: string | null, now: number): string {
  if (!iso) return "";
  const t = new Date(iso);
  if (!Number.isFinite(t.getTime())) return "";
  const date = t.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const ms = t.getTime() - now;
  const day = 86_400_000;
  let left: string;
  if (!Number.isFinite(ms) || ms <= 0) left = "0 minutes left";
  else if (ms >= day) {
    const d = Math.ceil(ms / day);
    left = `${d} day${d === 1 ? "" : "s"} left`;
  } else {
    const mins = Math.floor(ms / 60_000);
    const h = Math.floor(mins / 60), m = mins % 60;
    const hours = `${h} hour${h === 1 ? "" : "s"}`;
    const minutes = `${m} minute${m === 1 ? "" : "s"}`;
    left = h > 0 && m > 0 ? `${hours} and ${minutes} left` : h > 0 ? `${hours} left` : `${minutes} left`;
  }
  return `Usage limits reset on ${date} (${left})`;
}

/** "self_serve_business_prolite" -> "Self serve business prolite". */
export function planLabel(plan: string | null): string | null {
  if (!plan || plan === "unknown") return null;
  const s = plan.replace(/[_-]+/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : null;
}

/** Label and StateChip state (colour) for each usage state. */
const STATE: Record<UsageState, { label: string; chip: string }> = {
  live: { label: "Live", chip: "pass" },
  stale: { label: "Older reading", chip: "idle" },
  no_windows: { label: "No limits reported", chip: "idle" },
  keychain: { label: "Needs Keychain approval", chip: "blocked" },
  signed_out: { label: "Needs sign-in", chip: "blocked" },
  not_set_up: { label: "Not set up", chip: "idle" },
  not_signed_in: { label: "Not signed in", chip: "blocked" },
  rate_limited: { label: "Rate limited", chip: "idle" },
  error: { label: "Read failed", chip: "fail" },
  cli_missing: { label: "quota-axi missing", chip: "fail" },
  timeout: { label: "Timed out", chip: "fail" },
  unreadable: { label: "Unreadable output", chip: "fail" },
  failed: { label: "quota-axi failed", chip: "fail" },
};
export const stateInfo = (s: UsageState) => STATE[s] ?? { label: s, chip: "idle" };

/** Percent used, rounded; null when the window does not say. */
export const usedPct = (w: UsageWindow | null) => (w?.percentUsed == null ? null : Math.round(Math.min(100, Math.max(0, w.percentUsed))));

/** Bar tone: plain, getting close (75%+ used), or nearly out (90%+). */
export const tone = (pct: number | null) => (pct == null ? "none" : pct >= 90 ? "hot" : pct >= 75 ? "warm" : "ok");

