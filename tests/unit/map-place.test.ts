// Moving groups on the canvas: map/layout.yaml holds where the captain placed each group, written as one
// "map move" commit that the map's Undo (and an agent's undo) takes back exactly, with agent attribution.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { sandboxDaemon } from "../sandbox.ts";
import { mapAction } from "../../src/shared/map-actions.ts";
import { parseMapArgs } from "../../src/cli/map.ts";
import { nextLayout, readLayout, renderLayout } from "../../src/modules/missions/layout.ts";

let d: Awaited<ReturnType<typeof sandboxDaemon>>;
let home: string;
const log = () => execFileSync("git", ["log", "--format=%s"], { cwd: home, encoding: "utf8" }).trim().split("\n");
const file = () => path.join(home, "map", "layout.yaml");
const post = (url: string, body: unknown) => d.req("POST", url, body);
const agent = { kind: "agent", id: "jr-map-focus-test", via: "cli" };

beforeAll(async () => {
  d = await sandboxDaemon("map-place", ["sessions", "missions"]);
  home = d.sb.env.JOYRIDE_HOME;
  await d.ctx.service<any>("missions").settled();
  expect((await post("/api/lenses", { id: "reporting", title: "Reporting" })).status).toBe(200);
  expect((await post("/api/lenses", { id: "infra", title: "Infra" })).status).toBe(200);
});
afterAll(async () => { await d?.stop(); });

describe("the layout file", () => {
  it("round-trips positions in the order they were placed, ignoring ids the map can't chart", () => {
    const text = renderLayout(new Map([["lens:reporting", { x: 10.04, y: -20 }], ["repo:/tmp/a: b", { x: 1, y: 2 }]]));
    fs.mkdirSync(path.join(home, "scratch"), { recursive: true });
    const f = path.join(home, "scratch", "layout.yaml");
    fs.writeFileSync(f, text + '  "not a group": { x: 1, y: 1 }\n');
    expect([...readLayout(f)]).toEqual([["lens:reporting", { x: 10, y: -20 }], ["repo:/tmp/a: b", { x: 1, y: 2 }]]);
    expect(readLayout(path.join(home, "scratch", "missing.yaml")).size).toBe(0);
  });
  it("moves the dropped group last and treats a bare id as a lens group", () => {
    const next = nextLayout(new Map(), { positions: { "lens:a": { x: 1, y: 1 }, "lens:b": { x: 2, y: 2 }, "lens:c": { x: 3, y: 3 } }, moved: "lens:a" });
    expect([...next.groups.keys()]).toEqual(["lens:b", "lens:c", "lens:a"]);
    expect(nextLayout(next.groups, { group: "c", reset: true }).groups.has("lens:c")).toBe(false);
    expect(nextLayout(new Map(), { group: "reporting", x: 5, y: 6 }).moved).toBe("lens:reporting");
  });
});

describe("placing groups through the API", () => {
  it("stores the map's arrangement as one map move commit, and Undo restores the earlier one", async () => {
    const first = await post("/api/missions/map/layout", { positions: { "lens:infra": { x: 0, y: 900 }, "lens:reporting": { x: 1200, y: 0 } }, moved: "lens:reporting", title: "Reporting" });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ group: "lens:reporting", message: "Moved Reporting.", commit: expect.stringMatching(/^[0-9a-f]{40}$/) });
    expect(log()[0]).toBe("joyride: map move: group lens:reporting placed");
    expect((await d.req("GET", "/api/missions/map/layout")).body).toEqual({ "lens:infra": { x: 0, y: 900 }, "lens:reporting": { x: 1200, y: 0 } });
    const second = await post("/api/missions/map/layout", { positions: { "lens:infra": { x: 40, y: 40 }, "lens:reporting": { x: 1200, y: 0 } }, moved: "lens:infra" });
    expect(second.body.commit).toMatch(/^[0-9a-f]{40}$/);
    const same = await post("/api/missions/map/layout", { positions: { "lens:reporting": { x: 1200, y: 0 }, "lens:infra": { x: 40, y: 40 } }, moved: "lens:infra" });
    expect(same.body).toMatchObject({ commit: null, message: "Already there." });
    expect((await post("/api/missions/move/undo", { commit: second.body.commit })).body.message).toBe("Move undone.");
    expect(readLayout(file()).get("lens:infra")).toEqual({ x: 0, y: 900 });
    expect((await post("/api/missions/move/undo", { commit: first.body.commit })).status).toBe(200);
    expect(fs.existsSync(file())).toBe(false);
    // Undo refuses once the file has changed since.
    const third = await post("/api/missions/map/layout", { group: "reporting", x: 1, y: 2 });
    await post("/api/missions/map/layout", { group: "infra", x: 3, y: 4 });
    expect((await post("/api/missions/move/undo", { commit: third.body.commit })).status).toBe(409);
  });

  it("lets an agent move one group, attributed, and put it back in its usual spot", async () => {
    const moved = await post("/api/missions/map/layout", { group: "infra", x: -300, y: 120.25, actor: agent });
    expect(moved.body).toMatchObject({ group: "lens:infra", message: "Moved Infra." });
    expect(readLayout(file()).get("lens:infra")).toEqual({ x: -300, y: 120.3 });
    const history = (await d.req("GET", "/api/missions/move/history")).body;
    expect(history[0]).toMatchObject({ commit: moved.body.commit, summary: "group lens:infra placed", actor: agent, undone: false });
    const back = await post("/api/missions/map/layout", { group: "lens:infra", reset: true, actor: agent });
    expect(back.body.message).toBe("Infra is back in its usual spot.");
    expect(readLayout(file()).has("lens:infra")).toBe(false);
    expect((await d.req("GET", "/api/missions/map")).body.layout).toEqual(Object.fromEntries(readLayout(file())));
  });

  it("refuses the hub, unknown groups and malformed requests before writing", async () => {
    const before = log()[0];
    expect((await post("/api/missions/map/layout", { group: "nope", x: 1, y: 1 })).status).toBe(404);
    expect((await post("/api/missions/map/layout", { group: "firstmate", x: 1, y: 1 })).status).toBe(400);
    expect((await post("/api/missions/map/layout", { group: "reporting", x: "far", y: 1 })).status).toBe(400);
    expect((await post("/api/missions/map/layout", { positions: {}, moved: "lens:reporting" })).status).toBe(400);
    expect((await post("/api/missions/map/layout", { group: "reporting", x: 1, y: 1, actor: { kind: "agent", id: "a\nb", via: "cli" } })).status).toBe(400);
    expect(log()[0]).toBe(before);
  });
});

describe("the move-group agent action", () => {
  it("marshals CLI arguments to the layout endpoint", () => {
    const p = parseMapArgs(["move-group", "reporting", "--x", "-200", "--y", "640"]);
    expect(mapAction(p.name).prepare(p.args)).toEqual({ method: "POST", path: "/api/missions/map/layout", body: { group: "reporting", x: -200, y: 640 } });
    const r = parseMapArgs(["move-group", "repo:/tmp/alpha", "--reset"]);
    expect(mapAction(r.name).prepare(r.args)).toEqual({ method: "POST", path: "/api/missions/map/layout", body: { group: "repo:/tmp/alpha", reset: true } });
    expect(() => mapAction("move-group").prepare({ group: "reporting", x: 1 })).toThrow("--x and --y");
    expect(() => parseMapArgs(["move-group", "reporting", "--x", "left", "--y", "1"])).toThrow();
  });
});
