// Control plane CP0, truthful asks, end to end against the e2e sandbox daemon: a fixture FM_HOME
// with captain holds and a crewmate's keyed decision, read through /api/firstmate/tasks and
// /api/asks, a live `asks` change over SSE when the decision is resolved in the status log, and
// a stopped Firstmate that still takes create_task. API only: CP3a owns the map UI.
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { buildFirstmateHome, FIXTURE_TASKS as T } from "./crew-fixture";
import { addAskFixtures, ASK_TASKS, CALLS_REASON, REQUEST_ID } from "./asks-fixture";
import { BASE, call, PORT, waitUntil } from "./map-seed";

const env = JSON.parse(fs.readFileSync(`/tmp/joyride-e2e-${PORT}/env.json`, "utf8")) as Record<string, string>;
const MISSION = "cp0-asks-export";
const home = path.join(env.JOYRIDE_RUNTIME, "firstmate");
const ask = async (id: string) => (await call("GET", `/api/asks/${encodeURIComponent(id)}`)).body;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  if ((await call("GET", `/api/missions/${MISSION}`)).status === 404) {
    expect((await call("POST", "/api/missions", { id: MISSION, title: "Export asks", repos: ["/tmp/joyride-fixture-repos/alpha"] })).status).toBe(201);
  }
  buildFirstmateHome(home, MISSION);
  addAskFixtures(home);
  // An earlier spec may have left this same home answered (the calls task done, the decision resolved), so
  // wait until the daemon has read the rebuilt one, not merely until it lists six tasks.
  await waitUntil(async () => {
    const tasks: { id: string; status: string }[] = (await call("GET", "/api/firstmate/tasks")).body;
    const status = (id: string) => tasks.find((t) => t.id === id)?.status;
    return tasks.length === 6 && status(ASK_TASKS.calls) === "held" && status(T.scout) === "needs-decision";
  });
});

test.afterAll(async () => {
  // Later specs build their own home; leave the plain crew fixture behind, not this one.
  buildFirstmateHome(home, MISSION);
  await call("PUT", `/api/missions/${MISSION}`, { archive: true });
});

test("tasks carry who runs them, the decoded hold, the request marker and the open decisions", async () => {
  const ship = (await call("GET", `/api/firstmate/tasks/${T.ship}`)).body;
  expect(ship).toMatchObject({ model: "claude-opus-5-5", effort: "high", account: "claude-2", request: REQUEST_ID });
  const calls = (await call("GET", `/api/firstmate/tasks/${ASK_TASKS.calls}`)).body;
  expect(calls).toMatchObject({ status: "held", kind: "captain", hold: CALLS_REASON, hold_reason: CALLS_REASON, hold_kind: "captain", hold_origin: T.scout });
  expect(calls.hold).not.toMatch(/^fm-hold-v1:/);
  const scout = (await call("GET", `/api/firstmate/tasks/${T.scout}`)).body;
  expect(scout.last_event).toMatch(/^working:/);
  expect(scout.status).toBe("needs-decision");
  expect(scout.decisions.map((d: any) => [d.key, d.verb, d.keyed])).toEqual([["flake-cause", "needs-decision", true]]);
});

