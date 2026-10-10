import { test, expect } from "./devtools";
import { z } from "zod";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildSandbox } from "../sandbox";
import { shot } from "./shot";
import { ServerRun } from "../../src/shared/servers";
import { startHerdrReplyRelay } from "./review-server-relay";

test.skip(!process.env.E2E_REVIEW_SERVERS_LAB, "Run with scripts/lab-review-servers.sh on an isolated Herdr session.");
test("shared terminal groups, canvas controls, updates and private cleanup", async ({ page, request, context }) => {
  test.setTimeout(120000);
  const root = path.resolve("."), fixture = path.join(root, "tests/fixtures/review-server.mjs");
  const definition = {
    id: "review-fixture", name: "Dossier review fixture", purpose: "review", project: "Safe dossier fixture", change: "First change", branch: "fm/jr-review-servers", creator: "fixture creator", canvas: false,
    url: "http://127.0.0.1:4325", members: [
      { id: "frontend", name: "Frontend", cwd: root, command: `${process.execPath} ${fixture} 4325 'First change'`, ports: [4325] },
      { id: "backend", name: "Backend", cwd: root, command: `${process.execPath} ${fixture} 0 Backend`, ports: [] },
    ],
  };
  const create = await request.post("/api/servers", { data: definition });
  expect(create.ok(), await create.text()).toBeTruthy();
  const act = async (action: string, member?: string, id = definition.id, purpose = "review") => {
    const r = await request.post(`/api/servers/${id}/action`, { data: { action, purpose, ...(member ? { member } : {}) } });
    expect(r.ok(), await r.text()).toBeTruthy();
  };
  const group = async () => (await request.get(`/api/servers/${definition.id}`)).json();
  try {
    await page.goto("/#/map");
    await page.getByRole("link", { name: "Servers", exact: true }).first().click();
    await expect(page.getByRole("heading", { name: "Servers", exact: true })).toBeVisible();
    const card = page.locator(`[data-server="${definition.id}"]`);
    await expect(card.getByRole("button", { name: "Open review", exact: true })).toBeDisabled();
    await expect(card.getByText("Not ready to open", { exact: false })).toBeVisible();
    await card.getByRole("button", { name: "Start group", exact: true }).click();
    await expect.poll(async () => (await group()).instances.map((m: { state: string }) => m.state), { timeout: 15000 }).toEqual(["running", "running"]);
    await card.getByRole("button", { name: "Add to canvas", exact: true }).click();
    const canvas = page.locator('.map-node [data-server="review-fixture"]');
    await expect(canvas).toBeVisible();
    await page.locator('.region-label[data-region="server:review-fixture"]').getByRole("button", { name: "Dossier review fixture, open", exact: true }).press("Alt+ArrowRight");
    await expect.poll(async () => (await (await request.get("/api/missions/map/layout")).json())["server:review-fixture"]).toBeTruthy();
    await shot(page, "review-servers", "01-canvas-running");
    const popupWait = context.waitForEvent("page");
    await canvas.getByRole("link", { name: "Open review", exact: true }).click();
    const popup = await popupWait;
    await expect(popup.getByRole("heading", { name: "First change" })).toBeVisible();
    await popup.close();
    await canvas.getByRole("button", { name: "Stop group", exact: true }).click();
    await expect.poll(async () => (await group()).state).toBe("stopped");
    await expect(canvas.getByRole("button", { name: "Open review", exact: true })).toBeDisabled();
    await shot(page, "review-servers", "07-canvas-stopped");
    await canvas.getByRole("button", { name: "Restart group", exact: true }).click();
    await expect.poll(async () => (await group()).state).toBe("running");
    await canvas.getByRole("link", { name: "Dossier review fixture", exact: true }).click();
    await expect(page.locator("[data-terminal-state=live]")).toHaveCount(2);
    await page.locator(".server-terminals").scrollIntoViewIfNeeded();
    await expect(page.getByRole("region", { name: "Frontend terminal", exact: true })).toBeVisible();
    await shot(page, "review-servers", "02-both-terminals");
    await page.getByRole("button", { name: "Stop Backend", exact: true }).click();
    await expect.poll(async () => (await group()).instances.map((m: { state: string }) => m.state)).toEqual(["running", "stopped"]);
    await expect(page.locator('[data-server="review-fixture"]').getByRole("button", { name: "Open review", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Start Backend", exact: true }).click();
    await expect.poll(async () => (await group()).state).toBe("running");
    const before = (await group()).instances[0].run.nonce;
    await act("start");
    expect((await group()).instances[0].run.nonce).toBe(before);
    const changed = { ...definition, canvas: true, change: "Second change", members: [{ ...definition.members[0], command: `${process.execPath} ${fixture} 4325 'Second change'` }, definition.members[1]] };
    expect((await request.put(`/api/servers/${definition.id}`, { data: changed })).ok()).toBeTruthy();
    await expect(page.getByText("Change saved. Update to show it in the running instances.")).toBeVisible();
    await page.getByRole("button", { name: "Update group", exact: true }).click();
    await expect.poll(async () => (await group()).instances.map((m: { run: { change: string } }) => m.run.change)).toEqual(["Second change", "Second change"]);
    await expect.poll(async () => (await group()).state).toBe("running");
    expect((await group()).instances[0].run.change).toBe("Second change");
    expect(await (await request.get("http://127.0.0.1:4325")).text()).toContain("Second change");
    await page.reload();
    await expect(page.locator("[data-terminal-state=live]")).toHaveCount(2);
    await page.locator(".server-terminals").scrollIntoViewIfNeeded();
    await shot(page, "review-servers", "03-updated-after-reload");
    const placed = await request.post("/api/missions/map/layout", { data: { group: `server:${definition.id}`, x: 180, y: 260 } });
    expect(placed.ok()).toBeTruthy();
    expect((await (await request.get("/api/missions/map/layout")).json())[`server:${definition.id}`]).toEqual({ x: 180, y: 260 });
    const privateDefinition = { ...definition, id: "private-fixture", name: "Private check", purpose: "test", canvas: false, url: undefined, members: [{ ...definition.members[0], ports: [], command: `${process.execPath} ${fixture} 0 Private` }] };
    await page.getByRole("link", { name: "All server groups", exact: true }).click();
    await page.getByRole("button", { name: "New server group", exact: true }).click();
    const editor = page.getByRole("form", { name: "New server group", exact: true });
    await editor.getByLabel("Group name", { exact: true }).fill("Private fixture");
    await editor.getByLabel("Project", { exact: true }).fill(privateDefinition.project);
    await editor.getByLabel("Change to review", { exact: true }).fill(privateDefinition.change);
    await editor.getByRole("combobox", { name: "Purpose", exact: true }).selectOption("test");
    await editor.getByLabel("Working directory", { exact: true }).fill(root);
    await editor.getByLabel("Foreground command", { exact: true }).fill(privateDefinition.members[0].command);
    const ports = editor.getByLabel("Ports (comma separated)", { exact: true });
    await ports.pressSequentially("4325,4324");
    await expect(ports).toHaveValue("4325,4324");
    await ports.fill("");
    await editor.getByRole("button", { name: "Save group", exact: true }).click();
    await expect(editor).toHaveCount(0);
    expect((await request.get("/api/servers/private-fixture")).ok()).toBeTruthy();
    await act("start", undefined, "private-fixture", "test");
    await expect.poll(async () => (await (await request.get("/api/servers/private-fixture")).json()).state).toBe("running");
    expect((await request.post("/api/servers/review-fixture/action", { data: { action: "stop", purpose: "test" } })).status()).toBe(409);
    await act("stop", undefined, "private-fixture", "test");
    expect((await group()).state).toBe("running");
    await act("restart");
    await expect.poll(async () => (await group()).state).toBe("running");
    await page.goto("/#/servers/review-fixture");
    await expect(page.locator("[data-terminal-state=live]")).toHaveCount(2);
    await page.locator(".server-terminals").scrollIntoViewIfNeeded();
    await shot(page, "review-servers", "04-group-restarted");
  } finally {
    // The browser fixture may already be disposed after a timeout. Cleanup
    // uses the owned daemon directly and remains scoped to these two ids.
    for (const [id, purpose] of [["private-fixture", "test"], [definition.id, "review"]]) {
      await fetch(`http://127.0.0.1:${process.env.E2E_PORT ?? "4406"}/api/servers/${id}/action`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "stop", purpose }), signal: AbortSignal.timeout(15000),
      }).catch(() => {});
    }
  }
});

