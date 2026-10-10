// fleet.yaml, the steer guard's rules and the inferred fleet state, tested pure.
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, closedPolicy, isExcluded, parsePolicy, renderPolicy, withMembership } from "../../src/modules/fleet/policy";
import { guardRefusal } from "../../src/modules/live/steer-guard";
import { inferState } from "../../src/modules/fleet/state";
import type { WorkerView } from "../../src/shared/schema";

const member = (o: Partial<{ id: string; session: string | null; cwd: string }> = {}) => ({ id: "local:w1:p1", session: "claude:s1", cwd: "/repo/alpha", ...o });

describe("fleet.yaml", () => {
  it("defaults to every session in, with steer and answer_prompt authority", () => {
    expect(parsePolicy(null)).toEqual({ policy: DEFAULT_POLICY, error: null });
    expect(DEFAULT_POLICY).toEqual({ membership: "all", excluded: [], included: [], authority: ["steer", "answer_prompt", "retire_worker"], pruning: { idle_hours: 72, proposal_days: 14, archive_days: 30 } });
    expect(parsePolicy(renderPolicy(DEFAULT_POLICY)).policy).toEqual(DEFAULT_POLICY);
  });

  it("fails closed on a malformed file: no authority, every session kept out, or the last good membership", () => {
    const bad = parsePolicy("membership: everyone\n");
    expect(bad.policy).toEqual({ ...DEFAULT_POLICY, membership: "opt-in", authority: [] });
    expect(isExcluded(bad.policy, member())).toBe(true);
    expect(bad.error).toMatch(/fleet\.yaml: membership.*may not steer or answer any watched session/);
    const good = { ...DEFAULT_POLICY, excluded: ["claude:s9"] };
    expect(closedPolicy(good)).toEqual({ ...good, authority: [] });
    expect(parsePolicy("excluded: [\n").error).toMatch(/not valid YAML/);
    expect(parsePolicy("authority: [steer, close]\n").error).toMatch(/authority/);
  });

  it("excludes by session key, worker id or folder, and opt-in keeps out everything not included", () => {
    const p = { ...DEFAULT_POLICY, excluded: ["claude:s9", "local:w2:p1", "/repo/private"] };
    expect(isExcluded(p, member())).toBe(false);
    expect(isExcluded(p, member({ session: "claude:s9" }))).toBe(true);
    expect(isExcluded(p, member({ id: "local:w2:p1", session: null }))).toBe(true);
    expect(isExcluded(p, member({ cwd: "/repo/private/sub" }))).toBe(true);
    expect(isExcluded(p, member({ cwd: "/repo/private-other" }))).toBe(false);
    const optIn = { ...DEFAULT_POLICY, membership: "opt-in" as const, included: ["claude:s1"] };
    expect(isExcluded(optIn, member())).toBe(false);
    expect(isExcluded(optIn, member({ session: "claude:s2" }))).toBe(true);
  });

  it("excludes a live session by its session key and includes it back, never dropping a folder rule", () => {
    const out = withMembership(DEFAULT_POLICY, "local:w1:p1", member(), "exclude")!;
    expect(out.excluded).toEqual(["claude:s1", "local:w1:p1"]);
    // A new session in the same pane (/clear, a resume) is still the captain's.
    expect(isExcluded(out, member({ session: "claude:s2" }))).toBe(true);
    expect(withMembership(out, "local:w1:p1", member(), "exclude")).toBeNull();
    expect(withMembership(out, "local:w1:p1", member(), "include")!.excluded).toEqual([]);
    const folder = { ...DEFAULT_POLICY, excluded: ["/repo"] };
    const back = withMembership(folder, "local:w1:p1", member(), "include");
    expect(back).toBeNull(); // nothing names this session exactly; the folder rule stays
    // A worker without a session is kept by its worker id.
    expect(withMembership(DEFAULT_POLICY, "local:w1:p1", member({ session: null }), "exclude")!.excluded).toEqual(["local:w1:p1"]);
  });
});

