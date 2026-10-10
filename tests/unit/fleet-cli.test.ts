// `joyride fleet` and `joyride steer`: what Firstmate reads, and the exit codes it acts on (2 = the guard
// refused and nothing was sent). The CLI talks to a stub daemon here; the routes behind it are in fleet.test.ts.
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";

const calls: { method: string; url: string; body: any }[] = [];
let reply: (method: string, url: string, body: any) => { status: number; body: any } = () => ({ status: 404, body: { error: "no" } });
let server: http.Server;
let cli: typeof import("../../src/cli/fleet.ts");

const member = (o: any = {}) => ({
  worker: "local:w1:p1", session: "claude:s1", tier: "watched", task: null, state: "paused", why: "Idle", title: "Export fix", goal: "Fix the export totals",
  cwd: "/Users/x/alpha", repo: "/Users/x/alpha", helm: { by: "firstmate", since: null, until: null, via: null }, controllable: true, updated: new Date().toISOString(), ...o,
});
const roster = (members: any[]) => ({
  members, counts: { crew: members.filter((m) => m.tier === "crew").length, watched: members.filter((m) => m.tier === "watched").length, excluded: members.filter((m) => m.tier === "excluded").length, needs_you: members.filter((m) => ["blocked", "needs-decision", "failed"].includes(m.state)).length, captain_helm: members.filter((m) => m.helm?.by === "captain").length },
  feed: { attached: true, consumers: [{ id: "joyride-fleet", last_poll: new Date().toISOString(), pending: 0 }], last_seq: 3 }, policy_error: null, operator_doc: "/j/docs/fleet-operator.md",
});

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ method: req.method!, url: req.url!, body });
      const r = reply(req.method!, req.url!, body);
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  process.env.JOYRIDE_URL = `http://127.0.0.1:${(server.address() as any).port}`;
  cli = await import("../../src/cli/fleet.ts");
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("joyride fleet", () => {
  it("prints the roster with tier, state, helm and goal, and --brief only what needs Firstmate", async () => {
    const until = new Date(Date.now() + 10 * 60e3).toISOString();
    const members = [
      member(),
      member({ worker: "local:w2:p1", tier: "crew", task: "jr-x", state: "working", goal: "Ship phase 2" }),
      member({ worker: "local:w3:p1", state: "blocked", why: "Waiting for permission: Bash: npm publish", goal: "Publish docs" }),
      member({ worker: "local:w4:p1", helm: { by: "captain", since: new Date().toISOString(), until, via: "direct" } }),
      member({ worker: "local:w5:p1", tier: "excluded", goal: "Private notes" }),
    ];
    reply = () => ({ status: 200, body: roster(members) });
    const full = await cli.fleetCommand([]);
    expect(full.split("\n")[0]).toBe("Fleet: 1 crew · 3 watched · 1 yours only · 1 needs attention · 1 at the captain's helm · feed attached");
    expect(full).toMatch(/crew\s+local:w2:p1\s+working\s+firstmate\s+alpha\s+Ship phase 2 \(jr-x\)/);
    expect(full).toMatch(/watched\s+local:w3:p1\s+blocked .* — Waiting for permission: Bash: npm publish/);
    expect(full).toMatch(/local:w4:p1\s+paused\s+captain until /);
    expect(full).not.toContain("local:w5:p1"); // the captain's own, unless --all
    expect(await cli.fleetCommand(["--all"])).toMatch(/yours\s+local:w5:p1/);
    const brief = await cli.fleetCommand(["--brief"]);
    expect(brief).toContain("local:w3:p1");
    expect(brief).toContain("local:w4:p1");
    expect(brief).not.toContain("local:w1:p1");
    expect(JSON.parse(await cli.fleetCommand(["--json"])).members).toHaveLength(5);
    reply = () => ({ status: 200, body: roster([member()]) });
    expect(await cli.fleetCommand(["--brief"])).toMatch(/Nothing needs you right now/);
  });

  it("shows one member with the prompt on its screen and how to answer it", async () => {
    reply = () => ({ status: 200, body: { ...member({ state: "blocked", why: "Waiting at a prompt" }), prompt: { question: "Do you want to proceed?", options: ["1. Yes", "2. No"] } } });
    const out = await cli.fleetCommand(["show", "local:w1:p1"]);
    expect(out).toContain("prompt:  Do you want to proceed?");
    expect(out).toContain("1. Yes");
    expect(out).toContain('joyride steer local:w1:p1 --answer allow|allow_always|deny --why "<reason>"');
    reply = () => ({ status: 404, body: { error: "local:zz is not a live fleet member." } });
    await expect(cli.fleetCommand(["show", "local:zz"])).rejects.toMatchObject({ message: "local:zz is not a live fleet member.", code: 1 });
  });

  it("keeps the captain's own commands out of Firstmate's shell", async () => {
    process.env.FM_TASK_ID = "jr-x";
    try { await expect(cli.fleetCommand(["hand-back", "local:w1:p1"])).rejects.toMatchObject({ code: 2, message: expect.stringContaining("a crewmate's (task jr-x)") }); }
    finally { delete process.env.FM_TASK_ID; }
    expect(() => cli.captainOnly("exclude", "/x/vendor/firstmate")).not.toThrow();
    const { paths } = await import("../../src/shared/paths.ts");
    expect(() => cli.captainOnly("exclude", paths.firstmateDir)).toThrow(/in Firstmate's checkout or home/);
    reply = () => ({ status: 200, body: { id: "int_1", status: "sent", result: { worker: "local:w1:p1", released: "x" } } });
    expect(await cli.fleetCommand(["hand-back", "local:w1:p1"])).toBe("Handed the helm of local:w1:p1 back to Firstmate.");
    expect(calls.at(-1)).toMatchObject({ method: "POST", url: "/api/fleet/hand-back", body: { target: "local:w1:p1" } });
  });
});

it("prune --dry-run only reads candidates and prints each closure reason", async () => {
  reply = () => ({ status: 200, body: { candidates: [{ worker: "local:w1:p1", eligible: true, why: "idle 80 hours", git: { branch: "work", dirty: true, unpushed: null }, shared: 2 }, { worker: "local:w2:p1", eligible: false, why: "the captain holds the helm", git: null, shared: 1 }] } });
  const n = calls.length;
  const out = await cli.fleetCommand(["prune", "--dry-run"]);
  expect(out).toContain("Dry run: no panes closed.");
  expect(out).toContain("Would preserve and close local:w1:p1: idle 80 hours");
  expect(out).toContain("Keep local:w2:p1: the captain holds the helm");
  expect(calls.slice(n)).toEqual([{ method: "GET", url: "/api/fleet/prune", body: null }]);
  await expect(cli.fleetCommand(["prune"])).rejects.toThrow(/--dry-run/);
});

describe("joyride steer", () => {
  it("sends text and says when it waits in the agent's queue", async () => {
    reply = () => ({ status: 200, body: { id: "int_9", status: "sent", result: { queued: true } } });
    expect(await cli.steerCommand(["local:w1:p1", "Run", "the", "tests"])).toMatch(/^Sent to local:w1:p1 \(it is working, so the message waits in its queue/);
    expect(calls.at(-1)).toMatchObject({ url: "/api/fleet/steer", body: { worker: "local:w1:p1", text: "Run the tests" } });
  });

  it("exits 2 when the guard refuses, 1 on other failures", async () => {
    reply = () => ({ status: 409, body: { id: "int_2", status: "failed", error: "The captain holds the helm of local:w1:p1.", result: { refused: "captain_helm" } } });
    await expect(cli.steerCommand(["local:w1:p1", "hi"])).rejects.toMatchObject({ code: 2, message: "The captain holds the helm of local:w1:p1." });
    reply = () => ({ status: 400, body: { id: "int_3", status: "failed", error: "Herdr did not answer in time." } });
    await expect(cli.steerCommand(["local:w1:p1", "hi"])).rejects.toMatchObject({ code: 1 });
    await expect(cli.steerCommand(["local:w1:p1"])).rejects.toMatchObject({ message: expect.stringContaining("Nothing to send") });
  });

  it("answers a prompt only with a reason, and reports what it picked", async () => {
    await expect(cli.steerCommand(["local:w1:p1", "--answer", "allow"])).rejects.toMatchObject({ message: expect.stringContaining("--why") });
    await expect(cli.steerCommand(["local:w1:p1", "--answer", "allow", "--why", "x", "extra text"])).rejects.toMatchObject({ message: expect.stringContaining("carries no text") });
    reply = () => ({ status: 200, body: { id: "int_4", status: "sent", result: { picked: "Yes", prompt: { question: "Do you want to proceed?" } } } });
    expect(await cli.steerCommand(["local:w1:p1", "--answer", "allow", "--why", "Read-only test run"])).toBe('Answered local:w1:p1\'s prompt with "Yes" (Do you want to proceed?). Recorded as int_4.');
    expect(calls.at(-1)).toMatchObject({ url: "/api/fleet/answer", body: { worker: "local:w1:p1", choice: "allow", why: "Read-only test run" } });
  });

  it("says when the feed is not attached, so Firstmate knows to read the roster itself", () => {
    expect(cli.summaryLine({ counts: { crew: 0, watched: 0, excluded: 0, needs_you: 0, captain_helm: 0 }, feed: { attached: false, consumers: [], last_seq: 0 } } as any)).toMatch(/feed not attached$/);
    expect(cli.summaryLine({ counts: { crew: 0, watched: 1, excluded: 0, needs_you: 1, captain_helm: 0 }, feed: { attached: false, consumers: [{ id: "joyride-fleet", last_poll: "2026-01-01T00:00:00Z", pending: 2 }], last_seq: 2 } } as any)).toMatch(/1 needs attention .* feed not polled lately$/);
  });
});
