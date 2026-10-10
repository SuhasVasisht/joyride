// Subscription usage as the usage module serves it (GET /api/usage): one entry per configured
// account (`usage.accounts`: Claude Code, Codex logins, Cursor), each with the windows quota-axi
// reports for it. Types only, so the daemon and the UI share them.

export type UsageProviderId = "claude" | "codex" | "cursor";

/**
 * - `live`, `stale`: a reading with windows (`stale` is an older reading quota-axi kept).
 * - `no_windows`: the provider answered but reported no usage window.
 * - `keychain`: quota-axi needs a one-time macOS Keychain approval (`remedy` holds the command).
 * - `signed_out`: the provider's login is missing or expired.
 * - `not_set_up`: quota-axi found no credentials for the provider's default login on this machine.
 * - `not_signed_in`: a configured credential folder has no login yet (`remedy` is the login command).
 * - `rate_limited`, `error`: the provider's own read failed.
 * - `cli_missing`, `timeout`, `unreadable`, `failed`: quota-axi itself could not be run or read;
 *   every account read by that run carries the same state.
 */
export type UsageState =
  | "live" | "stale" | "no_windows" | "keychain" | "signed_out" | "not_set_up" | "not_signed_in" | "rate_limited" | "error"
  | "cli_missing" | "timeout" | "unreadable" | "failed";

export type UsagePace = "ahead" | "on_pace" | "behind";

export type UsageWindow = {
  /** Where the window sits on the card: `five_hour` and `weekly` for Claude and Codex, `cursor_models` and `other_models` for Cursor, quota-axi's id otherwise. */
  slot: string;
  /** quota-axi's window id (`five_hour`, `seven_day`, `weekly`, `auto_usage`, ...); null when not reported. */
  id: string | null;
  /** "Five-hour", "Weekly", "Cursor Models", "Other Models", or the provider's own name. */
  label: string;
  /** A short subtitle Cursor shows under the bucket ("Includes Cursor Grok and Composer"); null when there is none. */
  detail: string | null;
  /** The provider's overflow note, or why a window is not reported; null when there is none. */
  note: string | null;
  /** quota-axi's kind (`session`, `weekly`, `monthly`, ...), when it says. */
  kind: string | null;
  /** False when this card expects the window and the provider did not report it. */
  reported: boolean;
  percentUsed: number | null;
  percentRemaining: number | null;
  resetsAt: string | null;
  /** The provider's own reset wording when it gives no timestamp. */
  resetText: string | null;
  /** Usage against the reset clock: `ahead` means burning faster than the window allows. */
  pace: UsagePace | null;
};

export type ProviderUsage = {
  /** The configured account's id (what `launch_session` takes as `account`). */
  account: string;
  provider: UsageProviderId;
  /** The account's label. */
  title: string;
  /** The account's credential folder ("~/.codex-2"); null for the default login. */
  home: string | null;
  state: UsageState;
  /** What happened, in a sentence; null when the reading is live. */
  message: string | null;
  /** A command that fixes the state, when there is one. */
  remedy: string | null;
  plan: string | null;
  windows: UsageWindow[];
  /** Effective percent remaining across the limiting windows, when quota-axi knows it. */
  effectiveRemaining: number | null;
  /** quota-axi's account-wide runway; absent in older reports. */
  exhaustedNow?: boolean;
  runwaySeconds?: number | null;
};

export type UsageReport = {
  /** When quota-axi ran (or failed). */
  fetchedAt: string;
  /** quota-axi's own `generatedAt`, when it answered. */
  generatedAt: string | null;
  /** Seconds the daemon serves this report before reading again. */
  maxAgeSeconds: number;
  providers: ProviderUsage[];
};

/** GET /api/usage always returns immediately, including during the first provider read. */
export type UsageSnapshot = Omit<UsageReport, "fetchedAt"> & {
  fetchedAt: string | null;
  ageSeconds: number | null;
  refreshing: boolean;
};

/** A configured account as GET /api/usage/accounts lists it, for account pickers. */
export type UsageAccountInfo = { id: string; provider: UsageProviderId; label: string; home: string | null };
