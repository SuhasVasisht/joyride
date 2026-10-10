// What a drop on the map means, and where a moved mission is charted afterwards.
import { describe, expect, it } from "vitest";
import { buildRegions, layoutRegions } from "../../src/ui/views/map/layout";
import { homeRegion, menuTargets, missionTarget, moveBody, regionTarget, targetLabel, type DragItem } from "../../src/ui/views/map/regroup";

const mission = (id: string, over: any = {}): any => ({ id, title: id, goal: "", repos: ["/tmp/alpha"], lenses: [], done_when: [], health: "active", health_why: "", archive: false, updated: "2026-10-01", workers: [], attention: [], verdict: null, sessions: [], artifacts: [], ...over });
const lens = (id: string, over: any = {}): any => ({ id, title: id.toUpperCase(), description: "", missions: [], rule: {}, ...over });
const session = (from: string | null): DragItem => ({ kind: "session", key: "claude:s1", label: "s1", from });
const carried = (from: string | null, explicit = true): DragItem => ({ kind: "mission", id: "a", label: "a", from, home: "repo:/tmp/alpha", explicit });
const task = (from: string | null): DragItem => ({ kind: "task", id: "jr-x", label: "x", from });

describe("drop targets", () => {
  it("a session goes to any other mission, to a group, and to an Unfiled group only from a mission or group", () => {
    expect(missionTarget(session("a"), mission("b"))).toEqual({ kind: "mission", id: "b", title: "b" });
    expect(missionTarget(session("a"), mission("a"))).toBeNull();
    expect(regionTarget(session("a"), { id: "unfiled:alpha", kind: "unfiled", title: "alpha" })).toEqual({ kind: "unfiled" });
    expect(regionTarget(session(null), { id: "unfiled:alpha", kind: "unfiled", title: "alpha" })).toBeNull();
    expect(regionTarget(session("a"), { id: "lens:x", kind: "lens", title: "X", lens: "x" })).toEqual({ kind: "lens", id: "x", title: "X", region: "lens:x" });
    expect(regionTarget(session("a"), { id: "repo:/tmp/alpha", kind: "repo", title: "alpha" })).toBeNull();
    // Held by a group: not a target in its own region, but Unfiled takes it out.
    const held: DragItem = { kind: "session", key: "claude:s1", label: "s1", from: null, lens: "x", region: "lens:x" };
    expect(regionTarget(held, { id: "lens:x", kind: "lens", title: "X", lens: "x" })).toBeNull();
    expect(regionTarget(held, { id: "unfiled:alpha", kind: "unfiled", title: "alpha" })).toEqual({ kind: "unfiled" });
    expect(regionTarget(held, { id: "lens:y", kind: "lens", title: "Y", lens: "y" })).toEqual({ kind: "lens", id: "y", title: "Y", region: "lens:y" });
  });

  it("a mission goes to other lens groups, and back to its own repo group only out of a lens that names it", () => {
    expect(regionTarget(carried("x"), { id: "lens:y", kind: "lens", title: "Y", lens: "y" })).toEqual({ kind: "lens", id: "y", title: "Y", region: "lens:y" });
    expect(regionTarget(carried("x"), { id: "lens:x", kind: "lens", title: "X", lens: "x" })).toBeNull();
    expect(regionTarget(carried("x"), { id: "repo:/tmp/alpha", kind: "repo", title: "alpha" })).toEqual({ kind: "home", region: "repo:/tmp/alpha", title: "alpha" });
    expect(regionTarget(carried("x", false), { id: "repo:/tmp/alpha", kind: "repo", title: "alpha" })).toBeNull();
    // Repo groups are derived: another repo's group never takes a mission.
    expect(regionTarget(carried("x"), { id: "repo:/tmp/beta", kind: "repo", title: "beta" })).toBeNull();
    expect(regionTarget(carried(null), { id: "health:idle", kind: "health", title: "Becalmed" })).toBeNull();
    expect(missionTarget(carried("x"), mission("b"))).toBeNull();
    expect(homeRegion(mission("a", { repos: [] }))).toBe("repo:none");
  });

  it("builds the move request for each drop", () => {
    expect(moveBody(session("a"), { kind: "mission", id: "b", title: "b" })).toEqual({ session: "claude:s1", to: { mission: "b" } });
    expect(moveBody(session("a"), { kind: "unfiled" })).toEqual({ session: "claude:s1", to: { mission: null } });
    expect(moveBody(session(null), { kind: "lens", id: "y", title: "Y", region: "lens:y" })).toEqual({ session: "claude:s1", to: { lens: "y" } });
    expect(moveBody(session(null), { kind: "new-group" }, "Loose ends")).toEqual({ session: "claude:s1", to: { new_lens: "Loose ends" } });
    expect(moveBody(carried("x"), { kind: "lens", id: "y", title: "Y", region: "lens:y" })).toEqual({ mission: "a", from: "x", to: { lens: "y" } });
    expect(moveBody(carried("x"), { kind: "home", region: "repo:/tmp/alpha", title: "alpha" })).toEqual({ mission: "a", from: "x", to: { lens: null } });
    expect(moveBody(carried(null), { kind: "new-group" })).toBeNull();
    expect(moveBody(carried(null), { kind: "new-group" }, " Q4 bets ")).toEqual({ mission: "a", from: null, to: { new_lens: "Q4 bets" } });
  });
});

