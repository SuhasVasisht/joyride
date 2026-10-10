// CP1 backend journey: real vendored intake + tasks-axi in a disposable FM_HOME.
// JOYRIDE_TEST stubs every terminal doorbell. No real Herdr lifecycle is involved.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test, expect } from "@playwright/test";
import { buildFirstmateHome, FIXTURE_TASKS as T } from "./crew-fixture";
import { addAskFixtures, ASK_TASKS } from "./asks-fixture";
import { BASE, call, PORT, waitUntil } from "./map-seed";
import { fakeHerdrControl } from "../fixtures/fake-herdr";
import { shot } from "./shot";

const env: Record<string, string> = JSON.parse(fs.readFileSync(`/tmp/joyride-e2e-${PORT}/env.json`, "utf8"));
const home = path.join(env.JOYRIDE_RUNTIME, "firstmate");
const mission = "cp1-answer-export";
let promptPane = "";
const answer = async (target: string, text: string, mode?: "done" | "release", origin = "captain") =>
  (await call("POST", "/api/intents", { kind: "answer_ask", target, origin, payload: { answer: text, ...(mode ? { mode } : {}) } })).body;
const asks = async () => (await call("GET", "/api/asks")).body.asks;
const backlog = () => fs.readFileSync(path.join(home, "data", "backlog.md"), "utf8");
const notes = () => fs.readdirSync(path.join(home, "state", "inbox")).filter((n) => n.endsWith(".note"));

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  expect(home.startsWith(`/tmp/joyride-e2e-${PORT}/`)).toBe(true);
  expect(execFileSync("tasks-axi", ["--version"], { encoding: "utf8" })).toMatch(/\d+\.\d+\.\d+/);
  if ((await call("GET", `/api/missions/${mission}`)).status === 404) await call("POST", "/api/missions", { id: mission, title: "CSV export", repos: ["/tmp/joyride-fixture-repos/alpha"] });
  buildFirstmateHome(home, mission);
  addAskFixtures(home);
  fs.writeFileSync(path.join(home, "data", "secondmates.md"), "");
  await waitUntil(async () => (await asks()).some((a: { id: string }) => a.id === `hold:${ASK_TASKS.calls}`));
});

test.afterAll(async () => {
  if (promptPane) await fakeHerdrControl(env.JOYRIDE_HERDR_SOCKET, "fake.close_pane", { pane_id: promptPane });
  await call("PUT", `/api/missions/${mission}`, { archive: true });
});

test("Firstmate-origin answers cannot close a captain call", async () => {
  const before = backlog();
  const result = await answer(`hold:${ASK_TASKS.calls}`, "Use both", "done", "firstmate");
  expect(result).toMatchObject({ status: "failed", result: { refused: "captain_only" } });
  expect(backlog()).toBe(before);
});

test("done records the captain's exact words, wakes stopped Firstmate and creates one idea decision", async ({ page }) => {
  const text = "Go with your recommendations: 1 A, 2 B. Keep the server's rounding.";
  const target = `hold:${ASK_TASKS.calls}`;
  const result = await answer(target, text, "done");
  expect(result.status, result.error).toBe("sent");
  expect(backlog()).toContain(`- [x] ${ASK_TASKS.calls}`);
  expect(backlog()).toContain("Resolution recorded by fm-captain-hold");
  expect(backlog()).toContain(text);
  expect(backlog()).toContain("joyride-map");
  expect(notes()).toHaveLength(1);
  const note = fs.readFileSync(path.join(home, "state", "inbox", notes()[0]), "utf8");
  expect(note).toContain(`request_id=${result.id}`);
  expect(note).toContain(`Captain answered ${ASK_TASKS.calls} on the map: ${text}`);
  expect(fs.readFileSync(path.join(home, "state", ".wake-queue"), "utf8")).toContain("check");
  const entry = (await call("GET", `/api/notes/${result.result.note}`)).body;
  expect(entry).toMatchObject({ kind: "note", status: "active", scope: `mission:${mission}` });
  expect(entry.body).toContain(text);
  expect(entry.body).toContain("report.md");
  const before = backlog();
  const replay = await answer(target, text, "done");
  expect(replay).toMatchObject({ status: "sent", result: { replay: true, note: entry.id } });
  expect(backlog()).toBe(before); expect(notes()).toHaveLength(1);
  expect((await asks()).some((a: { id: string }) => a.id === target)).toBe(false);
  await page.goto(`${BASE}/api/notes/${entry.id}`);
  await shot(page, "C12", "cp1-captain-answer-decision");
});

