import { describe, it, expect, vi } from "vitest";
import type { UsageSnapshot } from "../../src/shared/usage.ts";
import type { PrimaryState } from "../../src/shared/firstmate-primary.ts";
import { isPrimaryIdle } from "../../src/shared/firstmate-primary.ts";
import { Config } from "../../src/shared/schema.ts";
import { resolveAccounts } from "../../src/core/accounts.ts";
import { parseQuota } from "../../src/modules/usage/quota.ts";
import { HANDOFF_MAX_BYTES, composeHandoff, exhaustionReason, ExhaustionConfirmation, hasCapacity, nextPrimary, primaries, primaryArgs, PrimaryFailover, type Observation, type FailoverIO } from "../../src/modules/firstmate/failover.ts";
import { readHome } from "../../src/modules/firstmate/state.ts";
import { codexHookTrustKeys, screenText } from "../../src/modules/live/screen.ts";
import { claudeLive, codexLive, cursorLive, report } from "../fixtures/quota.ts";

const accounts = resolveAccounts([{ provider: "claude" }, { provider: "codex" }, { provider: "codex", home: "/lab/codex-2" }, { provider: "cursor" }]);
const list = primaries(accounts, undefined, { claude: "/lab/claude", codex: "/lab/codex" });
function usage(now = Date.now()): UsageSnapshot {
  const providers = parseQuota(report(now, [claudeLive(now, { fiveUsed: 0 }), codexLive(now), cursorLive(now)]), accounts)!.providers;
  return { fetchedAt: new Date(now).toISOString(), generatedAt: new Date(now).toISOString(), maxAgeSeconds: 60, providers, ageSeconds: 0, refreshing: false };
}
const observation = (overrides: Partial<Observation> = {}): Observation => ({ primary: list[0], pane: { machine: "lab", pane_id: "p1", status: "blocked" }, screen: "", unchangedMs: 30_000, usage: usage(), ...overrides });

