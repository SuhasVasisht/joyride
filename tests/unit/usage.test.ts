// Usage limits: the account list (usage.accounts), quota-axi JSON parsing (five-hour and weekly
// windows for Claude and Codex, Cursor's own windows, pace), per-folder `--profile-only` reads and
// the not-signed-in state, every no-data and failure state, the real runner against stand-in scripts
// (missing, timeout, non-zero exit, folder env), the route's minute cache, and the panel's time
// formatting. quota-axi never runs.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { sandboxDaemon } from "../sandbox.ts";
import os from "node:os";
import { buildReport, parseQuota, KEYCHAIN_REMEDY, type SourceResult } from "../../src/modules/usage/quota.ts";
import { runQuotaAxi, setQuotaSource, quotaArgs, quotaRequests, MAX_AGE_S, type QuotaRequest } from "../../src/modules/usage/index.ts";
import { resolveAccounts, readAccounts, loginCommand, launchEnv, quotaCheckCommand } from "../../src/core/accounts.ts";
import { limitResetPhrase, localReset, planLabel, relReset, stateInfo, tone, usedPct } from "../../src/ui/views/usage/format.ts";
import { allLiveStdout, claudeKeychain, claudeLive, codexLive, codexProfileMissingStdout, codexProfileStdout, cursorLive, keychainStdout, liveStdout, report } from "../fixtures/quota.ts";

const NOW = Date.parse("2026-10-05T01:04:14.286Z");
const H = 3600e3, M = 60e3;
const parse = (stdout: string) => parseQuota(stdout)!;
const byId = (r: { providers: any[] }, id: string) => r.providers.find((p) => p.provider === id);
const win = (p: any, slot: string) => p.windows.find((w: any) => w.slot === slot);
/** Claude, Codex at its default folder, a second Codex folder, Cursor: the captain's four accounts. */
const SECOND = path.join(os.tmpdir(), "joyride-usage-codex-2");
const FOUR = resolveAccounts([{ provider: "claude" }, { provider: "codex", home: "~/.codex" }, { provider: "codex", label: "Codex 2", home: SECOND }, { provider: "cursor" }]);

describe("accounts", () => {
  it("defaults to one Claude, one Codex and Cursor, each on its default login", () => {
    expect(resolveAccounts().map((a) => [a.id, a.provider, a.label, a.home, a.envVar])).toEqual([
      ["claude-code", "claude", "Claude Code", null, null],
      ["codex", "codex", "Codex", null, null],
      ["cursor", "cursor", "Cursor", null, null],
    ]);
  });

  it("gives each folder its env var, treats ~/.codex as the default login, and keeps ids unique", () => {
    const a = resolveAccounts([
      { provider: "codex", home: "~/.codex" },
      { provider: "codex", home: "~/.codex-2" },
      { provider: "codex", label: "Codex 2", home: "/srv/codex-third" },
      { provider: "claude", label: "Work Claude", home: "~/.claude-work" },
      { provider: "cursor", home: "~/.cursor-elsewhere" },
    ]);
    expect(a.map((x) => [x.id, x.label, x.homeLabel, x.envVar])).toEqual([
      ["codex", "Codex", null, null],
      ["codex-2", "Codex 2", "~/.codex-2", "CODEX_HOME"],
      ["codex-2-2", "Codex 2", "/srv/codex-third", "CODEX_HOME"],
      ["work-claude", "Work Claude", "~/.claude-work", "CLAUDE_CONFIG_DIR"],
      // Cursor has no folder to point at; quota-axi reads its one signed-in login.
      ["cursor", "Cursor", null, null],
    ]);
    expect(a[1].home).toBe(path.join(os.homedir(), ".codex-2"));
    expect(resolveAccounts([{ provider: "codex", id: "Second Codex", home: "~/.codex-2" }])[0].id).toBe("second-codex");
  });

  it("builds the login, launch environment and check command for a folder", () => {
    const [def, second, work] = resolveAccounts([{ provider: "codex" }, { provider: "codex", home: "~/.codex-2" }, { provider: "claude", home: "/Users/me/claude two" }]);
    expect(loginCommand(def)).toBe("codex login");
    expect(launchEnv(def)).toEqual({});
    expect(quotaCheckCommand(def)).toBe("quota-axi --provider codex --full");
    expect(loginCommand(second)).toBe("mkdir -p ~/.codex-2 && CODEX_HOME=~/.codex-2 codex login");
    expect(launchEnv(second)).toEqual({ CODEX_HOME: path.join(os.homedir(), ".codex-2") });
    expect(quotaCheckCommand(second)).toBe("CODEX_HOME=~/.codex-2 quota-axi --provider codex --profile-only --full");
    expect(loginCommand(work)).toBe("mkdir -p '/Users/me/claude two' && CLAUDE_CONFIG_DIR='/Users/me/claude two' claude auth login");
    expect(loginCommand(resolveAccounts([{ provider: "cursor" }])[0])).toBeNull();
  });

  it("reads usage.accounts from joyride.config.yaml as it is now, and falls back to the defaults", () => {
    const file = path.join(process.env.JOYRIDE_HOME!, "joyride.config.yaml");
    const before = fs.readFileSync(file, "utf8");
    try {
      // The sandbox pins its own accounts, whatever the repo's config lists.
      expect(readAccounts().map((a) => [a.id, a.home])).toEqual([["claude-code", null], ["codex", null], ["cursor", null]]);
      // The shipped config: Claude, Codex on its default folder, a second Codex folder, Cursor.
      fs.copyFileSync(path.resolve("joyride.config.example.yaml"), file);
      expect(readAccounts().map((a) => [a.id, a.homeLabel])).toEqual([["claude-code", null], ["codex", null], ["codex-2", "~/.codex-2"], ["cursor", null]]);
      fs.writeFileSync(file, "port: 4317\n");
      expect(readAccounts().map((a) => a.id)).toEqual(["claude-code", "codex", "cursor"]);
    } finally { fs.writeFileSync(file, before); }
  });
});

