import { beforeAll, afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { sandboxDaemon } from "../sandbox.ts";
import { startFakeHerdr, waitFor, assertSandboxed, type FakeHerdr } from "../fixtures/fake-herdr.ts";
import type { SessionsService } from "../../src/modules/sessions/types.ts";

let d: Awaited<ReturnType<typeof sandboxDaemon>>, fake: FakeHerdr;
let sessions: SessionsService;
let count = 0;
const old = new Date(Date.now() - 80 * 3600e3).toISOString();
beforeAll(async () => {
  d = await sandboxDaemon("fleet-pruning", ["sessions", "missions", "guard", "live", "attention", "artifacts", "asks", "fleet"]);
  await assertSandboxed(d.sb.env);
  fake = await startFakeHerdr(d.sb.env.JOYRIDE_HERDR_SOCKET, { scenario: "empty" });
  await d.start();
  sessions = d.ctx.service<SessionsService>("sessions");
  await sessions.ready();
});
afterAll(async () => { await d?.stop(); await fake?.stop(); });

async function idle(opts: { cwd?: string } = {}) {
  const id = `abcdef01-0000-4000-8000-${String(++count).padStart(12, "0")}`;
  const cwd = opts.cwd ?? path.join(d.sb.dir, `work-${count}`);
  fs.mkdirSync(cwd, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "work"], { cwd });
  fs.writeFileSync(path.join(cwd, "output.md"), "Learning: keep the handoff.\n");
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=t@t", "commit", "--allow-empty", "-qm", "initial"], { cwd });
  const dir = path.join(d.sb.env.JOYRIDE_CLAUDE_DIR, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  const transcript = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(transcript, [
    { type: "user", uuid: `u-${id}`, sessionId: id, cwd, timestamp: old, message: { role: "user", content: "Write output.md and save what you learned" } },
    { type: "assistant", uuid: `a-${id}`, sessionId: id, cwd, timestamp: old, message: { role: "assistant", content: [{ type: "text", text: "Wrote output.md. Learning: keep context before closing." }, { type: "tool_use", id: "w1", name: "Write", input: { file_path: path.join(cwd, "output.md"), content: "Learning: keep the handoff." } }] } },
  ].map((v) => JSON.stringify(v)).join("\n") + "\n");
  await sessions.reindex({ full: true });
  const pane = fake.addPane({ workspace_id: `wp${count}`, cwd, agent: "claude", agent_status: "idle", title: `Preserve ${count}`, agent_session: { source: "claude", agent: "claude", kind: "id", value: id } });
  const worker = `local:${pane.pane_id}`, key = `claude:${id}`;
  await waitFor(() => d.ctx.service<any>("workers").get(worker)?.session === key, 5000);
  return { worker, pane, key, cwd, transcript };
}

it("dry run lists eligible panes without preserving or closing, then closes only after committed context and output snapshots", async () => {
  const a = await idle();
  const before = fs.readFileSync(a.transcript, "utf8");
  const dry = await d.req("GET", "/api/fleet/prune");
  expect(dry.body.dry_run).toBe(true);
  expect(dry.body.candidates.find((c: any) => c.worker === a.worker), JSON.stringify(dry.body)).toMatchObject({ eligible: true, git: { branch: "work", dirty: true }, shared: 1 });
  expect(fake.panes.has(a.pane.pane_id)).toBe(true);
  const r = await d.req("POST", "/api/fleet/retire", { worker: a.worker });
  expect(r.body, JSON.stringify(r.body)).toMatchObject({ origin: "firstmate", status: "sent", result: { closed: true } });
  expect(fake.panes.has(a.pane.pane_id)).toBe(false);
  const artifact = (await d.req("GET", `/api/artifacts/${r.body.result.artifact}`)).body;
  expect(artifact).toMatchObject({ kind: "session", session: a.key, snapshot_blob: expect.any(String) });
  const saved = JSON.parse(fs.readFileSync(r.body.result.file, "utf8"));
  expect(saved).toMatchObject({ summary: expect.any(String), work_done: expect.stringContaining("output.md"), git: { branch: "work", dirty: true }, resume: { session: a.key, cwd: a.cwd, command: expect.stringContaining("claude --resume") } });
  expect(saved.artifacts).toEqual([expect.objectContaining({ path: path.join(a.cwd, "output.md"), snapshot: expect.any(String) })]);
  expect(saved.learnings).toEqual([{ title: "Keep session context before closing", body: "The transcript and output snapshots let the next turn resume the work." }]);
  expect((await d.req("GET", "/api/memory")).status).toBe(404);
  expect(fs.readFileSync(a.transcript, "utf8")).toBe(before);
  expect(fs.readFileSync(path.join(a.cwd, "output.md"), "utf8")).toBe("Learning: keep the handoff.\n");
  execFileSync("git", ["cat-file", "-e", `HEAD:${path.relative(d.sb.env.JOYRIDE_HOME, r.body.result.file)}`], { cwd: d.sb.env.JOYRIDE_HOME });
  const resume = await d.req("POST", "/api/intents", { kind: "launch_session", target: a.cwd, payload: { agent: "claude", resume: a.key.slice(7), cwd: a.cwd } });
  expect(resume.body.status).toBe("sent");
});

it("refuses a captain helm and a draft; prune proposals appear as approval asks", async () => {
  const a = await idle();
  d.ctx.emit({ source: "live", type: "steer.attributed", data: { worker: a.worker, session: a.key, by: "captain", via: "direct", at: new Date().toISOString() } });
  await waitFor(() => d.ctx.service<any>("workers").get(a.worker)?.helm?.by === "captain", 5000);
  const helm = await d.req("POST", "/api/fleet/retire", { worker: a.worker });
  expect(helm.body.result.refused).toBe("captain_helm");
  expect(fake.panes.has(a.pane.pane_id)).toBe(true);
  const asks = (await d.req("GET", `/api/asks?worker=${encodeURIComponent(a.worker)}&kind=approval`)).body.asks;
  expect(asks).toEqual([expect.objectContaining({ kind: "approval", source: "fleet", answer: { via: "prune", target: expect.any(String) } })]);
  const b = await idle();
  fake.panes.get(b.pane.pane_id)!.input = "unfinished captain draft";
  const draft = await d.req("POST", "/api/fleet/retire", { worker: b.worker });
  expect(draft.body.result.refused).toBe("composer_draft");
  expect(fake.panes.get(b.pane.pane_id)?.input).toBe("unfinished captain draft");
});

it("keeps the pane when any preservation part fails, including a produced file that disappeared", async () => {
  const a = await idle();
  fs.unlinkSync(path.join(a.cwd, "output.md"));
  const r = await d.req("POST", "/api/fleet/retire", { worker: a.worker });
  expect(r.body.result.refused).toBe("preserve_failed");
  expect(fake.panes.has(a.pane.pane_id)).toBe(true);
  expect((await d.req("GET", `/api/asks?worker=${encodeURIComponent(a.worker)}`)).body.asks.some((a: any) => a.kind === "approval" && /Preserve and close failed/.test(a.question))).toBe(true);
});

it("expires prune asks after 14 days and archives old unlinked sessions without deleting transcripts", async () => {
  const a = await idle();
  const p = (await d.req("POST", "/api/fleet/propose-prune", { worker: a.worker, why: "This pane has finished its work." })).body;
  expect(Date.parse(p.expires) - Date.parse(p.created)).toBeCloseTo(14 * 864e5, -3);
  const { kvGet, kvSet } = await import("../../src/core/db.ts");
  const ps = kvGet<any[]>(d.ctx.db, "fleet:prunes", []);
  kvSet(d.ctx.db, "fleet:prunes", ps.map((x) => x.id === p.id ? { ...x, expires: old } : x));
  d.ctx.service<any>("fleet").housekeeping();
  expect((await d.req("GET", "/api/asks")).body.asks.some((x: any) => x.id === p.id)).toBe(false);
  expect(d.ctx.service<any>("fleet").proposals().find((x: any) => x.id === p.id).status).toBe("expired");
});

it("never retires crew, excluded workers or control workers", async () => {
  const a = await idle();
  const w = d.ctx.service<any>("workers").get(a.worker);
  const { createPruning } = await import("../../src/modules/fleet/pruning.ts");
  const { DEFAULT_POLICY } = await import("../../src/modules/fleet/policy.ts");
  const existing = d.ctx.services.get("workers");
  for (const tier of ["crew", "excluded", "control"]) {
    d.ctx.services.set("workers", { ...existing, get: () => ({ ...w, owner: { tier, task: "t", via: null } }), list: () => [{ ...w, owner: { tier, task: "t", via: null } }] });
    createPruning(d.ctx, () => DEFAULT_POLICY, () => null);
    const r = await d.req("POST", "/api/intents", { kind: "retire_worker", target: a.worker, origin: "firstmate" });
    expect(r.body.result.refused).toBe(tier);
    expect(fake.panes.has(a.pane.pane_id)).toBe(true);
  }
  d.ctx.services.set("workers", existing);
});

it("refuses if the model fails or the captain takes the helm during preservation", async () => {
  const { registerLlmFake } = await import("../../src/core/fakes.ts");
  const { initPreservationFake } = await import("../../src/modules/fleet/preserve.ts");
  const a = await idle();
  registerLlmFake("session_preserve", () => { throw new Error("model unavailable"); });
  const failed = await d.req("POST", "/api/fleet/retire", { worker: a.worker });
  expect(failed.body.result.refused).toBe("preserve_failed");
  expect(fake.panes.has(a.pane.pane_id)).toBe(true);
  initPreservationFake();
  const b = await idle();
  registerLlmFake("session_preserve", () => {
    d.ctx.bus.emitEvent({ id: "race-helm", ts: new Date().toISOString(), source: "live", type: "steer.attributed", data: { worker: b.worker, session: b.key, by: "captain", via: "direct", at: new Date().toISOString() } });
    return { summary: "Saved", work_done: "Wrote output", resume_context: "Continue", learnings: [], artifacts: [] };
  });
  const raced = await d.req("POST", "/api/fleet/retire", { worker: b.worker });
  expect(raced.body.result.refused).toBe("captain_helm");
  expect(fake.panes.has(b.pane.pane_id)).toBe(true);
  initPreservationFake();
});

it("expires mission proposals and archives their sessions, then archives 30-day unlinked history", async () => {
  const a = await idle();
  fake.closePane(a.pane.pane_id);
  await waitFor(() => !d.ctx.service<any>("workers").get(a.worker), 5000);
  const directory = path.join(d.sb.env.JOYRIDE_RUNTIME, "proposals", "missions");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "expired-proposal.json");
  fs.writeFileSync(file, JSON.stringify({ id: "expired-proposal", title: "Old proposed work", goal: "Work", repos: [a.cwd], branches: [], sessions: [{ source: "claude", id: a.key.slice(7) }], first_ts: old, last_ts: old, created: new Date(Date.now() - 15 * 864e5).toISOString(), status: "pending" }));
  d.ctx.service<any>("missions").pruneHistory({ proposal_days: 14, archive_days: 30 });
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ status: "expired", decision_reason: "expired" });
  const mission = d.ctx.service<any>("missions").get(d.ctx.service<any>("missions").missionOfSession(a.key));
  expect(mission).toMatchObject({ archive: true });
  expect(mission.sessions).toContainEqual({ source: "claude", id: a.key.slice(7) });
  expect(fs.existsSync(a.transcript)).toBe(true);
  const b = await idle();
  fake.closePane(b.pane.pane_id);
  await waitFor(() => !d.ctx.service<any>("workers").get(b.worker), 5000);
  fs.writeFileSync(b.transcript, fs.readFileSync(b.transcript, "utf8").replaceAll(old, new Date(Date.now() - 31 * 864e5).toISOString()));
  await sessions.reindex({ full: true });
  d.ctx.service<any>("missions").pruneHistory({ proposal_days: 14, archive_days: 30 });
  expect(d.ctx.service<any>("missions").get(d.ctx.service<any>("missions").missionOfSession(b.key)).archive).toBe(true);
  expect(fs.existsSync(b.transcript)).toBe(true);
});

