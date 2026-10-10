// Fleet phase 1, one canvas: the map groups by what the work is (mission, lens, project), never by who
// launched it. Work outside missions is unfiled under its project, crew and watched together; the
// Firstmate bridge and #/fleet count the fleet the same way.
import { describe, expect, it } from "vitest";
import { buildRegions, layoutRegions } from "../../src/ui/views/map/layout";
import { groupUnfiled, placeWorker } from "../../src/ui/views/map/place";
import { fleetCounts, fleetRows, matchesFilter, needsCaptain, projectOf } from "../../src/ui/views/fleet/model";

const now = new Date().toISOString();
const worker = (id: string, over: Record<string, unknown> = {}): any => ({
  id, machine: "local", agent: "claude", status: "idle", pane: id.split(":").slice(1).join(":"), pid: null, cwd: "/tmp/repos/alpha", repo: "/tmp/repos/alpha",
  session: `claude:${id}`, title: id, current_action: "", last_message: "", controllable: true, updated: now, mission: null, crew: null,
  owner: { tier: "watched", task: null, via: null }, helm: { by: "firstmate", since: null, until: null, via: null }, ...over,
});
const crew = (id: string, task: string, over: Record<string, unknown> = {}) => worker(id, { crew: task, owner: { tier: "crew", task, via: "pane" }, ...over });
const session = (key: string, repo: string | null, cwd = repo ?? "/tmp"): any => ({ key, repo, cwd, title: key, updated: now });
const mission = (id: string, over: any = {}): any => ({ id, title: id, goal: "", repos: ["/tmp/repos/alpha"], lenses: [], done_when: [], health: "active", health_why: "", archive: false, updated: now, workers: [], attention: [], verdict: null, sessions: [], artifacts: [], ...over });
// The ship task's worktree is named after the task; its project is the task's repo.
const taskRepo = new Map<string, string | null>([["jr-ship", "alpha"], ["jr-loose", "beta"]]);

describe("project of a worker", () => {
  it("is its crew task's repo, else its git repo, else its folder", () => {
    expect(projectOf(crew("local:w9:p1", "jr-ship", { repo: "/tmp/repos/alpha-worktrees/jr-ship", cwd: "/tmp/repos/alpha-worktrees/jr-ship/src" }), taskRepo)).toEqual({ key: "alpha", title: "alpha", path: "/tmp/repos/alpha-worktrees/jr-ship" });
    expect(projectOf(worker("local:w1:p1", { repo: "/Users/me/.treehouse/joyride-1/3/joyride" }))).toMatchObject({ key: "joyride", title: "joyride" });
    expect(projectOf(worker("local:w1:p1", { repo: null, cwd: "/Users/me/Documents" }))).toMatchObject({ key: "documents", title: "Documents", path: "/Users/me/Documents" });
    expect(projectOf(worker("local:w1:p1", { repo: null, cwd: "" }))).toEqual({ key: "", title: "No project", path: null });
  });
});

