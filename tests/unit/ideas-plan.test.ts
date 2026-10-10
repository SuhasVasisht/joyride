// Idea housekeeping guardrails, pins and placement thresholds, as pure functions (src/modules/ideas/plan.ts).
import { describe, it, expect } from "vitest";
import { Lens, Mission } from "../../src/shared/schema.ts";
import {
  MAX_PLACEMENTS, PLACE_THRESHOLD, briefExcerpt, emptyPins, isCaptainCommit, normalizeOp, opSignature, parseGitLog, pinsFromLog,
  placementFromJev, summarize, validatePlan, type World,
} from "../../src/modules/ideas/plan.ts";
import { llmAccountEnv } from "../../src/core/llm.ts";
import { resolveAccounts } from "../../src/core/accounts.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readHome } from "../../src/modules/firstmate/state.ts";
import { buildFirstmateHome, FIXTURE_TASKS as FT } from "../e2e/crew-fixture.ts";

const T = "2026-10-05T12:00:00.000Z";
const idea = (id: string, extra: Partial<Mission> = {}) => Mission.parse({ id, title: id.replace(/-/g, " "), created: T, updated: T, ...extra });

function world(over: Partial<World> = {}): World {
  const missions = over.missions ?? [
    idea("alpha", { crews: ["t1"], sessions: [{ source: "claude", id: "s1" }] }),
    idea("beta", { crews: ["t2"], sessions: [{ source: "codex", id: "s2" }] }),
    idea("gamma"),
    idea("old", { archive: true, state: "done" }),
  ];
  return {
    missions,
    lenses: over.lenses ?? [Lens.parse({ id: "joyride", title: "Joyride" })],
    tasks: over.tasks ?? [
      { id: "t1", title: "Task one", status: "working", section: "in_flight", mission: "alpha" },
      { id: "t2", title: "Task two", status: "done", section: "done", mission: "beta" },
      { id: "t3", title: "Task three", status: "queued", section: "queued", mission: null },
    ],
    pins: over.pins ?? emptyPins(),
    vetoes: over.vetoes ?? new Set(),
    now: T,
  };
}
const statuses = (r: ReturnType<typeof validatePlan>) => r.results.map((x) => `${x.status}${x.reason ? `: ${x.reason}` : ""}`);

