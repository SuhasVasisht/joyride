// One fleet, end to end through the sandbox daemon and a fake Herdr: the guarded steer path (refused on
// a captain's draft, at the captain's helm, for crew and excluded sessions), the captain's hand-back,
// the guarded prompt answer, the fleet feed and the captain inbox notes the fleet relays.
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { sandboxDaemon } from "../sandbox.ts";
import { startFakeHerdr, waitFor, assertSandboxed, CLAUDE_PERMISSION_MENU, type FakeHerdr } from "../fixtures/fake-herdr.ts";

process.env.JOYRIDE_HERDR_POLL_MS = "300";
process.env.JOYRIDE_FLEET_JOIN_BATCH_MS = "200";

let d: Awaited<ReturnType<typeof sandboxDaemon>>;
let fake: FakeHerdr;
const notes: { id: string; body: string }[] = [];
const crew: { task: string; mission: string | null; machine: string | null; pane: string | null }[] = [];

beforeAll(async () => {
  d = await sandboxDaemon("fleet", ["live", "fleet"]);
  fake = await startFakeHerdr(d.sb.env.JOYRIDE_HERDR_SOCKET, { scenario: "empty", promptFlipMs: 60_000 });
  await assertSandboxed(d.sb.env);
  // Firstmate stands in as a service: its crew records and the captain inbox notes the fleet files.
  d.ctx.services.set("firstmate", {
    crewKeys: () => crew, controlWorker: () => null,
    note: async (id: string, body: string) => { if (!notes.some((n) => n.id === id)) notes.push({ id, body }); return { note: `n${notes.length}`, outcome: "created", announced: true, path: "/x" }; },
  });
  await d.start();
});
afterAll(async () => { await d?.stop(); await fake?.stop(); });

const workers = async () => (await d.req("GET", "/api/workers")).body as any[];
const workerById = async (id: string) => (await workers()).find((w) => w.id === id);
const fleetEvents = async () => (await d.req("GET", "/api/fleet/events?after=0&limit=500")).body.events as any[];