describe("reading each account", () => {
  it("reads default logins in one shared run and each folder in its own --profile-only run", () => {
    const reqs = quotaRequests(FOUR, false);
    expect(reqs).toEqual([
      { fresh: false, providers: ["claude", "codex", "cursor"], profile: null },
      { fresh: false, providers: ["codex"], profile: { account: "codex-2", envVar: "CODEX_HOME", home: SECOND } },
    ]);
    expect(quotaArgs(reqs[0])).toEqual(["--provider", "claude,codex,cursor", "--json", "--max-age", "60s"]);
    expect(quotaArgs({ ...reqs[0], fresh: true })).toEqual(["--provider", "claude,codex,cursor", "--json"]);
    expect(quotaArgs(reqs[1])).toEqual(["--provider", "codex", "--profile-only", "--full", "--json"]);
    expect(quotaRequests(FOUR.slice(2, 3), false).map((r) => r.profile?.account)).toEqual(["codex-2"]);
  });

  it("shows four cards, each with its own windows, reset times and plan", () => {
    const r = buildReport(FOUR, { shared: { kind: "ok", stdout: allLiveStdout(NOW) }, profiles: { "codex-2": { kind: "ok", stdout: codexProfileStdout(NOW, { fiveUsed: 64, weekUsed: 12 }) } } }, new Date(NOW), MAX_AGE_S);
    expect(r.providers.map((p) => [p.account, p.provider, p.title, p.home, p.state])).toEqual([
      ["claude-code", "claude", "Claude Code", null, "live"],
      ["codex", "codex", "Codex", null, "live"],
      ["codex-2", "codex", "Codex 2", SECOND, "live"],
      ["cursor", "cursor", "Cursor", null, "live"],
    ]);
    expect(r.generatedAt).toBe(new Date(NOW).toISOString());
    expect(win(r.providers[1], "five_hour").percentUsed).toBe(23);
    expect(win(r.providers[2], "five_hour").percentUsed).toBe(64);
    expect(win(r.providers[2], "weekly").percentUsed).toBe(12);
    expect(r.providers[2].plan).toBe("self_serve_business_prolite");
    expect(r.providers[3].plan).toBe("Team");
  });

  it("shows Cursor's Plan & Usage buckets and never invents five-hour or weekly ones", () => {
    const cursor = byId(parse(report(NOW, [cursorLive(NOW)])), "cursor");
    expect(cursor.windows.map((w: any) => [w.slot, w.id, w.label, w.kind, w.percentUsed])).toEqual([
      ["cursor_models", "auto_usage", "Cursor Models", "monthly", 12],
      ["other_models", "api_usage", "Other Models", "monthly", 0],
      ["grok_bot", "grok_bot", "Grok Bot", "weekly", 0],
    ]);
    expect(cursor.windows[0]).toMatchObject({
      detail: "Includes Cursor Grok and Composer",
      note: "Additional usage beyond limits consumes Other Models quota or on-demand spend.",
    });
    expect(cursor.windows[1].note).toBe("Additional usage beyond limits consumes on-demand spend.");
    // Included usage is the combined total, so it is not a third plan bar. Grok Bot stays: it is a separate weekly meter.
    expect(cursor.windows.some((w: any) => w.slot === "included_usage" || w.slot === "five_hour" || w.slot === "weekly")).toBe(false);
    expect(cursor.windows[0].resetsAt).toBe(new Date(NOW + 20 * 24 * H + 15 * H).toISOString());
    expect(cursor.effectiveRemaining).toBe(66);
    const empty = byId(parse(report(NOW, [{ ...cursorLive(NOW), windows: [] }])), "cursor");
    expect(empty).toMatchObject({ state: "no_windows", message: "Cursor answered but reported no usage windows." });
  });

  it("maps captured quota-axi payloads and leaves a missing bucket not reported", () => {
    // Shapes from quota-axi 0.1.57 --full --json on this Mac, with percents and timestamps replaced.
    const pace = { status: "behind", reservePercentPoints: 1.5, burnMultiple: 0.2 };
    const captured = report(NOW, [
      {
        provider: "claude", plan: "team", label: "Claude Code", source: "oauth",
        windows: [
          { id: "five_hour", label: "session", kind: "session", percentUsed: 17, percentRemaining: 83, resetsAt: "2026-10-06T07:30:00.000Z", windowSeconds: 18000, pace },
          { id: "seven_day", label: "week", kind: "weekly", percentUsed: 41, percentRemaining: 59, resetsAt: "2026-10-06T22:00:00.000Z", windowSeconds: 604800, pace },
          { id: "model:fable", label: "Fable week", kind: "model", percentUsed: 4, percentRemaining: 96, resetsAt: "2026-10-06T22:00:00.000Z", windowSeconds: 604800, pace },
          { id: "extra_usage", label: "extra usage", kind: "credits", percentUsed: 0, percentRemaining: 100, spentUsd: 0, limitUsd: 20, pace },
        ],
        state: { status: "fresh", stale: false },
        quotaSemantics: { status: "known", effectiveAvailability: [{ scope: "all_models", status: "known", effectivePercentRemaining: 59, boundedBy: ["five_hour", "seven_day"], limitingWindowIds: ["seven_day"] }] },
      },
      {
        provider: "codex", plan: "prolite", label: "Codex", source: "oauth",
        windows: [
          { id: "weekly", label: "week", kind: "weekly", percentUsed: 8, percentRemaining: 92, resetsAt: "2026-10-12T08:24:52.000Z", windowSeconds: 604800, pace },
        ],
        state: { status: "fresh", stale: false }, credits: { unlimited: false, unit: "credits" },
        quotaSemantics: { status: "known", effectiveAvailability: [{ scope: "all_models", status: "known", effectivePercentRemaining: 92, boundedBy: ["weekly"], limitingWindowIds: ["weekly"] }] },
      },
      {
        provider: "cursor", plan: "Team", label: "Cursor", source: "api",
        windows: [
          { id: "included_usage", label: "included usage", kind: "monthly", percentUsed: 9, percentRemaining: 91, resetsAt: "2026-10-25T20:56:50.000Z", startsAt: "2026-09-25T20:56:50.000Z", pace },
          { id: "auto_usage", label: "auto usage", kind: "monthly", percentUsed: 6, percentRemaining: 94, resetsAt: "2026-10-25T20:56:50.000Z", startsAt: "2026-09-25T20:56:50.000Z", pace },
          { id: "api_usage", label: "API usage", kind: "monthly", percentUsed: 0, percentRemaining: 100, resetsAt: "2026-10-25T20:56:50.000Z", startsAt: "2026-09-25T20:56:50.000Z", pace },
          { id: "grok_bot", label: "Grok Bot", kind: "weekly", percentUsed: 0, percentRemaining: 100, resetsAt: "2026-10-09T07:27:22.007Z", startsAt: "2026-10-02T18:03:21.985Z", pace },
        ],
        state: { status: "fresh", stale: false },
        quotaSemantics: { status: "known", effectiveAvailability: [{ scope: "all_models", status: "known", effectivePercentRemaining: 91, boundedBy: ["included_usage", "auto_usage"], limitingWindowIds: ["included_usage"] }, { scope: "grok_bot", status: "known", effectivePercentRemaining: 100, boundedBy: ["grok_bot"], limitingWindowIds: ["grok_bot"] }] },
      },
    ]);
    const r = parse(captured);
    const claude = byId(r, "claude");
    expect(claude.windows.map((w: any) => [w.slot, w.label, w.percentUsed, w.reported])).toEqual([
      ["five_hour", "Five-hour", 17, true],
      ["weekly", "Weekly", 41, true],
      ["model:fable", "Fable week", 4, true],
      ["extra_usage", "Extra usage", 0, true],
    ]);
    expect(win(claude, "extra_usage").resetsAt).toBeNull();
    const codex = byId(r, "codex");
    expect(win(codex, "weekly")).toMatchObject({ percentUsed: 8, reported: true, resetsAt: "2026-10-12T08:24:52.000Z" });
    expect(win(codex, "five_hour")).toMatchObject({ reported: false, id: null, percentUsed: null, note: "The provider did not report a five-hour limit." });
    const cursor = byId(r, "cursor");
    // 6 comes from auto_usage, not from included_usage's 9.
    expect(cursor.windows.map((w: any) => [w.slot, w.percentUsed, w.reported])).toEqual([
      ["cursor_models", 6, true],
      ["other_models", 0, true],
      ["grok_bot", 0, true],
    ]);
    expect(win(cursor, "cursor_models").resetsAt).toBe("2026-10-25T20:56:50.000Z");
    expect(win(cursor, "grok_bot").resetsAt).toBe("2026-10-09T07:27:22.007Z");

    const missingApi = byId(parse(report(NOW, [{
      provider: "cursor", plan: "Team",
      windows: [{ id: "auto_usage", label: "auto usage", kind: "monthly", percentUsed: 6, percentRemaining: 94, resetsAt: "2026-10-25T20:56:50.000Z" }],
      state: { status: "fresh", stale: false },
    }])), "cursor");
    expect(win(missingApi, "other_models")).toMatchObject({ reported: false, percentUsed: null, note: "quota-axi did not report Other Models." });
    expect(win(missingApi, "cursor_models").percentUsed).toBe(6);

    const noPercent = byId(parse(report(NOW, [{
      provider: "cursor", plan: "Team",
      windows: [{ id: "auto_usage", label: "auto usage", kind: "monthly", resetsAt: "2026-10-25T20:56:50.000Z" }, { id: "api_usage", label: "API usage", kind: "monthly", percentUsed: 0, percentRemaining: 100, resetsAt: "2026-10-25T20:56:50.000Z" }],
      state: { status: "fresh", stale: false },
    }])), "cursor");
    expect(win(noPercent, "cursor_models")).toMatchObject({ reported: true, percentUsed: null, percentRemaining: null });

    const totalOnly = byId(parse(report(NOW, [{
      provider: "cursor", plan: "Pro",
      windows: [{ id: "included_usage", label: "included usage", kind: "monthly", percentUsed: 15, percentRemaining: 85, resetsAt: "2026-11-01T00:00:00.000Z" }],
      state: { status: "fresh", stale: false },
    }])), "cursor");
    expect(totalOnly.windows.map((w: any) => [w.slot, w.label, w.percentUsed])).toEqual([["included_usage", "Included usage", 15]]);
  });

  it("shows a folder with no login yet as not signed in, with the exact login command", () => {
    const accounts = resolveAccounts([{ provider: "codex", label: "Codex 2", home: "~/.codex-2" }]);
    const r = buildReport(accounts, { shared: null, profiles: { "codex-2": { kind: "ok", stdout: codexProfileMissingStdout(NOW) } } }, new Date(NOW), MAX_AGE_S);
    expect(r.providers[0]).toMatchObject({
      account: "codex-2", state: "not_signed_in", windows: [],
      message: "No Codex login in ~/.codex-2 yet. Sign in with the command below, then refresh.",
      remedy: "mkdir -p ~/.codex-2 && CODEX_HOME=~/.codex-2 codex login",
    });
    // The same when quota-axi leaves the provider out, and an expired folder login points at the same command.
    expect(parseQuota(report(NOW, []), accounts)!.providers[0].state).toBe("not_signed_in");
    const expired = parseQuota(report(NOW, [{ provider: "codex", windows: [], state: { status: "auth_required", reason: "credentials_expired" } }]), accounts)!.providers[0];
    expect(expired).toMatchObject({ state: "signed_out", remedy: "mkdir -p ~/.codex-2 && CODEX_HOME=~/.codex-2 codex login" });
    expect(stateInfo("not_signed_in")).toEqual({ label: "Not signed in", chip: "blocked" });
  });

  it("keeps a failed folder read to that one card, and names the folder's own check command", () => {
    const r = buildReport(FOUR, { shared: { kind: "ok", stdout: allLiveStdout(NOW) }, profiles: { "codex-2": { kind: "timeout", seconds: 20 } } }, new Date(NOW), MAX_AGE_S);
    expect(r.providers.map((p) => p.state)).toEqual(["live", "live", "timeout", "live"]);
    expect(r.providers[2].message).toContain(`CODEX_HOME=${SECOND} quota-axi --provider codex --profile-only --full`);
    const down = buildReport(FOUR, { shared: { kind: "missing" }, profiles: { "codex-2": { kind: "ok", stdout: codexProfileStdout(NOW) } } }, new Date(NOW), MAX_AGE_S);
    expect(down.providers.map((p) => p.state)).toEqual(["cli_missing", "cli_missing", "live", "cli_missing"]);
  });
});