test("/api/asks lists every call with placement, parsed options and its answer route", async () => {
  const r = (await call("GET", "/api/asks")).body;
  const fm = r.asks.filter((a: any) => a.source === "backlog" || a.source === "status");
  expect(fm.map((a: any) => a.id).sort()).toEqual([`decision:${T.scout}:flake-cause`, `hold:${ASK_TASKS.calls}`, `hold:${T.queued}`, `hold:${ASK_TASKS.later}`]);
  const held = fm.find((a: any) => a.id === `hold:${ASK_TASKS.calls}`);
  expect(held).toMatchObject({
    kind: "captain_call", needs_you: true, owner: "captain", mission: MISSION, place: { on: "task", id: T.scout },
    recommended_answer: "Go with your recommendations: 1 A, 2 B", options_source: "parsed",
    answer: { via: "fm-captain-hold", target: ASK_TASKS.calls, modes: ["done", "release"] },
  });
  expect(held.calls.map((c: any) => [c.n, c.options.map((o: any) => `${o.id}${o.recommended ? "*" : ""}`)])).toEqual([[1, ["A*", "B"]], [2, ["A", "B*"]]]);
  expect(fm.find((a: any) => a.id === `hold:${T.queued}`)).toMatchObject({ needs_you: false, hold: { bucket: "blocked" } });
  expect(fm.find((a: any) => a.id === `hold:${ASK_TASKS.later}`)).toMatchObject({ needs_you: false, hold: { bucket: "dated" } });
  const dec = fm.find((a: any) => a.id === `decision:${T.scout}:flake-cause`);
  expect(dec).toMatchObject({ kind: "task_decision", needs_you: false, owner: "firstmate", state: "Firstmate is deciding", answer: { via: "fm-send-resolve-key", target: T.scout, key: "flake-cause" } });
  expect(r.crosscheck).toMatchObject({ valid: true, only_firstmate: [] });
  expect(r.crosscheck.only_joyride).toContain(`${ASK_TASKS.calls}|${ASK_TASKS.calls}`);
  const orange = (await call("GET", "/api/asks?needs_you=1")).body.asks;
  expect(orange.every((a: any) => a.needs_you)).toBe(true);
  expect(orange.map((a: any) => a.id)).toContain(`hold:${ASK_TASKS.calls}`);
  expect((await call("GET", `/api/asks?task=${T.scout}`)).body.asks.map((a: any) => a.id).sort()).toEqual([`decision:${T.scout}:flake-cause`, `hold:${ASK_TASKS.calls}`]);
  // A decision with no options in its text gets suggested ones from the cached ask_options task.
  await waitUntil(async () => (await ask(`decision:${T.scout}:flake-cause`)).options_source === "suggested");
  expect((await ask(`decision:${T.scout}:flake-cause`)).calls[0].options.length).toBeGreaterThanOrEqual(2);
});

test("resolving the key in the status log clears the ask live, over SSE", async () => {
  const ctrl = new AbortController();
  const res = await fetch(`${BASE}/api/stream`, { signal: ctrl.signal });
  const reader = res.body!.getReader();
  let seen = "";
  const sawAsks = (async () => {
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return false;
      seen += dec.decode(value);
      if (/"entity":"asks"/.test(seen)) return true;
    }
  })();
  await new Promise((r) => setTimeout(r, 300));
  fs.appendFileSync(path.join(home, "state", `${T.scout}.status`), `resolved [key=flake-cause] [at=${Math.floor(Date.now() / 1000)}]: answered: fix the download race first\n`);
  const got = await Promise.race([sawAsks, new Promise<boolean>((r) => setTimeout(() => r(false), 10_000))]);
  ctrl.abort();
  expect(got, `SSE carried: ${seen.slice(-400)}`).toBe(true);
  expect((await call("GET", `/api/asks/${encodeURIComponent(`decision:${T.scout}:flake-cause`)}`)).status).toBe(404);
  const scout = (await call("GET", `/api/firstmate/tasks/${T.scout}`)).body;
  expect(scout).toMatchObject({ status: "working", decisions: [] });
});

test("create_task files its note while Firstmate is stopped", async () => {
  expect((await call("GET", "/api/firstmate/status")).body.running).toBe(false);
  const it = (await call("POST", "/api/intents", { kind: "create_task", target: MISSION, payload: { brief: "Add a totals row to the XLSX export too" } })).body;
  expect(it.status, it.error).toBe("sent");
  expect(it.result).toMatchObject({ via: "inbox", firstmate_running: false, marker: `joyride-mission: ${MISSION}` });
  const notes = fs.readdirSync(path.join(home, "state", "inbox")).filter((n) => n.endsWith(".note"));
  expect(notes.some((n) => fs.readFileSync(path.join(home, "state", "inbox", n), "utf8").includes(`request_id=${it.id}`))).toBe(true);
});