let n = 0;
/** A live Claude Code pane with a session its hooks report, as the captain would have started it. */
async function claudePane(title: string, o: { cwd?: string } = {}) {
  n++;
  const pane = fake.addPane({ workspace_id: `wf${n}`, cwd: o.cwd ?? "/tmp", agent: "claude", agent_status: "idle", title });
  const session = `cccccccc-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const worker = `local:${pane.pane_id}`;
  const hook = (type: string, data: Record<string, unknown> = {}) => d.ctx.emit({ source: "hook.claude", type, session, agent: "claude", cwd: o.cwd ?? "/tmp", pane: pane.pane_id, data } as any);
  hook("session.start");
  await waitFor(async () => (await workerById(worker))?.session === `claude:${session}`, 5000);
  return { pane, worker, session, hook };
}

describe("the guarded steer", () => {
  it("refuses to type over the captain's draft, leaving it as it is", async () => {
    const a = await claudePane("Export totals");
    fake.panes.get(a.pane.pane_id)!.input = "actually use the net amou";
    const r = await d.req("POST", "/api/fleet/steer", { worker: a.worker, text: "Run the export tests serially." });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ kind: "reply", origin: "firstmate", status: "failed", result: { refused: "composer_draft" } });
    expect(r.body.error).toMatch(/holds text \("actually use the net amou"\), most likely the captain's draft/);
    expect(fake.panes.get(a.pane.pane_id)!.input).toBe("actually use the net amou");
    expect(fake.prompts.filter((p) => p.target === a.pane.pane_id)).toEqual([]);
    expect(fake.inputs.filter((i) => i.target === a.pane.pane_id)).toEqual([]); // not even a clearing key
  });

  it("refuses at the captain's helm, and steers once the captain hands it back", async () => {
    const a = await claudePane("Net amounts");
    // The captain types in the pane and presses Enter: a direct steer takes the helm.
    a.hook("prompt.submit", { prompt: "Stop, use the net amounts instead" });
    await waitFor(async () => (await workerById(a.worker))?.helm?.by === "captain", 5000);
    const refused = await d.req("POST", "/api/fleet/steer", { worker: a.worker, text: "Rebase onto main." });
    expect(refused.status).toBe(409);
    expect(refused.body.result).toMatchObject({ refused: "captain_helm", helm: { by: "captain", via: "direct" } });
    // Firstmate can't hand the helm back to itself.
    const self = await d.req("POST", "/api/intents", { kind: "hand_back", target: a.worker, origin: "firstmate" });
    expect(self.body).toMatchObject({ status: "failed", result: { refused: "captain_only" } });
    const back = await d.req("POST", "/api/fleet/hand-back", { worker: a.worker });
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ kind: "hand_back", origin: "captain", status: "sent", result: { worker: a.worker } });
    await waitFor(async () => (await workerById(a.worker)).helm.by === "firstmate");
    const ok = await d.req("POST", "/api/fleet/steer", { worker: a.worker, text: "Rebase onto main." });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ origin: "firstmate", status: "sent" });
    expect(fake.prompts.find((p) => p.target === a.pane.pane_id)?.text).toBe("Rebase onto main.");
    // Firstmate's steer never takes the helm.
    expect((await workerById(a.worker)).helm.by).toBe("firstmate");
    // The feed told Firstmate both helm changes, and the hand-back came with what the captain said.
    await waitFor(async () => (await fleetEvents()).some((e) => e.worker === a.worker && e.type === "helm.firstmate"), 5000);
    const evs = (await fleetEvents()).filter((e) => e.worker === a.worker);
    expect(evs.map((e) => e.type)).toEqual(["helm.captain", "helm.firstmate"]);
    expect(evs[1].data.via).toBe("hand_back");
    await waitFor(() => notes.some((x) => x.id === `fleet-handback-${back.body.id}`), 5000);
    const note = notes.find((x) => x.id === `fleet-handback-${back.body.id}`)!.body;
    expect(note).toContain(`the captain handed back the helm of ${a.worker}`);
    expect(note).toContain("- Stop, use the net amounts instead");
    expect(note).toContain(`joyride steer ${a.worker}`);
  });

  it("refuses crew (fm-send is its path), Firstmate's images, and a guard approval", async () => {
    const c = await claudePane("Crew pane");
    crew.push({ task: "jr-crew-1", mission: null, machine: "local", pane: c.pane.pane_id });
    await waitFor(async () => (await workerById(c.worker))?.owner?.tier === "crew", 5000);
    const r = await d.req("POST", "/api/fleet/steer", { worker: c.worker, text: "hello" });
    expect(r.body).toMatchObject({ status: "failed", result: { refused: "crew" } });
    expect(r.body.error).toContain("fm-send.sh jr-crew-1");
    const img = await d.req("POST", "/api/intents", { kind: "reply", target: c.worker, origin: "firstmate", payload: { text: "look", images: ["/tmp/x.png"] } });
    expect(img.body.result).toMatchObject({ refused: "images" });
    const approve = await d.req("POST", "/api/intents", { kind: "approve", target: "gr_1", origin: "firstmate" });
    expect(approve.body).toMatchObject({ status: "failed", result: { refused: "guard_is_captains" } });
    // Moving a session into Herdr ends its process: never Firstmate's to do.
    const move = await d.req("POST", "/api/intents", { kind: "move_to_herdr", target: c.worker, origin: "firstmate" });
    expect(move.body).toMatchObject({ status: "failed", result: { refused: "captain_only" } });
    // The captain's own reply is never guarded: it still clears a stale input box and goes in.
    fake.panes.get(c.pane.pane_id)!.input = "old recalled prompt";
    const mine = await d.req("POST", "/api/intents", { kind: "reply", target: c.worker, payload: { text: "Captain here" } });
    expect(mine.body.status).toBe("sent");
    expect(fake.prompts.find((p) => p.target === c.pane.pane_id)?.text).toBe("Captain here");
  });
});

describe("membership", () => {
  it("keeps a session the captain excludes out of the fleet, and lets it back in", async () => {
    const x = await claudePane("Private notes");
    // Once the fleet has seen it as watched, keeping it out is news for Firstmate.
    const snapshot = path.join(d.sb.env.JOYRIDE_RUNTIME, "state", "fleet.json");
    await waitFor(() => fs.existsSync(snapshot) && fs.readFileSync(snapshot, "utf8").includes(`"${x.worker}"`), 5000);
    const ex = await d.req("POST", "/api/fleet/exclude", { worker: x.worker });
    expect(ex.body).toMatchObject({ status: "sent", result: { changed: true, entry: `claude:${x.session}` } });
    const policy = fs.readFileSync(path.join(d.sb.env.JOYRIDE_HOME, "fleet.yaml"), "utf8");
    expect(policy).toContain(`- claude:${x.session}`);
    await waitFor(async () => (await workerById(x.worker))?.owner?.tier === "excluded", 5000);
    const r = await d.req("POST", "/api/fleet/steer", { worker: x.worker, text: "hi" });
    expect(r.body.result).toMatchObject({ refused: "excluded" });
    const roster = (await d.req("GET", "/api/fleet")).body;
    expect(roster.members.find((m: any) => m.worker === x.worker)?.tier).toBe("excluded");
    expect(roster.counts.excluded).toBeGreaterThanOrEqual(1);
    // Only the captain decides membership.
    const fm = await d.req("POST", "/api/intents", { kind: "include_session", target: x.worker, origin: "firstmate" });
    expect(fm.body.result).toMatchObject({ refused: "captain_only" });
    expect((await d.req("POST", "/api/fleet/include", { worker: x.worker })).body).toMatchObject({ status: "sent", result: { changed: true } });
    await waitFor(async () => (await workerById(x.worker))?.owner?.tier === "watched", 5000);
    await waitFor(async () => (await fleetEvents()).some((e) => e.worker === x.worker && e.type === "member.included"), 5000);
    expect((await fleetEvents()).filter((e) => e.worker === x.worker).map((e) => e.type)).toEqual(["member.excluded", "member.included"]);
    // Crew can't be excluded.
    const c = await claudePane("Crew pane two");
    crew.push({ task: "jr-crew-2", mission: null, machine: "local", pane: c.pane.pane_id });
    await waitFor(async () => (await workerById(c.worker))?.owner?.tier === "crew", 5000);
    expect((await d.req("POST", "/api/fleet/exclude", { worker: c.worker })).body.error).toMatch(/is crew on task jr-crew-2/);
  });

  it("fails closed while fleet.yaml is broken: no steer, no membership change, no false news", async () => {
    const y = await claudePane("While broken");
    const snapshot = path.join(d.sb.env.JOYRIDE_RUNTIME, "state", "fleet.json");
    await waitFor(() => fs.existsSync(snapshot) && fs.readFileSync(snapshot, "utf8").includes(`"${y.worker}"`), 5000);
    const file = path.join(d.sb.env.JOYRIDE_HOME, "fleet.yaml");
    const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    const evs0 = (await fleetEvents()).length;
    fs.writeFileSync(file, "authority: [steer, answer-prompt]\n");
    try {
      await waitFor(async () => (await d.req("GET", "/api/fleet")).body.policy_error, 5000);
      const r = await d.req("POST", "/api/fleet/steer", { worker: y.worker, text: "hello" });
      expect(r.body.result?.refused).toMatch(/no_authority|excluded/);
      const ex = await d.req("POST", "/api/fleet/exclude", { worker: y.worker });
      expect(ex.body.result).toMatchObject({ refused: "policy_broken" });
      expect(fs.readFileSync(file, "utf8")).toBe("authority: [steer, answer-prompt]\n");
      await new Promise((r) => setTimeout(r, 800));
      expect((await fleetEvents()).slice(evs0).filter((e) => e.type === "member.excluded" || e.type === "member.included")).toEqual([]);
    } finally { if (before == null) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, before); }
  });

  it("tells Firstmate once, in one note, which watched sessions joined", async () => {
    const j = await claudePane("Joined late");
    await waitFor(() => notes.some((x) => x.id.startsWith("fleet-joined-") && x.body.includes(j.worker)), 5000);
    const joined = notes.filter((x) => x.id.startsWith("fleet-joined-"));
    const body = joined.map((x) => x.body).join("\n");
    expect(body).toMatch(/joined the fleet as watched/);
    expect(body).toContain("Joined late");
    expect(body).toContain("joyride steer <worker>");
    // Each session is announced once, however often the roster changes.
    const ids = joined.flatMap((j) => j.body.split("\n").filter((l) => l.startsWith("- local:")).map((l) => l.split(" ")[1]));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("the guarded prompt answer", () => {
  it("answers only a choice the prompt offers, records why, and refuses raw keys, no reason, or no prompt", async () => {
    const b = await claudePane("Flaky export test");
    const p = fake.panes.get(b.pane.pane_id)!;
    p.menu = fs.readFileSync(new URL("../fixtures/permission-prompts/claude-2.1.285.txt", import.meta.url), "utf8").split("\n");
    fake.setStatus(b.pane.pane_id, "blocked");
    await waitFor(async () => (await workerById(b.worker))?.status === "blocked", 5000);
    await waitFor(async () => (await fleetEvents()).some((e) => e.worker === b.worker && e.type === "member.state" && e.data.state === "blocked"), 5000);

    const show = (await d.req("GET", `/api/fleet/members/${encodeURIComponent(b.worker)}`)).body;
    expect(show.prompt.options[0]).toBe("1. Yes");
    expect(show.prompt.question).toMatch(/Do you want to proceed\?/);

    expect((await d.req("POST", "/api/fleet/answer", { worker: b.worker, choice: "allow" })).body.result).toMatchObject({ refused: "why" });
    expect((await d.req("POST", "/api/intents", { kind: "answer_prompt", target: b.worker, origin: "firstmate", payload: { keys: ["1"], why: "x" } })).body.result).toMatchObject({ refused: "keys" });
    expect((await d.req("POST", "/api/fleet/answer", { worker: b.worker, choice: "yes please", why: "x" })).body.result).toMatchObject({ refused: "choice" });
    expect(fake.keys.filter((k) => k.target === b.pane.pane_id)).toEqual([]);

    const r = await d.req("POST", "/api/fleet/answer", { worker: b.worker, choice: "allow", why: "Runs the session's own tests serially; nothing leaves the machine." });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ kind: "answer_prompt", origin: "firstmate", status: "sent", result: { keys: ["1"], picked: "Yes", choice: "allow", why: "Runs the session's own tests serially; nothing leaves the machine." } });
    expect(r.body.result.prompt.options).toContain("1. Yes");
    expect(fake.keys.filter((k) => k.target === b.pane.pane_id).map((k) => k.keys)).toEqual([["1"]]);

    // The prompt is gone: there is nothing to answer.
    await waitFor(async () => (await workerById(b.worker))?.status !== "blocked", 5000);
    expect((await d.req("POST", "/api/fleet/answer", { worker: b.worker, choice: "allow", why: "x" })).body.result).toMatchObject({ refused: "no_prompt" });
  });

  it("refuses at the captain's helm", async () => {
    const c = await claudePane("Captain's own run");
    c.hook("prompt.submit", { prompt: "lab: run it" });
    await waitFor(async () => (await workerById(c.worker))?.helm?.by === "captain", 5000);
    const p = fake.panes.get(c.pane.pane_id)!;
    p.menu = [...CLAUDE_PERMISSION_MENU];
    fake.setStatus(c.pane.pane_id, "blocked");
    await waitFor(async () => (await workerById(c.worker))?.status === "blocked", 5000);
    const r = await d.req("POST", "/api/fleet/answer", { worker: c.worker, choice: "allow", why: "x" });
    expect(r.body.result).toMatchObject({ refused: "captain_helm" });
    expect(fake.keys.filter((k) => k.target === c.pane.pane_id)).toEqual([]);
  });
});

describe("the feed endpoint", () => {
  it("delivers by request id and says what changed", async () => {
    const f = await claudePane("Feed source");
    fake.setStatus(f.pane.pane_id, "blocked");
    await waitFor(async () => (await fleetEvents()).some((e) => e.worker === f.worker && e.data.state === "blocked"), 5000);
    const poll = async (q: string, headers: Record<string, string> = { "x-joyride-feed": "1" }) => {
      const r = await d.app.request(`/api/fleet/feed?${q}`, { headers });
      return { status: r.status, body: await r.json() as any };
    };
    // A web page can't move Firstmate's place in the feed: it can't send the header without a preflight.
    expect((await poll("consumer=t-feed&request=r0&wait=0", {})).status).toBe(403);
    expect((await poll("consumer=t-feed&request=r0&wait=0", { "x-joyride-feed": "1", "sec-fetch-site": "cross-site" })).status).toBe(403);
    const one = (await poll("consumer=t-feed&request=r1&wait=0")).body;
    expect(one.events.length).toBeGreaterThan(0);
    expect(one.text.split("\n")[0]).toMatch(/^joyride-fleet-feed\/1 seq=\d+(-\d+)? kinds=/);
    expect((await poll("consumer=t-feed&request=r1&wait=0")).body.events.map((e: any) => e.seq)).toEqual(one.events.map((e: any) => e.seq));
    const two = (await poll("consumer=t-feed&request=r2&wait=0")).body;
    expect(two.events.every((e: any) => e.seq > one.events.at(-1).seq)).toBe(true);
    expect((await poll("consumer=bad id&request=r")).status).toBe(400);
    const roster = (await d.req("GET", "/api/fleet")).body;
    expect(roster.feed.consumers.find((c: any) => c.id === "t-feed")).toMatchObject({ attached: true });
    expect(roster.feed.attached).toBe(true);
  });
});
