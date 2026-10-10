import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { sandboxDaemon } from "../sandbox.ts";
import { assertSandboxed, startFakeHerdr, waitFor, FIXTURE_REPOS, type FakeHerdr } from "../fixtures/fake-herdr.ts";
import type { MissionsService, LensesService } from "../../src/modules/missions/index.ts";

process.env.JOYRIDE_HERDR_POLL_MS = "300";
let d: Awaited<ReturnType<typeof sandboxDaemon>>;
let fake: FakeHerdr;
const launch = (here: unknown) => d.req("POST", "/api/intents", { kind: "launch_session", target: "", payload: { here } });

beforeAll(async () => {
  d = await sandboxDaemon("session-here", ["sessions", "missions", "live", "artifacts", "fleet"]);
  d.ctx.config.knowledge.pipeline = "off";
  fake = await startFakeHerdr(d.sb.env.JOYRIDE_HERDR_SOCKET);
  await assertSandboxed(d.sb.env);
  await d.start();
  await waitFor(() => d.ctx.service("herdr").connected(), 5000);
});
afterAll(async () => { await d?.stop(); await fake?.stop(); });

it("starts in the idea's repo with current goal, notes, public artifact links and configured permissions, then files it", async () => {
  const missions = d.ctx.service<MissionsService>("missions");
  const m = missions.create({ id: "csv-here", title: "CSV totals", goal: "Export a totals row.", repos: [FIXTURE_REPOS.alpha] });
  const report = path.join(d.sb.dir, "csv-spec.md"); fs.writeFileSync(report, "CSV specification");
  const artifact = (await d.req("POST", "/api/artifacts", { title: "CSV specification", local_source: report, mission: m.id, kind: "report" })).body;
  expect(artifact.id).toBeTruthy();
  const secret = (await d.req("POST", "/api/artifacts", { title: "Private review", url: "https://example.com/private-review", mission: m.id })).body;
  // Authored private flag, through the same store used by artifact registry reads.
  const file = path.join(d.sb.env.JOYRIDE_HOME, "artifacts", `${secret.id}.md`);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('id:', 'private: true\nid:'));
  missions.save({ ...m, goal: "Export totals once at the end." });
  d.ctx.config.workers.permission_mode = "bypassPermissions";
  const r = await launch({ kind: "idea", id: m.id });
  expect(r.body.status).toBe("sent");
  const id = r.body.result.session.slice(7);
  const start = fake.calls.filter(c => c.method === "agent.start").at(-1);
  expect(start?.params.args).toEqual(["--session-id", id, "--permission-mode", "bypassPermissions"]);
  expect(fake.prompts.at(-1)?.text).toContain("Export totals once at the end.");
  expect(fake.prompts.at(-1)?.text).toContain("joyride notes --idea csv-here");
  expect(fake.prompts.at(-1)?.text).toContain(path.join(d.sb.env.JOYRIDE_RUNTIME, "blobs", artifact.snapshot_blob));
  expect(fake.prompts.at(-1)?.text).toContain("Write any report to a file and register it with joyride map link.");
  expect(fake.prompts.at(-1)?.text).not.toContain("private-review");
  expect(missions.missionOfSession(r.body.result.session)).toBe(m.id);
  const w = await waitFor(() => { const w = d.ctx.service("workers").get(r.body.result.worker); return w?.session === r.body.result.session ? w : null; }, 5000);
  expect(w).toMatchObject({ cwd: FIXTURE_REPOS.alpha, session: r.body.result.session, mission: m.id, owner: { tier: "watched" }, helm: { by: "firstmate" } });
});