describe("Move to menu", () => {
  const ideas = [mission("a"), mission("b", { title: "Bravo" }), mission("c", { title: "Old", archive: true })];
  const where = (id: string) => (id === "b" ? "Reporting" : undefined);

  it("offers a task every other open idea, never an archived one, and never Unfiled", () => {
    expect(menuTargets(task("a"), ideas, [], where)).toEqual([{ target: { kind: "mission", id: "b", title: "Bravo" }, where: "Reporting" }]);
    expect(menuTargets(task(null), ideas, []).map((t) => t.target)).toEqual([{ kind: "mission", id: "a", title: "a" }, { kind: "mission", id: "b", title: "Bravo" }]);
    // Dragging agrees: an archived idea is not a drop target for a task, but still is for a session.
    expect(missionTarget(task("a"), mission("c", { archive: true }))).toBeNull();
    expect(missionTarget(session("a"), mission("c", { archive: true }))).not.toBeNull();
  });

  it("offers a filed session the other open ideas, groups, Unfiled and New group; an unfiled one no Unfiled", () => {
    expect(menuTargets(session("a"), ideas, []).map((t) => targetLabel(t.target))).toEqual(["Move to Bravo", "Move to Unfiled", "New group…"]);
    expect(menuTargets(session(null), ideas, [{ id: "x", title: "X" }]).map((t) => targetLabel(t.target))).toEqual(["Move to a", "Move to Bravo", "Move to X", "New group…"]);
    const held: DragItem = { kind: "session", key: "claude:s1", label: "s1", from: null, lens: "x" };
    expect(menuTargets(held, ideas, [{ id: "x", title: "X" }, { id: "y", title: "Y" }]).map((t) => targetLabel(t.target))).toEqual(["Move to a", "Move to Bravo", "Move to Y", "Move to Unfiled", "New group…"]);
  });

  it("offers an idea the other groups, its repo group when a group names it, and New group", () => {
    const lenses = [lens("x"), lens("y")];
    expect(menuTargets(carried("x"), ideas, lenses, where, "alpha").map((t) => targetLabel(t.target))).toEqual(["Move to Y", "Back to alpha", "New group…"]);
    expect(menuTargets(carried("x", false), ideas, lenses, where, "alpha").map((t) => targetLabel(t.target))).toEqual(["Move to Y", "New group…"]);
    expect(menuTargets(carried(null), ideas, lenses).map((t) => targetLabel(t.target))).toEqual(["Move to X", "Move to Y", "New group…"]);
    // Every row builds the same request a drop on that target would.
    expect(moveBody(carried("x"), menuTargets(carried("x"), ideas, lenses, where, "alpha")[1].target)).toEqual({ mission: "a", from: "x", to: { lens: null } });
  });
});

describe("charting after a move", () => {
  it("the mission's own lens wins over a lens that lists it or claims it by rule", () => {
    const lenses = [lens("listed", { missions: ["a"] }), lens("rule", { rule: { repo: "alpha" } }), lens("own")];
    const where = (m: any) => buildRegions([m], lenses, null, []).find((r) => r.missions.length)!;
    expect(where(mission("a")).id).toBe("lens:listed");
    expect(where(mission("a", { lenses: ["own"] })).id).toBe("lens:own");
    expect(where(mission("a", { lenses: ["own"] })).lens).toBe("own");
    expect(where(mission("b")).id).toBe("lens:rule");
    expect(where(mission("c", { repos: ["/tmp/gamma"] })).id).toBe("repo:/tmp/gamma");
  });

  it("makes room for artifact chips at mid and near, not far", () => {
    const h = (m: any, lv: "far" | "mid" | "near") => layoutRegions(buildRegions([m], [], null, []), lv).items.get(m.id)!.h;
    const withArt = mission("a", { artifacts: [{ id: "r1", title: "Report", kind: "report", url: null, session: null, mission: "a", created: "" }] });
    expect(h(withArt, "mid")).toBeGreaterThan(h(mission("a"), "mid"));
    expect(h(withArt, "near")).toBeGreaterThan(h(mission("a"), "near"));
    expect(h(withArt, "far")).toBe(h(mission("a"), "far"));
  });
});
