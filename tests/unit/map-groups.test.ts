// Making groups from the map: create, rename (a group, an Unfiled group, a repo group), delete and
// merge are each one "map move" commit that undo takes back exactly, and no member is ever lost.
// A session can sit in a group directly, and the map can set unfiled work aside.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { sandboxDaemon } from "../sandbox.ts";
import { readLensDir, readMissionDir } from "../../src/modules/missions/store.ts";
import { primaryLens } from "../../src/shared/lens-match.ts";

const C7 = "claude:77777777-7777-4777-8777-777777777777", C8 = "claude:88888888-8888-4888-8888-888888888888";
const ALPHA = "/tmp/joyride-fixture-repos/alpha";
let d: Awaited<ReturnType<typeof sandboxDaemon>>;
let home: string;
const log = () => execFileSync("git", ["log", "--format=%s"], { cwd: home, encoding: "utf8" }).trim().split("\n");
const onDisk = () => ({ missions: readMissionDir(path.join(home, "missions")).missions, lenses: readLensDir(path.join(home, "lenses")) });
const lens = (id: string) => onDisk().lenses.find((l) => l.id === id);
const groupOf = (mission: string) => { const { missions, lenses } = onDisk(); return primaryLens(missions.find((m) => m.id === mission)!, lenses)?.id ?? null; };
const post = (url: string, body: unknown) => d.req("POST", url, body);
const undo = (commit: string) => post("/api/missions/move/undo", { commit });

beforeAll(async () => {
  d = await sandboxDaemon("map-groups", ["sessions", "missions"]);
  home = d.sb.env.JOYRIDE_HOME;
  await d.ctx.service<any>("missions").settled();
  for (const m of [
    { id: "docs", title: "Docs pass", repos: ["/tmp/joyride-fixture-repos/gamma"], sessions: [C7] },
    { id: "search", title: "Search box", repos: [ALPHA] },
    { id: "filters", title: "Filters", repos: [ALPHA] },
    { id: "billing", title: "Billing export", repos: ["/tmp/joyride-fixture-repos/beta"] },
  ]) expect((await post("/api/missions", m)).status).toBe(201);
  expect((await post("/api/lenses", { id: "beta-work", title: "Beta work", rule: { repo: "beta" } })).status).toBe(200);
});
afterAll(async () => { await d?.stop(); });

describe("creating and renaming a group", () => {
  it("creates an empty group as one map move, and undo removes it", async () => {
    const r = await post("/api/lenses/create", { title: "Q4 bets" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ lens: "q4-bets", commit: expect.stringMatching(/^[0-9a-f]{40}$/) });
    expect(log()[0]).toBe("joyride: map move: group q4-bets created");
    expect(lens("q4-bets")).toMatchObject({ title: "Q4 bets", missions: [], sessions: [], projects: [] });
    expect((await undo(r.body.commit)).status).toBe(200);
    expect(lens("q4-bets")).toBeUndefined();
    expect((await post("/api/lenses/create", { title: "  " })).status).toBe(400);
  });

  it("renames a group in place: same id, new title", async () => {
    const c = await post("/api/lenses/create", { title: "Q4 bets" });
    const r = await post("/api/lenses/rename", { lens: c.body.lens, title: "Q4 big bets" });
    expect(r.status).toBe(200);
    expect(lens("q4-bets")?.title).toBe("Q4 big bets");
    expect((await post("/api/lenses/rename", { lens: "q4-bets", title: "Q4 big bets" })).body.commit).toBeNull();
    expect((await post("/api/lenses/rename", { lens: "nope", title: "x" })).status).toBe(404);
    expect((await undo(r.body.commit)).status).toBe(200);
    expect(lens("q4-bets")?.title).toBe("Q4 bets");
  });

  it("renaming an Unfiled group makes a group that holds that project's unfiled work", async () => {
    const r = await post("/api/lenses/rename", { unfiled: "Alpha", title: "Alpha scratch" });
    expect(r.status).toBe(200);
    expect(lens(r.body.lens)).toMatchObject({ title: "Alpha scratch", projects: ["alpha"], missions: [] });
    expect(log()[0]).toBe(`joyride: map move: group ${r.body.lens} from unfiled alpha`);
    // One group per project's unfiled work.
    expect((await post("/api/lenses/rename", { unfiled: "alpha", title: "Again" })).status).toBe(409);
  });

  it("renaming a repo group makes a group that lists the ideas it charted", async () => {
    const r = await post("/api/lenses/rename", { repo: ALPHA, title: "Alpha ideas" });
    expect(r.status).toBe(200);
    expect(lens(r.body.lens)?.missions.sort()).toEqual(["filters", "search"]);
    expect(groupOf("search")).toBe(r.body.lens);
    // Billing is claimed by Beta work's rule, so the beta repo group has nothing to rename.
    expect((await post("/api/lenses/rename", { repo: "/tmp/joyride-fixture-repos/beta", title: "x" })).status).toBe(404);
  });
});

