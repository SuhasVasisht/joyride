import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { sandboxDaemon } from "../sandbox.ts";

const REPOS = "/tmp/joyride-fixture-repos";
function fixtureRepos() {
  for (const r of ["alpha", "beta", "gamma"]) {
    const dir = path.join(REPOS, r);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(path.join(dir, ".git"))) { try { execFileSync("git", ["init", "-q", dir]); } catch { fs.mkdirSync(path.join(dir, ".git"), { recursive: true }); } }
  }
  fs.mkdirSync("/tmp/joyride-fixture-norepo/scratch", { recursive: true });
}

const ALPHA = `${REPOS}/alpha`, BETA = `${REPOS}/beta`;
const C1 = "11111111-1111-4111-8111-111111111111", C2 = "22222222-2222-4222-8222-222222222222", C3 = "33333333-3333-4333-8333-333333333333";
const C4 = "44444444-4444-4444-8444-444444444444", C5 = "55555555-5555-4555-8555-555555555555", C6 = "66666666-6666-4666-8666-666666666666";
const C7 = "77777777-7777-4777-8777-777777777777", C8 = "88888888-8888-4888-8888-888888888888", C10 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const X1 = "019a0000-0000-7000-8000-000000000001", X2 = "019a0000-0000-7000-8000-000000000002", X3 = "019a0000-0000-7000-8000-000000000003";

let d: Awaited<ReturnType<typeof sandboxDaemon>>;
let missions: any, sessions: any, home: string;
const keysOf = (p: any) => p.sessions.map((r: any) => `${r.source}:${r.id}`).sort();
const gitLog = () => execFileSync("git", ["log", "--format=%s"], { cwd: home, encoding: "utf8" }).trim().split("\n");
const proposalWith = (key: string) => missions.proposals().find((p: any) => keysOf(p).includes(key));
const writeSession = (id: string, cwd: string, branch: string, prompt: string) => {
  const file = path.join(d.sb.env.JOYRIDE_CLAUDE_DIR, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const ts = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify({ type: "user", cwd, sessionId: id, gitBranch: branch, timestamp: ts, origin: { kind: "human" }, message: { role: "user", content: prompt } }) + "\n");
};

beforeAll(async () => {
  fixtureRepos();
  d = await sandboxDaemon("missions", ["sessions", "missions"]);
  missions = d.ctx.service("missions");
  sessions = d.ctx.service("sessions");
  home = d.sb.env.JOYRIDE_HOME;
});
afterAll(async () => { await d?.stop(); });

describe("clustering", () => {
  it("normalizes default branches and splits on 72h gaps", async () => {
    const { clusterSessions, normBranch } = await import("../../src/modules/missions/backfill.ts");
    expect([null, "", "main", "master", "HEAD"].map(normBranch)).toEqual(["main", "main", "main", "main", "main"]);
    expect(normBranch("feature/x")).toBe("feature/x");
    const at = (h: number) => new Date(Date.now() - h * 3600e3).toISOString();
    const s = (id: string, startH: number, endH: number, branch: string | null, repo = "/r/a") =>
      ({ key: `claude:${id}`, source: "claude", id, title: id, cwd: repo, repo, branch, first_prompt: "", started: at(startH), updated: at(endH), turns: 1, tokens: 0, model: null, transcript: "", mission: null, archived: false, subagents: 0 });
    const clusters = clusterSessions([s("a", 200, 199, "master"), s("b", 100, 99, null), s("c", 60, 59, "HEAD"), s("d", 10, 9, "feat"), s("e", 5, 4, null, "/r/b")] as any);
    const ids = clusters.map((c: any) => c.sessions.map((x: any) => x.id).join(",")).sort();
    expect(ids).toEqual(["a", "b,c", "d", "e"]);
    // an umbrella repo splits by the project folder a session ran in
    const u = (id: string, cwd: string) => ({ ...s(id, 10, 9, "main", "/r/u"), cwd });
    const um = clusterSessions([u("root1", "/r/u"), u("root2", "/r/u"), u("p1a", "/r/u/Temp/p1"), u("p1b", "/r/u/Temp/p1/sub"), u("p2", "/r/u/Temp/p2")] as any);
    expect(um.map((c: any) => c.sessions.map((x: any) => x.id).join(",")).sort()).toEqual(["p1a,p1b", "p2", "root1,root2"]);
  });

  it("names clusters in batches of at most ten", async () => {
    const { clusterSessions, nameClusters } = await import("../../src/modules/missions/backfill.ts");
    const at = new Date().toISOString();
    const many = Array.from({ length: 23 }, (_, i) => ({ key: `claude:s${i}`, source: "claude", id: `s${i}`, title: `Task ${i}`, cwd: `/r/repo${i}`, repo: `/r/repo${i}`, branch: "main", first_prompt: "", started: at, updated: at, turns: 1, tokens: 0, model: null, transcript: "", mission: null, archived: false, subagents: 0 }));
    const clusters = clusterSessions(many as any);
    expect(clusters).toHaveLength(23);
    const r = await nameClusters(clusters);
    expect(r.calls).toBe(3);
    expect(r.fallbacks).toBe(0);
    expect(r.names.map((n: any) => n.title)).toEqual(clusters.map((c: any) => `${c.repo.split("/").pop()}: ${c.sessions[0].title}`));
  });
});