it("allows preservation commits when the watched session works in Joyride's data repo", async () => {
  const a = await idle({ cwd: d.sb.env.JOYRIDE_HOME });
  const r = await d.req("POST", "/api/fleet/retire", { worker: a.worker });
  expect(r.body, JSON.stringify(r.body)).toMatchObject({ status: "sent", result: { closed: true } });
  expect(fake.panes.has(a.pane.pane_id)).toBe(false);
  expect(fs.readFileSync(path.join(a.cwd, "output.md"), "utf8")).toBe("Learning: keep the handoff.\n");
});

it("refuses recent or busy sessions and open attention or guard requests", async () => {
  const a = await idle();
  fake.setStatus(a.pane.pane_id, "working");
  await waitFor(() => d.ctx.service<any>("workers").get(a.worker)?.status === "working", 5000);
  expect((await d.req("POST", "/api/fleet/retire", { worker: a.worker })).body.result.refused).toBe("not_eligible");
  fake.setStatus(a.pane.pane_id, "idle");
  await waitFor(() => d.ctx.service<any>("workers").get(a.worker)?.status === "idle", 5000);
  const guard = d.ctx.services.get("guard");
  d.ctx.services.set("guard", { ...guard, pending: () => [{ session: a.key }] });
  const gated = await d.req("POST", "/api/fleet/retire", { worker: a.worker });
  expect(gated.body.error).toContain("pending guard request");
  d.ctx.services.set("guard", guard);
  const attention = d.ctx.services.get("attention");
  d.ctx.services.set("attention", { ...attention, list: () => [{ worker: a.worker, session: a.key }] });
  const pending = await d.req("POST", "/api/fleet/retire", { worker: a.worker });
  expect(pending.body.error).toContain("open attention");
  d.ctx.services.set("attention", attention);
  fs.writeFileSync(a.transcript, fs.readFileSync(a.transcript, "utf8").replaceAll(old, new Date().toISOString()));
  await sessions.reindex({ full: true });
  const recent = await d.req("POST", "/api/fleet/retire", { worker: a.worker });
  expect(recent.body.error).toContain("idle less than 72 hours");
  expect(fake.panes.has(a.pane.pane_id)).toBe(true);
});

