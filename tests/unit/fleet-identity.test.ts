// Fleet phase 0, truthful projection: who owns a live worker (crew by recorded pane or FM_TASK_ID,
// Firstmate's control pane, else watched), the Herdr pane a task's meta records, and where the map
// places a worker (a crewmate on a mission's task sits in that mission, not at the Firstmate node).
import { describe, expect, it } from "vitest";
import { resolveOwner, type CrewKey } from "../../src/modules/live/owner";
import { parseMeta, taskPane } from "../../src/modules/firstmate/state";
import { placeWorker } from "../../src/ui/views/map/place";

const keys: CrewKey[] = [
  { task: "jr-ship", mission: "csv-export", machine: "local", pane: "w14:p2" },
  { task: "jr-tmux", mission: null, machine: null, pane: null },
  { task: "jr-remote", mission: "sync", machine: "devvm", pane: "w1:p1" },
];
const w = (id: string, pane: string | null, machine = "local") => ({ id, machine, pane });

describe("crew identity", () => {
  it("names a crewmate by the Herdr pane its task recorded, on the same machine", () => {
    expect(resolveOwner(w("local:w14:p2", "w14:p2"), null, keys, null)).toEqual({ tier: "crew", task: "jr-ship", via: "pane", mission: "csv-export" });
    expect(resolveOwner(w("devvm:w1:p1", "w1:p1", "devvm"), null, keys, null)).toMatchObject({ tier: "crew", task: "jr-remote", via: "pane" });
    // The same pane id on another machine is someone else's pane.
    expect(resolveOwner(w("local:w1:p1", "w1:p1"), null, keys, null).tier).toBe("watched");
  });

  it("names a crewmate by FM_TASK_ID when its task records no pane", () => {
    expect(resolveOwner(w("local:w9:p1", "w9:p1"), "jr-tmux", keys, null)).toEqual({ tier: "crew", task: "jr-tmux", via: "env", mission: null });
    expect(resolveOwner(w("local:pid:42", null), "jr-tmux", keys, null)).toMatchObject({ tier: "crew", via: "env" });
  });

  it("trusts the record over the environment, and only this home's tasks", () => {
    // jr-ship's record names pane w14:p2, so a session in another local pane claiming it is not its crew.
    expect(resolveOwner(w("local:w3:p1", "w3:p1"), "jr-ship", keys, null).tier).toBe("watched");
    // A pane on a machine the record does not cover can still be named by the environment.
    expect(resolveOwner(w("devvm:w3:p1", "w3:p1", "devvm"), "jr-ship", keys, null)).toMatchObject({ tier: "crew", via: "env" });
    expect(resolveOwner(w("local:w3:p1", "w3:p1"), "another-homes-task", keys, null).tier).toBe("watched");
  });

  it("uses the task's current pid after relaunch", () => {
    expect(resolveOwner({ id: "local:pid:42", machine: "local", pane: null, pid: 42 }, null, [{ task: "jr-relaunch", mission: null, machine: "local", pane: null, pid: 42 }], null)).toMatchObject({ tier: "crew", task: "jr-relaunch" });
    expect(resolveOwner({ id: "local:pid:41", machine: "local", pane: null, pid: 41 }, null, [{ task: "jr-relaunch", mission: null, machine: "local", pane: null, pid: 42 }], null).tier).toBe("watched");
  });
  it("never guesses from the cwd: nothing but pane and FM_TASK_ID makes crew", () => {
    // resolveOwner takes no cwd at all; a captain session in a crew worktree is watched.
    expect(resolveOwner(w("local:w5:p1", "w5:p1"), null, keys, null)).toEqual({ tier: "watched", task: null, via: null, mission: null });
  });

  it("marks Firstmate's own pane as control, ahead of every other rule", () => {
    expect(resolveOwner(w("local:wH:p1", "wH:p1"), "jr-ship", keys, "local:wH:p1")).toEqual({ tier: "control", task: null, via: "control", mission: null });
  });
});

describe("a task's recorded pane", () => {
  it("reads herdr_pane_id and herdr_session from a herdr-backend meta", () => {
    const m = parseMeta("window=default:w14:p2\nbackend=herdr\nherdr_session=default\nherdr_workspace_id=w14\nherdr_pane_id=w14:p2\n");
    expect(taskPane(m)).toEqual({ pane: "w14:p2", herdr_session: "default" });
  });
  it("falls back to the herdr window <session>:<pane-id>", () => {
    expect(taskPane(parseMeta("window=devvm:w1:p3\nbackend=herdr\n"))).toEqual({ pane: "w1:p3", herdr_session: "devvm" });
  });
  it("uses the current window after relaunch rather than a stale saved pane", () => {
    expect(taskPane(parseMeta("backend=herdr\nherdr_pane_id=w14:p2\nherdr_session=old\nwindow=default:w29:p1\n"))).toEqual({ pane: "w29:p1", herdr_session: "default" });
  });
  it("gives no pane for a tmux window or a meta without one", () => {
    expect(taskPane(parseMeta("window=fixture:fm-x\n"))).toEqual({ pane: null, herdr_session: null });
    expect(taskPane(parseMeta("window=fm:x\nbackend=tmux\n"))).toEqual({ pane: null, herdr_session: null });
    expect(taskPane(parseMeta("worktree=/x\n"))).toEqual({ pane: null, herdr_session: null });
  });
});

describe("map placement", () => {
  const ctx = {
    controlId: "local:wH:p1",
    sessionMission: new Map([["claude:s-linked", "report"]]),
    taskMission: new Map<string, string | null>([["jr-ship", "csv-export"], ["jr-loose", null]]),
    missions: new Set(["csv-export", "report"]),
  };
  const worker = (over: Record<string, unknown>): any => ({ id: "local:w1:p1", mission: null, session: null, crew: null, owner: { tier: "watched", task: null, via: null }, ...over });

  it("puts a crewmate on a mission's task under that mission, even with an unlinked session", () => {
    expect(placeWorker(worker({ crew: "jr-ship", owner: { tier: "crew", task: "jr-ship", via: "pane" } }), ctx)).toEqual({ at: "mission", mission: "csv-export" });
  });
  it("prefers the session's own mission over the task's", () => {
    expect(placeWorker(worker({ session: "claude:s-linked", crew: "jr-ship", owner: { tier: "crew", task: "jr-ship", via: "env" } }), ctx)).toEqual({ at: "mission", mission: "report" });
  });
  it("files crew outside any mission with everyone else's unfiled work, and hides the control pane", () => {
    expect(placeWorker(worker({ crew: "jr-loose", owner: { tier: "crew", task: "jr-loose", via: "pane" } }), ctx)).toEqual({ at: "unfiled" });
    expect(placeWorker(worker({ id: "local:wH:p1" }), ctx)).toEqual({ at: "control" });
    expect(placeWorker(worker({ id: "local:wX:p9", owner: { tier: "control", task: null, via: "control" } }), ctx)).toEqual({ at: "control" });
  });
  it("leaves the captain's own sessions outside missions unfiled", () => {
    expect(placeWorker(worker({}), ctx)).toEqual({ at: "unfiled" });
  });
});
