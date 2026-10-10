import { beforeAll, afterAll, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { sandboxDaemon } from "../sandbox.ts";
import { startFakeHerdr, waitFor, type FakeHerdr } from "../fixtures/fake-herdr.ts";

let d: Awaited<ReturnType<typeof sandboxDaemon>>, fake: FakeHerdr;
process.env.JOYRIDE_WORKERS_POLL_MS = "100";
beforeAll(async () => {
  process.env.JOYRIDE_FIRSTMATE_DIR = path.join(process.env.JOYRIDE_SANDBOX_DIR!, "firstmate-checkout");
  fs.mkdirSync(process.env.JOYRIDE_FIRSTMATE_DIR, { recursive: true });
  d = await sandboxDaemon("fleet-control", ["live", "firstmate", "fleet"]);
  fake = await startFakeHerdr(d.sb.env.JOYRIDE_HERDR_SOCKET, { scenario: "empty" });
  await d.start();
});
afterAll(async () => { await d?.stop(); await fake?.stop(); });

it("Firstmate's pid-based session never joins the fleet or receives a helm event", async () => {
  const id = "aaaa0000-0000-4000-8000-000000000000";
  const registry = path.join(d.sb.env.JOYRIDE_CLAUDE_DIR, "sessions");
  fs.mkdirSync(registry, { recursive: true });
  fs.writeFileSync(path.join(registry, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: id, cwd: process.env.JOYRIDE_FIRSTMATE_DIR, status: "idle", updatedAt: Date.now() }));
  await waitFor(async () => (await d.req("GET", "/api/workers")).body.some((w: any) => w.id === `local:pid:${process.pid}` && w.owner.tier === "control" && w.helm === null), 5000);
  d.ctx.emit({ source: "hook.claude", type: "prompt.submit", session: id, agent: "claude", cwd: process.env.JOYRIDE_FIRSTMATE_DIR, data: { prompt: "Fleet supervision" } });
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect((await d.req("GET", "/api/fleet")).body.members.some((m: any) => m.session === `claude:${id}`)).toBe(false);
  expect((await d.req("GET", "/api/fleet/events?after=0")).body.events.some((e: any) => e.session === `claude:${id}`)).toBe(false);
  expect(d.ctx.db.prepare("SELECT COUNT(*) n FROM events WHERE source='live' AND type='steer.attributed' AND session=?").get(id)).toEqual({ n: 0 });
});

it("a relaunched task's current window wins over stale pane metadata", async () => {
  const home = d.sb.env.FM_HOME;
  fs.mkdirSync(path.join(home, "state"), { recursive: true });
  fs.writeFileSync(path.join(home, "state", "jr-relaunched.meta"), "backend=herdr\nwindow=default:w-new:p1\nherdr_pane_id=w-old:p1\nherdr_session=default\n");
  d.ctx.service<any>("firstmate").reload();
  const pane = fake.addPane({ workspace_id: "w-new", cwd: d.sb.dir, agent: "claude", agent_status: "idle", pane_id: "w-new:p1" });
  await waitFor(async () => (await d.req("GET", "/api/workers")).body.some((w: any) => w.id === `local:${pane.pane_id}` && w.owner.tier === "crew" && w.owner.task === "jr-relaunched"), 5000);
});
