// Turns quota-axi `--json` output (schemaVersion 5) into one usage card per configured account,
// and a failed run into the matching state for every account that run read. Default logins come
// from one shared run; each credential folder from its own `--profile-only` run.
// Pure: the module supplies the accounts and run results.
import type { ProviderUsage, UsagePace, UsageReport, UsageState, UsageWindow } from "../../shared/usage.ts";
import { PROVIDER_TITLES, loginCommand, quotaCheckCommand, resolveAccounts, type Account } from "../../core/accounts.ts";

export const KEYCHAIN_REMEDY = "quota-axi --allow-keychain-prompt";

/** One quota-axi run. `ok` carries stdout whatever the exit code; quota-axi reports per-provider failures in the JSON. */
export type SourceResult =
  | { kind: "ok"; stdout: string }
  | { kind: "missing" }
  | { kind: "timeout"; seconds: number }
  | { kind: "failed"; code: number | null; output: string };

/** The runs behind one report: `shared` reads every default login, `profiles` one credential folder each (by account id). */
export type Runs = { shared: SourceResult | null; profiles: Record<string, SourceResult> };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const PACES: UsagePace[] = ["ahead", "on_pace", "behind"];
const sentence = (s: string) => s[0].toUpperCase() + s.slice(1);

function toWindow(w: any, slot: string, label: string): UsageWindow {
  const used = num(w.percentUsed), left = num(w.percentRemaining);
  return {
    slot,
    id: String(w.id),
    label,
    detail: null,
    note: null,
    kind: str(w.kind),
    reported: true,
    percentUsed: used ?? (left === null ? null : Math.max(0, 100 - left)),
    percentRemaining: left ?? (used === null || w.shareOf ? null : Math.max(0, 100 - used)),
    resetsAt: str(w.resetsAt),
    resetText: str(w.resetText),
    pace: PACES.includes(w.pace?.status) ? w.pace.status : null,
  };
}
const unreported = (slot: string, label: string, note: string | null = null): UsageWindow =>
  ({ slot, id: null, label, detail: null, note, kind: null, reported: false, percentUsed: null, percentRemaining: null, resetsAt: null, resetText: null, pace: null });

/**
 * Cursor's Plan & Usage screen (Settings) shows two buckets, not quota-axi's four rows.
 * quota-axi's `auto_usage` is `planUsage.autoPercentUsed` ("Cursor Models", which includes
 * Cursor Grok and Composer). `api_usage` is `planUsage.apiPercentUsed` ("Other Models").
 * `included_usage` is `totalPercentUsed`, the combined figure, and is not its own bar beside
 * those buckets. When the payload has neither bucket, that total is the only plan limit and stays.
 * `grok_bot` is GetSandUsageStatus, a separate weekly meter Plan & Usage does not draw, so it
 * stays on the card under its own name and reset. The notes are Cursor's settings copy for the
 * two buckets (the client remap of the spillover UI config), not measured usage.
 */
const CURSOR_MODELS_NOTE = "Additional usage beyond limits consumes Other Models quota or on-demand spend.";
const OTHER_MODELS_NOTE = "Additional usage beyond limits consumes on-demand spend.";

function cursorBucket(w: any, slot: string, label: string, detail: string | null, note: string): UsageWindow {
  return { ...toWindow(w, slot, label), detail, note };
}

function cursorWindows(plain: any[]): UsageWindow[] {
  const find = (id: string) => plain.find((w) => w.id === id);
  const auto = find("auto_usage"), api = find("api_usage"), grok = find("grok_bot");
  const grokRow = grok ? [toWindow(grok, "grok_bot", sentence(str(grok.label) ?? "Grok Bot"))] : [];
  if (!auto && !api) {
    // No Plan & Usage breakdown. Keep the total and any other real window, including Grok Bot.
    const rest = plain.filter((w) => w.id !== "grok_bot");
    return [...rest.map((w) => toWindow(w, w.id, sentence(str(w.label) ?? w.id.replace(/_/g, " ")))), ...grokRow];
  }
  return [
    auto ? cursorBucket(auto, "cursor_models", "Cursor Models", "Includes Cursor Grok and Composer", CURSOR_MODELS_NOTE) : unreported("cursor_models", "Cursor Models", "quota-axi did not report Cursor Models."),
    api ? cursorBucket(api, "other_models", "Other Models", null, OTHER_MODELS_NOTE) : unreported("other_models", "Other Models", "quota-axi did not report Other Models."),
    ...grokRow,
  ];
}