it("uses the project checkout for a repo-less idea and files a group session into its group", async () => {
  d.ctx.config.workers.permission_mode = "acceptEdits";
  const m = d.ctx.service<MissionsService>("missions").create({ id: "repo-less", title: "Plan the launch", goal: "Plan a small launch." });
  const r = await launch({ kind: "idea", id: m.id });
  expect(r.body.status).toBe("sent");
  expect(fake.calls.filter(c => c.method === "workspace.create").at(-1)?.params.cwd).toBe(d.sb.env.JOYRIDE_HOME);
  const l = d.ctx.service<LensesService>("lenses").save({ id: "reporting-here", title: "Reporting", missions: ["csv-here"] });
  const group = await launch({ kind: "group", id: l.id });
  expect(group.body.status).toBe("sent");
  expect(d.ctx.service<LensesService>("lenses").get(l.id)?.sessions).toContain(group.body.result.session);
  expect(fake.prompts.at(-1)?.text).toContain("joyride notes --group reporting-here");
  expect(fake.calls.filter(c => c.method === "agent.start").at(-1)?.params.args.slice(-2)).toEqual(["--permission-mode", "acceptEdits"]);
});

it("refuses missing context or an unreachable runtime without filing a phantom session", async () => {
  expect((await launch({ kind: "idea", id: "missing" })).body).toMatchObject({ status: "failed", error: expect.stringContaining("no longer exists") });
  expect((await launch({ kind: "group", id: "missing" })).body.status).toBe("failed");
  expect((await launch({ kind: "project", title: "Broken", cwd: "/no/such/project" })).body.error).toContain("does not exist");
  expect((await launch({ kind: "anything" })).body.status).toBe("failed");
  const before = d.ctx.service<MissionsService>("missions").get("csv-here")?.sessions;
  fake.failNext("tab.create", "test_offline", "Runtime unavailable");
  expect((await launch({ kind: "idea", id: "csv-here" })).body.status).toBe("failed");
  expect(d.ctx.service<MissionsService>("missions").get("csv-here")?.sessions).toEqual(before);
});

describe("the former open dive is an ordinary watched session", () => {
  it("keeps its native transcript and worker visible, steerable by Firstmate, in the feed and event log", async () => {
    const id = "a4947948-be11-4c58-94b4-76b5c5e06db0";
    const cwd = FIXTURE_REPOS.alpha;
    const dir = path.join(d.sb.env.JOYRIDE_CLAUDE_DIR, "projects", "session-here"); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), [
      { type: "user", sessionId: id, cwd, timestamp: new Date().toISOString(), message: { role: "user", content: "Review the map" } },
      { type: "assistant", sessionId: id, cwd, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "The transcript stays." }] } },
    ].map(x => JSON.stringify(x)).join("\n") + "\n");
    await d.ctx.service("sessions").reindex();
    const p = fake.addPane({ cwd, agent: "claude", agent_status: "idle", title: "Former research session", agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: id } });
    const worker = `local:${p.pane_id}`;
    await waitFor(() => d.ctx.service("workers").get(worker), 5000);
    expect((await d.req("GET", `/api/sessions/${encodeURIComponent(`claude:${id}`)}`)).status).toBe(200);
    expect(((await d.ctx.service("sessions").transcript(`claude:${id}`, { limit: 20 })) ?? []).map((t: { text: string }) => t.text).join("\n")).toContain("The transcript stays.");
    await waitFor(async () => (await d.req("GET", "/api/fleet")).body.members.some((m: { worker: string }) => m.worker === worker));
    const fleet = (await d.req("GET", "/api/fleet")).body;
    expect(fleet.members.find((m: { worker: string }) => m.worker === worker)).toMatchObject({ tier: "watched", session: `claude:${id}`, helm: { by: "firstmate" } });
    const steer = await d.req("POST", "/api/fleet/steer", { worker, text: "Continue the review" });
    expect(steer.body).toMatchObject({ status: "sent", origin: "firstmate" });
    expect(fake.prompts.at(-1)).toMatchObject({ target: p.pane_id, text: "Continue the review" });
    d.tailer.drain();
    expect(d.ctx.db.prepare("SELECT count(*) AS n FROM events WHERE source = 'intent' AND type = 'intent.sent' AND json_extract(json, '$.data.id') = ?").get(steer.body.id)).toMatchObject({ n: 1 });
    fake.setStatus(p.pane_id, "blocked");
    await waitFor(async () => (await d.req("GET", "/api/fleet/events")).body.events.some((e: { worker: string }) => e.worker === worker), 5000);
    expect((await d.req("POST", "/api/intents", { kind: "start_dive", target: "csv-here" })).status).toBe(400);
  });
});
