// CP4a notes backend against the real sandbox daemon: /api/notes create, list by anchor,
// edit and archive; the `joyride notes` CLI (online and with the daemon unreachable); the
// per-task digest and a real SessionStart hook run for a crewmate (FM_TASK_ID); notes kept
// out of ordinary SessionStart context; and authored notes in Search.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { shot } from "./shot";

const PORT = Number(process.env.E2E_PORT ?? 4399);
if (PORT === 4317 || PORT === 3000) throw new Error("notes e2e refuses to run against the real daemon port");
const BASE = `http://127.0.0.1:${PORT}`;
const SANDBOX = `/tmp/joyride-e2e-${PORT}`;
const REPO = `${SANDBOX}/repos/notes-shop`;
const IDEA = "notes-control-plane";
const TASK = "cp4a-notes-e2e";
const ROOT = path.resolve(".");
const BUN = process.env.BUN_BIN ?? path.join(os.homedir(), ".bun", "bin", "bun");

async function call<T = any>(method: string, p: string, body?: unknown): Promise<{ status: number; body: T }> {
  const r = await fetch(BASE + p, { method, headers: { "content-type": "application/json", connection: "close" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : (null as T) };
}
const env = (): Record<string, string> => ({ ...(process.env as Record<string, string>), ...JSON.parse(fs.readFileSync(path.join(SANDBOX, "env.json"), "utf8")) });
function cli(args: string[], extra: Record<string, string> = {}, input?: string) {
  const e = { ...env(), ...extra };
  delete e.FM_TASK_ID;
  if (extra.FM_TASK_ID) e.FM_TASK_ID = extra.FM_TASK_ID;
  const r = spawnSync(path.join(ROOT, "node_modules/.bin/tsx"), [path.join(ROOT, "src/cli/joyride.ts"), "notes", ...args], { env: e, encoding: "utf8", input, timeout: 30000 });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}
function hook(cwd: string, task?: string) {
  const e = env();
  delete e.JOYRIDE_INTERNAL;
  delete e.FM_TASK_ID;
  if (task) e.FM_TASK_ID = task;
  const r = spawnSync(BUN, [path.join(ROOT, "src/hooks/hook.ts"), "claude", "SessionStart"], {
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: `e2e-notes-${task ?? "none"}`, cwd, source: "startup" }), env: e, encoding: "utf8", timeout: 20000,
  });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout ? String(JSON.parse(r.stdout).hookSpecificOutput.additionalContext) : "";
}

test.describe.configure({ mode: "serial" });

