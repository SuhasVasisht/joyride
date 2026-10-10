// Regrouping from the map: moves write authored files in one commit, survive a reload from disk,
// and undo restores exactly what the move changed.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { sandboxDaemon } from "../sandbox.ts";
import { readLensDir, readMissionDir } from "../../src/modules/missions/store.ts";
import { primaryLens } from "../../src/shared/lens-match.ts";

const C7 = "claude:77777777-7777-4777-8777-777777777777", C8 = "claude:88888888-8888-4888-8888-888888888888";
let d: Awaited<ReturnType<typeof sandboxDaemon>>;
let home: string;
const log = () => execFileSync("git", ["log", "--format=%s"], { cwd: home, encoding: "utf8" }).trim().split("\n");
/** What a fresh daemon would read: the files on disk, not the module's memory. */
const onDisk = () => ({ missions: readMissionDir(path.join(home, "missions")).missions, lenses: readLensDir(path.join(home, "lenses")) });
const keys = (id: string) => onDisk().missions.find((m) => m.id === id)!.sessions.map((r) => `${r.source}:${r.id}`);
const move = (body: unknown) => d.req("POST", "/api/missions/move", body);
const undo = (commit: string) => d.req("POST", "/api/missions/move/undo", { commit });

beforeAll(async () => {
  d = await sandboxDaemon("map-move", ["sessions", "missions"]);
  home = d.sb.env.JOYRIDE_HOME;
  await d.ctx.service<any>("missions").settled();
  for (const m of [
    { id: "docs", title: "Docs pass", repos: ["/tmp/joyride-fixture-repos/gamma"], sessions: [C7] },
    { id: "search", title: "Search box", repos: ["/tmp/joyride-fixture-repos/alpha"] },
    { id: "billing", title: "Billing export", repos: ["/tmp/joyride-fixture-repos/beta"] },
  ]) expect((await d.req("POST", "/api/missions", m)).status).toBe(201);
  expect((await d.req("POST", "/api/lenses", { id: "q4", title: "Q4 bets", missions: ["search"] })).status).toBe(200);
  expect((await d.req("POST", "/api/lenses", { id: "beta-work", title: "Beta work", rule: { repo: "beta" } })).status).toBe(200);
});
afterAll(async () => { await d?.stop(); });

describe("moving a session", () => {
  it("assigns an unfiled session to a mission and persists it as one commit", async () => {
    const r = await move({ session: C8, to: { mission: "search" } });
    expect(r.status).toBe(200);
    expect(r.body.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(r.body.message).toBe("Moved the session to Search box.");
    expect(log()[0]).toBe(`joyride: map move: session ${C8} to search`);
    expect(keys("search")).toContain(C8);
  });

  it("moves a session between missions: it leaves the old one", async () => {
    const r = await move({ session: C7, to: { mission: "search" } });
    expect(r.status).toBe(200);
    expect(keys("search")).toEqual(expect.arrayContaining([C7, C8]));
    expect(keys("docs")).not.toContain(C7);
    // Undo puts it back exactly, both files in one commit.
    const u = await undo(r.body.commit);
    expect(u.status).toBe(200);
    expect(log()[0]).toBe(`joyride: undo map move ${r.body.commit.slice(0, 8)}`);
    expect(keys("docs")).toContain(C7);
    expect(keys("search")).not.toContain(C7);
    expect(d.ctx.service<any>("missions").missionOfSession(C7)).toBe("docs");
  });

  it("drops a session back to Unfiled, and a repeat move is a no-op", async () => {
    const r = await move({ session: C8, to: { mission: null } });
    expect(r.status).toBe(200);
    expect(r.body.message).toMatch(/to Unfiled/);
    expect(keys("search")).not.toContain(C8);
    expect(d.ctx.service<any>("missions").missionOfSession(C8)).toBeNull();
    expect((await move({ session: C8, to: { mission: null } })).body).toEqual({ commit: null, message: "Already there." });
  });

  it("explains bad input", async () => {
    expect((await move({ session: "nope", to: { mission: "search" } })).status).toBe(400);
    expect((await move({ session: C8, to: { mission: "missing" } })).status).toBe(404);
    expect((await move({})).status).toBe(400);
  });
});

describe("moving a mission between groups", () => {
  it("assigns a lens; explicit membership wins over the lens that listed it", async () => {
    const r = await move({ mission: "search", from: "q4", to: { lens: "beta-work" } });
    expect(r.status).toBe(200);
    const { missions, lenses } = onDisk();
    const m = missions.find((x) => x.id === "search")!;
    expect(m.lenses).toEqual(["beta-work"]);
    expect(lenses.find((l) => l.id === "q4")!.missions).not.toContain("search");
    expect(primaryLens(m, lenses)?.id).toBe("beta-work");
    expect(log()[0]).toBe("joyride: map move: mission search to lens beta-work");
    const u = await undo(r.body.commit);
    expect(u.status).toBe(200);
    const back = onDisk();
    expect(back.missions.find((x) => x.id === "search")!.lenses).toEqual([]);
    expect(back.lenses.find((l) => l.id === "q4")!.missions).toEqual(["search"]);
  });

  it("creates a new group from a dropped mission, and undo removes the group", async () => {
    const r = await move({ mission: "docs", to: { new_lens: "Writing" } });
    expect(r.status).toBe(200);
    expect(r.body.lens).toBe("writing");
    expect(onDisk().lenses.find((l) => l.id === "writing")?.title).toBe("Writing");
    expect(onDisk().missions.find((x) => x.id === "docs")!.lenses).toEqual(["writing"]);
    expect((await move({ mission: "search", to: { new_lens: "Writing" } })).body.lens).toBe("writing-2");
  });

  it("refuses to undo a move whose files changed since", async () => {
    const r = await move({ mission: "billing", to: { new_lens: "Money" } });
    expect((await move({ mission: "billing", from: "money", to: { lens: "q4" } })).status).toBe(200);
    const u = await undo(r.body.commit);
    expect(u.status).toBe(409);
    expect(u.body.error).toMatch(/changed after that move/);
  });

  it("takes a mission back to its repo group, unless a lens rule claims it", async () => {
    const r = await move({ mission: "search", from: "writing-2", to: { lens: null } });
    expect(r.status).toBe(200);
    expect(onDisk().missions.find((x) => x.id === "search")!.lenses).toEqual([]);
    const b = await move({ mission: "billing", from: "q4", to: { lens: null } });
    expect(b.status).toBe(409);
    expect(b.body.error).toMatch(/Beta work.*rule/);
  });

  it("only undoes map moves", async () => {
    const other = execFileSync("git", ["log", "--format=%H", "--grep=create mission docs"], { cwd: home, encoding: "utf8" }).trim();
    expect((await undo(other)).status).toBe(409);
    expect((await undo("not-a-sha")).status).toBe(400);
  });
});

describe("persistence", () => {
  it("a restarted module reads the moves back from disk", () => {
    expect(fs.existsSync(path.join(home, "lenses", "writing.yaml"))).toBe(true);
    const fresh = readMissionDir(path.join(home, "missions")).missions;
    const lenses = readLensDir(path.join(home, "lenses"));
    expect(primaryLens(fresh.find((m) => m.id === "docs")!, lenses)?.id).toBe("writing");
    expect(primaryLens(fresh.find((m) => m.id === "billing")!, lenses)?.id).toBe("q4");
  });
});
