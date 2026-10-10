// The helm: Firstmate holds it by default; a steer by the captain takes it until that turn ends plus
// 15 quiet minutes. The rules are tested pure, then end to end through the sandbox daemon, where
// /api/workers carries each worker's helm.
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { FIRSTMATE_HELM, HELM_MAX_HOLD_MS, HELM_QUIET_MS, HelmTracker, helmFor } from "../../src/modules/live/helm";
import { sandboxDaemon } from "../sandbox.ts";
import { startFakeHerdr, waitFor, assertSandboxed, type FakeHerdr } from "../fixtures/fake-herdr.ts";

const t0 = Date.parse("2026-10-05T12:00:00.000Z");
const at = (s: number) => new Date(t0 + s * 1000).toISOString();
const steer = (by: string, s: number, via = "direct", worker = "local:w1:p1", session = "claude:s1"): any =>
  ({ id: "ev", ts: at(s), source: "live", type: "steer.attributed", session: "s1", agent: "claude", data: { worker, session, by, via, at: at(s) } });
const hook = (type: string, s: number, session = "s1"): any => ({ id: "ev", ts: at(s), source: "hook.claude", type, agent: "claude", session, data: {} });
const sent = (origin: string | undefined, s: number, target = "local:w1:p1", kind = "reply"): any =>
  ({ id: "ev", ts: at(s), source: "intent", type: "intent.sent", data: { id: "int_1", kind, target, origin } });
const busy = { status: "working" as const, updated: at(0) };

describe("helm rules", () => {
  it("is Firstmate's until the captain steers", () => {
    const h = new HelmTracker();
    expect(helmFor(h.markOf("local:w1:p1", "claude:s1"), busy, t0)).toEqual(FIRSTMATE_HELM);
    // Firstmate steering never takes the helm, by inbox or by typing.
    expect(h.observe(steer("firstmate", 1, "firstmate-inbox"))).toBe(false);
    expect(h.observe(sent("firstmate", 2))).toBe(false);
    expect(helmFor(h.markOf("local:w1:p1", "claude:s1"), busy, t0 + 3000)).toEqual(FIRSTMATE_HELM);
  });

  it("goes to the captain on a direct steer, holds while the turn runs, and returns 15 quiet minutes after it ends", () => {
    const h = new HelmTracker();
    expect(h.observe(steer("captain", 10))).toBe(true);
    const m = () => h.markOf("local:w1:p1", "claude:s1");
    expect(helmFor(m(), busy, t0 + 60_000)).toEqual({ by: "captain", since: at(10), until: null, via: "direct" });
    expect(h.observe(hook("turn.stop", 300))).toBe(true);
    // A second turn end is not the one that counts.
    expect(h.observe(hook("turn.stop", 400))).toBe(false);
    const until = new Date(t0 + 300_000 + HELM_QUIET_MS).toISOString();
    expect(helmFor(m(), { status: "idle", updated: at(300) }, t0 + 301_000)).toEqual({ by: "captain", since: at(10), until, via: "direct" });
    expect(helmFor(m(), { status: "idle", updated: at(300) }, t0 + 300_000 + HELM_QUIET_MS)).toEqual(FIRSTMATE_HELM);
  });

  it("restarts the count on a later captain steer, and finds the mark by worker or by session", () => {
    const h = new HelmTracker();
    h.observe(steer("captain", 0));
    h.observe(hook("turn.stop", 60));
    h.observe(steer("captain", 600, "joyride-terminal", "local:w1:p1"));
    expect(helmFor(h.markOf("local:w1:p1", null), busy, t0 + 60_000 + HELM_QUIET_MS + 1000)).toMatchObject({ by: "captain", since: at(600), until: null, via: "joyride-terminal" });
    expect(h.markOf("local:other", "claude:s1")?.at).toBe(at(600));
    // An older event (a seed replaying out of order) never replaces a newer mark.
    expect(h.observe(steer("captain", 5))).toBe(false);
  });

  it("gives the helm back on a hand-back, and a steer from before it, arriving late, never takes it again", () => {
    const h = new HelmTracker();
    h.observe(steer("captain", 10));
    const released: any = { id: "ev", ts: at(20), source: "live", type: "helm.released", data: { worker: "local:w1:p1", session: "claude:s1", via: "hand_back", at: at(20) } };
    expect(h.observe(released)).toBe(true);
    expect(helmFor(h.markOf("local:w1:p1", "claude:s1"), busy, t0 + 21_000)).toEqual(FIRSTMATE_HELM);
    expect(h.observe(steer("captain", 15))).toBe(false); // attributed late, but typed before the hand-back
    expect(helmFor(h.markOf("local:w1:p1", "claude:s1"), busy, t0 + 22_000)).toEqual(FIRSTMATE_HELM);
    expect(h.observe(steer("captain", 30))).toBe(true); // a new steer takes it again
    expect(helmFor(h.markOf("local:w1:p1", "claude:s1"), busy, t0 + 31_000).by).toBe("captain");
  });

  it("takes the helm on a captain reply that reached the pane, and reads a worker at rest after it as the turn's end", () => {
    const h = new HelmTracker();
    expect(h.observe(sent(undefined, 0, "local:w9:p1"))).toBe(true); // origin defaults to the captain
    expect(h.observe(sent("captain", 0, "local:w9:p2", "focus"))).toBe(false);
    const m = h.markOf("local:w9:p1", null);
    expect(m).toMatchObject({ at: at(0), via: "joyride-reply" });
    // Codex crewmates send no hooks: Herdr says idle since 2 minutes after the steer.
    expect(helmFor(m, { status: "idle", updated: at(120) }, t0 + 130_000)).toMatchObject({ by: "captain", until: new Date(t0 + 120_000 + HELM_QUIET_MS).toISOString() });
    // Still idle from before the steer: the turn has not visibly started or ended yet.
    expect(helmFor(m, { status: "idle", updated: at(-60) }, t0 + 130_000)).toMatchObject({ by: "captain", until: null });
    // A turn that never visibly ends stops counting after the cap.
    expect(helmFor(m, busy, t0 + HELM_MAX_HOLD_MS + 1000)).toEqual(FIRSTMATE_HELM);
  });
});