/** Claude and Codex: the account-wide five-hour and weekly windows, plus any model-specific
 *  window and extra usage the provider reported. Code-review windows are a separate workload.
 *  Cursor: the two Plan & Usage buckets. */
function pickWindows(provider: Account["provider"], windows: any[]): UsageWindow[] {
  const plain = windows.filter((w) => w && typeof w.id === "string" && !w.id.startsWith("code_review") && !w.shareOf);
  if (provider === "cursor") return cursorWindows(plain);
  if (provider !== "claude" && provider !== "codex") return plain.map((w) => toWindow(w, w.id, sentence(str(w.label) ?? w.id.replace(/_/g, " "))));
  const five = plain.find((w) => w.id === "five_hour") ?? plain.find((w) => w.kind === "session");
  const week = plain.find((w) => w.id === "seven_day" || w.id === "weekly") ?? plain.find((w) => w.kind === "weekly");
  const rest = plain.filter((w) => w !== five && w !== week && (w.kind === "model" || String(w.id).startsWith("model:") || w.id === "extra_usage"));
  if (!five && !week && !rest.length) return [];
  return [
    five ? toWindow(five, "five_hour", "Five-hour") : unreported("five_hour", "Five-hour", "The provider did not report a five-hour limit."),
    week ? toWindow(week, "weekly", "Weekly") : unreported("weekly", "Weekly", "The provider did not report a weekly limit."),
    ...rest.map((w) => toWindow(w, w.id, sentence(str(w.label) ?? w.id.replace(/_/g, " ")))),
  ];
}

const blank = (a: Account, state: UsageState, message: string | null, remedy: string | null = null): ProviderUsage =>
  ({ account: a.id, provider: a.provider, title: a.label, home: a.homeLabel, state, message, remedy, plan: null, windows: [], effectiveRemaining: null });

function accountUsage(a: Account, p: any): ProviderUsage {
  const title = a.label, product = PROVIDER_TITLES[a.provider];
  const st = p?.state ?? {};
  const login = loginCommand(a);
  if (a.home && (!p || p.notSetUp || /credentials? missing/i.test(String(st.error ?? "")))) {
    return blank(a, "not_signed_in", `No ${product} login in ${a.homeLabel} yet. Sign in with the command below, then refresh.`, login);
  }
  if (!p || p.notSetUp) return blank(a, "not_set_up", `quota-axi found no ${product} login on this machine. Sign in to ${product}, then refresh.`, login);
  const remedy = str(st.remedyCommand);
  if (st.status === "auth_required") {
    if (st.reason === "keychain_access_required" || st.error === "keychain_prompt_required") {
      return blank(a, "keychain", `quota-axi needs a one-time Keychain approval to read ${title}'s usage. Run the command below and choose "Always Allow".`, remedy ?? KEYCHAIN_REMEDY);
    }
    if (st.reason === "inference_opt_in_required") {
      return blank(a, "signed_out", `quota-axi can only read ${title}'s usage by sending a tiny request, and that needs your opt-in. Run the command below once.`, remedy);
    }
    return blank(a, "signed_out", `${title}'s login has expired or is missing. Sign in to ${product} again, then refresh.`, a.home ? login : remedy);
  }
  if (st.status === "rate_limited") return blank(a, "rate_limited", `${product} is rate limiting usage reads. Joyride tries again in a minute.`, remedy);
  if (st.status === "unavailable" || st.status === "error") {
    const detail = str(st.error) ? ` (${str(st.error)})` : "";
    return blank(a, "error", `quota-axi could not read ${title}'s usage${detail}. Run \`${quotaCheckCommand(a)}\` to see why.`, remedy);
  }
  const avail: any[] = Array.isArray(p.quotaSemantics?.effectiveAvailability) ? p.quotaSemantics.effectiveAvailability : [];
  const scope = avail.find((x) => x?.scope === "all_models") ?? avail[0];
  const windows = pickWindows(a.provider, Array.isArray(p.windows) ? p.windows : []);
  const stale = st.stale === true || st.status === "stale";
  const out: ProviderUsage = {
    ...blank(a, stale ? "stale" : "live", stale ? `This is an older reading; quota-axi could not refresh ${title} just now.` : null, remedy),
    plan: str(p.plan),
    windows,
    effectiveRemaining: num(scope?.effectivePercentRemaining),
    ...(scope?.runway ? { exhaustedNow: scope.runway.status === "exhausted_now", runwaySeconds: num(scope.runway.usableRunwaySeconds) } : {}),
  };
  if (!windows.length) {
    const what = a.provider === "claude" || a.provider === "codex" ? "no five-hour or weekly limit" : "no usage windows";
    return { ...out, state: "no_windows", message: `${title} answered but reported ${what}.` };
  }
  return out;
}