describe("parsing quota-axi JSON", () => {
  it("reads Claude's and Codex's five-hour and weekly windows, pace and plan", () => {
    const r = parse(liveStdout(NOW));
    expect(r.generatedAt).toBe(new Date(NOW).toISOString());
    expect(r.providers.map((p) => [p.provider, p.title, p.state])).toEqual([["claude", "Claude Code", "live"], ["codex", "Codex", "live"], ["cursor", "Cursor", "not_set_up"]]);
    const claude = byId(r, "claude");
    expect(claude.windows.map((w: any) => [w.slot, w.label])).toEqual([["five_hour", "Five-hour"], ["weekly", "Weekly"], ["model:opus", "Opus week"]]);
    expect(win(claude, "five_hour")).toMatchObject({ id: "five_hour", reported: true, percentUsed: 92, percentRemaining: 8, pace: "ahead" });
    expect(win(claude, "weekly")).toMatchObject({ id: "seven_day", percentUsed: 57 });
    expect(win(claude, "five_hour")).not.toHaveProperty("limiting");
    expect(win(claude, "five_hour").resetsAt).toBe(new Date(NOW + 47 * M + 30e3).toISOString());
    expect(claude.effectiveRemaining).toBe(8);
    expect(claude.message).toBeNull();
    const codex = byId(r, "codex");
    // Code review is a separate workload. A model window is kept when the provider reports one.
    expect(codex.windows).toHaveLength(2);
    expect(codex.windows.some((w: any) => String(w.id).startsWith("code_review"))).toBe(false);
    expect(win(codex, "five_hour")).toMatchObject({ id: "five_hour", percentUsed: 23, pace: "on_pace" });
    expect(win(codex, "weekly")).toMatchObject({ id: "weekly", percentUsed: 41, pace: "behind" });
    expect(codex.plan).toBe("self_serve_business_prolite");
  });

  it("reads quota-axi's real output on this Mac: Claude waits on the Keychain, Codex reports only a weekly window", () => {
    const real = {
      generatedAt: "2026-10-05T01:04:14.286Z", schemaVersion: 5,
      providers: [
        claudeKeychain(),
        { provider: "codex", plan: "self_serve_business_prolite", windows: [{ id: "weekly", label: "week", kind: "weekly", resetsAt: "2026-10-11T06:46:31.000Z", percentRemaining: 100, pace: { status: "behind", reservePercentPoints: 10.8901, burnMultiple: 0 } }], credits: { unlimited: false, unit: "credits" }, state: { status: "fresh", stale: false }, accountKeys: ["codex-home"], quotaSemantics: { status: "known", effectiveAvailability: [{ scope: "all_models", status: "known", effectivePercentRemaining: 100, boundedBy: ["weekly"], limitingWindowIds: ["weekly"] }] } },
      ],
      help: ["Tell your user: run `quota-axi --allow-keychain-prompt` once and approve Keychain access (\"Always Allow\") so quota-axi can read claude's live quota."],
    };
    const r = parse(JSON.stringify(real));
    const claude = byId(r, "claude");
    expect(claude).toMatchObject({ state: "keychain", remedy: KEYCHAIN_REMEDY, windows: [] });
    expect(claude.message).toMatch(/Keychain approval/);
    const codex = byId(r, "codex");
    expect(codex.state).toBe("live");
    expect(win(codex, "five_hour")).toMatchObject({ reported: false, id: null, percentUsed: null, note: "The provider did not report a five-hour limit." });
    // Only percentRemaining is reported; percent used is derived.
    expect(win(codex, "weekly")).toMatchObject({ reported: true, percentUsed: 0, percentRemaining: 100, resetsAt: "2026-10-11T06:46:31.000Z" });
  });

  it("falls back to the Keychain remedy when quota-axi names the error but no command", () => {
    const p = claudeKeychain();
    const r = parse(report(NOW, [{ ...p, state: { status: "auth_required", error: "keychain_prompt_required" } }, codexLive(NOW)]));
    expect(byId(r, "claude")).toMatchObject({ state: "keychain", remedy: "quota-axi --allow-keychain-prompt" });
  });

  it("names each provider failure state with what happened and how to fix it", () => {
    const st = (state: object) => ({ provider: "claude", windows: [], state, quotaSemantics: { status: "unknown", effectiveAvailability: [] } });
    const cases: [object, string, RegExp][] = [
      [{ status: "auth_required", reason: "credentials_expired" }, "signed_out", /Sign in to Claude Code again/],
      [{ status: "auth_required", reason: "inference_opt_in_required", remedyCommand: "quota-axi --provider claude --allow-claude-inference" }, "signed_out", /opt-in/],
      [{ status: "rate_limited", stale: false }, "rate_limited", /rate limiting/],
      [{ status: "unavailable", error: "network_error" }, "error", /network_error.*quota-axi --provider claude --full/],
      [{ status: "error" }, "error", /could not read Claude Code's usage\. Run/],
      [{ status: "fresh", stale: false }, "no_windows", /no five-hour or weekly limit/],
    ];
    for (const [state, want, msg] of cases) {
      const p = byId(parse(report(NOW, [st(state), codexLive(NOW)])), "claude");
      expect(p.state, JSON.stringify(state)).toBe(want);
      expect(p.message).toMatch(msg);
    }
    const inference = byId(parse(report(NOW, [st(cases[1][0]), codexLive(NOW)])), "claude");
    expect(inference.remedy).toBe("quota-axi --provider claude --allow-claude-inference");
  });

  it("keeps an older reading's windows and says it is stale", () => {
    const p = claudeLive(NOW);
    const r = parse(report(NOW, [{ ...p, state: { status: "stale", stale: true, error: "network_error" } }, codexLive(NOW)]));
    expect(byId(r, "claude")).toMatchObject({ state: "stale" });
    expect(win(byId(r, "claude"), "five_hour").percentUsed).toBe(92);
    expect(byId(r, "claude").message).toMatch(/older reading/);
  });

  it("reports a provider quota-axi left out, or marked not set up, as not set up", () => {
    const missing = parse(report(NOW, [codexLive(NOW)]));
    expect(byId(missing, "claude")).toMatchObject({ state: "not_set_up", windows: [], remedy: "claude auth login" });
    const notSetUp = parse(report(NOW, [claudeLive(NOW), { provider: "codex", notSetUp: true, windows: [], state: { status: "unavailable" } }]));
    expect(byId(notSetUp, "codex").state).toBe("not_set_up");
    expect(byId(notSetUp, "codex").message).toMatch(/Sign in to Codex/);
    expect(byId(notSetUp, "cursor")).toMatchObject({ state: "not_set_up", remedy: null });
  });

  it("rejects text that is not a quota-axi report", () => {
    expect(parseQuota("not json")).toBeNull();
    expect(parseQuota("{\"providers\": 3}")).toBeNull();
    expect(parseQuota("null")).toBeNull();
    expect(parseQuota("")).toBeNull();
  });
});

describe("failed runs", () => {
  const states = (r: ReturnType<typeof buildReport>) => r.providers.map((p) => [p.provider, p.state]);
  it("gives every account the same clear state when quota-axi cannot be run or read", () => {
    const now = new Date(NOW);
    const cases: [SourceResult, string, RegExp, string | null][] = [
      [{ kind: "missing" }, "cli_missing", /not installed/, "npm install -g quota-axi"],
      [{ kind: "timeout", seconds: 20 }, "timeout", /did not answer within 20 seconds/, null],
      [{ kind: "failed", code: 2, output: "boom\nError: bad flag\n" }, "failed", /exited with code 2: Error: bad flag/, null],
      [{ kind: "ok", stdout: "<html>oops</html>" }, "unreadable", /cannot read/, null],
    ];
    for (const [result, want, msg, remedy] of cases) {
      const r = buildReport(resolveAccounts(), { shared: result, profiles: {} }, now, MAX_AGE_S);
      expect(states(r), want).toEqual([["claude", want], ["codex", want], ["cursor", want]]);
      expect(r.providers[0].message).toMatch(msg);
      expect(r.providers[0].remedy).toBe(remedy);
      expect(r).toMatchObject({ fetchedAt: now.toISOString(), generatedAt: null, maxAgeSeconds: MAX_AGE_S });
    }
  });
});

describe("running quota-axi", () => {
  const dir = path.join(process.env.JOYRIDE_RUNTIME!, "quota-bin");
  const script = (name: string, body: string) => {
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, name);
    fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return p;
  };
  it("reports a missing CLI", async () => {
    expect(await runQuotaAxi(null, [])).toEqual({ kind: "missing" });
    expect(await runQuotaAxi(path.join(dir, "nope"), [])).toEqual({ kind: "missing" });
  });
  it("passes the flags and the folder's env var, and keeps stdout even on a non-zero exit", async () => {
    const p = script("args", `echo "{\\"args\\": \\"$*\\", \\"home\\": \\"$CODEX_HOME\\", \\"providers\\": []}"; exit 1`);
    const [shared, folder] = quotaRequests(FOUR, false);
    const r = await runQuotaAxi(p, quotaArgs(shared));
    expect(r.kind).toBe("ok");
    expect(JSON.parse((r as any).stdout).args).toBe("--provider claude,codex,cursor --json --max-age 60s");
    const f = await runQuotaAxi(p, quotaArgs(folder), { env: { CODEX_HOME: SECOND } });
    expect(JSON.parse((f as any).stdout)).toMatchObject({ args: "--provider codex --profile-only --full --json", home: SECOND });
  });
  it("reports a non-zero exit without JSON as failed", async () => {
    const r = await runQuotaAxi(script("fail", "echo 'unknown flag' >&2; exit 3"), []);
    expect(r).toEqual({ kind: "failed", code: 3, output: "unknown flag\n" });
  });
  it("kills a run that takes too long", async () => {
    const t = Date.now();
    expect(await runQuotaAxi(script("slow", "sleep 5"), [], { timeoutS: 1 })).toEqual({ kind: "timeout", seconds: 1 });
    expect(Date.now() - t).toBeLessThan(4000);
  });
});

