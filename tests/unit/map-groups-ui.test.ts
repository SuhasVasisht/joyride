// Groups on the chart: every group is charted (an empty one as a drop spot), a group shows what it
// holds outside its ideas, Unfiled keeps only work with something left to do, and ideas that are
// archived, dropped or done leave the chart.
import { describe, expect, it } from "vitest";
import { buildRegions, layoutRegions } from "../../src/ui/views/map/layout";
import { groupUnfiled, hasWorkLeft, holdInGroups, setAside } from "../../src/ui/views/map/place";
import { offChart } from "../../src/ui/views/map/world";

const NOW = Date.parse("2026-10-05T12:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60e3).toISOString();
const worker = (id: string, over: any = {}): any => ({ id, session: `claude:${id}`, status: "idle", updated: ago(5), repo: "/r/alpha", cwd: "/r/alpha", crew: null, title: id, ...over });
const lens = (id: string, over: any = {}): any => ({ id, title: id.toUpperCase(), description: "", missions: [], rule: {}, sessions: [], projects: [], ...over });
const mission = (id: string, over: any = {}): any => ({ id, title: id, goal: "", repos: ["/r/alpha"], lenses: [], done_when: [], health: "active", health_why: "", archive: false, state: "open", updated: "2026-10-01", workers: [], attention: [], verdict: null, sessions: [], artifacts: [], tasks: [], landed: [], asks: [], nudges: [], ...over });

describe("unfiled work on the chart", () => {
  it("keeps a worker while it is working, blocked or active in the last half hour", () => {
    expect(hasWorkLeft(worker("a", { status: "working", updated: ago(600) }), NOW)).toBe(true);
    expect(hasWorkLeft(worker("a", { status: "blocked", updated: ago(600) }), NOW)).toBe(true);
    expect(hasWorkLeft(worker("a", { status: "idle", updated: ago(10) }), NOW)).toBe(true);
    expect(hasWorkLeft(worker("a", { status: "idle", updated: ago(45) }), NOW)).toBe(false);
    expect(hasWorkLeft(worker("a", { status: "done", updated: ago(45) }), NOW)).toBe(false);
  });

  it("a worker set aside stays off until it does something new", () => {
    const w = worker("a", { updated: ago(10) });
    expect(setAside(w, { "claude:a": ago(5) })).toBe(true);
    expect(setAside(w, { "claude:a": ago(20) })).toBe(false);
    expect(setAside(worker("b", { session: null }), { b: ago(1) })).toBe(true);
    expect(setAside(w, {})).toBe(false);
  });

  it("splits unfiled work between groups and Unfiled; work with nothing left leaves the chart", () => {
    const named = worker("n", { status: "idle", updated: ago(600) });
    const byProject = worker("p", { repo: "/r/beta", cwd: "/r/beta", status: "working" });
    const loose = worker("l", { status: "working" });
    const stale = worker("s", { status: "idle", updated: ago(600) });
    const out = holdInGroups([lens("q4", { sessions: ["claude:n", "claude:old"] }), lens("beta", { projects: ["beta"] })],
      { workers: [named, byProject, loose, stale], sessions: [{ key: "claude:old" }, { key: "claude:other" }] }, NOW);
    expect(out.byLens.get("q4")).toMatchObject({ workers: [named], sessions: [{ key: "claude:old" }] });
    expect(out.byLens.get("beta")?.workers).toEqual([byProject]);
    expect(out.workers).toEqual([loose]);
  });

  it("an Unfiled group with nothing to act on is not drawn", () => {
    const groups = groupUnfiled<any, any>({ workers: [] });
    expect(buildRegions([], [], null, groups).filter((r) => r.kind === "unfiled")).toEqual([]);
  });
});

describe("groups on the chart", () => {
  it("charts an empty group as a drop spot, and a group's held sessions and workers", () => {
    const w = worker("n", { status: "working" });
    const held = new Map([["q4", { workers: [w], sessions: [{ key: "claude:old", title: "old", cwd: "/r/alpha", repo: null } as any], projects: [] }]]);
    const regions = buildRegions([mission("a")], [lens("empty"), lens("q4")], null, [], undefined, held);
    const empty = regions.find((r) => r.id === "lens:empty")!;
    expect(empty).toMatchObject({ kind: "lens", lens: "empty", missions: [], workers: [], sessions: [] });
    expect(regions.find((r) => r.id === "lens:q4")).toMatchObject({ workers: [w], sessions: [{ key: "claude:old" }] });
    // Busy groups first, the empty one last.
    expect(regions.map((r) => r.id).indexOf("lens:empty")).toBe(regions.length - 1);
    const laid = layoutRegions(regions, "mid");
    expect(laid.regions.find((r) => r.id === "lens:empty")!.items.map((i) => i.kind)).toEqual(["empty"]);
  });

  it("does not chart groups when the chart groups by repo", () => {
    const regions = buildRegions([mission("a")], [lens("empty")], { home: { group_by: "repo" } }, []);
    expect(regions.some((r) => r.kind === "lens")).toBe(false);
  });

  it("an Unfiled region carries its project key, so renaming it names that project's group", () => {
    const groups = groupUnfiled<any, any>({ workers: [worker("l", { status: "working" })] });
    expect(buildRegions([], [], null, groups).find((r) => r.kind === "unfiled")).toMatchObject({ project: "alpha", title: "alpha" });
  });
});

describe("ideas off the chart", () => {
  it("archived, dropped and done ideas leave the chart; open and paused ones stay", () => {
    expect(offChart({ archive: true, state: "open" })).toBe(true);
    expect(offChart({ archive: false, state: "dropped" })).toBe(true);
    expect(offChart({ archive: false, state: "done" })).toBe(true);
    expect(offChart({ archive: false, state: "open" })).toBe(false);
    expect(offChart({ archive: false, state: "paused" })).toBe(false);
  });
});
