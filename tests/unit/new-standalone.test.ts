import { matchLaunchThread } from "../../src/modules/live/launch-identity.ts";
import type { CodexThread } from "../../src/modules/sessions/codex.ts";
import Database from "better-sqlite3";
import type { SessionsService } from "../../src/modules/sessions/types.ts";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { sandboxDaemon } from "../sandbox.ts";
import { classifyNew } from "../../src/modules/new/classify.ts";
import { standaloneOffer } from "../../src/shared/standalone-plan.ts";
import { Config } from "../../src/shared/schema.ts";
import { newContext, newWorld } from "../fixtures/new-world.ts";
import { startFakeHerdr, waitFor, assertSandboxed } from "../fixtures/fake-herdr.ts";
import { newModelAccount } from "../../src/core/new-models.ts";

let d: Awaited<ReturnType<typeof sandboxDaemon>>;
let fake: Awaited<ReturnType<typeof startFakeHerdr>>;
beforeAll(async () => {
  d = await sandboxDaemon("new-standalone", ["missions", "notes", "sessions", "live", "system", "new"]);
  fake = await startFakeHerdr(d.sb.env.JOYRIDE_HERDR_SOCKET);
  await assertSandboxed(d.sb.env);
  await d.start();
  await waitFor(() => d.ctx.service("herdr").connected(), 5000);
});
afterAll(async () => { await d.stop(); await fake.stop(); });

