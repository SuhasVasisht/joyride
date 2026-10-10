// Notes with the real Firstmate projection: a crew task gets its idea's notes in its
// SessionStart digest through Firstmate's task-to-idea mapping (the brief marker), and
// create_task carries the idea's notes in the inbox note it files through bin/fm-inbox.sh.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { sandboxDaemon } from "../sandbox.ts";
import { startFakeHerdr, waitFor, assertSandboxed, FIXTURE_REPOS, type FakeHerdr } from "../fixtures/fake-herdr.ts";
import { buildFirstmateHome, FIXTURE_TASKS as T } from "../e2e/crew-fixture.ts";

process.env.JOYRIDE_HERDR_POLL_MS = "300";
process.env.JOYRIDE_FIRSTMATE_POLL_MS = "200";

const MISSION = "csv-export";
let d: Awaited<ReturnType<typeof sandboxDaemon>>;
let fake: FakeHerdr;
let home: string;

beforeAll(async () => {
  home = path.join(process.env.JOYRIDE_RUNTIME!, "firstmate");
  buildFirstmateHome(home, MISSION);
  d = await sandboxDaemon("notes-firstmate", ["sessions", "missions", "live", "firstmate", "notes"]);
  fake = await startFakeHerdr(d.sb.env.JOYRIDE_HERDR_SOCKET, { scenario: "default" });
  await assertSandboxed(d.sb.env);
  await d.start();
  const r = await d.req("POST", "/api/missions", { id: MISSION, title: "CSV export with totals", goal: "Users can export the report as CSV.", repos: [FIXTURE_REPOS.alpha] });
  expect(r.status).toBe(201);
  await waitFor(async () => (await d.req("GET", "/api/herdr/status")).body.connected, 5000);
  await waitFor(async () => (await d.req("GET", `/api/firstmate/tasks/${T.ship}`)).body.mission === MISSION, 4000);
});
afterAll(async () => {
  await d?.stop();
  await fake?.stop();
});

describe("notes with Firstmate", () => {
  it("gives a crew task its idea's notes through Firstmate's own task-to-idea link", async () => {
    const n = await d.req("POST", "/api/notes", { idea: MISSION, bullets: ["Totals row goes last", "Use the server's rounding"] });
    expect(n.status, JSON.stringify(n.body)).toBe(201);
    const t = (await d.req("GET", `/api/notes/task/${T.ship}`)).body;
    expect(t).toMatchObject({ task: T.ship, mission: { id: MISSION, title: "CSV export with totals" }, file: `task-${T.ship}.md` });
    expect(t.idea_notes.map((x: any) => x.id)).toEqual([n.body.id]);
    const file = path.join(d.sb.env.JOYRIDE_RUNTIME, "task-notes", `task-${T.ship}.md`);
    expect(fs.readFileSync(file, "utf8")).toContain(`Idea ${MISSION}:\n- Totals row goes last\n- Use the server's rounding`);
    // Every task Firstmate files under the idea gets one; a task under no idea does not.
    expect(fs.existsSync(path.join(d.sb.env.JOYRIDE_RUNTIME, "task-notes", `task-${T.scout}.md`))).toBe(true);
    expect((await d.req("GET", `/api/firstmate/tasks/${T.done}`)).body.mission).toBeNull();
    expect(fs.existsSync(path.join(d.sb.env.JOYRIDE_RUNTIME, "task-notes", `task-${T.done}.md`))).toBe(false);
  });

  it("puts the idea's notes in the task request create_task files with Firstmate", async () => {
    expect((await d.req("POST", "/api/firstmate/start")).body.status).toBe("sent");
    const it = (await d.req("POST", "/api/intents", { kind: "create_task", target: MISSION, payload: { brief: "Add the totals row" } })).body;
    expect(it.status, it.error).toBe("sent");
    const ids = (await d.req("GET", `/api/notes?idea=${MISSION}`)).body.map((x: any) => x.id);
    expect(it.result.notes).toEqual(ids);
    const dir = path.join(home, "state", "inbox");
    const name = fs.readdirSync(dir).filter((x) => x.endsWith(".note")).find((x) => fs.readFileSync(path.join(dir, x), "utf8").includes(`request_id=${it.id}`))!;
    const text = fs.readFileSync(path.join(dir, name), "utf8");
    expect(text).toContain(`joyride-mission: ${MISSION}`);
    expect(text).toContain("The captain's notes on this idea (put them in the task brief):\n- Totals row goes last\n- Use the server's rounding");
  });
});
