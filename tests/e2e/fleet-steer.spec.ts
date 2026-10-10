// Fleet phase 2, one fleet, on the Agents page (#/agents): the captain hands a session's helm back to Firstmate, keeps a
// session to themself and puts it back, and sees whether Firstmate reads the fleet feed. Firstmate's
// guarded steer goes through the API it uses (joyride steer): refused at the captain's helm, sent once
// the helm is back, and never taking the helm. Runs against the sandbox daemon and the fake Herdr.
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { shot } from "./shot";
import { call, herdr, PORT, waitUntil } from "./map-seed";

const sandbox = `/tmp/joyride-e2e-${PORT}`;
const env = JSON.parse(fs.readFileSync(`${sandbox}/env.json`, "utf8")) as Record<string, string>;
const SESSION = "f1ee7000-0000-4000-8000-0000000000a2";
let pane = "";
const worker = () => `local:${pane}`;

function appendHookEvents(evs: { type: string; data: Record<string, unknown>; agoMs: number }[]) {
  const dir = path.join(env.JOYRIDE_RUNTIME, "events");
  if (!dir.startsWith(sandbox)) throw new Error("refusing: event log is not in the sandbox");
  fs.mkdirSync(dir, { recursive: true });
  const lines = evs.map((e, i) => JSON.stringify({
    ts: new Date(Date.now() - e.agoMs).toISOString(), id: `ev_e2e_fleet2_${PORT}_${Date.now()}_${i}`, source: "hook.claude", type: e.type,
    session: SESSION, agent: "claude", cwd: "/tmp/joyride-fixture-repos/gamma", pane, data: e.data,
  }));
  fs.appendFileSync(path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`), lines.join("\n") + "\n");
}
const workerNow = async () => (await call<any[]>("GET", "/api/workers")).body.find((w) => w.id === worker());

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  pane = (await herdr("fake.add_pane", { cwd: "/tmp/joyride-fixture-repos/gamma", agent: "claude", agent_status: "idle", title: "Captain's release notes", label: "gamma" })).pane.pane_id;
  appendHookEvents([{ type: "session.start", data: {}, agoMs: 3 * 60e3 }, { type: "prompt.submit", data: { prompt: "Draft the release notes from the changelog" }, agoMs: 60e3 }]);
  await waitUntil(async () => (await workerNow())?.helm?.by === "captain", 10000);
});
test.afterAll(async () => { if (pane) await herdr("fake.close_pane", { pane_id: pane }).catch(() => {}); });

test("the captain hands the helm back, and Firstmate's guarded steer goes in only then", async ({ page }) => {
  // Firstmate tries while the captain holds the helm: refused, nothing typed.
  const refused = await call("POST", "/api/fleet/steer", { worker: worker(), text: "Add the migration notes too." });
  expect(refused.status).toBe(409);
  expect(refused.body.result.refused).toBe("captain_helm");

  await page.goto("/#/agents?show=your-helm");
  const row = page.locator(`[data-agent="w:${worker()}"]`);
  await expect(row.locator('[data-helm="captain"]')).toHaveText("Helm: you");
  const hand = row.locator('[data-action="hand-back"]');
  await expect(hand).toBeVisible();
  await shot(page, "fleet-p2", "fleet-captain-helm");

  await hand.click();
  await page.goto("/#/agents");
  await expect(row.locator('[data-helm="firstmate"]')).toHaveText("Helm: Firstmate");
  await expect(row.locator('[data-action="hand-back"]')).toHaveCount(0);
  expect((await workerNow()).helm.by).toBe("firstmate");

  const sent = await call("POST", "/api/fleet/steer", { worker: worker(), text: "Add the migration notes too." });
  expect(sent.body).toMatchObject({ status: "sent", origin: "firstmate" });
  const st = await herdr("fake.state");
  expect(st.prompts.some((p: any) => p.target === pane && p.text === "Add the migration notes too.")).toBe(true);
  // Firstmate's steer never takes the helm.
  await expect(row.locator('[data-helm="firstmate"]')).toHaveText("Helm: Firstmate");
  const evs = (await call("GET", "/api/fleet/events?after=0&limit=500")).body.events.filter((e: any) => e.worker === worker());
  expect(evs.map((e: any) => e.type)).toEqual(["helm.captain", "helm.firstmate"]);
  expect(evs[1].data.via).toBe("hand_back");
  await shot(page, "fleet-p2", "fleet-helm-handed-back");
});

test("the captain keeps a session to themself, and puts it back in the fleet", async ({ page }) => {
  await page.goto("/#/agents");
  const row = page.locator(`[data-agent="w:${worker()}"]`);
  await row.locator('[data-action="exclude"]').click();
  await expect(row.locator('[data-owner="excluded"]')).toHaveText("Yours only");
  await expect(row).toHaveAttribute("data-owner", "yours");
  const refused = await call("POST", "/api/fleet/steer", { worker: worker(), text: "hello" });
  expect(refused.body.result.refused).toBe("excluded");
  expect(fs.readFileSync(path.join(env.JOYRIDE_HOME, "fleet.yaml"), "utf8")).toContain(`claude:${SESSION}`);
  await page.goto("/#/agents?owner=yours");
  await expect(row).toBeVisible();
  await shot(page, "fleet-p2", "fleet-yours-only");

  await row.locator('[data-action="include"]').click();
  await page.goto("/#/agents");
  await expect(row.locator('[data-owner="watched"]')).toHaveText("Watched");
  const types = (await call("GET", "/api/fleet/events?after=0&limit=500")).body.events.filter((e: any) => e.worker === worker()).map((e: any) => e.type);
  expect(types.slice(-2)).toEqual(["member.excluded", "member.included"]);
});

test("the page says whether Firstmate reads the fleet feed", async ({ page }) => {
  await page.goto("/#/agents");
  const feed = page.getByTestId("fleet-feed");
  await expect(feed).toHaveAttribute("data-attached", "false");
  await expect(feed).toContainText("./bin/joyride install firstmate-feed");
  // Firstmate's extension polls (one long-poll request, as the process-event host sends it).
  const r = await (await fetch(`http://127.0.0.1:${PORT}/api/fleet/feed?consumer=joyride-fleet&request=e2e-1&wait=0`, { headers: { "x-joyride-feed": "1" } })).json();
  expect(r.text.split("\n")[0]).toMatch(/^joyride-fleet-feed\/1 seq=/);
  await page.reload();
  await expect(feed).toHaveAttribute("data-attached", "true");
  await expect(feed).toContainText("Firstmate reads the fleet feed");
  await shot(page, "fleet-p2", "fleet-feed-attached");
});