test("creator exit, daemon restart, ownership loss and occupied port", async ({ page, request }) => {
  test.setTimeout(120000);
  const root = path.resolve("."), sb = buildSandbox(path.join(root, ".joyride", "review-server-restart"), { port: 4329 });
  const env = { ...process.env, ...sb.env, JOYRIDE_HERDR_SOCKET: process.env.E2E_LAB_HERDR_SOCKET, JOYRIDE_UI_DIR: path.join(root, `dist/ui-${process.env.E2E_PORT ?? "4406"}`) };
  const base = "http://127.0.0.1:4329";
  let daemon: ReturnType<typeof spawn> | null = null;
  const start = async () => {
    daemon = spawn("nice", ["-n", "10", process.execPath, "--import", "tsx", "src/server/main.ts"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    const output = fs.createWriteStream(path.join(sb.dir, "daemon-proof.log"), { flags: "a" });
    daemon.stdout?.pipe(output, { end: false }); daemon.stderr?.pipe(output, { end: false }); daemon.once("exit", () => output.end());
    await expect.poll(async () => { try { const r = await request.get(base + "/api/health", { timeout: 500 }); const h = await r.json(); return h.ok && h.root === sb.env.JOYRIDE_HOME; } catch { return false; } }, { timeout: 15000 }).toBe(true);
    await expect.poll(async () => (await (await request.get(base + "/api/herdr/status")).json()).connected).toBe(true);
  };
  const stop = async () => {
    const own = daemon; daemon = null;
    if (!own || own.exitCode !== null) return;
    await new Promise<void>((resolve) => { own.once("exit", () => resolve()); own.kill("SIGTERM"); });
  };
  const cli = (args: string[]) => promisify(execFile)("nice", ["-n", "10", process.execPath, "--import", "tsx", "src/cli/joyride.ts", "servers", ...args], { cwd: root, env });
  const fixture = path.join(root, "tests/fixtures/review-server.mjs");
  const group = { id: "retained-review", name: "Retained review", purpose: "review", project: "Safe fixture", change: "Creator exited", branch: "fm/jr-review-servers", creator: "CLI creator exits after start", canvas: true, url: "http://127.0.0.1:4325", members: [{ id: "frontend", name: "Frontend", cwd: root, command: `${process.execPath} ${fixture} 4325 Retained`, ports: [4325] }] };
  const file = path.join(sb.dir, "group.json"); fs.writeFileSync(file, JSON.stringify(group));
  const view = async () => (await request.get(base + "/api/servers/retained-review")).json();
  let occupied: http.Server | null = null;
  try {
    await start();
    await cli(["create", file]);
    await cli(["start", group.id]);
    await expect.poll(async () => (await view()).state).toBe("running");
    const nonce = (await view()).instances[0].run.nonce;
    const layout = await request.post(base + "/api/missions/map/layout", { data: { group: `server:${group.id}`, x: 280, y: 160 } }); expect(layout.ok()).toBeTruthy();
    await stop();
    expect(await (await request.get("http://127.0.0.1:4325")).text()).toContain("Retained");
    await start();
    await expect.poll(async () => (await view()).state).toBe("running");
    expect((await view()).instances[0].run.nonce).toBe(nonce);
    await cli(["start", group.id]); expect((await view()).instances[0].run.nonce).toBe(nonce);
    expect((await (await request.get(base + "/api/missions/map/layout")).json())[`server:${group.id}`]).toEqual({ x: 280, y: 160 });
    await page.goto(base + `/#/map?focus=server:${group.id}`);
    await expect(page.locator('[data-server="retained-review"]')).toBeVisible();
    await shot(page, "review-servers", "05-retained-after-daemon-restart");
    await cli(["restart", group.id, "--request", "restart-once"]);
    await expect.poll(async () => (await view()).state).toBe("running");
    const restarted = (await view()).instances[0].run.nonce;
    await cli(["restart", group.id, "--request", "restart-once"]);
    expect((await view()).instances[0].run.nonce).toBe(restarted);
    // Herdr closes only the terminal created and identified by this test group.
    const run = (await view()).instances[0].run;
    const helper = process.env.FM_HERDR_LAB_HELPER ?? path.resolve("vendor/firstmate/bin/fm-herdr-lab.sh");
    const session = path.basename(path.dirname(String(process.env.E2E_LAB_HERDR_SOCKET)));
    await promisify(execFile)(helper, ["run", session, "pane", "close", run.pane], { env: process.env });
    await expect.poll(async () => (await view()).state).toBe("failed");
    await stop(); await start();
    expect((await view()).state).toBe("failed");
    await cli(["start", group.id]); await expect.poll(async () => (await view()).state).toBe("running");
    occupied = http.createServer((_req, res) => res.end("unrelated owner"));
    await new Promise<void>((resolve) => occupied?.listen(0, "127.0.0.1", resolve));
    const occupiedAddress = occupied.address();
    if (!occupiedAddress || typeof occupiedAddress === "string") throw new Error("Missing owned listener port");
    const occupiedPort = occupiedAddress.port;
    const conflict = { ...group, id: "occupied-test", name: "Occupied port", purpose: "test", canvas: false, url: undefined, members: [{ ...group.members[0], ports: [occupiedPort], command: `${process.execPath} ${fixture} ${occupiedPort} Conflict` }] };
    expect((await request.post(base + "/api/servers", { data: conflict })).ok()).toBeTruthy();
    const refused = await request.post(base + "/api/servers/occupied-test/action", { data: { action: "start", purpose: "test" } });
    expect(refused.status()).toBe(409); expect((await refused.json()).error).toContain(`Port ${occupiedPort} is occupied`);
    expect(await (await request.get(`http://127.0.0.1:${occupiedPort}`)).text()).toBe("unrelated owner");
    expect((await view()).state).toBe("running");
    await shot(page, "review-servers", "06-owned-recovery");
  } finally {
    if (daemon) await request.post(base + "/api/servers/retained-review/action", { data: { action: "stop", purpose: "review" } });
    if (occupied) await new Promise<void>((resolve) => occupied?.close(() => resolve()));
    await stop();
  }
});

test("real owned servers tolerate delayed replies and reconcile lost replies without replay", async ({ page, request, devtools }) => {
  test.setTimeout(120000);
  const root = path.resolve("."), sb = buildSandbox(path.join(root, ".joyride", "review-server-replies"), { port: 4329 });
  const relay = await startHerdrReplyRelay(path.join(sb.dir, "rpc.sock"), String(process.env.E2E_LAB_HERDR_SOCKET));
  const env = { ...process.env, ...sb.env, JOYRIDE_HERDR_SOCKET: relay.socket,
    JOYRIDE_UI_DIR: path.join(root, `dist/ui-${process.env.E2E_PORT ?? "4406"}`) };
  const base = "http://127.0.0.1:4329";
  const daemon = spawn("nice", ["-n", "10", process.execPath, "--import", "tsx", "src/server/main.ts"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  const output = fs.createWriteStream(path.join(sb.dir, "daemon-proof.log"));
  daemon.stdout?.pipe(output, { end: false }); daemon.stderr?.pipe(output, { end: false }); daemon.once("exit", () => output.end());
  const fixture = path.join(root, "tests/fixtures/review-server.mjs");
  const View = z.object({ state: z.string(), instances: z.array(z.object({ state: z.string(), run: ServerRun.nullable() })) });
  const view = async (id: string) => View.parse(await (await request.get(base + `/api/servers/${id}`)).json());
  const runOf = async (id: string) => { const run = (await view(id)).instances[0]?.run; if (!run) throw new Error("Missing owned launch"); return run; };
  const action = (id: string, kind = "start") => request.post(base + `/api/servers/${id}/action`, { data: { action: kind, purpose: "test", request: `${id}-${kind}-once` } });
  const create = async (id: string) => {
    const result = await request.post(base + "/api/servers", { data: {
      id, name: id, purpose: "test", project: "Safe real Herdr reply proof", change: "Reply recovery", canvas: false,
      url: "http://127.0.0.1:4325", members: [{ id: "frontend", name: "Frontend", cwd: root,
        command: `${process.execPath} ${fixture} 4325 ${id}`, ports: [4325] }],
    } });
    expect(result.ok(), await result.text()).toBe(true);
  };
  const mutations = () => relay.calls.filter(c => ["workspace.create", "pane.send_input", "pane.close"].includes(c.method));
  try {
    await expect.poll(async () => { try { return (await (await request.get(base + "/api/health", { timeout: 500 })).json()).root; } catch { return null; } }, { timeout: 15000 }).toBe(sb.env.JOYRIDE_HOME);
    await expect.poll(async () => (await (await request.get(base + "/api/herdr/status")).json()).connected).toBe(true);

    await create("delayed-real-reply");
    relay.arm({ method: "workspace.create", mode: "delay", ms: 1800 });
    relay.arm({ method: "pane.send_input", mode: "delay", ms: 1800 });
    const delayed = await action("delayed-real-reply");
    expect(delayed.ok(), await delayed.text()).toBe(true);
    await expect.poll(async () => (await view("delayed-real-reply")).state).toBe("running");
    expect(await (await request.get("http://127.0.0.1:4325")).text()).toContain("delayed-real-reply");
    const launched = await runOf("delayed-real-reply"), completed = mutations();
    expect((await action("delayed-real-reply")).ok()).toBe(true);
    expect((await runOf("delayed-real-reply")).nonce).toBe(launched.nonce);
    expect(mutations()).toEqual(completed);
    expect((await action("delayed-real-reply", "stop")).ok()).toBe(true);

    await create("lost-real-input");
    const beforeInput = mutations().length;
    relay.arm({ method: "pane.send_input", mode: "drop" });
    const lostInput = await action("lost-real-input");
    expect(lostInput.status()).toBe(409);
    expect((await lostInput.json()).error).toContain("pane.send_input");
    await expect.poll(async () => (await view("lost-real-input")).state).toBe("running");
    const running = await runOf("lost-real-input");
    expect(await (await request.get("http://127.0.0.1:4325")).text()).toContain("lost-real-input");
    expect((await action("lost-real-input")).ok()).toBe(true);
    expect((await runOf("lost-real-input")).nonce).toBe(running.nonce);
    expect(mutations().slice(beforeInput).map(c => c.method)).toEqual(["workspace.create", "pane.send_input"]);
    await devtools.command(page, "open", base + "/#/servers/lost-real-input");
    await expect(page.locator("[data-terminal-state=live]")).toHaveCount(1);
    await devtools.command(page, "screenshot", path.resolve("docs/checkpoints/review-servers/08-lost-reply-owned-running.png"));
    expect((await action("lost-real-input", "stop")).ok()).toBe(true);

    await create("lost-real-create");
    const beforeCreate = mutations().length;
    relay.arm({ method: "workspace.create", mode: "drop" });
    const lostCreate = await action("lost-real-create");
    expect(lostCreate.status()).toBe(409);
    expect((await lostCreate.json()).error).toContain("workspace.create");
    const preserved = await runOf("lost-real-create");
    expect(preserved.phase).toBe("prepared");
    expect(preserved.pane).toBeTruthy(); expect(preserved.terminal).toBeTruthy();
    expect((await view("lost-real-create")).state).toBe("unknown");
    expect((await action("lost-real-create")).status()).toBe(409);
    expect(await runOf("lost-real-create")).toEqual(preserved);
    expect(mutations().slice(beforeCreate).map(c => c.method)).toEqual(["workspace.create"]);
    await devtools.command(page, "open", base + "/#/servers/lost-real-create");
    await expect(page.locator('[data-server="lost-real-create"] .server-state').first()).toHaveText("unknown");
    await expect(page.locator('[data-server="lost-real-create"]').getByRole("button", { name: "Open review", exact: true })).toBeDisabled();
    await expect(page.locator('[data-server="lost-real-create"]')).toContainText("http://127.0.0.1:4325");
    await expect(page.locator('[data-server="lost-real-create"]')).toContainText("Not ready to open");
    await devtools.command(page, "screenshot", path.resolve("docs/checkpoints/review-servers/09-lost-create-preserved-unknown.png"));
  } finally {
    // Unknown prepared ownership is left intact for the guarded named-lab teardown.
    for (const id of ["delayed-real-reply", "lost-real-input"]) {
      await action(id, "stop").catch(() => {});
    }
    if (daemon.exitCode === null) await new Promise<void>(resolve => { daemon.once("exit", () => resolve()); daemon.kill("SIGTERM"); });
    await relay.stop();
  }
});
