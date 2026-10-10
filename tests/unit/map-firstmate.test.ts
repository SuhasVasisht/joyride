// The map's Firstmate node, the fleet bridge: always charted first, as its own region, sized per zoom level.
import { describe, expect, it } from "vitest";
import { buildRegions, layoutRegions } from "../../src/ui/views/map/layout";
import { groupUnfiled } from "../../src/ui/views/map/place";
import type { FirstmateNode } from "../../src/ui/views/map/world";

const worker = (id: string): any => ({ id, machine: "local", agent: "claude", status: "working", pane: "w1:p1", pid: null, cwd: "/tmp/x", repo: null, session: null, title: id, updated: new Date().toISOString() });
const mission = (id: string): any => ({ id, title: id, goal: "", repos: ["/tmp/alpha"], lenses: [], done_when: [], health: "active", health_why: "", archive: false, updated: "2026-10-01", workers: [], attention: [], verdict: null, sessions: [] });
const fleet = { crew: 2, watched: 5, yoursOnly: 0, needsYou: 1, yourHelm: 1 };
const fm = (over: Partial<FirstmateNode> = {}): FirstmateNode => ({ status: { running: true } as any, error: null, worker: null, fleet, inFlight: 2, calls: 1, log: [], asks: [], orphans: [], needsYou: null, ...over });

describe("map Firstmate node", () => {
  it("is its own first region, apart from mission clusters and unfiled work", () => {
    const regions = buildRegions([mission("a")], [], null, groupUnfiled({ workers: [worker("loose")] }), fm());
    expect(regions.map((r) => r.kind)).toEqual(["firstmate", "repo", "unfiled"]);
    expect(regions[0].missions).toEqual([]);
    expect(regions[0].workers).toEqual([]);
  });

  it("is charted even when nothing else is", () => {
    const regions = buildRegions([], [], null, [], fm({ status: null }));
    expect(regions).toHaveLength(1);
    const lay = layoutRegions(regions, "far");
    expect(lay.items.get("firstmate")?.kind).toBe("firstmate");
  });

  it("sits top-left at every zoom level and grows for the start action, never for the fleet's size", () => {
    const regions = buildRegions([mission("a"), mission("b")], [], null, [], fm());
    for (const lv of ["far", "mid", "near"] as const) {
      const it = layoutRegions(regions, lv).items.get("firstmate")!;
      const others = [...layoutRegions(regions, lv).items.values()].filter((x) => x.id !== "firstmate");
      expect(others.every((o) => o.x >= it.x && o.y >= it.y)).toBe(true);
    }
    const h = (f: FirstmateNode, lv: "far" | "mid" | "near") => layoutRegions(buildRegions([], [], null, [], f), lv).items.get("firstmate")!.h;
    expect(h(fm({ status: { running: false } as any }), "mid")).toBeGreaterThan(h(fm(), "mid"));
    for (const lv of ["far", "mid", "near"] as const) expect(h(fm({ fleet: { crew: 40, watched: 90, yoursOnly: 4, needsYou: 9, yourHelm: 3 } }), lv)).toBe(h(fm(), lv));
  });

  it("is left out when the map has no Firstmate data", () => {
    expect(buildRegions([mission("a")], [], null, []).some((r) => r.kind === "firstmate")).toBe(false);
  });
});
