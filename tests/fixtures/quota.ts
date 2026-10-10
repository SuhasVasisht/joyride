// quota-axi `--json` output (schemaVersion 5) for Claude, Codex and Cursor, plus `--profile-only` runs
// for a second Codex folder, shaped like real runs on this Mac. Reset times are relative to `now` so
// relative labels ("in 3h 12m") stay predictable.
const at = (now: number, ms: number) => new Date(now + ms).toISOString();
const H = 3600e3, M = 60e3, D = 24 * H;

/** Codex's live reading as quota-axi printed it, plus a five-hour window. */
export function codexLive(now: number, o: { fiveUsed?: number; weekUsed?: number } = {}) {
  const five = o.fiveUsed ?? 23, week = o.weekUsed ?? 41;
  return {
    provider: "codex",
    plan: "self_serve_business_prolite",
    windows: [
      { id: "five_hour", label: "session", kind: "session", percentUsed: five, percentRemaining: 100 - five, resetsAt: at(now, 3 * H + 12 * M + 30e3), pace: { status: "on_pace", reservePercentPoints: 1.2, burnMultiple: 1 } },
      { id: "weekly", label: "week", kind: "weekly", percentUsed: week, percentRemaining: 100 - week, resetsAt: at(now, 6 * D + 5 * H + 30e3), pace: { status: "behind", reservePercentPoints: 10.89, burnMultiple: 0.7 } },
      { id: "code_review_five_hour", label: "code review session", kind: "session", percentUsed: 99, percentRemaining: 1, resetsAt: at(now, H) },
    ],
    credits: { unlimited: false, unit: "credits" },
    state: { status: "fresh", stale: false },
    accountKeys: ["codex-home"],
    quotaSemantics: {
      status: "known",
      effectiveAvailability: [{ scope: "all_models", status: "known", effectivePercentRemaining: Math.min(100 - five, 100 - week), boundedBy: ["five_hour", "weekly"], limitingWindowIds: [five > week ? "five_hour" : "weekly"] }],
    },
  };
}

/** Claude once the Keychain is approved: percentUsed from the API, plus a per-model window. */
export function claudeLive(now: number, o: { fiveUsed?: number; weekUsed?: number } = {}) {
  const five = o.fiveUsed ?? 92, week = o.weekUsed ?? 57;
  return {
    provider: "claude",
    plan: "max",
    windows: [
      { id: "five_hour", label: "session", kind: "session", percentUsed: five, percentRemaining: 100 - five, resetsAt: at(now, 47 * M + 30e3), windowSeconds: 18000, pace: { status: "ahead", reservePercentPoints: -7.5, burnMultiple: 1.1 } },
      { id: "seven_day", label: "week", kind: "weekly", percentUsed: week, percentRemaining: 100 - week, resetsAt: at(now, 2 * D + 4 * H + 30e3), windowSeconds: 604800, pace: { status: "ahead", reservePercentPoints: -3, burnMultiple: 1.05 } },
      { id: "model:opus", label: "Opus week", kind: "model", percentUsed: 12, percentRemaining: 88, resetsAt: at(now, 2 * D) },
    ],
    state: { status: "fresh", stale: false },
    accountKeys: ["default"],
    quotaSemantics: {
      status: "known",
      effectiveAvailability: [{ scope: "all_models", status: "known", effectivePercentRemaining: 100 - five, boundedBy: ["five_hour", "seven_day"], limitingWindowIds: ["five_hour"] }],
    },
  };
}

/** Claude before the one-time Keychain approval: exactly what quota-axi printed on this Mac. */
export const claudeKeychain = () => ({
  provider: "claude",
  windows: [],
  state: { status: "auth_required", stale: false, error: "keychain_prompt_required", reason: "keychain_access_required", remedyCommand: "quota-axi --allow-keychain-prompt" },
  quotaSemantics: { status: "unknown", effectiveAvailability: [] },
  accountKeys: ["default"],
});

export const report = (now: number, providers: unknown[]) => JSON.stringify({ generatedAt: new Date(now).toISOString(), schemaVersion: 5, providers, help: [] });
/** Both live. */
export const liveStdout = (now: number) => report(now, [claudeLive(now), codexLive(now)]);
/** Today's machine: Claude waits on the Keychain, Codex is live. */
export const keychainStdout = (now: number) => report(now, [claudeKeychain(), codexLive(now)]);

/** Cursor as quota-axi prints it: included (combined total), auto, API, and a Grok Bot window.
 *  Joyride shows auto as Cursor Models and API as Other Models. The combined total stays off that card.
 *  Grok Bot stays, under its own name, because it is a separate weekly meter. */
export function cursorLive(now: number, o: { includedUsed?: number } = {}) {
  const used = o.includedUsed ?? 34;
  const pace = { status: "behind", reservePercentPoints: 31.1, burnMultiple: 0 };
  return {
    provider: "cursor",
    plan: "Team",
    windows: [
      { id: "included_usage", label: "included usage", kind: "monthly", resetsAt: at(now, 20 * D + 15 * H), percentRemaining: 100 - used, pace },
      { id: "auto_usage", label: "auto usage", kind: "monthly", resetsAt: at(now, 20 * D + 15 * H), percentRemaining: 88, pace },
      { id: "api_usage", label: "API usage", kind: "monthly", resetsAt: at(now, 20 * D + 15 * H), percentRemaining: 100, pace },
      { id: "grok_bot", label: "Grok Bot", kind: "weekly", resetsAt: at(now, 4 * D + 2 * H), percentRemaining: 100, pace: { status: "behind", reservePercentPoints: 37.5, burnMultiple: 0 } },
    ],
    state: { status: "fresh", stale: false },
    quotaSemantics: {
      status: "known",
      effectiveAvailability: [
        { scope: "all_models", status: "known", effectivePercentRemaining: 100 - used, boundedBy: ["included_usage", "auto_usage", "api_usage"], limitingWindowIds: ["included_usage", "auto_usage", "api_usage"] },
        { scope: "grok_bot", status: "known", effectivePercentRemaining: 100, boundedBy: ["grok_bot"], limitingWindowIds: ["grok_bot"] },
      ],
    },
    accountKeys: ["default"],
  };
}

/** `CODEX_HOME=<empty folder> quota-axi --provider codex --profile-only --full --json`, exactly as printed on this Mac. */
export const codexProfileMissing = () => ({
  provider: "codex",
  label: "Codex",
  source: "unavailable",
  windows: [],
  state: { status: "unavailable", stale: false, error: "Codex profile credentials missing", sourcesTried: ["oauth"] },
  attempts: [{ source: "oauth", status: "skipped", error: "credentials_missing" }],
  accountKeys: ["codex-home"],
  quotaSemantics: { status: "unknown", description: "No quota windows are available, so no effective remaining percentage can be computed.", effectiveAvailability: [] },
  notSetUp: true,
});

/** All three default logins live. */
export const allLiveStdout = (now: number) => report(now, [claudeLive(now), codexLive(now), cursorLive(now)]);
/** A second Codex folder's `--profile-only` run, signed in and live. */
export const codexProfileStdout = (now: number, o: { fiveUsed?: number; weekUsed?: number } = {}) => report(now, [codexLive(now, o)]);
/** A second Codex folder with no login yet. */
export const codexProfileMissingStdout = (now: number) => report(now, [codexProfileMissing()]);