describe("backfill and missions", () => {
  it("runs backfill automatically on first start", async () => {
    await d.start();
    await missions.settled();
    const props = missions.proposals({ status: "pending" });
    expect(props).toHaveLength(5);

    const recent = proposalWith(`claude:${C1}`);
    expect(keysOf(recent)).toEqual([`claude:${C1}`, `claude:${C2}`, `codex:${X1}`].sort());
    expect(recent.title).toBe("alpha: Add CSV export to report page");
    expect(recent.repos).toEqual([ALPHA]);
    expect(recent.branches).toEqual(["main"]);
    expect(recent.first_ts).toBe(sessions.get(C2).started);
    expect(recent.reason).toMatch(/^3 sessions in alpha on main/);
    expect(keysOf(proposalWith(`claude:${C4}`))).toEqual([`claude:${C4}`]); // > 72h before the rest of alpha/main
    expect(proposalWith(`claude:${C3}`).branches).toEqual(["feature/auth"]);
    const beta = proposalWith(`claude:${C5}`);
    expect(keysOf(beta)).toEqual([`claude:${C5}`, `claude:${C6}`, `codex:${X2}`].sort());
    expect(beta.branches.sort()).toEqual(["HEAD", "master"]);
    const norepo = proposalWith(`claude:${C10}`);
    expect(norepo.repos).toEqual([]);
    expect(props.every((p: any) => p.merge_into === null && p.status === "pending")).toBe(true);

    // older than 30 days: folded into an archive mission, one commit
    const archive = missions.get("archive-gamma");
    expect(archive).toMatchObject({ archive: true, state: "done", repos: [`${REPOS}/gamma`] });
    expect(keysOf(archive)).toEqual([`claude:${C7}`, `claude:${C8}`, `codex:${X3}`].sort());
    expect(fs.existsSync(path.join(home, "missions", "archive-gamma.md"))).toBe(true);
    expect(gitLog().filter((s) => s.startsWith("joyride: archive"))).toEqual(["joyride: archive 3 sessions older than 30 days into 1 archive mission"]);
    expect(missions.missionOfSession(`claude:${C7}`)).toBe("archive-gamma");
    expect(props.some((p: any) => keysOf(p).some((k: string) => [C7, C8, X3].some((id) => k.endsWith(id))))).toBe(false);
  });

  it("is idempotent on re-run", async () => {
    const r = await missions.runBackfill();
    expect(r.ok).toBe(true);
    expect(r.created).toEqual([]);
    expect(r.kept).toHaveLength(5);
    expect(r.archived.sessions).toBe(0);
    expect(missions.proposals({ status: "pending" })).toHaveLength(5);
  });

  it("accepts a proposal into a mission file with a git commit", async () => {
    const p = proposalWith(`claude:${C1}`);
    const r = await d.req("POST", `/api/missions/proposals/${p.id}/accept`, { edits: { title: "Report CSV export", done_when: ["Export test passes"] } });
    expect(r.status).toBe(200);
    expect(r.body.mission.id).toBe("report-csv-export");
    expect(r.body.proposal).toMatchObject({ status: "accepted", mission: "report-csv-export" });

    const file = path.join(home, "missions", "report-csv-export.md");
    const text = fs.readFileSync(file, "utf8");
    expect(text.startsWith("---\n")).toBe(true);
    const front = text.split("---\n")[1];
    expect(front).not.toMatch(/^goal:/m);
    expect(text.trim().endsWith(p.goal)).toBe(true);
    const { parseMission } = await import("../../src/modules/missions/store.ts");
    expect(parseMission(text, "x")).toEqual(missions.get("report-csv-export"));
    expect(missions.get("report-csv-export")).toMatchObject({ title: "Report CSV export", repos: [ALPHA], branches: ["main"], done_when: [{ id: "c1", text: "Export test passes", kind: "other" }] });
    expect(gitLog()[0]).toBe(`joyride: accept proposal ${p.id}`);
    expect(execFileSync("git", ["status", "--porcelain", "missions"], { cwd: home, encoding: "utf8" })).toBe("");

    expect(missions.missionOfSession(`claude:${C1}`)).toBe("report-csv-export");
    expect(missions.missionOfSession(C1)).toBe("report-csv-export");
    expect(missions.missionOfSession(`codex:${X1}`)).toBe("report-csv-export");
    expect(missions.missionOfSession("claude:unknown")).toBeNull();
    expect(sessions.get(C2).mission).toBe("report-csv-export");
    expect(sessions.list({ mission: "report-csv-export" })).toHaveLength(3);
    const unassigned = sessions.list({ mission: "none", limit: 100 }).map((v: any) => v.id);
    expect(unassigned).toHaveLength(12 - 3 - 3);
    expect(unassigned).not.toContain(C1);
    expect(missions.proposals({ status: "pending" })).toHaveLength(4);
    expect((await d.req("POST", `/api/missions/proposals/${p.id}/accept`, {})).status).toBe(409);
  });

  it("never re-proposes a rejected session set", async () => {
    const p = proposalWith(`claude:${C5}`);
    const r = await d.req("POST", `/api/missions/proposals/${p.id}/reject`, { reason: "chores" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "rejected", decision_reason: "chores" });
    const again = await missions.runBackfill();
    expect(again.created).toEqual([]);
    expect(again.skipped).toContain(p.id);
    expect(missions.proposals({ status: "rejected" }).map((x: any) => x.id)).toEqual([p.id]);
    expect((await d.req("GET", "/api/missions/proposals")).body).toHaveLength(3);
  });

  it("asks Jev whether a new cluster belongs to an open mission in the repo", async () => {
    const un = await d.req("DELETE", `/api/missions/report-csv-export/sessions/claude:${C1}`);
    expect(un.status).toBe(200);
    expect(missions.missionOfSession(C1)).toBeNull();
    const r = await missions.runBackfill();
    expect(r.created).toHaveLength(1);
    expect(r.merge_suggestions).toBe(1);
    const p = proposalWith(`claude:${C1}`);
    expect(p.merge_into).toBe("report-csv-export");
    const acc = await missions.acceptProposal(p.id);
    expect(acc.mission.id).toBe("report-csv-export");
    expect(missions.missionOfSession(C1)).toBe("report-csv-export");
  });

  it("auto-links a new session when exactly one open mission matches repo and branch", async () => {
    writeSession("cccccccc-cccc-4ccc-8ccc-cccccccccccc", ALPHA, "master", "Tidy up the export module");
    writeSession("dddddddd-dddd-4ddd-8ddd-dddddddddddd", BETA, "main", "Speed up the sync job");
    writeSession("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", ALPHA, "feature/other", "Unrelated branch work");
    await sessions.reindex();
    expect(missions.missionOfSession("claude:cccccccc-cccc-4ccc-8ccc-cccccccccccc")).toBe("report-csv-export");
    expect(missions.missionOfSession("claude:dddddddd-dddd-4ddd-8ddd-dddddddddddd")).toBeNull();
    expect(missions.missionOfSession("claude:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee")).toBeNull();
    expect(gitLog()[0]).toBe("joyride: auto-link 1 new session to report-csv-export");
  });

  it("gates done on a passing verdict or an override reason", async () => {
    const id = "report-csv-export";
    const no = await d.req("PUT", `/api/missions/${id}/state`, { state: "done" });
    expect(no.status).toBe(409);
    expect(no.body.error).toMatch(/override reason/);
    const ok = await d.req("PUT", `/api/missions/${id}/state`, { state: "done", reason: "Verified by hand" });
    expect(ok.status).toBe(200);
    expect(ok.body.state).toBe("done");
    expect(ok.body.override.reason).toBe("Verified by hand");
    expect(missions.get(id).override.reason).toBe("Verified by hand");

    const plain = (await d.req("POST", "/api/missions", { title: "Plain chores", goal: "No criteria" })).body;
    expect((await d.req("PUT", `/api/missions/${plain.id}/state`, { state: "done" })).status).toBe(200);

    const gated = (await d.req("POST", "/api/missions", { title: "Gated work", done_when: [{ text: "e2e green", kind: "e2e" }] })).body;
    let verdict: any = { verdict: "fail", created: new Date().toISOString() };
    d.ctx.services.set("evidence", { latestVerdict: async () => verdict, list: () => [] });
    try {
      const fail = await d.req("PUT", `/api/missions/${gated.id}/state`, { state: "done" });
      expect(fail.status).toBe(409);
      expect(fail.body.error).toMatch(/no passing verdict/);
      verdict = { verdict: "pass", created: new Date().toISOString() };
      const pass = await d.req("PUT", `/api/missions/${gated.id}/state`, { state: "done" });
      expect(pass.status).toBe(200);
      expect(pass.body.override).toBeNull();
    } finally { d.ctx.services.delete("evidence"); }
    // reopening keeps state edits on the same gate
    expect((await d.req("PUT", `/api/missions/${id}/state`, { state: "open" })).status).toBe(200);
    expect((await d.req("PUT", `/api/missions/${id}/state`, { state: "finished" })).status).toBe(400);
  });

  it("derives health from attention, workers and session activity", async () => {
    const id = "report-csv-export";
    expect(missions.health(id)).toBe("active"); // C1 updated 10 minutes ago
    const items: any[] = [];
    d.ctx.services.set("attention", { list: () => items });
    try {
      items.push({ id: "a1", level: "L2", title: "Review the export diff", session: null, mission: id, resolved: null });
      expect(missions.health(id)).toBe("needs-review");
      items.push({ id: "a2", level: "L3", title: "Permission to run migration", session: `claude:${C1}`, mission: null, resolved: null });
      const h = await d.req("GET", `/api/missions/${id}/health`);
      expect(h.body).toMatchObject({ id, health: "blocked", why: "Permission to run migration" });
    } finally { d.ctx.services.delete("attention"); }
    d.ctx.services.set("workers", { byMission: () => [{ id: "local:w1:p1", status: "blocked" }] });
    try { expect(missions.health(id)).toBe("blocked"); } finally { d.ctx.services.delete("workers"); }
    const idle = missions.create({ title: "Old idea", sessions: [`claude:${C4}`] });
    expect(missions.health(idle.id)).toBe("idle");
    const list = (await d.req("GET", "/api/missions?archive=false")).body;
    expect(list.every((m: any) => !m.archive && typeof m.health === "string")).toBe(true);
    expect(list.find((m: any) => m.id === id).health).toBe("active");
    expect((await d.req("GET", "/api/missions?archive=true")).body.map((m: any) => m.id)).toEqual(["archive-gamma"]);
  });

  it("round-trips edits and session links through the API", async () => {
    const created = await d.req("POST", "/api/missions", { title: "Sync reliability", goal: "## Why\n\nNightly sync must never double-insert.\n", repos: [BETA] });
    expect(created.status).toBe(201);
    const id = created.body.id;
    expect(id).toBe("sync-reliability");
    expect((await d.req("POST", "/api/missions", { title: "Sync reliability" })).body.id).toBe("sync-reliability-2");
    const linked = await d.req("POST", `/api/missions/${id}/sessions`, { refs: [`claude:${C5}`, C6, { source: "codex", id: X2 }] });
    expect(linked.status).toBe(200);
    expect(keysOf(linked.body)).toEqual([`claude:${C5}`, `claude:${C6}`, `codex:${X2}`].sort());
    expect(linked.body.branches.sort()).toEqual(["HEAD", "master"]);
    const bad = await d.req("POST", `/api/missions/${id}/sessions`, { refs: ["claude:"] });
    expect(bad.status).toBe(400);
    const put = await d.req("PUT", `/api/missions/${id}`, { goal: "Updated goal", lenses: ["ops"] });
    expect(put.status).toBe(200);
    const text = fs.readFileSync(path.join(home, "missions", `${id}.md`), "utf8");
    expect(text.trim().endsWith("Updated goal")).toBe(true);
    expect(text).toMatch(/lenses:\n {2}- ops/);
    expect((await d.req("GET", `/api/missions/${id}`)).body).toMatchObject({ id, goal: "Updated goal", lenses: ["ops"] });
    expect((await d.req("GET", "/api/missions/nope")).status).toBe(404);
    expect((await d.req("PUT", `/api/missions/${id}`, { id: "renamed" })).status).toBe(400);
    expect((await d.req("POST", "/api/missions", { goal: "no title" })).status).toBe(400);
    // a session belongs to one mission: linking moves it
    await d.req("POST", "/api/missions/sync-reliability-2/sessions", { refs: [`claude:${C5}`] });
    expect(missions.missionOfSession(C5)).toBe("sync-reliability-2");
    expect(keysOf(missions.get(id))).not.toContain(`claude:${C5}`);
  });

  it("stores lenses as YAML files in git", async () => {
    const r = await d.req("POST", "/api/lenses", { title: "Customer work", missions: ["report-csv-export"], rule: { repo: ALPHA } });
    expect(r.status).toBe(200);
    expect(r.body.id).toBe("customer-work");
    expect(fs.readFileSync(path.join(home, "lenses", "customer-work.yaml"), "utf8")).toMatch(/title: Customer work/);
    expect((await d.req("GET", "/api/lenses")).body.map((l: any) => l.id)).toEqual(["customer-work"]);
    expect(gitLog()[0]).toBe("joyride: create lens customer-work");
    expect((await d.req("DELETE", "/api/lenses/customer-work")).status).toBe(200);
    expect(fs.existsSync(path.join(home, "lenses", "customer-work.yaml"))).toBe(false);
    expect(gitLog()[0]).toBe("joyride: remove lens customer-work");
    expect((await d.req("DELETE", "/api/lenses/customer-work")).status).toBe(404);
  });
});
