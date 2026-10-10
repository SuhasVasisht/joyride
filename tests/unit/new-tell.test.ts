// New's message for Firstmate (tell_firstmate): an update or a question, filed as a captain inbox note through
// the real bin/fm-inbox.sh into a fixture Firstmate home, with the request marker (and the idea's, when New was
// opened on one). Firstmate's fm-inbox.sh reply reaches the map through /api/firstmate/replies.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { sandboxDaemon } from "../sandbox.ts";
import { startFakeHerdr, waitFor, assertSandboxed, FIXTURE_REPOS, type FakeHerdr } from "../fixtures/fake-herdr.ts";
import { buildFirstmateHome, FIXTURE_TASKS as T } from "../e2e/crew-fixture.ts";
import { captainMessage, mapReplies, type ReceiptNote } from "../../src/modules/firstmate/request.ts";

process.env.JOYRIDE_HERDR_POLL_MS = "300";
process.env.JOYRIDE_FIRSTMATE_POLL_MS = "200";

const MISSION = "csv-export";
let d: Awaited<ReturnType<typeof sandboxDaemon>>;
let fake: FakeHerdr;
let home: string;

function inboxNote(intentId: string): { id: string; text: string } {
  for (const dir of [path.join(home, "state", "inbox"), path.join(home, "state", "inbox", "handled")]) {
    if (!fs.existsSync(dir)) continue;
    const name = fs.readdirSync(dir).filter((x) => x.endsWith(".note")).find((x) => fs.readFileSync(path.join(dir, x), "utf8").includes(`request_id=${intentId}`));
    if (name) { const text = fs.readFileSync(path.join(dir, name), "utf8"); return { id: text.match(/^id=(.+)$/m)![1], text }; }
  }
  throw new Error(`no inbox note for ${intentId}`);
}

beforeAll(async () => {
  home = path.join(process.env.JOYRIDE_RUNTIME!, "firstmate");
  buildFirstmateHome(home, MISSION);
  d = await sandboxDaemon("new-tell", ["sessions", "missions", "live", "firstmate", "notes"]);
  fake = await startFakeHerdr(d.sb.env.JOYRIDE_HERDR_SOCKET, { scenario: "default" });
  await assertSandboxed(d.sb.env);
  await d.start();
  expect((await d.req("POST", "/api/missions", { id: MISSION, title: "CSV export with totals", repos: [FIXTURE_REPOS.alpha] })).status).toBe(201);
  await waitFor(async () => (await d.req("GET", `/api/firstmate/tasks/${T.ship}`)).body.mission === MISSION, 4000);
});
afterAll(async () => {
  await d?.stop();
  await fake?.stop();
});

describe("a message for Firstmate from New", () => {
  it("says it is not a task request, and carries the markers", () => {
    expect(captainMessage({ requestId: "int_1", text: "  The API key rotated.  ", idea: { id: "m", title: "M" } })).toBe([
      `The captain wrote to you from Joyride's New box, on the idea "M":`, "", "The API key rotated.", "",
      "This is an update or a question, not a task request. Act on it as you see fit, and answer it with `fm-inbox.sh reply <note id>` so Joyride shows your answer on the map.",
      "joyride-mission: m", "joyride-request: int_1",
    ].join("\n"));
    expect(captainMessage({ requestId: "r", text: "x" })).not.toContain("joyride-mission");
  });

  it("files an inbox note, and Firstmate's reply shows on the map", async () => {
    const r = await d.req("POST", "/api/intents", { kind: "tell_firstmate", target: "firstmate", payload: { text: "How is the CSV export going?", idea: MISSION } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ kind: "tell_firstmate", status: "sent", origin: "captain", result: { request: r.body.id, mission: MISSION } });
    const note = inboxNote(r.body.id);
    expect(note.text).toContain("How is the CSV export going?");
    expect(note.text).toContain("not a task request");
    expect(note.text).toContain(`joyride-mission: ${MISSION}`);
    expect(note.text).toContain(`joyride-request: ${r.body.id}`);
    expect((await d.req("GET", `/api/firstmate/requests/${r.body.id}`)).body.stage).toBe("sent");

    const fmInbox = path.join((await d.req("GET", "/api/firstmate/status")).body.vendor.path, "bin", "fm-inbox.sh");
    if (!home.startsWith(path.dirname(process.env.JOYRIDE_RUNTIME!))) throw new Error("refusing: FM_HOME is not in the sandbox");
    execFileSync(fmInbox, ["reply", note.id, "On track: the totals row lands today."], { env: { ...process.env, FM_HOME: home } });
    await waitFor(async () => (await d.req("GET", "/api/firstmate/replies")).body.some((x: any) => x.request === r.body.id), 6000);
    const reply = (await d.req("GET", "/api/firstmate/replies")).body.find((x: any) => x.request === r.body.id);
    expect(reply).toMatchObject({ text: "How is the CSV export going?", task: null, reply: { body: "On track: the totals row lands today." } });
  });

  it("refuses an empty message", async () => {
    const r = await d.req("POST", "/api/intents", { kind: "tell_firstmate", target: "firstmate", payload: { text: "  " } });
    expect(r.body.status).toBe("failed");
    expect(r.body.error).toContain("Type the message for Firstmate");
  });

  it("lists captain messages with task requests, by their text", () => {
    const note = (rid: string): ReceiptNote => ({ id: `n-${rid}`, at: "2026-10-05T11:00:00Z", source: "joyride", request_id: rid, acknowledged: true, announced: true, reply: { id: `n-${rid}`, at: "2026-10-05T11:30:00Z", body: "ok", cursor: "1" } });
    const list = mapReplies(
      [{ id: "m1", kind: "tell_firstmate", status: "sent", created: "2026-10-05T11:00:00Z", payload: { text: "fyi  the key\nrotated" }, result: { request: "m1" } }],
      { schema: "fm-inbox-receipts.v1", pending: [], handled: [note("m1")] }, [], {}, Date.parse("2026-10-05T12:00:00Z"));
    expect(list).toMatchObject([{ request: "m1", text: "fyi the key rotated", mission: null, task: null }]);
  });
});
