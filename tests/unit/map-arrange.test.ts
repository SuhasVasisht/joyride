import { describe, expect, it } from "vitest";
import { Mission } from "../../src/shared/schema";
import { arrangementAfterDrop, settle, spread, toStored, toWorld } from "../../src/ui/views/map/arrange";
import { buildRegions, layoutRegions, levelOf, type Layout } from "../../src/ui/views/map/layout";
import type { FirstmateNode, MapMission } from "../../src/ui/views/map/world";

const now = "2026-10-05T12:00:00Z";
const idea = (id: string, repo: string): MapMission => ({
  ...Mission.parse({ id, title: `Idea ${id} with a title long enough to wrap`, repos: [`/fixture/${repo}`], created: now, updated: now }),
  health: "active", health_why: "", workers: [], attention: [], verdict: null, artifacts: [], tasks: [], landed: [], asks: [], nudges: [],
});
const missions = [idea("a1", "alpha"), idea("a2", "alpha"), idea("b1", "beta"), idea("c1", "gamma"), idea("c2", "gamma"), idea("c3", "gamma"), idea("d1", "delta")];
const firstmate: FirstmateNode = { status: null, error: null, worker: null, fleet: { crew: 0, watched: 0, yoursOnly: 0, needsYou: 0, yourHelm: 0 }, inFlight: 0, calls: 0, log: [], asks: [], orphans: [], needsYou: null };
const regions = buildRegions(missions, [], null, [], firstmate);
const rect = (l: Layout, id: string) => l.regions.find((r) => r.id === id)!;
const apart = (l: Layout) => {
  for (const [i, a] of l.regions.entries()) for (const b of l.regions.slice(i + 1)) {
    const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    expect(ox <= 0 || oy <= 0, `${a.id} overlaps ${b.id}`).toBe(true);
  }
};

describe("settling placed groups", () => {
  it("keeps a free wish and moves an overlapping box to the nearest free spot", () => {
    const at = settle([{ id: "a", x: 0, y: 0, w: 100, h: 100 }, { id: "b", x: 300, y: 0, w: 100, h: 100 }, { id: "c", x: 20, y: 10, w: 100, h: 100 }], 20);
    expect(at.get("a")).toEqual({ x: 0, y: 0 });
    expect(at.get("b")).toEqual({ x: 300, y: 0 });
    // Right of a (dx 100) is nearer than below it (dy 110).
    expect(at.get("c")).toEqual({ x: 120, y: 10 });
  });
  it("never moves an earlier box for a later one", () => {
    const boxes = Array.from({ length: 12 }, (_, i) => ({ id: `b${i}`, x: (i % 3) * 10, y: 0, w: 200, h: 120 }));
    const at = settle(boxes, 30);
    expect(at.get("b0")).toEqual({ x: 0, y: 0 });
    const placed = boxes.map((b) => ({ ...b, ...at.get(b.id)! }));
    for (const [i, a] of placed.entries()) for (const b of placed.slice(i + 1)) {
      expect(a.x + a.w + 30 <= b.x + 0.5 || b.x + b.w + 30 <= a.x + 0.5 || a.y + a.h + 30 <= b.y + 0.5 || b.y + b.h + 30 <= a.y + 0.5).toBe(true);
    }
  });
  it("spreads stored positions per level, exactly invertible at the level they were stored at", () => {
    expect(spread("near", 1)).toEqual({ x: 1, y: 1 });
    const far = spread("far", 0.42);
    expect(far.x).toBeGreaterThan(1);
    expect(far.y).toBeLessThan(1);
    const p = { x: 1234.5, y: -321 };
    const back = toWorld(toStored(p, far), far);
    expect(back.x).toBeCloseTo(p.x, 0);
    expect(back.y).toBeCloseTo(p.y, 0);
  });
});

describe("the chart with placed and focused groups", () => {
  it("lays out exactly as before when nothing is placed or focused", () => {
    for (const s of [0.3, 0.7, 1]) {
      const a = layoutRegions(regions, levelOf(s), s);
      const b = layoutRegions(regions, levelOf(s), s, new Map(), undefined, { positions: new Map() });
      expect(b.regions.map((r) => [r.id, r.x, r.y])).toEqual(a.regions.map((r) => [r.id, r.x, r.y]));
    }
  });
  it("puts a dropped group where it was dropped at that zoom, keeps the rest where they were, and never overlaps at any zoom", () => {
    const s = 0.42, lv = levelOf(s), sp = spread(lv, s);
    const before = layoutRegions(regions, lv, s);
    const gamma = rect(before, "repo:/fixture/gamma");
    const drop = { x: gamma.x + 900, y: gamma.y + 1400 };
    const positions = arrangementAfterDrop(before.regions.map((r) => ({ id: r.id, x: r.x, y: r.y, movable: r.kind !== "firstmate" })), gamma.id, drop, sp);
    expect([...positions.keys()].at(-1)).toBe(gamma.id);
    const after = layoutRegions(regions, lv, s, new Map(), undefined, { positions });
    expect(rect(after, gamma.id).x).toBeCloseTo(drop.x, 0);
    expect(rect(after, gamma.id).y).toBeCloseTo(drop.y, 0);
    for (const r of before.regions) if (r.id !== gamma.id) {
      expect(rect(after, r.id).x).toBeCloseTo(r.x, 0);
      expect(rect(after, r.id).y).toBeCloseTo(r.y, 0);
    }
    for (const z of [0.24, 0.42, 0.56, 0.7, 0.88, 1, 1.6]) apart(layoutRegions(regions, levelOf(z), z, new Map(), undefined, { positions }));
  });
  it("nudges a group dropped onto another to the nearest free spot instead of overlapping", () => {
    const s = 0.7, lv = levelOf(s), sp = spread(lv, s);
    const before = layoutRegions(regions, lv, s);
    const alpha = rect(before, "repo:/fixture/alpha"), beta = rect(before, "repo:/fixture/beta");
    const positions = arrangementAfterDrop(before.regions.map((r) => ({ id: r.id, x: r.x, y: r.y, movable: r.kind !== "firstmate" })), beta.id, { x: alpha.x + 20, y: alpha.y + 10 }, sp);
    const after = layoutRegions(regions, lv, s, new Map(), undefined, { positions });
    expect(rect(after, alpha.id).x).toBeCloseTo(alpha.x, 0);
    apart(after);
  });
  it("opens a focused group at Near detail in place and moves its neighbours aside", () => {
    const s = 0.42;
    const before = layoutRegions(regions, "far", s);
    const id = "repo:/fixture/gamma";
    const focused = layoutRegions(regions, "far", s, new Map(), undefined, { focus: id });
    expect(rect(focused, id).x).toBeCloseTo(rect(before, id).x, 0);
    expect(rect(focused, id).y).toBeCloseTo(rect(before, id).y, 0);
    // Near cards are taller than Far ones.
    expect(rect(focused, id).h).toBeGreaterThan(rect(before, id).h);
    apart(focused);
  });
});
