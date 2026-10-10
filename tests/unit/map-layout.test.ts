import { describe, expect, it } from "vitest";
import { Mission, WorkerView } from "../../src/shared/schema";
import { buildRegions, layoutRegions, levelOf } from "../../src/ui/views/map/layout";
import type { FirstmateNode, MapMission } from "../../src/ui/views/map/world";
import { frame, largestFit } from "../../src/ui/views/map/focus";

const now = "2026-10-05T12:00:00Z";
const missions: MapMission[] = Array.from({ length: 10 }, (_, i) => ({
  ...Mission.parse({ id: `m${i}`, title: "Validate the complete map experience across every zoom level", repos: [`/fixture/project-${i % 4}`], created: now, updated: now }),
  health: "active", health_why: "", workers: [], attention: [], verdict: null, artifacts: [], tasks: [], landed: [], asks: [], nudges: [],
}));
const firstmate: FirstmateNode = { status: null, error: null, worker: null, fleet: { crew: 10, watched: 22, yoursOnly: 0, needsYou: 2, yourHelm: 12 }, inFlight: 2, calls: 0, log: [], asks: [], orphans: [], needsYou: null };
const worker = WorkerView.parse({ id: "unfiled-worker", title: "Review a Documents session with the captain at the helm", agent: "claude", status: "working",
  pane: "p1", pid: null, cwd: "/fixture/Documents", repo: "/fixture/Documents", session: "claude:loose", updated: now, controllable: true, helm: { by: "captain" },
});
const regions = buildRegions(missions, [], null, [{ key: "Documents", title: "Documents", path: "/fixture/Documents", workers: [worker], quiet: [], sessions: [], proposals: 0 }], firstmate);

describe("map layout reservations", () => {
  it("frames a tall group in readable columns instead of clipping its last ideas", () => {
    const ideas = missions.slice(0, 8).map((m) => ({ ...m, repos: ["/fixture/tall"] }));
    const regions = buildRegions(ideas, [], null, []);
    const sizes = new Map(ideas.map((m) => [m.id, 180]));
    const viewport = { w: 1238, h: 862 };
    const reading = (scale: number) => layoutRegions(regions, levelOf(scale), scale, sizes, undefined,
      { focus: "repo:/fixture/tall", focusSizes: sizes, focusViewport: viewport }).regions[0];
    const s = largestFit((s) => {
      const r = reading(s);
      return r.w * s <= viewport.w - 64 && r.h * s <= viewport.h - 64;
    }, .24, 1);
    const r = reading(s), v = frame(r, s, viewport, { top: 32, bottom: 32 });
    expect(new Set(r.items.map((it) => it.x)).size).toBeGreaterThan(1);
    expect(r.items).toHaveLength(8);
    for (const it of r.items) {
      // These ideas have no work cards; their readable minimum is 240px.
      expect(it.w * s).toBeGreaterThanOrEqual(240);
      expect(it.h * s).toBeCloseTo(180);
      expect(it.x * s + v.tx).toBeGreaterThanOrEqual(32);
      expect((it.x + it.w) * s + v.tx).toBeLessThanOrEqual(viewport.w - 32);
      expect(it.y * s + v.ty).toBeGreaterThanOrEqual(32);
      expect((it.y + it.h) * s + v.ty).toBeLessThanOrEqual(viewport.h - 32);
    }
  });

  it("reserves the rendered Firstmate and cluster heights throughout the zoom range", () => {
    const measured = new Map([["firstmate", 276], ["m0", 184], ["region:repo:/fixture/project-0", 90], [worker.id, 156]]);
    for (const scale of [0.24, 0.42, 0.55, 0.56, 0.7, 0.87, 0.88, 1, 1.6]) {
      const layout = layoutRegions(regions, levelOf(scale), scale, measured);
      const fm = layout.items.get("firstmate");
      expect(fm).toBeDefined();
      expect((fm?.h ?? 0) * scale).toBeCloseTo(276);
      expect((fm?.w ?? 0) * scale).toBeGreaterThanOrEqual(320);
      const items = [...layout.items.values()];
      for (const [i, a] of items.entries()) for (const b of items.slice(i + 1)) {
        const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        expect(overlapX <= 0 || overlapY <= 0, `${scale}: ${a.id} overlaps ${b.id}`).toBe(true);
      }
      for (const r of layout.regions) for (const item of r.items) {
        expect(item.x + item.w).toBeLessThanOrEqual(r.x + r.w);
        expect(item.y + item.h).toBeLessThanOrEqual(r.y + r.h);
        if (r.kind !== "firstmate") expect(item.y).toBeGreaterThan(r.labelY);
      }
    }
  });

  it("grows a region when its contents wrap, leaving Firstmate's slot separate", () => {
    const before = layoutRegions(regions, "far", 0.24);
    const after = layoutRegions(regions, "far", 0.24, new Map([["firstmate", 320], ["m0", 280]]));
    expect(after.regions.find((r) => r.id === "firstmate")?.h).toBeGreaterThan(before.regions.find((r) => r.id === "firstmate")?.h ?? 0);
    expect(after.regions.find((r) => r.missions.some((m) => m.id === "m0"))?.h).toBeGreaterThan(before.regions.find((r) => r.missions.some((m) => m.id === "m0"))?.h ?? 0);
  });
});

describe("one region per name", () => {
  const idea = (id: string, repos: string[], lenses: string[] = []): MapMission => ({
    ...Mission.parse({ id, title: id, repos, lenses, created: now, updated: now }),
    health: "active", health_why: "", workers: [], attention: [], verdict: null, artifacts: [], tasks: [], landed: [], asks: [], nudges: [],
  });
  const lens = { id: "joyride", title: "Joyride", description: "", missions: [], rule: {} };
  const ideas = [idea("build-joyride", ["/Users/x/Temp/joyride"]), idea("unify-agent-tooling", [], ["joyride"]), idea("atlas", ["/Users/x/atlas_3d"])];

  it("folds an unclaimed idea into the group that bears its repo's name, ignoring case", () => {
    const out = buildRegions(ideas, [lens as any], null, []);
    const titles = out.map((r) => r.title);
    expect(titles.filter((t) => t.toLowerCase() === "joyride")).toEqual(["Joyride"]);
    expect(out.find((r) => r.id === "lens:joyride")?.missions.map((m) => m.id).sort()).toEqual(["build-joyride", "unify-agent-tooling"]);
    expect(out.find((r) => r.id === "repo:/Users/x/atlas_3d")?.missions.map((m) => m.id)).toEqual(["atlas"]);
  });

  it("keeps the repo region when no group shares its name, or when the chart groups by repo", () => {
    expect(buildRegions(ideas, [], null, []).map((r) => r.id)).toContain("repo:/Users/x/Temp/joyride");
    const byRepo = buildRegions(ideas, [lens as any], { home: { group_by: "repo" } } as any, []);
    expect(byRepo.map((r) => r.id)).toContain("repo:/Users/x/Temp/joyride");
  });
});