describe("GET /api/usage", () => {
  let d: Awaited<ReturnType<typeof sandboxDaemon>>;
  let calls = 0;
  let next: () => Promise<SourceResult>;
  const freshFlags: boolean[] = [];
  beforeAll(async () => {
    d = await sandboxDaemon("usage", ["usage"]);
    setQuotaSource(({ fresh, profile }) => { calls++; freshFlags.push(fresh); return profile ? Promise.resolve({ kind: "ok", stdout: codexProfileMissingStdout(NOW) }) : next(); });
  });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => { setQuotaSource(null); await d?.stop(); });

  const settled = () => d.ctx.service<{ refresh(): Promise<unknown> }>("usage").refresh();

  it("serves a minute-old reading from cache, re-reads after a minute, and throttles refreshes", async () => {
    next = async () => ({ kind: "ok", stdout: keychainStdout(Date.now()) });
    const snapshot = d.ctx.service<{ snapshot(): unknown }>("usage").snapshot();
    expect(snapshot).toMatchObject({ fetchedAt: null, refreshing: false, providers: [] });
    await Promise.resolve();
    expect(calls).toBe(0);
    const cold = await d.req("GET", "/api/usage");
    expect(cold.body).toMatchObject({ fetchedAt: null, refreshing: true, ageSeconds: null, providers: [] });
    await settled();
    const a = await d.req("GET", "/api/usage");
    expect(a.status).toBe(200);
    expect(a.body.providers.map((p: any) => p.state)).toEqual(["keychain", "live", "not_set_up"]);
    expect(calls).toBe(1);
    await d.req("GET", "/api/usage");
    await d.req("GET", "/api/usage?fresh=1"); // within 5s of the last read: cached
    expect(calls).toBe(1);
    const real = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(real + 6000);
    await d.req("GET", "/api/usage?fresh=1");
    await settled();
    expect(calls).toBe(2);
    vi.spyOn(Date, "now").mockReturnValue(real + 6000 + MAX_AGE_S * 1000 + 1);
    await d.req("GET", "/api/usage");
    await settled();
    expect(calls).toBe(3);
    // Only the refresh button skips quota-axi's own shared reading.
    expect(freshFlags).toEqual([false, true, false]);
  });

  it("shares one run between requests that arrive together", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10 * MAX_AGE_S * 1000);
    let release!: () => void;
    next = () => new Promise((r) => { release = () => r({ kind: "ok", stdout: liveStdout(NOW) }); });
    const before = calls;
    const both = Promise.all([d.req("GET", "/api/usage"), d.req("GET", "/api/usage")]);
    await new Promise((r) => setTimeout(r, 20));
    // Both HTTP requests must finish while the provider is still waiting.
    const [x, y] = await both;
    expect(x.body.refreshing).toBe(true);
    expect(x.body.providers.length).toBeGreaterThan(0);
    expect(x.body.ageSeconds).toBeGreaterThan(MAX_AGE_S);
    release();
    await settled();
    expect(calls - before).toBe(1);
    expect(x.body).toEqual(y.body);
  });

  it("keeps answering when the source throws", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 20 * MAX_AGE_S * 1000);
    next = async () => { throw new Error("spawn EACCES"); };
    await d.req("GET", "/api/usage");
    await settled();
    const r = await d.req("GET", "/api/usage");
    expect(r.status).toBe(200);
    expect(r.body.providers.map((p: any) => p.state)).toEqual(["stale", "stale", "failed"]);
    expect(r.body.providers[0].windows[0].reported).toBe(true);
    expect(r.body.ageSeconds).toBeGreaterThan(MAX_AGE_S);
    expect(r.body.providers[0].message).toMatch(/spawn EACCES/);
  });

  it("reads a configured second Codex folder in its own run, and lists the accounts for pickers", async () => {
    const file = path.join(process.env.JOYRIDE_HOME!, "joyride.config.yaml");
    const before = fs.readFileSync(file, "utf8");
    const seen: QuotaRequest[] = [];
    setQuotaSource((req) => { seen.push(req); return Promise.resolve({ kind: "ok", stdout: req.profile ? codexProfileMissingStdout(NOW) : allLiveStdout(NOW) }); });
    try {
      const accounts = `usage:\n  accounts:\n    - { provider: claude }\n    - { provider: codex, home: ~/.codex }\n    - { provider: codex, label: Codex 2, home: ${SECOND} }\n    - { provider: cursor }\n`;
      fs.writeFileSync(file, before.replace(/^usage:[\s\S]*$/m, accounts));
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 30 * MAX_AGE_S * 1000);
      await d.req("GET", "/api/usage");
      await settled();
      const r = await d.req("GET", "/api/usage");
      expect(seen.map((q) => q.profile?.home ?? q.providers.join(","))).toEqual(["claude,codex,cursor", SECOND]);
      expect(r.body.providers.map((p: any) => [p.account, p.state])).toEqual([["claude-code", "live"], ["codex", "live"], ["codex-2", "not_signed_in"], ["cursor", "live"]]);
      expect(r.body.providers[2].remedy).toBe(`mkdir -p ${SECOND} && CODEX_HOME=${SECOND} codex login`);
      const list = await d.req("GET", "/api/usage/accounts");
      expect(list.body).toEqual([
        { id: "claude-code", provider: "claude", label: "Claude Code", home: null },
        { id: "codex", provider: "codex", label: "Codex", home: null },
        { id: "codex-2", provider: "codex", label: "Codex 2", home: SECOND },
        { id: "cursor", provider: "cursor", label: "Cursor", home: null },
      ]);
    } finally { fs.writeFileSync(file, before); }
  });

  it("lets the e2e sandbox fake the source, per folder and with its own accounts", async () => {
    setQuotaSource(null);
    const set = await d.req("POST", "/api/usage/test-fake", { result: { kind: "timeout", seconds: 20 } });
    expect(set.status).toBe(200);
    await d.req("GET", "/api/usage");
    await settled();
    const r = await d.req("GET", "/api/usage");
    expect(r.body.providers.map((p: any) => p.state)).toEqual(["timeout", "timeout", "timeout"]);
    await d.req("POST", "/api/usage/test-fake", {
      result: { kind: "ok", stdout: allLiveStdout(NOW) },
      profiles: { "codex-2": { kind: "ok", stdout: codexProfileStdout(NOW) } },
      accounts: [{ provider: "claude" }, { provider: "codex" }, { provider: "codex", label: "Codex 2", home: "~/.codex-2" }, { provider: "cursor" }],
    });
    await d.req("GET", "/api/usage");
    await settled();
    const four = await d.req("GET", "/api/usage");
    expect(four.body.providers.map((p: any) => [p.account, p.state])).toEqual([["claude-code", "live"], ["codex", "live"], ["codex-2", "live"], ["cursor", "live"]]);
    expect((await d.req("GET", "/api/usage/accounts")).body.map((a: any) => a.id)).toEqual(["claude-code", "codex", "codex-2", "cursor"]);
  });

  it("answers a cold request before the source resolves and ignores a superseded read", async () => {
    await d.req("POST", "/api/usage/test-fake", {});
    let release: (result: SourceResult) => void = () => { throw new Error("Source not started"); };
    setQuotaSource(() => new Promise((resolve) => { release = resolve; }));
    const pending = await d.req("GET", "/api/usage");
    const old = settled();
    expect(pending.body).toMatchObject({ refreshing: true, fetchedAt: null, providers: [] });
    // The daemon remains responsive with a provider request still unresolved.
    expect((await d.req("GET", "/api/health")).status).toBe(200);
    await d.req("POST", "/api/usage/test-fake", { result: { kind: "timeout", seconds: 20 } });
    setQuotaSource(null);
    await d.req("GET", "/api/usage");
    await settled();
    release({ kind: "ok", stdout: allLiveStdout(NOW) });
    await old;
    expect((await d.req("GET", "/api/usage")).body.providers[0].state).toBe("timeout");
  });

  it("refreshes in the background without a page request and stops its timer on shutdown", async () => {
    vi.useFakeTimers();
    const module = d.modules.find((m) => m.name === "usage");
    let backgroundCalls = 0;
    setQuotaSource(async () => { backgroundCalls++; return { kind: "ok", stdout: allLiveStdout(Date.now()) }; });
    try {
      await d.req("POST", "/api/usage/test-fake", {});
      await module?.start?.(d.ctx);
      await settled();
      expect(backgroundCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(MAX_AGE_S * 1000 + 1);
      expect(backgroundCalls).toBe(2);
      await module?.stop?.();
      await vi.advanceTimersByTimeAsync(MAX_AGE_S * 1000 + 1);
      expect(backgroundCalls).toBe(2);
    } finally { vi.useRealTimers(); }
  });
});

