import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { sandboxDaemon } from "../sandbox.ts";
import type { NewReceipt, ScreenContext } from "../../src/shared/freeform.ts";
import type { NewWorld } from "../../src/shared/freeform-plan.ts";

const context: ScreenContext = { route: "map", view: { s: 1, tx: 0, ty: 0 }, place: null, focused: null, hovered: null, selected: null, visible: [] };
let d: Awaited<ReturnType<typeof sandboxDaemon>>;
beforeAll(async () => { d = await sandboxDaemon("new-freeform", ["missions", "notes", "live", "new"]); });
afterAll(async () => { await d.stop(); });

describe("New owner execution", () => {
  it("saves a note immediately, retries without duplicates, and Undo restores exact files", async () => {
    const input = { request: "new-note-1", text: "note: staging keys rotate on Fridays", context };
    const r = await d.req("POST", "/api/new", input);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ route: "deterministic", state: "done", animation: "note", undo: true });
    const receipt: NewReceipt = r.body;
    const notes = (await d.req("GET", "/api/notes?global=1")).body;
    expect(notes.filter((n: { bullets: string[] }) => n.bullets.includes("staging keys rotate on Fridays"))).toHaveLength(1);
    expect((await d.req("POST", "/api/new", input)).body.id).toBe(receipt.id);
    expect((await d.req("POST", `/api/new/${receipt.id}/undo`, {})).body.state).toBe("undone");
    expect((await d.req("GET", "/api/notes?global=1")).body.some((n: { bullets: string[] }) => n.bullets.includes("staging keys rotate on Fridays"))).toBe(false);
  });
  it("refuses an Undo that would overwrite a later edit", async () => {
    const r = await d.req("POST", "/api/new", { request: "new-conflict", text: "note: keep later edits", context });
    expect(r.body.state).toBe("done");
    const id = r.body.landing.id;
    await d.req("PUT", `/api/notes/${id}`, { text: "later authored edit" });
    const undo = await d.req("POST", "/api/new/new-conflict/undo", {});
    expect(undo.status).toBe(409);
    expect(undo.body.error).toContain("nothing was restored");
    expect((await d.req("GET", `/api/notes/${id}`)).body.bullets).toEqual(["later authored edit"]);
  });
  it("sends UI commands back to the submitting browser and records Undo", async () => {
    const r = await d.req("POST", "/api/new", { request: "new-ui", text: "Go to Board", context });
    expect(r.body).toMatchObject({ route: "deterministic", state: "done", ui: [{ action: "navigate", path: "board" }], undo: true });
  });
  it("refuses the same id carrying different words while another request is running", async () => {
    const [one, two] = await Promise.all([d.req("POST", "/api/new", { request: "new-concurrent", text: "Note: first words", context }), d.req("POST", "/api/new", { request: "new-concurrent", text: "Note: different words", context })]);
    expect(one.body.state).toBe("done"); expect(two.status).toBe(400);
    expect(two.body.error).toContain("different words");
    expect((await d.req("GET", "/api/notes?global=1")).body.some((n: { bullets: string[] }) => n.bullets.includes("different words"))).toBe(false);
  });
  it("preserves unknown input and context on the agent route", async () => {
    const svc = d.ctx.service<{ classify: (text: string, context: ScreenContext) => Promise<{ candidate: { route: string } }> }>("new");
    const r = await svc.classify("Link the artifact about exports here", context);
    expect(r.candidate.route).toBe("agent");
  });
  it("keeps the job's identity when its owner action launches another session", async () => {
    const intents = d.ctx.service<{ registerHandler: (kind: string, handler: () => Promise<unknown>) => void }>("intents");
    let launches = 0;
    intents.registerHandler("launch_session", async () => ++launches === 1 ? { worker: "job-worker", session: "claude:job" } : { worker: "result-worker", session: "codex:result" });
    const job = (await d.req("POST", "/api/new", { request: "job-identity", text: "Find an export artifact here", context })).body;
    expect(job).toMatchObject({ route: "agent", state: "running", worker: "job-worker", session: "claude:job" });
    expect((await d.req("POST", `/api/new/jobs/${job.id}/actions`, { request: "launch-result", action: { kind: "intent", intent: "launch_session", target: d.sb.env.JOYRIDE_HOME, payload: { agent: "codex", cwd: d.sb.env.JOYRIDE_HOME } } })).status).toBe(200);
    expect((await d.req("GET", `/api/new/${job.id}`)).body).toMatchObject({ worker: "job-worker", session: "claude:job" });
    const mapNote = await d.req("POST", `/api/new/jobs/${job.id}/actions`, { request: "attributed-note", action: { kind: "map", action: "note", args: { text: "Agent map result" }, actor: { kind: "agent", id: "export-job", via: "cli" } } });
    expect(mapNote.body.provenance).toEqual({ type: "agent", ref: "cli:export-job" });
    const apiNote = await d.req("POST", `/api/new/jobs/${job.id}/actions`, { request: "attributed-api-note", action: { kind: "api", method: "POST", path: "/api/notes", body: { text: "Agent API result", global: true } } });
    expect(apiNote.body.provenance).toEqual({ type: "agent", ref: "cli:claude:job" });
    await d.req("POST", `/api/new/jobs/${job.id}/complete`, { message: "Started the requested session." });
    expect((await d.req("POST", `/api/new/${job.id}/undo`, {})).status).toBe(200);
    expect((await d.req("GET", "/api/notes?global=1")).body.some((n: { id: string }) => [mapNote.body.id, apiNote.body.id].includes(n.id))).toBe(false);
  });
});