describe("Firstmate capacity", () => {
  it("allows a return after a completed Codex turn while keeping working and blocked turns protected", () => {
    expect(isPrimaryIdle("done")).toBe(true);
    expect(isPrimaryIdle("idle")).toBe(true);
    for (const status of ["working", "blocked", "unknown", undefined]) expect(isPrimaryIdle(status)).toBe(false);
  });
  it("recognizes Codex's first-run hook trust screen only with the offered trust option", () => {
    expect(codexHookTrustKeys("Hooks need review\n› 1. Review hooks\n  2. Trust all and continue\n  3. Continue without trusting (hooks won't run)")).toEqual(["2", "enter"]);
    expect(codexHookTrustKeys("Captain asks to Trust all and continue")).toBeNull();
    expect(codexHookTrustKeys("Hooks need review\n› 1. Review hooks")).toBeNull();
  });
  it("reads limit banners from both plain CLI output and the production socket response", () => {
    const banner = "You've hit your limit · resets tomorrow";
    for (const response of [banner, { read: { text: `\u001b[31m${banner}\u001b[0m` } }]) {
      expect(screenText(response)).toBe(banner);
      expect(exhaustionReason(observation({ screen: screenText(response) }), 60)).toContain("limit");
    }
    expect(exhaustionReason(observation({ primary: list[1], screen: "■ You've hit your usage limit. Try again after reset." }), 60)).toContain("limit");
  });
  it("follows the screen order and keeps the two Codex login roots distinct", () => {
    expect(list.map((p) => [p.account, p.harness, p.model])).toEqual([["claude-code", "claude", null], ["codex", "codex", "gpt-6.1-sol"], ["codex-2", "codex", "gpt-6.1-sol"], ["cursor", "cursor", null]]);
    expect(list[1].env).toEqual({ CODEX_HOME: "/lab/codex" });
    expect(list[2].env).toEqual({ CODEX_HOME: "/lab/codex-2" });
    const custom = primaries(accounts, [{ account: "cursor", model: "grok" }, { account: "codex", model: "other" }], { claude: "c", codex: "x" });
    expect(custom.map((p) => p.account)).toEqual(["cursor", "codex"]);
    expect(custom[1].model).toBe("other");
    expect(Config.parse({}).firstmate.confirmation_seconds).toBe(15);
    expect(Config.safeParse({ firstmate: { primaries: [{ account: "codex" }, { account: "codex" }] } }).success).toBe(false);
  });
  it("parses quota-axi's authoritative exhausted_now and runway", () => {
    const p = { ...claudeLive(Date.now()), quotaSemantics: { effectiveAvailability: [{ scope: "all_models", runway: { status: "exhausted_now", usableRunwaySeconds: 0 } }] } };
    expect(parseQuota(report(Date.now(), [p]), accounts)!.providers[0]).toMatchObject({ exhaustedNow: true, runwaySeconds: 0 });
  });
  it("takes the next account with capacity, skipping exhausted and unknown accounts", () => {
    const r = usage();
    expect(nextPrimary(list, "claude-code", r)?.account).toBe("codex");
    r.providers[1].exhaustedNow = true;
    expect(nextPrimary(list, "claude-code", r)?.account).toBe("codex-2");
    r.providers[2].state = "stale";
    expect(nextPrimary(list, "claude-code", r)?.account).toBe("cursor");
    r.providers[3].effectiveRemaining = 0;
    expect(nextPrimary(list, "claude-code", r)).toBeNull();
    expect(nextPrimary(list, "cursor", usage())).toBeNull();
  });
  it("refuses stale, failed and invalid-date readings without treating them as exhaustion", () => {
    const o = observation();
    o.usage.providers[0].exhaustedNow = true;
    o.usage.providers[0].state = "stale";
    expect(exhaustionReason(o, 60)).toBeNull();
    expect(hasCapacity(o.usage, "claude-code")).toBe(false);
    o.usage.fetchedAt = "bad";
    expect(hasCapacity(o.usage, "codex")).toBe(false);
    o.usage.fetchedAt = new Date(Date.now() - 130_000).toISOString();
    expect(hasCapacity(o.usage, "codex")).toBe(false);
  });
  it("detects quota exhaustion alone, and near-zero runway only on a stalled turn", () => {
    const o = observation({ pane: { machine: "lab", pane_id: "p1", status: "working" }, unchangedMs: 100 });
    o.usage.providers[0].runwaySeconds = 30;
    expect(exhaustionReason(o, 60)).toBeNull();
    o.unchangedMs = 30_000;
    expect(exhaustionReason(o, 60)).toContain("30 seconds");
    o.usage.providers[0].exhaustedNow = true;
    o.unchangedMs = 0;
    expect(exhaustionReason(o, 60)).toContain("exhausted");
  });
  it("detects stalled limit banners even when quota reads fail, without matching ordinary discussion", () => {
    const o = observation({ screen: "You've hit your limit · resets 10pm" });
    o.usage.providers = [];
    expect(exhaustionReason(o, 60)).toContain("cannot continue");
    o.screen = "Please handle usage limit messages and 429 errors.";
    expect(exhaustionReason(o, 60)).toBeNull();
    o.screen = "Rate limit reached";
    o.pane.status = "working"; o.unchangedMs = 50;
    expect(exhaustionReason(o, 60)).toBeNull();
  });
  it("requires an uninterrupted confirmation window and resets on progress or a new account", () => {
    const d = new ExhaustionConfirmation();
    expect(d.observe("claude", "limit", 1000, 15_000)).toBeNull();
    expect(d.observe("claude", "limit", 15_999, 15_000)).toBeNull();
    expect(d.observe("claude", null, 16_000, 15_000)).toBeNull();
    expect(d.observe("claude", "limit", 20_000, 15_000)).toBeNull();
    expect(d.observe("claude", "limit", 35_000, 15_000)).toBe("limit");
    expect(d.observe("codex", "limit", 36_000, 15_000)).toBeNull();
  });
  it("preserves the standing permission flags and per-harness model", () => {
    expect(primaryArgs(list[0], "bypassPermissions")).toEqual(["--permission-mode", "bypassPermissions"]);
    expect(primaryArgs(list[1], "bypassPermissions")).toEqual(["--no-daemon", "--model", "gpt-6.1-sol", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust"]);
    expect(primaryArgs(list[1], "auto")).toEqual(["--no-daemon", "--model", "gpt-6.1-sol", "--sandbox", "workspace-write", "--ask-for-approval", "on-request"]);
    expect(primaryArgs(list[3], "bypassPermissions")).toEqual(["--trust", "--force"]);
  });
});

describe("Primary handoff", () => {
  it("bounds huge UTF-8 sections and keeps the full recovery file paths", () => {
    const huge = "long context 🐈\n".repeat(10000);
    const home = readHome("/does-not-exist", {});
    home.summary_decisions = [{ id: huge, key: huge, verb: "needs-decision" }];
    const body = composeHandoff({ from: list[0], to: list[1], reason: "limit", home, screen: huge + "LAST PANE LINE", live: [{ id: "lab:p2", task: "worker", status: "working", action: huge }],
      contextPath: "/lab/context.json", outgoingPath: "/lab/outgoing.md", transcriptPath: "/lab/transcript.jsonl",
      transcript: { turns: [{ role: "user", ts: null, text: huge, tools: [] }, { role: "assistant", ts: null, text: huge, tools: [{ name: "exec", summary: huge }] }], queue: [{ ts: null, text: huge }], pulled: [] } });
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(HANDOFF_MAX_BYTES);
    for (const file of ["/lab/context.json", "/lab/outgoing.md", "/lab/transcript.jsonl"]) expect(body).toContain(file);
    expect(body).toContain("LAST PANE LINE");
    expect(body).not.toContain("\uFFFD");
    expect(body).toContain("Excerpt only");
  });
  it("retains captain asks verbatim, queued asks, promises, decisions and workers", () => {
    const home = readHome("/does-not-exist", {});
    home.summary_decisions = [{ id: "pending", key: "choice", verb: "needs-decision" }];
    const body = composeHandoff({ from: list[0], to: list[1], reason: "limit", home, screen: "limit banner", live: [{ id: "lab:p2", task: "worker", status: "working", action: "running tests" }],
      transcript: { turns: [{ role: "user", ts: null, text: "Keep A\n  exactly, please.", tools: [] }, { role: "assistant", ts: null, text: "Next I will resolve the pending decision.", tools: [{ name: "exec", summary: "tests started" }] }], queue: [{ ts: null, text: "Also keep B" }], pulled: [] } });
    expect(body).toContain("Keep A\n  exactly, please.");
    expect(body).toContain("Also keep B");
    expect(body).toContain("Next I will resolve the pending decision.");
    expect(body).toContain('"key":"choice"');
    expect(body).toContain("lab:p2: task worker, working, running tests");
    expect(body).toContain("gpt-6.1-sol");
  });
  function setup() {
    let state: PrimaryState = { current: list[0], phase: "ready", lastSwitch: null, error: null };
    let o: Observation | null = observation({ screen: "Usage limit reached" });
    const calls: string[] = [];
    const io: FailoverIO = { state: () => state, save: (s) => { state = s; }, choices: () => list, observe: async () => o,
      handoff: async () => { calls.push("handoff"); return "saved context"; }, note: async () => { calls.push("note"); return "n1"; },
      stop: async () => { calls.push("stop"); }, launch: async (p) => { calls.push(`launch ${p.account}`); o = observation({ primary: p }); } };
    return { io, calls, get: () => state, clear: () => { o = null; } };
  }
  it("files context before stopping, launches exactly once after confirmation, then advances to Codex 2", async () => {
    const s = setup(), d = new PrimaryFailover(s.io, { confirmationMs: 15_000, nearZeroSeconds: 60 });
    const time = Date.now();
    await d.check(time); await d.check(time + 14_000);
    expect(s.calls).toEqual([]);
    await Promise.all([d.check(time + 15_000), d.check(time + 15_000)]);
    expect(s.calls).toEqual(["handoff", "note", "stop", "launch codex"]);
    expect(s.get()).toMatchObject({ phase: "ready", current: { account: "codex" }, lastSwitch: { from: "claude-code", to: "codex", note: "n1" } });
    await d.switch("codex-2");
    expect(s.get().current?.account).toBe("codex-2");
  });
  it("never stops or launches without a durable note, and never starts after a stop failure", async () => {
    const s = setup();
    s.io.note = async () => { throw new Error("disk full"); };
    const d = new PrimaryFailover(s.io, { confirmationMs: 15_000, nearZeroSeconds: 60 });
    await expect(d.switch("codex")).rejects.toThrow("disk full");
    expect(s.calls).toEqual(["handoff"]);
    expect(s.get().phase).toBe("failed");
    s.io.note = async () => "n1";
    s.io.stop = async () => { throw new Error("still alive"); };
    await expect(d.switch("codex")).rejects.toThrow("still alive");
    expect(s.calls.some((c) => c.startsWith("launch"))).toBe(false);
    expect(s.get().current?.account).toBe("claude-code");
  });
  it("restores a source with capacity when successor startup fails, keeping the saved handoff", async () => {
    const s = setup();
    s.io.launch = async () => { s.calls.push("launch codex failed"); throw new Error("missing credentials"); };
    s.io.recover = async (source, note) => { s.calls.push(`recover ${source.primary.account} ${note}`); };
    const d = new PrimaryFailover(s.io, { confirmationMs: 1, nearZeroSeconds: 60 });
    await expect(d.switch("codex")).rejects.toThrow("missing credentials");
    expect(s.calls).toEqual(["handoff", "note", "stop", "launch codex failed", "recover claude-code n1"]);
    expect(s.get()).toMatchObject({ current: { account: "claude-code" }, phase: "failed", lastSwitch: { note: "n1" } });
    expect(s.get().error).toContain("source was restored");
  });
  it("rechecks source recovery after a slow startup outlives the captured quota reading", async () => {
    const start = Date.now(), clock = vi.spyOn(Date, "now").mockReturnValue(start);
    try {
      const s = setup();
      s.io.launch = async () => { clock.mockReturnValue(start + 130_000); throw new Error("startup readiness timeout"); };
      s.io.recover = async (source, note) => {
        expect(hasCapacity(source.usage, source.primary.account)).toBe(false);
        expect(hasCapacity(usage(), source.primary.account)).toBe(true);
        s.calls.push(`recover ${source.primary.account} ${note}`);
      };
      const d = new PrimaryFailover(s.io, { confirmationMs: 1, nearZeroSeconds: 60 });
      await expect(d.switch("codex")).rejects.toThrow("startup readiness timeout");
      expect(s.calls).toContain("recover claude-code n1");
      expect(s.get()).toMatchObject({ current: { account: "claude-code" }, phase: "failed", lastSwitch: { note: "n1" } });
      expect(s.get().error).toContain("source was restored");
    } finally { clock.mockRestore(); }
  });
  it("preserves the original source pane when a fresh-capacity target fails authentication", async () => {
    const s = setup();
    s.io.validate = async () => { throw new Error("Codex is not signed in. The source was preserved."); };
    const d = new PrimaryFailover(s.io, { confirmationMs: 1, nearZeroSeconds: 60 });
    await expect(d.switch("codex")).rejects.toThrow("not signed in");
    expect(s.calls).toEqual(["handoff", "note"]);
    expect(s.get()).toMatchObject({ current: { account: "claude-code" }, phase: "failed", lastSwitch: { note: "n1" } });
  });
  it("keeps the primary when no successor has capacity, then clears the error after recovery", async () => {
    const s = setup();
    s.io.choices = () => [list[0]];
    const d = new PrimaryFailover(s.io, { confirmationMs: 1, nearZeroSeconds: 60 });
    const time = Date.now();
    await d.check(time); await d.check(time + 1);
    expect(s.get().error).toContain("No later account");
    expect(s.calls).toEqual([]);
    s.io.observe = async () => observation({ pane: { machine: "lab", pane_id: "p1", status: "working" }, unchangedMs: 0 });
    await d.check(time + 2);
    expect(s.get().error).toBeNull();
  });
  it("refuses overlapping manual and automatic switches", async () => {
    const s = setup();
    let finish: (value: string) => void = () => {};
    s.io.handoff = () => new Promise<string>((r) => { finish = r; });
    const d = new PrimaryFailover(s.io, { confirmationMs: 1, nearZeroSeconds: 60 });
    const job = d.switch("codex");
    await Promise.resolve();
    await expect(d.switch("codex-2")).rejects.toThrow("already switching");
    finish("context"); await job;
    expect(s.calls.filter((c) => c.startsWith("launch"))).toEqual(["launch codex"]);
  });
  it("reuses the request id after a timeout and daemon restart, then stops automatic retries after three failures", async () => {
    const s = setup();
    const ids: string[] = [];
    s.io.note = async (id) => { ids.push(id); throw new Error("inbox timed out"); };
    const settings = { confirmationMs: 0, nearZeroSeconds: 60 };
    await expect(new PrimaryFailover(s.io, settings).check()).rejects.toThrow("timed out");
    expect(s.get().lastSwitch?.attempts).toBe(1);
    const second = new PrimaryFailover(s.io, settings);
    await second.check();
    expect(ids).toHaveLength(1);
    await expect(second.check(s.get().lastSwitch!.retryAt!)).rejects.toThrow("timed out");
    expect(s.get().lastSwitch?.attempts).toBe(2);
    await expect(new PrimaryFailover(s.io, settings).check(s.get().lastSwitch!.retryAt!)).rejects.toThrow("timed out");
    expect(ids).toEqual([ids[0], ids[0], ids[0]]);
    expect(s.get().error).toContain("Automatic handoff paused after 3 attempts");
    const stopped = new PrimaryFailover(s.io, settings);
    await stopped.check(Date.now() + 3600_000);
    expect(ids).toHaveLength(3);
    s.io.note = async (id) => { ids.push(id); return "saved"; };
    await stopped.switch("codex");
    expect(ids).toEqual([ids[0], ids[0], ids[0], ids[0]]);
    expect(s.get()).toMatchObject({ phase: "ready", lastSwitch: { attempts: 1, note: "saved" } });
  });
  it("retries a stop failure with the existing durable note", async () => {
    const s = setup();
    let stops = 0;
    s.io.stop = async () => { if (++stops === 1) throw new Error("still alive"); };
    const settings = { confirmationMs: 0, nearZeroSeconds: 60 };
    await expect(new PrimaryFailover(s.io, settings).switch("codex")).rejects.toThrow("still alive");
    const id = s.get().lastSwitch?.id;
    await new PrimaryFailover(s.io, settings).switch("codex");
    expect(s.calls.filter((c) => c === "note")).toHaveLength(1);
    expect(s.get().lastSwitch?.id).toBe(id);
    expect(s.get().phase).toBe("ready");
  });
  it("keeps the source when target capacity disappears while the handoff note is filing", async () => {
    const s = setup();
    const o = await s.io.observe();
    if (!o) throw new Error("missing source");
    s.io.observe = async () => o;
    s.io.note = async () => {
      s.calls.push("note");
      const target = o.usage.providers.find((p) => p.account === "codex");
      if (!target) throw new Error("missing target quota");
      target.exhaustedNow = true;
      return "saved-before-quota-change";
    };
    const d = new PrimaryFailover(s.io, { confirmationMs: 15000, nearZeroSeconds: 60 });
    await expect(d.switch("codex")).rejects.toThrow("capacity");
    expect(s.calls).toEqual(["handoff", "note"]);
    expect(s.get()).toMatchObject({ phase: "failed", current: { account: "claude-code" }, lastSwitch: { note: "saved-before-quota-change" } });
  });
  it("refuses to close a different primary that replaced the captured source during delayed filing", async () => {
    const s = setup();
    const originalObserve = s.io.observe;
    s.io.note = async () => {
      s.calls.push("note");
      s.io.observe = async () => observation({ primary: list[2], pane: { machine: "lab", pane_id: "other", status: "idle" } });
      return "saved-source-context";
    };
    const d = new PrimaryFailover(s.io, { confirmationMs: 15000, nearZeroSeconds: 60 });
    await expect(d.switch("codex")).rejects.toThrow("changed");
    expect(s.calls).toEqual(["handoff", "note"]);
    expect(await originalObserve()).toBeTruthy();
  });

  it("preserves the source and its saved request when capture is interrupted", async () => {
    const s = setup();
    s.io.handoff = async () => { s.calls.push("handoff"); throw new Error("capture interrupted"); };
    const d = new PrimaryFailover(s.io, { confirmationMs: 15000, nearZeroSeconds: 60 });
    await expect(d.switch("codex")).rejects.toThrow("capture interrupted");
    const id = s.get().lastSwitch?.id;
    expect(s.calls).toEqual(["handoff"]);
    s.io.handoff = async () => { s.calls.push("handoff retry"); return "saved after interruption"; };
    await d.switch("codex");
    expect(s.get()).toMatchObject({ phase: "ready", lastSwitch: { id, attempts: 2, note: "n1" } });
    expect(s.calls).toEqual(["handoff", "handoff retry", "note", "stop", "launch codex"]);
  });

});