describe("unfiled, by project", () => {
  it("puts crew and watched sessions of one project in one group, with its recent sessions and proposals", () => {
    const groups = groupUnfiled({
      workers: [crew("local:w9:p1", "jr-ship", { repo: "/tmp/repos/alpha-worktrees/jr-ship" }), worker("local:w1:p1"), worker("local:w2:p1", { repo: "/tmp/repos/beta", cwd: "/tmp/repos/beta" })],
      quiet: [worker("local:w3:p1", { repo: null, cwd: "/Users/me/Documents" })],
      sessions: [session("claude:old-alpha", "/tmp/repos/alpha"), session("codex:old-gamma", null, "/tmp/repos/gamma")],
      proposals: [{ repos: ["/tmp/repos/alpha"] }, { repos: ["/elsewhere/alpha"] }, { repos: ["/tmp/repos/delta"] }, { repos: [] }],
    }, taskRepo);
    const alpha = groups.find((g) => g.key === "alpha")!;
    expect(alpha.workers.map((w) => w.id)).toEqual(["local:w9:p1", "local:w1:p1"]);
    expect(alpha.sessions.map((s) => s.key)).toEqual(["claude:old-alpha"]);
    expect(alpha.proposals).toBe(2);
    expect(groups.find((g) => g.key === "documents")!.quiet).toHaveLength(1);
    expect(groups.find((g) => g.key === "gamma")!.sessions).toHaveLength(1);
    // A project with only proposals gets no group of its own.
    expect(groups.some((g) => g.key === "delta")).toBe(false);
  });

  it("orders groups: someone blocked, then someone working, then the busiest, with no project last", () => {
    const groups = groupUnfiled({
      workers: [
        worker("local:a:1", { repo: "/r/quiet-big" }), worker("local:a:2", { repo: "/r/quiet-big" }),
        worker("local:b:1", { repo: "/r/busy", status: "working" }),
        worker("local:c:1", { repo: "/r/stuck", status: "blocked" }),
        worker("local:d:1", { repo: null, cwd: "" }), worker("local:d:2", { repo: null, cwd: "" }),
        worker("local:e:1", { repo: "/r/small" }),
      ],
    });
    // Two-item groups tie on size; the one with a project comes first.
    expect(groups.map((g) => g.key)).toEqual(["stuck", "busy", "quiet-big", "", "small"]);
  });

  it("charts each project as its own unfiled region after the missions, never a Firstmate crew region", () => {
    const groups = groupUnfiled({
      workers: [crew("local:w9:p1", "jr-loose", { repo: "/tmp/repos/beta" }), worker("local:w1:p1")],
      sessions: [session("claude:x", "/tmp/repos/alpha")],
      quiet: [worker("local:w5:p1", { repo: "/tmp/repos/beta" })],
    }, taskRepo);
    const fm: any = { status: null, error: null, worker: null, fleet: { crew: 1, watched: 2, yoursOnly: 0, needsYou: 0, yourHelm: 0 }, inFlight: 0, calls: 0, log: [] };
    const regions = buildRegions([mission("m1")], [], null, [...groups, { key: "empty", title: "empty", path: null, workers: [], quiet: [], sessions: [], proposals: 3 }], fm);
    expect(regions.map((r) => [r.kind, r.id])).toEqual([["firstmate", "firstmate"], ["repo", "repo:/tmp/repos/alpha"], ["unfiled", "unfiled:alpha"], ["unfiled", "unfiled:beta"]]);
    expect(regions.find((r) => r.id === "unfiled:beta")!.workers.map((w) => w.id)).toEqual(["local:w9:p1"]);
    expect(regions[0].workers).toEqual([]);
    // Each region's session and quiet lists are separate map items.
    for (const lv of ["far", "mid", "near"] as const) {
      const items = layoutRegions(regions, lv).items;
      expect(items.get("unfiled:alpha:sessions")?.kind).toBe("sessions");
      expect(items.get("unfiled:beta:quiet")?.kind).toBe("quiet");
    }
  });

  it("files every non-control worker outside a mission, crew or not", () => {
    const ctx = { controlId: "local:fm:1", sessionMission: new Map([["claude:local:w1:p1", "m1"]]), taskMission: new Map<string, string | null>([["jr-ship", "m2"], ["jr-loose", null]]), missions: new Set(["m1", "m2"]) };
    expect(placeWorker(worker("local:w1:p1"), ctx)).toEqual({ at: "mission", mission: "m1" });
    expect(placeWorker(crew("local:w9:p1", "jr-ship"), ctx)).toEqual({ at: "mission", mission: "m2" });
    expect(placeWorker(crew("local:w9:p2", "jr-loose"), ctx)).toEqual({ at: "unfiled" });
    expect(placeWorker(worker("local:w2:p1"), ctx)).toEqual({ at: "unfiled" });
    expect(placeWorker(worker("local:fm:1"), ctx)).toEqual({ at: "control" });
  });

  it("makes room for each card's owner and helm chips at mid and near", () => {
    const h = (lv: "far" | "mid" | "near") => layoutRegions(buildRegions([], [], null, groupUnfiled({ workers: [worker("local:w1:p1")] })), lv).items.get("local:w1:p1")!.h;
    expect(h("near")).toBeGreaterThanOrEqual(112);
    expect(h("mid") * 0.7).toBeGreaterThanOrEqual(92);
  });
});

describe("fleet counts and rows", () => {
  const attention: any[] = [
    { level: "L3", worker: null, session: "claude:local:w2:p1", title: "Asked which cause to fix first" },
    { level: "L2", worker: "local:w1:p1", session: null, title: "Done with evidence" },
  ];
  const ws = [
    worker("local:fm:1", { owner: { tier: "control", task: null, via: "control" }, status: "blocked", helm: null }),
    crew("local:w9:p1", "jr-ship", { status: "blocked" }),
    crew("local:w9:p2", "jr-loose", { status: "working", helm: { by: "captain", since: now, until: null, via: "direct" } }),
    worker("local:w1:p1", { updated: new Date(Date.now() - 60e3).toISOString() }),
    worker("local:w2:p1", { updated: new Date(Date.now() - 120e3).toISOString() }),
  ];

  it("needs the captain when blocked or holding an open item at L3 or above", () => {
    expect(needsCaptain(ws[1], attention)).toBe("Waiting at a prompt");
    expect(needsCaptain(ws[4], attention)).toBe("Asked which cause to fix first");
    expect(needsCaptain(ws[3], attention)).toBeNull();
  });

  it("counts crew, watched, needing you and at your helm, leaving Firstmate's own pane out", () => {
    expect(fleetCounts(ws, attention)).toEqual({ crew: 2, watched: 2, yoursOnly: 0, needsYou: 2, yourHelm: 1 });
    expect(fleetCounts([], [])).toEqual({ crew: 0, watched: 0, yoursOnly: 0, needsYou: 0, yourHelm: 0 });
  });

  it("lists needs-you first, then working, then the most recent, and filters by the bridge's counts", () => {
    const rows = fleetRows(ws, attention, taskRepo);
    expect(rows.map((r) => r.w.id)).toEqual(["local:fm:1", "local:w9:p1", "local:w2:p1", "local:w9:p2", "local:w1:p1"]);
    expect(rows.find((r) => r.w.id === "local:w9:p1")!.project.title).toBe("alpha");
    const ids = (f: any) => rows.filter((r) => matchesFilter(r, f)).map((r) => r.w.id);
    expect(ids("crew")).toEqual(["local:w9:p1", "local:w9:p2"]);
    expect(ids("watched")).toEqual(["local:w2:p1", "local:w1:p1"]);
    expect(ids("needs-you")).toEqual(["local:w9:p1", "local:w2:p1"]);
    expect(ids("your-helm")).toEqual(["local:w9:p2"]);
    expect(ids("all")).toHaveLength(5);
  });
});
