// "Save and tell Firstmate" (CP4b): the tell_note intent files a captain inbox note through the
// real bin/fm-inbox.sh into a fixture Firstmate home, carrying the note's bullets, how to read it,
// the joyride-mission marker (the idea's, or the task's idea) and the joyride-request marker.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { sandboxDaemon } from "../sandbox.ts";
import { startFakeHerdr, waitFor, assertSandboxed, FIXTURE_REPOS, type FakeHerdr } from "../fixtures/fake-herdr.ts";
import { buildFirstmateHome, FIXTURE_TASKS as T } from "../e2e/crew-fixture.ts";
import { tellText } from "../../src/modules/notes/tell.ts";

process.env.JOYRIDE_HERDR_POLL_MS = "300";
process.env.JOYRIDE_FIRSTMATE_POLL_MS = "200";

const MISSION = "csv-export";
let d: Awaited<ReturnType<typeof sandboxDaemon>>;
let fake: FakeHerdr;
let home: string;

function inboxNote(intentId: string): string {
  const dir = path.join(home, "state", "inbox");
  const name = fs.readdirSync(dir).filter((x) => x.endsWith(".note")).find((x) => fs.readFileSync(path.join(dir, x), "utf8").includes(`request_id=${intentId}`));
  if (!name) throw new Error(`no inbox note for ${intentId}`);
  return fs.readFileSync(path.join(dir, name), "utf8");
}

beforeAll(async () => {
  home = path.join(process.env.JOYRIDE_RUNTIME!, "firstmate");
  buildFirstmateHome(home, MISSION);
  d = await sandboxDaemon("notes-tell", ["sessions", "missions", "live", "firstmate", "notes"]);
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

describe("tell Firstmate about a note", () => {
  it("writes the note text with both markers", () => {
    const t = tellText({ requestId: "int_1", note: { id: "note-a", bullets: ["One", "Two"], anchor: { kind: "task", id: "jr-x" } }, mission: { id: "m", title: "M" } });
    expect(t).toBe([
      `The captain saved a note on task jr-x in the idea "M" in Joyride and asked you to read it:`,
      "- One", "- Two", "",
      "Note note-a; read it and its neighbours with `joyride notes --task jr-x`. Act on it, or keep it for the next brief on this work.",
      "joyride-mission: m", "joyride-request: int_1",
    ].join("\n"));
    expect(tellText({ requestId: "r", note: { id: "n", bullets: ["x"], anchor: { kind: "global" } }, mission: null })).not.toContain("joyride-mission");
  });

  it("files an inbox note for an idea note", async () => {
    const n = (await d.req("POST", "/api/notes", { idea: MISSION, bullets: ["Totals row goes last", "Use the server's rounding"], provenance: { type: "human", ref: "map" } })).body;
    const r = await d.req("POST", `/api/notes/${n.id}/tell`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ kind: "tell_note", target: n.id, status: "sent", origin: "captain", result: { note: n.id, mission: MISSION } });
    const text = inboxNote(r.body.id);
    expect(text).toContain(`The captain saved a note on the idea "CSV export with totals" (${MISSION}) in Joyride`);
    expect(text).toContain("- Totals row goes last\n- Use the server's rounding");
    expect(text).toContain(`joyride notes --idea ${MISSION}`);
    expect(text).toContain(`joyride-mission: ${MISSION}`);
    expect(text).toContain(`joyride-request: ${r.body.id}`);
    // The intent log has it, so a timeline or audit can show it.
    const log = (await d.req("GET", "/api/intents?kind=tell_note&limit=5")).body;
    expect(log.map((x: any) => x.id)).toContain(r.body.id);
  });

  it("gives a task note its task's idea", async () => {
    const n = (await d.req("POST", "/api/notes", { task: T.ship, text: "Keep the button left of Print" })).body;
    const r = await d.req("POST", `/api/notes/${n.id}/tell`);
    expect(r.body.status, r.body.error).toBe("sent");
    const text = inboxNote(r.body.id);
    expect(text).toContain(`on task ${T.ship} in the idea "CSV export with totals"`);
    expect(text).toContain(`joyride-mission: ${MISSION}`);
  });

  it("says when there is no such note", async () => {
    const r = await d.req("POST", "/api/notes/note-missing/tell");
    expect(r.status).toBe(404);
    expect(r.body.error).toContain("no note note-missing");
  });
});
