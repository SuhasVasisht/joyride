// Direct freeform tasks retain the existing Firstmate receipt and reply visibility.
import fs from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { shot } from "./shot";
import { buildFirstmateHome, FIXTURE_TASKS as T } from "./crew-fixture";
import { FIXTURE_REPOS } from "../fixtures/fake-herdr";
import { composeTask, newInput, newSection, openNew } from "./new-box";

const port = Number(process.env.E2E_PORT ?? 4399);
const env = JSON.parse(fs.readFileSync(`/tmp/joyride-e2e-${port}/env.json`, "utf8")) as Record<string, string>;
const base = `http://127.0.0.1:${port}`;
const MISSION = "compose-csv";
const CP = "CP5";
const home = path.join(env.JOYRIDE_RUNTIME, "firstmate");

async function api(method: string, p: string, body?: unknown) {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
}
async function until<T>(fn: () => Promise<T>, ms = 12000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 200)); }
}
function noteFile(intentId: string): string | null {
  for (const dir of [path.join(home, "state", "inbox"), path.join(home, "state", "inbox", "handled")]) {
    if (!fs.existsSync(dir)) continue;
    const n = fs.readdirSync(dir).filter((x) => x.endsWith(".note")).find((x) => fs.readFileSync(path.join(dir, x), "utf8").includes(`request_id=${intentId}`));
    if (n) return path.join(dir, n);
  }
  return null;
}
/** Wait for every ghost card's FLIP to land before a screenshot. */
const landed = (page: Page) => page.waitForFunction(() => [...document.querySelectorAll(".ghost")].every((el) => el.getAnimations().every((a) => a.playState !== "running")));
const lastIntent = async (kind: string) => (await api("GET", `/api/intents?kind=${kind}&limit=1`)).body[0];

const compose = composeTask;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  buildFirstmateHome(home, MISSION);
  const m = await api("POST", "/api/missions", { id: MISSION, title: "CSV export with totals", goal: "Users can export the report as CSV, including a totals row.", repos: [FIXTURE_REPOS.alpha] });
  expect([201, 409]).toContain(m.status);
  await until(async () => (await api("GET", `/api/firstmate/tasks/${T.ship}`)).body?.mission === MISSION);
});

test("task sends directly and follows Firstmate's receipts into the task", async ({ page }) => {
  await openNew(page, MISSION);
  const ghost = await compose(page, "Add a footer row to the CSV export");
  const it = await until(async () => { const x = await lastIntent("create_task"); return x?.payload?.brief === "Add a footer row to the CSV export" ? x : null; });
  expect(it).toMatchObject({ target: MISSION, status: "sent" });
  const file = noteFile(it.id)!;
  expect(fs.readFileSync(file, "utf8")).toContain(`joyride-mission: ${MISSION}\njoyride-request: ${it.id}`);
  await expect(ghost.locator(".ghost-steps li.done")).toHaveText(["Sent"]);
  await shot(page, CP, "direct-task-sent");
  fs.mkdirSync(path.join(home, "state", "inbox", "handled"), { recursive: true });
  fs.renameSync(file, path.join(home, "state", "inbox", "handled", path.basename(file)));
  await expect(ghost.locator(".ghost-steps li.done")).toHaveText(["Sent", "Read"], { timeout: 10000 });
  const id = "jr-csv-footer", backlog = path.join(home, "data", "backlog.md");
  fs.writeFileSync(backlog, fs.readFileSync(backlog, "utf8").replace("## Queued\n", `## Queued\n\n- [ ] ${id} - Add a footer row to the CSV export (repo: alpha) (kind: ship)\n`));
  fs.mkdirSync(path.join(home, "data", id), { recursive: true });
  fs.writeFileSync(path.join(home, "data", id, "brief.md"), `# Task\n\njoyride-mission: ${MISSION}\njoyride-request: ${it.id}\n\nAdd a footer row.\n`);
  await expect(ghost).toHaveClass(/is-task/, { timeout: 12000 });
  await expect(ghost.locator(".ghost-steps li.done")).toHaveText(["Sent", "Read", `Task ${id}`]);
  expect((await api("GET", `/api/firstmate/tasks/${id}`)).body.mission).toBe(MISSION);
  await shot(page, CP, "direct-task-created-private-home");
  await ghost.getByRole("button", { name: "Hide this request" }).click();
});
test("an unscoped task creates and commits a named idea without a placement picker", async ({ page }) => {
  await openNew(page);
  const ghost = await compose(page, "Task: nightly backup of the reports database");
  const it = await lastIntent("create_task");
  expect(it).toMatchObject({ target: "new", status: "sent" });
  const mission = (await api("GET", `/api/missions/${it.result.mission}`)).body;
  expect(mission.title).toBe("nightly backup of the reports database");
  expect(fs.readFileSync(noteFile(it.id)!, "utf8")).toContain(`joyride-mission: ${mission.id}`);
  await expect(ghost.getByRole("list", { name: "Where this goes" })).toHaveCount(0);
  await shot(page, CP, "new-idea-auto-filed");
  await ghost.getByRole("button", { name: "Hide this request" }).click();
});
test("explicit steering goes straight to the existing task's private inbox", async ({ page }) => {
  await openNew(page);
  await newInput(page).fill(`Steer task ${T.ship}: Also show the totals row in bold`);
  const response = page.waitForResponse((r) => r.url().endsWith("/api/new"));
  await newInput(page).press("Enter"); expect((await (await response).json()).state).toBe("done");
  const it = await lastIntent("steer_task");
  expect(it).toMatchObject({ target: T.ship, status: "sent", payload: { text: "Also show the totals row in bold" } });
  const inbox = path.join(home, "state", `${T.ship}.inbox`);
  expect(fs.readdirSync(inbox).filter((f) => f.endsWith(".msg")).map((f) => fs.readFileSync(path.join(inbox,f),"utf8")).join("\n")).toContain("Also show the totals row in bold");
});