describe("panel formatting", () => {
  it("shows resets relative to now", () => {
    expect(relReset(new Date(NOW + 3 * H + 12 * M + 30e3).toISOString(), NOW)).toBe("in 3h 12m");
    expect(relReset(new Date(NOW + 3 * H + 10e3).toISOString(), NOW)).toBe("in 3h");
    expect(relReset(new Date(NOW + 47 * M + 30e3).toISOString(), NOW)).toBe("in 47m");
    expect(relReset(new Date(NOW + 30e3).toISOString(), NOW)).toBe("in under a minute");
    expect(relReset(new Date(NOW + 6 * 24 * H + 5 * H + 30e3).toISOString(), NOW)).toBe("in 6d 5h");
    expect(relReset(new Date(NOW - M).toISOString(), NOW)).toBe("now");
    expect(relReset(null, NOW)).toBe("");
    expect(relReset("garbage", NOW)).toBe("");
  });
  it("shows resets in local time, naming today and tomorrow", () => {
    const base = new Date(2026, 9, 5, 9, 0).getTime();
    expect(localReset(new Date(2026, 9, 5, 18, 46).toISOString(), base)).toMatch(/^today /);
    expect(localReset(new Date(2026, 9, 6, 6, 46).toISOString(), base)).toMatch(/^tomorrow /);
    expect(localReset(new Date(2026, 9, 11, 6, 46).toISOString(), base)).toMatch(/11/);
    expect(localReset(null, base)).toBe("");
  });
  it("phrases Cursor's plan reset the way Cursor's settings screen does", () => {
    const reset = new Date(NOW + 20 * 24 * H).toISOString();
    expect(limitResetPhrase(reset, NOW)).toBe("Usage limits reset on Oct 25 (20 days left)");
    expect(limitResetPhrase(new Date(NOW + 3 * H).toISOString(), NOW)).toMatch(/\(3 hours left\)/);
    expect(limitResetPhrase(new Date(NOW - H).toISOString(), NOW)).toMatch(/\(0 minutes left\)/);
    expect(limitResetPhrase(null, NOW)).toBe("");
  });
  it("labels plans, states and bar tones", () => {
    expect(planLabel("self_serve_business_prolite")).toBe("Self serve business prolite");
    expect(planLabel("unknown")).toBeNull();
    expect(planLabel(null)).toBeNull();
    expect(stateInfo("keychain")).toEqual({ label: "Needs Keychain approval", chip: "blocked" });
    expect(stateInfo("cli_missing").label).toBe("quota-axi missing");
    expect([tone(null), tone(10), tone(80), tone(95)]).toEqual(["none", "ok", "warm", "hot"]);
    expect(usedPct({ percentUsed: 41.6 } as any)).toBe(42);
    expect(usedPct(null)).toBeNull();
  });
});
