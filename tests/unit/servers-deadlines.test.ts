import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sandboxDaemon } from "../sandbox.ts";
import { assertSandboxed, startFakeHerdr, waitFor, type FakeHerdr } from "../fixtures/fake-herdr.ts";
import { ServerDefinition } from "../../src/shared/servers.ts";
import type { ServersService } from "../../src/modules/servers/service.ts";
import { readJournal } from "../../src/modules/servers/store.ts";
import { paths } from "../../src/shared/paths.ts";

describe("review server lifecycle replies", () => {
  let d: Awaited<ReturnType<typeof sandboxDaemon>>, fake: FakeHerdr;
  beforeAll(async () => {
    d = await sandboxDaemon("servers-deadlines", ["live", "servers"]);
    await assertSandboxed(d.sb.env);
    fake = await startFakeHerdr(d.sb.env.JOYRIDE_HERDR_SOCKET, { scenario: "empty" });
    await d.start();
    await waitFor(() => d.ctx.service("herdr").connected());
  });
  afterAll(async () => { await d.stop(); await fake.stop(); });

  const create = async (id: string) => {
    const g = ServerDefinition.parse({ id, name: "Dossier review", project: "Original project", change: "Existing data", members: [
      { id: "backend", name: "Backend", command: "node app.mjs", cwd: paths.root, ports: [] },
    ] });
    expect((await d.req("POST", "/api/servers", g)).status).toBe(200);
    return { action: "start", purpose: "review", request: `${id}-request` };
  };
  const state = async (id: string) => {
    const groups = await d.ctx.service<ServersService>("servers").list();
    const group = groups.find(g => g.id === id);
    if (!group) throw new Error("Missing test group");
    return group;
  };
  const mutations = () => fake.calls.filter(c => ["workspace.create", "pane.send_input", "pane.close"].includes(c.method));

  it("accepts delayed workspace creation and reuses a completed request without duplicate submission", async () => {
    const id = "delayed-create";
    const action = await create(id);
    fake.delayNextReply("workspace.create", 1800);
    fake.delayNextReply("pane.send_input", 1800);
    const result = await d.req("POST", `/api/servers/${id}/action`, action);
    expect(result.body.error).toBeUndefined();
    expect(result.status).toBe(200);
    const run = readJournal().runs[`${id}/backend`];
    expect(run?.phase).toBe("launched");
    expect(run?.terminal).toBeTruthy();
    const calls = mutations();
    expect(calls.map(c => c.method)).toEqual(["workspace.create", "pane.send_input"]);
    expect((await d.req("POST", `/api/servers/${id}/action`, action)).status).toBe(200);
    expect(mutations()).toEqual(calls);
    expect(readJournal().runs[`${id}/backend`]?.nonce).toBe(run?.nonce);
  });

  it("recovers the exact prepared workspace after a lost create reply without replaying a mutation", async () => {
    const id = "lost-create";
    const action = await create(id);
    const before = mutations().length;
    fake.dropNextReply("workspace.create");
    const result = await d.req("POST", `/api/servers/${id}/action`, action);
    expect(result.status).toBe(409);
    expect(result.body.error).toContain("workspace.create");
    const run = readJournal().runs[`${id}/backend`];
    expect(run?.phase).toBe("prepared");
    expect(run?.pane).toBeNull();
    fake.delayNextReply("workspace.list", 1800);
    const recovered = await state(id);
    expect(recovered.state).toBe("unknown");
    expect(recovered.instances[0]?.run?.nonce).toBe(run?.nonce);
    expect(recovered.instances[0]?.run?.pane).toBeTruthy();
    expect(recovered.instances[0]?.run?.terminal).toBeTruthy();
    expect(recovered.instances[0]?.run?.phase).toBe("prepared");
    expect((await d.req("POST", `/api/servers/${id}/action`, action)).status).toBe(409);
    expect(mutations().slice(before).map(c => c.method)).toEqual(["workspace.create"]);
    expect(fake.typed.filter(t => t.target === recovered.instances[0]?.run?.pane)).toHaveLength(0);
  });

  it("never sends the command again after its acknowledgement is lost", async () => {
    const id = "lost-input";
    const action = await create(id);
    const before = mutations().length;
    fake.dropNextReply("pane.send_input");
    const result = await d.req("POST", `/api/servers/${id}/action`, action);
    expect(result.status).toBe(409);
    expect(result.body.error).toContain("pane.send_input");
    const run = readJournal().runs[`${id}/backend`];
    expect(run?.phase).toBe("launched");
    expect((await state(id)).state).toBe("unknown");
    expect((await d.req("POST", `/api/servers/${id}/action`, action)).status).toBe(409);
    expect(readJournal().runs[`${id}/backend`]?.nonce).toBe(run?.nonce);
    expect(mutations().slice(before).map(c => c.method)).toEqual(["workspace.create", "pane.send_input"]);
    expect(fake.typed.filter(t => t.target === run?.pane)).toHaveLength(1);
  });
});