describe("validatePlan", () => {
  it("places tasks and creates ideas in existing groups without changing sessions", () => {
    const r = validatePlan(world(), [
      { op: "move", task: "t3", to: "alpha", from: null },
      { op: "create", title: "Fresh stream", goal: "Do the thing.", tasks: ["t2"], group: "Joyride" },
    ]);
    expect(statuses(r)).toEqual(["applied", "applied"]);
    expect(r.missions.find((m) => m.id === "alpha")).toMatchObject({ crews: ["t1", "t3"], sessions: [{ source: "claude", id: "s1" }] });
    expect(r.missions.find((m) => m.id === "fresh-stream")).toMatchObject({ crews: ["t2"], lenses: ["joyride"] });
    expect(r.missions.find((m) => m.id === "beta")).toMatchObject({ crews: [], sessions: [{ source: "codex", id: "s2" }] });
    expect(r.lenses).toEqual([]);
  });

  it("rejects rename, merge, archive, group, delete and session moves", () => {
    const r = validatePlan(world(), [
      ...["rename", "merge", "archive", "group", "delete"].map((op) => ({ op, idea: "beta", into: "alpha", title: "B", group: "joyride" })),
      { op: "move", session: "codex:s2", to: "alpha" },
    ]);
    expect(r.results).toHaveLength(6);
    expect(r.results.every((o) => o.status === "rejected")).toBe(true);
    expect(r.missions).toEqual([]);
  });

  it("leaves pinned tasks and changes the captain undid alone", () => {
    const pins = emptyPins();
    pins.tasks.set("t1", "moved on the map");
    expect(validatePlan(world({ pins }), [{ op: "move", task: "t1", to: "beta" }]).results[0].reason).toMatch(/captain put task/);
    const op = { op: "move" as const, task: "t3", to: "alpha", why: "" };
    expect(validatePlan(world({ vetoes: new Set([opSignature(op)]) }), [op]).results[0].reason).toMatch(/undid this change/);
  });

  it("rejects empty ideas, duplicate names, unknown tasks and missing or archived destinations", () => {
    const r = validatePlan(world(), [
      { op: "create", title: "alpha", tasks: ["t3"] },
      { op: "create", title: "Empty", tasks: [] },
      { op: "create", title: "Ghost", tasks: ["nope"] },
      { op: "move", task: "t3", to: "old" },
      { op: "move", task: "t3", to: "missing" },
    ]);
    expect(r.results.every((o) => o.status === "rejected")).toBe(true);
    expect(r.missions).toEqual([]);
  });

  it("a placement expects the task where the model saw it", () => {
    const tasks = [{ id: "t3", title: "Task three", status: "queued", section: "queued", mission: "gamma" }];
    expect(validatePlan(world({ tasks }), [{ op: "move", task: "t3", to: "beta", from: null }]).results[0].reason).toBe("task t3 moved to gamma meanwhile");
  });

  it("caps a run, builds dry-run files and summarizes the placement", () => {
    const tasks = Array.from({ length: MAX_PLACEMENTS + 1 }, (_, i) => ({ id: `loose-${i}`, title: `Task ${i}`, status: "queued", section: "queued", mission: null }));
    const ops = tasks.map((t) => ({ op: "move", task: t.id, to: "alpha", from: null }));
    const r = validatePlan(world({ tasks }), ops, { apply: false });
    expect(r.results.filter((o) => o.status === "proposed")).toHaveLength(MAX_PLACEMENTS);
    expect(r.results.at(-1)?.reason).toMatch(/over the limit/);
    expect(r.missions[0].crews).toHaveLength(MAX_PLACEMENTS + 1);
    expect(summarize(r.results)).toContain('Filed loose-0 in "alpha"');
    expect(normalizeOp({ op: "move", task: "t3", to: "alpha", from: null, why: "" })).toEqual({ op: { op: "move", task: "t3", to: "alpha", from: null, why: "" } });
  });
});

describe("pins from history", () => {
  const now = Date.parse(T);
  const log = parseGitLog([
    `\0a1\t2026-10-05T10:00:00+00:00\tjoyride: map move: task jr-x to one-fleet\n\nmissions/one-fleet.md\nmissions/other.md`,
    `\0a2\t2026-09-01T10:00:00+00:00\tjoyride: map move: session claude:abc out of docs\n\nmissions/docs.md`,
    `\0a3\t2026-09-01T10:00:00+00:00\tjoyride: map move: mission docs to lens q4\n\nmissions/docs.md\nlenses/q4.yaml`,
    `\0a4\t2026-10-04T10:00:00+00:00\tjoyride: edit mission atlas\n\nmissions/atlas.md`,
    `\0a5\t2026-10-04T10:00:00+00:00\tjoyride: housekeeping: tidy: Renamed "x" to "y"\n\nmissions/x.md`,
    `\0a6\t2026-10-04T10:00:00+00:00\tjoyride: auto-link 2 new sessions to atlas\n\nmissions/atlas2.md`,
    `\0a7\t2026-10-04T10:00:00+00:00\tjoyride: undo housekeeping a5a5a5a5\n\nmissions/x.md`,
  ].join("\n"));

  it("pins map moves for good and captain edits for seven days; housekeeping and automation pin nothing", () => {
    const p = pinsFromLog(log, now);
    expect([...p.tasks.keys()]).toEqual(["jr-x"]);
    expect([...p.sessions.keys()]).toEqual(["claude:abc"]);
    expect([...p.grouped.keys()]).toEqual(["docs"]);
    expect([...p.ideas.keys()].sort()).toEqual(["atlas", "one-fleet", "other", "x"]);
    expect(p.ideas.get("one-fleet")).toBe("map move 2026-10-05");
    expect(p.ideas.has("docs")).toBe(false); // older than seven days
    expect(p.ideas.has("atlas2")).toBe(false);
  });

  it("knows which subjects are the captain's", () => {
    expect(isCaptainCommit("joyride: mission atlas: open -> paused")).toBe(true);
    expect(isCaptainCommit("joyride: accept proposal mp-1")).toBe(true);
    expect(isCaptainCommit("joyride: mission atlas: link Firstmate task jr-1")).toBe(false);
    expect(isCaptainCommit("joyride: archive 3 sessions older than 30 days into 1 archive mission")).toBe(false);
  });
});