type Parsed = { generatedAt: string | null; providers: any[] };
function parseDoc(stdout: string): Parsed | null {
  let doc: any;
  try { doc = JSON.parse(stdout); } catch { return null; }
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.providers)) return null;
  return { generatedAt: str(doc.generatedAt), providers: doc.providers };
}

/** Parses one quota-axi report for the given accounts; null when the text is not a quota-axi report. */
export function parseQuota(stdout: string, accounts: Account[] = resolveAccounts()): { generatedAt: string | null; providers: ProviderUsage[] } | null {
  const doc = parseDoc(stdout);
  if (!doc) return null;
  return { generatedAt: doc.generatedAt, providers: accounts.map((a) => accountUsage(a, doc.providers.find((p: any) => p?.provider === a.provider))) };
}

/** An account's card when its run did not produce a readable report. */
function failedRun(a: Account, result: Exclude<SourceResult, { kind: "ok" }> | { kind: "unreadable" }): ProviderUsage {
  const check = quotaCheckCommand(a);
  switch (result.kind) {
    case "missing":
      return blank(a, "cli_missing", "quota-axi is not installed, so Joyride cannot read usage limits. Install it, then refresh.", "npm install -g quota-axi");
    case "timeout":
      return blank(a, "timeout", `quota-axi did not answer within ${result.seconds} seconds. Joyride tries again in a minute; run \`${check}\` to check it by hand.`);
    case "failed": {
      const tail = result.output.trim().split("\n").filter(Boolean).pop()?.slice(0, 200);
      return blank(a, "failed", `quota-axi exited with code ${result.code ?? "unknown"}${tail ? `: ${tail}` : ""}. Run \`${check}\` to see why.`);
    }
    case "unreadable":
      return blank(a, "unreadable", "quota-axi answered with output Joyride cannot read. Update it with `quota-axi update`, then refresh.");
  }
}

/** The usage report for the given accounts: each read from the shared run, or from its own folder's run. */
export function buildReport(accounts: Account[], runs: Runs, now: Date, maxAgeSeconds: number): UsageReport {
  const parsed = new Map<SourceResult, Parsed | null>();
  let generatedAt: string | null = null;
  const providers = accounts.map((a) => {
    const result: SourceResult = (a.home ? runs.profiles[a.id] : runs.shared) ?? { kind: "failed", code: null, output: "Joyride did not run quota-axi for this account." };
    if (result.kind !== "ok") return failedRun(a, result);
    if (!parsed.has(result)) parsed.set(result, parseDoc(result.stdout));
    const doc = parsed.get(result);
    if (!doc) return failedRun(a, { kind: "unreadable" });
    if (!a.home || !generatedAt) generatedAt = doc.generatedAt ?? generatedAt;
    return accountUsage(a, doc.providers.find((p: any) => p?.provider === a.provider));
  });
  return { fetchedAt: now.toISOString(), generatedAt, maxAgeSeconds, providers };
}