const worker = (o: Partial<WorkerView> = {}): WorkerView => ({
  id: "local:w1:p1", machine: "local", agent: "claude", status: "idle", pane: "w1:p1", pid: null, cwd: "/repo", repo: "/repo", session: "claude:s1",
  title: "Export fix", current_action: "", last_message: "", controllable: true, updated: new Date().toISOString(), mission: null, crew: null,
  owner: { tier: "watched", task: null, via: null }, helm: { by: "firstmate", since: null, until: null, via: null }, ...o,
});

describe("steer guard", () => {
  const policy = { authority: ["steer", "answer_prompt"] };
  it("lets Firstmate steer a watched session in Herdr at its own helm", () => {
    expect(guardRefusal(worker(), "steer", policy)).toBeNull();
    expect(guardRefusal(worker(), "answer_prompt", policy)).toBeNull();
  });
  it("refuses crew, Firstmate's own pane, excluded sessions and missing authority", () => {
    expect(guardRefusal(worker({ owner: { tier: "crew", task: "jr-x", via: "pane" }, crew: "jr-x" }), "steer", policy)).toMatchObject({ code: "crew", message: expect.stringContaining("fm-send.sh jr-x") });
    expect(guardRefusal(worker({ owner: { tier: "control", task: null, via: "control" } }), "steer", policy)?.code).toBe("control");
    expect(guardRefusal(worker({ owner: { tier: "excluded", task: null, via: null } }), "steer", policy)?.code).toBe("excluded");
    expect(guardRefusal(worker(), "answer_prompt", { authority: ["steer"] })).toMatchObject({ code: "no_authority", message: expect.stringContaining("authority: steer") });
    expect(guardRefusal(worker(), "steer", null)?.code).toBe("fleet_unavailable");
  });
  it("refuses while the captain holds the helm, saying when it comes back", () => {
    const until = "2026-10-05T12:30:00.000Z";
    const r = guardRefusal(worker({ helm: { by: "captain", since: "2026-10-05T12:00:00.000Z", until, via: "direct" } }), "steer", policy);
    expect(r?.code).toBe("captain_helm");
    expect(r?.message).toMatch(/steered it in its pane/);
    expect(guardRefusal(worker({ helm: { by: "captain", since: null, until: null, via: "joyride-reply" } }), "steer", policy)?.message).toMatch(/15 quiet minutes after the turn ends/);
  });
  it("refuses sessions outside Herdr and agents whose input box Joyride can't read", () => {
    expect(guardRefusal(worker({ pane: null, controllable: false }), "steer", policy)?.code).toBe("not_herdr");
    expect(guardRefusal(worker({ agent: "pi" }), "steer", policy)?.code).toBe("unreadable_input");
  });
});

describe("inferred fleet state", () => {
  const item = (o: any) => ({ level: "L3", kind: "question", title: "Waiting on you", why: "", worker: "local:w1:p1", session: "claude:s1", resolved: null, snoozed_until: null, ...o });
  it("maps Herdr status and open attention onto Firstmate's words", () => {
    expect(inferState(worker({ status: "blocked", current_action: "Waiting for permission: Bash: npm publish" }), [])).toEqual({ state: "blocked", why: "Waiting for permission: Bash: npm publish" });
    expect(inferState(worker(), [item({ kind: "approval", why: "Bash: rm -rf build" })]).state).toBe("blocked");
    expect(inferState(worker(), [item({ why: "Should I drop the column?" })])).toEqual({ state: "needs-decision", why: "Should I drop the column?" });
    expect(inferState(worker(), [item({ kind: "error", why: "API error 529" })]).state).toBe("failed");
    expect(inferState(worker({ status: "working", current_action: "Bash: npm test" }), [])).toEqual({ state: "working", why: "Bash: npm test" });
    expect(inferState(worker(), [item({ level: "L2", kind: "review", why: "Tests pass" })]).state).toBe("done");
    expect(inferState(worker({ last_message: "All set." }), [])).toEqual({ state: "paused", why: "Idle after: All set." });
  });
  it("ignores resolved, snoozed, low-level and other sessions' items", () => {
    const future = new Date(Date.now() + 3600e3).toISOString();
    const noise = [item({ resolved: "x" }), item({ snoozed_until: future }), item({ level: "L1" }), item({ worker: "local:w9:p9", session: "claude:other" })];
    expect(inferState(worker(), noise).state).toBe("paused");
  });
});