it("answers prune approvals through the captain-only ask channel and replays without closing twice", async () => {
  const a = await idle();
  const p = (await d.req("POST", "/api/fleet/propose-prune", { worker: a.worker, why: "Save and retire this completed session." })).body;
  const forbidden = await d.req("POST", "/api/intents", { kind: "answer_ask", target: p.id, origin: "firstmate", payload: { answer: "approve" } });
  expect(forbidden.body.result.refused).toBe("captain_only");
  const answered = await d.req("POST", "/api/intents", { kind: "answer_ask", target: p.id, payload: { answer: "approve" } });
  expect(answered.body, JSON.stringify(answered.body)).toMatchObject({ status: "sent", result: { replay: false, delivery: { status: "sent", origin: "captain", result: { closed: true } } } });
  const replay = await d.req("POST", "/api/intents", { kind: "answer_ask", target: p.id, payload: { answer: "approve" } });
  expect(replay.body).toMatchObject({ status: "sent", result: { replay: true } });
  expect(fake.calls.filter((c) => c.method === "pane.close" && c.params.pane_id === a.pane.pane_id)).toHaveLength(1);
  const b = await idle();
  const reject = (await d.req("POST", "/api/fleet/propose-prune", { worker: b.worker, why: "Keep this work available." })).body;
  expect((await d.req("POST", "/api/intents", { kind: "answer_ask", target: reject.id, payload: { answer: "Keep the pane open" } })).body.status).toBe("sent");
  expect(fake.panes.has(b.pane.pane_id)).toBe(true);
  expect((await d.req("GET", "/api/asks")).body.asks.some((a: any) => a.id === reject.id)).toBe(false);
});