describe("standalone New", () => {
  it("protects explicit standalone and deep-work intent from unavailable or mistaken judges", async () => {
    for (const text of ["Start my own session for deep work", "Start a standalone session to triage Firstmate", "Start a task without Firstmate", "Open a session without Firstmate", "Start deep work in my own group", "Firstmate is down. Start a repo session to triage it."]) {
      const judge = vi.fn(async () => { throw new Error("offline"); });
      expect((await classifyNew(text, newContext, newWorld, judge)).candidate.route).toBe("standalone");
      expect(judge).not.toHaveBeenCalled();
    }
    expect((await classifyNew("Note: start a standalone session tomorrow", newContext, newWorld)).candidate.route).toBe("deterministic");
  });
  it("resolves explicit own-group and contextual existing-group placement without guessing repos", () => {
    const model = Config.parse({}).new_models.standalone;
    expect(standaloneOffer("Start my own session in my own group called Triage in repo alpha", newContext, newWorld, model)).toMatchObject({ cwd: null, placement: { kind: "new", title: "Triage" } });
    expect(standaloneOffer("Start my own session join group Missing", newContext, newWorld, model).placement).toBeNull();
    const c = { ...newContext, place: { kind: "idea", id: "build-joyride", title: "Build Joyride" } } satisfies typeof newContext;
    expect(standaloneOffer("Start my own session for deep work", c, newWorld, model)).toMatchObject({ cwd: "/r/joyride", placement: { kind: "group", id: "core" } });
    expect(standaloneOffer("Start a standalone session in repo /repo using codex luna on account codex-main", c, newWorld, model).model).toMatchObject({ backend: "codex", model: "gpt-6-luna", account: "codex-main" });
    expect(standaloneOffer("Start my own session join Core group: use model gpt-5.6-luna with high effort", c, newWorld, model)).toMatchObject({ cwd: "/r/joyride", placement: { kind: "group", id: "core" }, model: { model: "gpt-5.6-luna", effort: "high" } });
    expect(standaloneOffer("Start my own session using claude opus", c, newWorld, model).model).toMatchObject({ backend: "claude", model: "opus" });
  });
  it("returns a supported choice before any launch when repo or group is missing", async () => {
    const result = await d.req("POST", "/api/new", { request: "standalone-choice", text: "Start my own session join group Missing", context: newContext });
    expect(result.body).toMatchObject({ route: "standalone", state: "choose", worker: null });
    expect(result.body.standalone.groups).toEqual([]);
  });
  it("starts a user-owned Codex session in its own canvas group with stable retries", async () => {
    const cwd = path.join(d.sb.dir, "project"); fs.mkdirSync(cwd);
    const input = { request: "standalone-launch", text: `Start a standalone session in repo ${cwd} in my own group called Recovery: inspect the repo`, context: newContext };
    const result = await d.req("POST", "/api/new", input);
    expect(result.body, result.body.message).toMatchObject({ route: "standalone", state: "done", session: expect.stringMatching(/^codex:/), launch: { model: "gpt-6-luna", backend: "codex" } });
    const groups = (await d.req("GET", "/api/missions/map")).body.groups;
    const group = groups.find((g: { title: string }) => g.title === "Recovery");
    expect(group.sessions).toContain(result.body.session);
    expect((await d.req("POST", "/api/new", input)).body.worker).toBe(result.body.worker);
    expect((await d.req("GET", "/api/missions/map")).body.groups.filter((g: { title: string }) => g.title === "Recovery")).toHaveLength(1);
    expect(fake.calls.find(c => c.method === "agent.start" && c.params.args.includes("gpt-6-luna"))).toBeTruthy();
    const create = fake.calls.filter(c => c.method === "workspace.create").at(-1);
    expect(create?.params.env.FM_TASK_ID).toBe("");
    expect(create?.params.env.CLAUDE_SESSION_ID).toBe("");
    expect(create?.params.env.JOYRIDE_NEW_JOB).toBe("");
    const joined = await d.req("POST", "/api/new", { request: "standalone-join", text: `Start my own session in repo ${cwd} join group Recovery: deep work`, context: newContext });
    expect(joined.body, joined.body.message).toMatchObject({ route: "standalone", state: "done", landing: { id: group.id } });
    expect((await d.req("GET", "/api/missions/map")).body.groups.find((g: { id: string }) => g.id === group.id).sessions).toContain(joined.body.session);
  });
  it("acquires Luna defaults without replacing explicit settings or other role defaults", async () => {
    const old = Config.parse({ llm: { default: { backend: "claude", model: "opus" } } });
    expect(old.new_models.small_job.model).toBe("gpt-6-luna");
    expect(old.llm.default.model).toBe("opus");
    expect(Config.parse({ new_models: { small_job: { backend: "claude", model: "haiku", account: "claude-code" } } }).new_models.small_job.model).toBe("haiku");
    const saved = await d.req("PUT", "/api/system/config", { new_models: { standalone: { backend: "codex", model: "gpt-5.6-luna", account: "codex", effort: "high" } } });
    expect(saved.status).toBe(200);
    expect((await d.req("GET", "/api/system/config")).body.config.new_models.standalone).toMatchObject({ model: "gpt-5.6-luna", account: "codex", effort: "high" });
    expect((await d.req("PUT", "/api/system/config", { new_models: { standalone: { backend: "codex", model: "haiku" } } })).body.error).toContain("not supported");
    expect((await d.req("PUT", "/api/system/config", { new_models: { standalone: { backend: "codex", model: "gpt-6-luna", account: "claude-code" } } })).body.error).toContain("runs claude");
  });
  it("identifies a native launch by its unique prompt marker and refuses cwd-only or ambiguous matches", () => {
    const thread: CodexThread = { id: "native", rollout_path: "", created_ms: 10000, updated_ms: 10000, cwd: "/repo", title: "", branch: null, first_user_message: "joyride-launch: unique", tokens_used: 0, model: "gpt-6-luna", archived: false, parent: null, subagent: false };
    expect(matchLaunchThread([thread], "/repo", "joyride-launch: unique", 10000)).toBe("codex:native");
    expect(matchLaunchThread([thread], "/repo", "joyride-launch: other", 10000)).toBeNull();
    expect(matchLaunchThread([thread], "/repo", "joyride-launch: unique", 20000)).toBeNull();
    expect(matchLaunchThread([thread, { ...thread, id: "ambiguous" }], "/repo", "joyride-launch: unique", 10000)).toBeNull();
  });
  it("projects sessions from configured account homes without writing to either external store", async () => {
    const extraCodex = path.join(d.sb.dir, "extra-codex"); fs.mkdirSync(extraCodex);
    const source = path.join(d.sb.env.JOYRIDE_CODEX_DIR, "state_5.sqlite");
    fs.copyFileSync(source, path.join(extraCodex, "state_5.sqlite"));
    const db = new Database(path.join(extraCodex, "state_5.sqlite"));
    db.prepare("UPDATE threads SET id = ? WHERE id = ?").run("private-account-proof", "019a0000-0000-7000-8000-000000000001"); db.close();
    const extraClaude = path.join(d.sb.dir, "extra-claude"), projects = path.join(extraClaude, "projects", "extra"); fs.mkdirSync(projects, { recursive: true });
    const claudeId = "12345678-1234-4234-8234-123456789012";
    fs.writeFileSync(path.join(projects, `${claudeId}.jsonl`), JSON.stringify({ type: "user", sessionId: claudeId, cwd: d.sb.dir, timestamp: new Date().toISOString(), message: { role: "user", content: "Private Claude account proof" } }) + "\n");
    const before = fs.readFileSync(path.join(extraCodex, "state_5.sqlite"));
    const previous = d.ctx.config.usage;
    d.ctx.config.usage = { accounts: [{ provider: "codex", home: extraCodex }, { provider: "claude", home: extraClaude }] };
    const sessions = d.ctx.service<SessionsService>("sessions");
    await sessions.reindex();
    expect(sessions.get("codex:private-account-proof")).toMatchObject({ source: "codex" });
    expect(sessions.get(`claude:${claudeId}`)).toMatchObject({ source: "claude", first_prompt: "Private Claude account proof" });
    expect(fs.readFileSync(path.join(extraCodex, "state_5.sqlite"))).toEqual(before);
    d.ctx.config.usage = previous;
    await sessions.reindex();
  });
  it("uses the selected account catalog and refuses its unsupported models and effort", () => {
    const home = path.join(d.sb.dir, "pinned-account"); fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-6-luna", supported_reasoning_levels: [{ effort: "low" }] }] }));
    const cfg = Config.parse({ usage: { accounts: [{ id: "pin", provider: "codex", home }] } });
    expect(() => newModelAccount({ backend: "codex", model: "gpt-5.6-luna", account: "pin" }, cfg)).toThrow("not supported");
    expect(() => newModelAccount({ backend: "codex", model: "gpt-6-luna", account: "pin", effort: "max" }, cfg)).toThrow("does not support max");
  });
});