describe("helm on /api/workers", () => {
  let d: Awaited<ReturnType<typeof sandboxDaemon>>;
  let fake: FakeHerdr;
  beforeAll(async () => {
    process.env.JOYRIDE_HERDR_POLL_MS = "300";
    d = await sandboxDaemon("fleet-helm", ["live", "fleet"]);
    fake = await startFakeHerdr(d.sb.env.JOYRIDE_HERDR_SOCKET, { scenario: "empty" });
    await assertSandboxed(d.sb.env);
    await d.start();
  });
  afterAll(async () => { await d?.stop(); await fake?.stop(); });

  const workerById = async (id: string) => ((await d.req("GET", "/api/workers")).body as any[]).find((w) => w.id === id);

  it("shows Firstmate at the helm, then the captain after a direct steer, with the release time once the turn ends", async () => {
    const pane = fake.addPane({ workspace_id: "w82", cwd: "/tmp", agent: "claude", agent_status: "idle", title: "Helm target" });
    const session = "bbbbbbbb-0000-4000-8000-0000000000c1";
    const worker = `local:${pane.pane_id}`;
    const emit = (type: string, data: Record<string, unknown> = {}) => d.ctx.emit({ source: "hook.claude", type, session, agent: "claude", cwd: "/tmp", pane: pane.pane_id, data } as any);
    emit("session.start");
    await waitFor(async () => (await workerById(worker))?.session === `claude:${session}`, 5000);
    expect((await workerById(worker)).helm).toEqual({ by: "firstmate", since: null, until: null, via: null });

    emit("prompt.submit", { prompt: "Stop, use the net amounts instead" });
    await waitFor(async () => (await workerById(worker))?.helm?.by === "captain", 5000);
    expect((await workerById(worker)).helm).toMatchObject({ by: "captain", until: null, via: "direct" });

    emit("turn.stop", { last: "Switched to net amounts." });
    await waitFor(async () => Boolean((await workerById(worker))?.helm?.until), 5000);
    const h = (await workerById(worker)).helm;
    expect(Date.parse(h.until) - Date.parse(h.since)).toBeGreaterThanOrEqual(HELM_QUIET_MS);
  });

  it("gives Firstmate's reply no helm, and the captain's reply from Joyride the helm", async () => {
    const pane = fake.addPane({ workspace_id: "w83", cwd: "/tmp", agent: "codex", agent_status: "idle", title: "Codex crewmate, no hooks" });
    const worker = `local:${pane.pane_id}`;
    await waitFor(async () => Boolean(await workerById(worker)), 5000);
    expect((await d.req("POST", "/api/intents", { kind: "reply", target: worker, payload: { text: "Rebase onto main" }, origin: "firstmate" })).body.status).toBe("sent");
    await new Promise((r) => setTimeout(r, 300));
    expect((await workerById(worker)).helm.by).toBe("firstmate");
    expect((await d.req("POST", "/api/intents", { kind: "reply", target: worker, payload: { text: "Actually, wait for me" } })).body.status).toBe("sent");
    await waitFor(async () => (await workerById(worker))?.helm?.by === "captain", 5000);
    expect((await workerById(worker)).helm.via).toBe("joyride-reply");
  });
});