test("release unholds a work item without completing it", async () => {
  const result = await answer(`hold:${T.queued}`, "Approved, start the docs", "release");
  expect(result.status, result.error).toBe("sent");
  const task = (await call("GET", `/api/firstmate/tasks/${T.queued}`)).body;
  expect(task).toMatchObject({ section: "queued", hold_kind: null, hold_reason: null });
  expect(backlog()).toContain(`- [ ] ${T.queued}`);
  expect(backlog()).not.toContain(`- [x] ${T.queued}`);
  expect((await asks()).some((a: { id: string }) => a.id === `hold:${T.queued}`)).toBe(false);
});

test("a keyed decision writes its durable inbox and exact resolved key once", async () => {
  const target = `decision:${T.scout}:flake-cause`;
  const result = await answer(target, "Fix the download race first");
  expect(result.status, result.error).toBe("sent");
  const statusFile = path.join(home, "state", `${T.scout}.status`);
  const log = fs.readFileSync(statusFile, "utf8");
  expect(log).toMatch(/resolved .*\[key=flake-cause\].*answered: Fix the download race first/);
  const inbox = path.join(home, "state", `${T.scout}.inbox`);
  const records = fs.readdirSync(inbox).filter((n) => n.endsWith(".msg"));
  expect(records).toHaveLength(1);
  expect(fs.readFileSync(path.join(inbox, records[0]), "utf8")).toContain("Fix the download race first");
  expect(await answer(target, "Fix the download race first")).toMatchObject({ status: "sent", result: { replay: true } });
  expect(fs.readFileSync(statusFile, "utf8")).toBe(log);
  expect((await asks()).some((a: { id: string }) => a.id === target)).toBe(false);
  expect(fs.existsSync(path.join(env.JOYRIDE_RUNTIME, "firstmate-stubs", "calls.log"))).toBe(true);
});

test("a watched permission prompt sends the selected keys through answer_prompt once", async () => {
  const socket = env.JOYRIDE_HERDR_SOCKET;
  promptPane = (await fakeHerdrControl(socket, "fake.add_pane", { cwd: "/tmp/joyride-fixture-repos/alpha", agent: "claude", agent_status: "blocked", title: "CP1 permission prompt" })).pane.pane_id;
  const worker = `local:${promptPane}`;
  await fakeHerdrControl(socket, "fake.set_menu", { pane_id: promptPane, status: "blocked" });
  await waitUntil(async () => (await call("GET", `/api/workers/${encodeURIComponent(worker)}`)).status === 200);
  const attention = (await call("POST", "/api/attention", { level: "L3", kind: "approval", title: "Allow Bash?", why: "Allow this tool", worker })).body;
  const target = `attention:${attention.id}`;
  const result = await answer(target, "allow");
  expect(result.status, result.error).toBe("sent");
  const child = (await call("GET", `/api/intents/${result.result.delivery.intent}`)).body;
  expect(child).toMatchObject({ kind: "answer_prompt", origin: "captain", result: { worker, choice: "allow" } });
  const before = (await fakeHerdrControl(socket, "fake.state")).keys.length;
  expect(await answer(target, "allow")).toMatchObject({ status: "sent", result: { replay: true } });
  expect((await fakeHerdrControl(socket, "fake.state")).keys).toHaveLength(before);
  expect((await asks()).some((a: { id: string }) => a.id === target)).toBe(false);
});

test("guard approvals and denials use the captain's existing intents", async () => {
  for (const choice of ["allow", "deny"] as const) {
    const guard = (await call("POST", "/api/guard/requests", { rule: "push", title: "git push", tool: "Bash", input: { command: "git push origin main" }, session: `fixture-${choice}`, agent: "claude", cwd: "/tmp" })).body;
    const result = await answer(`guard:${guard.id}`, choice);
    expect(result.status, result.error).toBe("sent");
    expect((await call("GET", `/api/guard/requests/${guard.id}`)).body.decision).toBe(choice);
  }
});

test("review acknowledgement clears the ask and is idempotent", async () => {
  const item = (await call("POST", "/api/attention", { level: "L2", kind: "review", title: "Review export report", why: "Report is ready" })).body;
  const target = `attention:${item.id}`;
  expect((await answer(target, "Reviewed")).status).toBe("sent");
  expect(await answer(target, "Reviewed")).toMatchObject({ status: "sent", result: { replay: true } });
  expect((await asks()).some((a: { id: string }) => a.id === target)).toBe(false);
});