describe("sessions in groups", () => {
  it("drops a session on a group: it leaves its idea and sits in the group", async () => {
    const r = await post("/api/missions/move", { session: C7, to: { lens: "q4-bets" } });
    expect(r.status).toBe(200);
    expect(log()[0]).toBe(`joyride: map move: session ${C7} to lens q4-bets`);
    expect(lens("q4-bets")?.sessions).toEqual([C7]);
    expect(d.ctx.service<any>("missions").missionOfSession(C7)).toBeNull();
    expect((await post("/api/missions/move", { session: C7, to: { lens: "q4-bets" } })).body.commit).toBeNull();
    // Undo restores both files at once.
    expect((await undo(r.body.commit)).status).toBe(200);
    expect(lens("q4-bets")?.sessions).toEqual([]);
    expect(d.ctx.service<any>("missions").missionOfSession(C7)).toBe("docs");
  });

  it("moves a session between groups, to an idea, to Unfiled, and into a new group", async () => {
    await post("/api/missions/move", { session: C8, to: { lens: "q4-bets" } });
    await post("/api/missions/move", { session: C8, to: { lens: "beta-work" } });
    expect(lens("q4-bets")?.sessions).toEqual([]);
    expect(lens("beta-work")?.sessions).toEqual([C8]);
    await post("/api/missions/move", { session: C8, to: { mission: "search" } });
    expect(lens("beta-work")?.sessions).toEqual([]);
    expect(d.ctx.service<any>("missions").missionOfSession(C8)).toBe("search");
    await post("/api/missions/move", { session: C8, to: { lens: "beta-work" } });
    const out = await post("/api/missions/move", { session: C8, to: { mission: null } });
    expect(out.body.message).toMatch(/to Unfiled/);
    expect(lens("beta-work")?.sessions).toEqual([]);
    const n = await post("/api/missions/move", { session: C8, to: { new_lens: "Loose ends" } });
    expect(n.body.lens).toBe("loose-ends");
    expect(lens("loose-ends")?.sessions).toEqual([C8]);
  });
});

describe("deleting and merging groups", () => {
  it("deletes a group: its ideas fall back to their repo group, its sessions to Unfiled; undo brings it all back", async () => {
    await post("/api/missions/move", { mission: "docs", to: { lens: "q4-bets" } });
    await post("/api/missions/move", { session: C7, to: { lens: "q4-bets" } });
    expect(groupOf("docs")).toBe("q4-bets");
    const r = await post("/api/lenses/delete", { lens: "q4-bets" });
    expect(r.status).toBe(200);
    expect(log()[0]).toBe("joyride: map move: group q4-bets deleted");
    expect(lens("q4-bets")).toBeUndefined();
    expect(onDisk().missions.find((m) => m.id === "docs")!.lenses).toEqual([]);
    expect(groupOf("docs")).toBeNull();
    const u = await undo(r.body.commit);
    expect(u.status).toBe(200);
    expect(lens("q4-bets")?.sessions).toEqual([C7]);
    expect(groupOf("docs")).toBe("q4-bets");
  });

  it("merges a group into another: ideas (named or by rule), sessions and projects all join it", async () => {
    const before = onDisk();
    const alphaScratch = before.lenses.find((l) => l.projects.includes("alpha"))!;
    await post("/api/lenses/merge", { lens: alphaScratch.id, into: "q4-bets" });
    expect(lens("q4-bets")?.projects).toEqual(["alpha"]);
    const r = await post("/api/lenses/merge", { lens: "beta-work", into: "q4-bets" });
    expect(r.status).toBe(200);
    expect(log()[0]).toBe("joyride: map move: group beta-work merged into q4-bets");
    expect(lens("beta-work")).toBeUndefined();
    expect(groupOf("billing")).toBe("q4-bets"); // was in Beta work by its repo rule
    expect(groupOf("docs")).toBe("q4-bets");
    expect(lens("q4-bets")?.sessions).toEqual([C7]);
    expect((await undo(r.body.commit)).status).toBe(200);
    expect(groupOf("billing")).toBe("beta-work");
    expect((await post("/api/lenses/merge", { lens: "q4-bets", into: "q4-bets" })).status).toBe(400);
    expect((await post("/api/lenses/delete", { lens: "nope" })).status).toBe(404);
  });

  it("is exposed as a service for agents", () => {
    const svc = d.ctx.service<any>("lenses");
    for (const f of ["createGroup", "renameGroup", "deleteGroup", "mergeGroup"]) expect(typeof svc[f]).toBe("function");
  });
});

describe("setting unfiled work aside", () => {
  it("hides a session from the map until undone, and lists what is hidden", async () => {
    const r = await post("/api/missions/hide", { key: C8 });
    expect(r.status).toBe(200);
    expect(Object.keys((await d.req("GET", "/api/missions/hidden")).body)).toEqual([C8]);
    await post("/api/missions/unhide", { key: C8 });
    expect((await d.req("GET", "/api/missions/hidden")).body).toEqual({});
    expect((await post("/api/missions/hide", { key: "bad key!" })).status).toBe(400);
  });

  it("lists sessions by key", async () => {
    await d.ctx.service<any>("sessions").reindex();
    const all = (await d.req("GET", "/api/sessions?limit=3")).body.map((s: any) => s.key);
    expect(all.length).toBeGreaterThan(1);
    const r = await d.req("GET", `/api/sessions?keys=${all[0]},${all[1]},claude:missing`);
    expect(r.status).toBe(200);
    expect(r.body.map((s: any) => s.key).sort()).toEqual([all[0], all[1]].sort());
    expect((await d.req("GET", "/api/sessions?keys=")).body).toEqual([]);
  });
});