test("notes: API, CLI, task digest and the SessionStart hook", async ({ page }) => {
  if (!fs.existsSync(path.join(REPO, ".git"))) {
    fs.mkdirSync(path.join(REPO, "src"), { recursive: true });
    const g = (...a: string[]) => execFileSync("git", ["-c", "user.email=e2e@local", "-c", "user.name=e2e", ...a], { cwd: REPO });
    g("init", "-q", "-b", "main");
    fs.writeFileSync(path.join(REPO, "src/cart.ts"), "export const total = 0;\n");
    g("add", "-A"); g("commit", "-qm", "init");
  }
  const m = await call("POST", "/api/missions", { id: IDEA, title: "Map as control plane", crews: [TASK], repos: [REPO] });
  expect([201, 400]).toContain(m.status); // 400 when a retry finds it already there

  let ideaNote: any, taskNote: any, agentNote: any;
  await test.step("API: create on an idea, a task, an agent and globally", async () => {
    ideaNote = (await call("POST", "/api/notes", { idea: IDEA, bullets: ["Save first, close later", "Only captain calls turn orange"] })).body;
    expect(ideaNote).toMatchObject({ kind: "note", status: "active", scope: `mission:${IDEA}` });
    taskNote = (await call("POST", "/api/notes", { task: TASK, text: "- Keep the hook fast\n- No map UI in this phase" })).body;
    expect(taskNote.bullets).toEqual(["Keep the hook fast", "No map UI in this phase"]);
    agentNote = (await call("POST", "/api/notes", { session: "claude:e2e-agent-1", bullets: ["This agent is on the old branch"] })).body;
    expect(agentNote.scope).toBe("session:claude:e2e-agent-1");
    const g = await call("POST", "/api/notes", { bullets: ["Lunch at noon"] });
    expect(g.status).toBe(201);
    expect(fs.readFileSync(path.join(env().JOYRIDE_HOME, "notes", `${ideaNote.id}.md`), "utf8")).toContain("kind: note");
    const bad = await call<any>("POST", "/api/notes", { idea: "not-an-idea", bullets: ["x"] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/There is no idea "not-an-idea"/);
  });

  await test.step("API: list by anchor, edit, archive", async () => {
    expect((await call<any[]>("GET", `/api/notes?task=${TASK}`)).body.map((n) => n.id)).toEqual([taskNote.id]);
    expect((await call<any[]>("GET", `/api/notes?idea=${IDEA}`)).body.map((n) => n.id)).toEqual([ideaNote.id]);
    expect((await call<any[]>("GET", "/api/notes?session=claude:e2e-agent-1")).body.map((n) => n.id)).toEqual([agentNote.id]);
    const e = await call<any>("PUT", `/api/notes/${taskNote.id}`, { bullets: ["Keep the hook fast", "No map UI in this phase", "Rebase onto main before done"] });
    expect(e.status).toBe(200);
    expect(e.body.bullets).toHaveLength(3);
    const draft = (await call<any>("POST", "/api/notes", { task: TASK, bullets: ["Scratch this"] })).body;
    expect((await call<any>("POST", `/api/notes/${draft.id}/archive`)).body.status).toBe("archived");
    expect((await call<any[]>("GET", `/api/notes?task=${TASK}`)).body.map((n) => n.id)).toEqual([taskNote.id]);
    expect((await call<any[]>("GET", `/api/notes?task=${TASK}&include_archived=1`)).body.map((n) => n.id).sort()).toEqual([taskNote.id, draft.id].sort());
  });

  await test.step("task digest holds the task's notes and its idea's", async () => {
    const t = (await call<any>("GET", `/api/notes/task/${TASK}`)).body;
    expect(t).toMatchObject({ task: TASK, mission: { id: IDEA, title: "Map as control plane" }, file: `task-${TASK}.md` });
    expect(t.digest).toContain(`Task ${TASK}:\n- Keep the hook fast\n- No map UI in this phase\n- Rebase onto main before done`);
    expect(t.digest).toContain(`Idea ${IDEA}:\n- Save first, close later\n- Only captain calls turn orange`);
    expect(t.digest).not.toMatch(/Scratch this|Lunch at noon|old branch/);
    await expect.poll(() => { try { return fs.readFileSync(path.join(env().JOYRIDE_RUNTIME, "task-notes", `task-${TASK}.md`), "utf8"); } catch { return ""; } }).toBe(t.digest);
  });

  await test.step("a real SessionStart hook run appends the task's notes for its crewmate only", async () => {
    const digest = (await call<any>("GET", `/api/notes/task/${TASK}`)).body.digest.trim();
    const crew = hook(path.join(REPO, "src"), TASK);
    expect(crew.endsWith(digest)).toBe(true);
    const captain = hook(path.join(REPO, "src"));
    expect(captain.trim()).toBe("");
    expect(captain).not.toMatch(/Save first|Keep the hook fast|Lunch at noon/);
    fs.mkdirSync("test-results", { recursive: true });
    fs.writeFileSync("test-results/notes-hook-sessionstart.txt", `FM_TASK_ID=${TASK}\n\n${crew}\n\n--- without FM_TASK_ID ---\n\n${captain}\n`);
  });

  await test.step("repo and global memory routes are retired", async () => {
    expect((await call("GET", "/api/memory/digest")).status).toBe(404);
  });

  await test.step("joyride notes CLI: list, add, edit, archive, and listing with the daemon down", async () => {
    const list = cli(["--task", TASK]);
    expect(list.code, list.err).toBe(0);
    expect(list.out).toContain(`Task ${TASK}`);
    expect(list.out).toContain(`task:${TASK} · ${taskNote.id}`);
    expect(list.out).toContain("  - Rebase onto main before done");
    expect(list.out).toContain(`Idea ${IDEA} (Map as control plane)`);
    expect(list.out).toContain("  - Save first, close later");
    // A crewmate's FM_TASK_ID is the default place, for reading and adding.
    expect(cli([], { FM_TASK_ID: TASK }).out).toBe(list.out);
    const add = cli(["add", "Found by the crewmate", "second bullet"], { FM_TASK_ID: TASK });
    expect(add.code, add.err).toBe(0);
    const id = add.out.match(/^Saved (note-\S+)/)![1];
    const saved = (await call<any>("GET", `/api/notes/${id}`)).body;
    expect(saved).toMatchObject({ scope: `task:${TASK}`, bullets: ["Found by the crewmate", "second bullet"], provenance: { type: "agent", ref: `task:${TASK}` } });
    const stdin = cli(["add", "--idea", IDEA, "-"], {}, "- from stdin\n- two\n");
    expect(stdin.code, stdin.err).toBe(0);
    expect(stdin.out).toContain(`mission:${IDEA}`);
    const edit = cli(["edit", id, "Edited by the crewmate"]);
    expect(edit.out).toContain("  - Edited by the crewmate");
    expect(cli(["archive", id]).out).toMatch(new RegExp(`^Archived ${id}`));
    expect(cli(["--idea", IDEA, "--json"]).out).toContain('"from stdin"');
    const bad = cli(["add", "--idea", "no-such-idea", "x"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/There is no idea "no-such-idea"/);
    const offline = cli(["--task", TASK], { JOYRIDE_URL: "http://127.0.0.1:1" });
    expect(offline.code, offline.err).toBe(0);
    expect(offline.out).toContain("- Keep the hook fast");
    expect(offline.out).toContain("daemon is not reachable");
    const offWrite = cli(["add", "x"], { JOYRIDE_URL: "http://127.0.0.1:1" });
    expect(offWrite.code).toBe(1);
    expect(offWrite.err).toMatch(/not reachable .* nothing was saved/);
    fs.writeFileSync("test-results/notes-cli.txt", `$ joyride notes --task ${TASK}\n${list.out}\n\n$ FM_TASK_ID=${TASK} joyride notes add "Found by the crewmate" "second bullet"\n${add.out}\n\n$ joyride notes --task ${TASK}   (daemon down)\n${offline.out}\n`);
  });

  await test.step("notes show in the knowledge home with their kind and place", async () => {
    await page.goto("/#/memory/entries");
    await expect(page.getByTestId("knowledge-page")).toBeVisible();
    await page.getByTestId("type-filter").getByRole("button", { name: /^Notes/ }).click();
    await expect(page).toHaveURL(/types=notes/);
    const list = page.locator(".kn-groups");
    await expect(list.getByText("Save first, close later").first()).toBeVisible();
    await expect(list.getByText("Lunch at noon").first()).toBeVisible();
    await expect(list.getByText("Never call payments from tests")).toHaveCount(0);
    await list.getByText("Keep the hook fast").first().click();
    await expect(page.getByTestId("note-detail")).toContainText("Keep the hook fast");
    await page.getByTestId("open-on-board").click();
    await expect(page.getByTestId("board-page")).toBeVisible();
    await page.waitForTimeout(250);
    await shot(page, "CP4a", "notes-memory-page");
  });
});