describe("placement", () => {
  it(`Jev's pick stands at ${PLACE_THRESHOLD} or above; new, unknown or weaker picks escalate`, () => {
    const ids = ["a", "b", "c", "d"];
    expect(placementFromJev("a", { a: 0.8, b: 0.1, new: 0.1 }, ids)).toEqual({ idea: "a", p: 0.8, escalate: false, candidates: ["a", "b"] });
    expect(placementFromJev("a", { a: 0.75 }, ids).escalate).toBe(false);
    expect(placementFromJev("a", { a: 0.74, b: 0.2, c: 0.05, d: 0.01 }, ids)).toMatchObject({ idea: null, escalate: true, candidates: ["a", "b", "c"] });
    expect(placementFromJev("new", { new: 0.9, a: 0.1 }, ids)).toMatchObject({ idea: null, escalate: true });
    expect(placementFromJev("zzz", { zzz: 0.99 }, ids)).toMatchObject({ idea: null, escalate: true });
    expect(placementFromJev(null, {}, ids)).toMatchObject({ idea: null, escalate: true });
  });

  it("reads what a task is from its brief, without worker boilerplate", () => {
    const brief = "# Current worker role contract\nYou are a crewmate.\n\n# Task\n## Captain's intent\njoyride-mission: x\nMake answers work from the map.\n\n# Herdr lifecycle declaration\nNOT ENABLED\n# Setup\nmore";
    const ex = briefExcerpt(brief);
    expect(ex).toContain("Make answers work from the map.");
    expect(ex).not.toMatch(/crewmate|Herdr|Setup|joyride-mission/);
  });
});

describe("llm task account", () => {
  const accounts = resolveAccounts([{ provider: "claude" }, { provider: "codex", label: "Codex", home: "~/.codex" }, { provider: "codex", label: "Codex 2", home: "/tmp/codex-2" }]);
  it("runs a task on a named login, clears the variable for the default login, and explains bad ids", () => {
    expect(llmAccountEnv({ backend: "codex" }, accounts)).toEqual({});
    expect(llmAccountEnv({ backend: "codex", account: "codex-2" }, accounts)).toEqual({ CODEX_HOME: "/tmp/codex-2" });
    expect(llmAccountEnv({ backend: "codex", account: "codex" }, accounts)).toEqual({ CODEX_HOME: undefined });
    expect(() => llmAccountEnv({ backend: "codex", account: "codex-9" }, accounts)).toThrow(/not in usage.accounts. Use one of: codex, codex-2/);
    expect(() => llmAccountEnv({ backend: "claude", account: "codex-2" }, accounts)).toThrow(/is a codex login, but the task runs on claude/);
  });
});

describe("a task's idea", () => {
  it("the authored crews link wins over the brief's marker, unless it is Joyride's own stale auto-link", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jr-fm-"));
    try {
      buildFirstmateHome(home, "marked");
      const of = (crews: Record<string, string[]>, auto: Record<string, string> = {}) => readHome(home, crews, auto).tasks.find((t) => t.id === FT.ship)!;
      expect(of({})).toMatchObject({ mission: "marked", mission_source: "marker" });
      expect(of({ marked: [FT.ship] })).toMatchObject({ mission: "marked", mission_source: "marker" });
      // A move (by the captain or housekeeping) to another idea wins.
      expect(of({ moved: [FT.ship] })).toMatchObject({ mission: "moved", mission_source: "crews" });
      expect(of({ moved: [FT.ship] }, { [FT.ship]: "marked" })).toMatchObject({ mission: "moved", mission_source: "crews" });
      // Joyride linked it to "old" from an earlier marker; the brief now says "marked", so the marker wins.
      expect(of({ old: [FT.ship] }, { [FT.ship]: "old" })).toMatchObject({ mission: "marked", mission_source: "marker" });
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});