it("refuses when the live pane changes sessions during preservation even before the projection catches up", async () => {
  const a = await idle();
  const { registerLlmFake } = await import("../../src/core/fakes.ts");
  const { initPreservationFake } = await import("../../src/modules/fleet/preserve.ts");
  registerLlmFake("session_preserve", () => {
    fake.panes.get(a.pane.pane_id)!.agent_session = { source: "claude", agent: "claude", kind: "id", value: "different-session" };
    return { summary: "Saved", work_done: "Output", resume_context: "Continue", learnings: [], artifacts: [] };
  });
  const r = await d.req("POST", "/api/fleet/retire", { worker: a.worker });
  expect(r.body.result.refused).toBe("changed");
  expect(fake.panes.has(a.pane.pane_id)).toBe(true);
  initPreservationFake();
});

it("verifies Claude's current foreground registry when Herdr has no native session reference", async () => {
  const a = await idle();
  const file = path.join(d.sb.env.JOYRIDE_CLAUDE_DIR, "sessions", `${process.pid}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const registry = { pid: process.pid, sessionId: a.key.slice(7), cwd: a.cwd, status: "idle", updatedAt: Date.now() };
  fs.writeFileSync(file, JSON.stringify(registry));
  const p = fake.panes.get(a.pane.pane_id)!;
  p.agent_session = null;
  p.pids = [process.pid];
  try {
    const r = await d.req("POST", "/api/fleet/retire", { worker: a.worker });
    expect(r.body, JSON.stringify(r.body)).toMatchObject({ status: "sent", result: { closed: true } });
    expect(fake.calls.some((c) => c.method === "pane.process_info" && c.params.pane_id === a.pane.pane_id)).toBe(true);
  } finally { fs.rmSync(file, { force: true }); }
});

it("refuses a changed foreground registry even while hooks still identify the old session", async () => {
  const a = await idle();
  const file = path.join(d.sb.env.JOYRIDE_CLAUDE_DIR, "sessions", `${process.pid}.json`);
  const registry = { pid: process.pid, sessionId: a.key.slice(7), cwd: a.cwd, status: "idle", updatedAt: Date.now() };
  fs.writeFileSync(file, JSON.stringify(registry));
  const p = fake.panes.get(a.pane.pane_id)!;
  p.agent_session = null;
  p.pids = [process.pid];
  const { registerLlmFake } = await import("../../src/core/fakes.ts");
  const { initPreservationFake } = await import("../../src/modules/fleet/preserve.ts");
  registerLlmFake("session_preserve", () => {
    fs.writeFileSync(file, JSON.stringify({ ...registry, sessionId: "different-session" }));
    return { summary: "Saved", work_done: "Output", resume_context: "Continue", learnings: [], artifacts: [] };
  });
  try {
    const r = await d.req("POST", "/api/fleet/retire", { worker: a.worker });
    expect(r.body.result.refused).toBe("changed");
    expect(fake.panes.has(a.pane.pane_id)).toBe(true);
  } finally { fs.rmSync(file, { force: true }); initPreservationFake(); }
});

it("keeps the pane and raises an ask when an output exceeds the snapshot size limit", async () => {
  const a = await idle();
  fs.truncateSync(path.join(a.cwd, "output.md"), 26 * 1024 * 1024);
  const r = await d.req("POST", "/api/fleet/retire", { worker: a.worker });
  expect(r.body.result.refused).toBe("preserve_failed");
  expect(r.body.error).toContain("25 MiB");
  expect(fake.panes.has(a.pane.pane_id)).toBe(true);
  expect((await d.req("GET", `/api/asks?worker=${encodeURIComponent(a.worker)}`)).body.asks.some((a: any) => a.kind === "approval")).toBe(true);
});
