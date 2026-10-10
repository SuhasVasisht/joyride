import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { z } from "zod";
import YAML from "yaml";
import { parse, stringify } from "smol-toml";
import type { HerdrApi } from "../src/modules/live/herdr.ts";
import { buildSandbox } from "../tests/sandbox.ts";

const exec = promisify(execFile);
const home = z.string().parse(process.env.FM_HOME);
const helper = z.string().parse(process.env.HERDR_LAB_HELPER);
const sessionName = z.string().regex(/^fm-lab-/).parse(process.env.HERDR_LAB_SESSION);
const vendor = z.string().parse(process.env.JOYRIDE_FIRSTMATE_DIR);
assert(fs.existsSync(path.join(home, ".fm-lab-home")));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const until = async (fn: () => Promise<boolean>, label: string, ms = 90_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(250); }
  throw new Error(`Timed out waiting for ${label}`);
};
async function cli(args: string[]) {
  return (await exec(helper, ["run", sessionName, ...args], { timeout: 65_000, maxBuffer: 4 << 20 })).stdout;
}
const sb = buildSandbox(path.join(home, "sandbox"), { port: 4326 });
const realSocket = path.join(os.homedir(), ".config/herdr/sessions", sessionName, "herdr.sock");
assert(fs.existsSync(realSocket));
const privateSocketDir = z.string().regex(/^\/tmp\/fml\.[A-Za-z0-9]{6}$/).parse(process.env.LAB_TMUX_DIR);
const proxySocket = path.join(privateSocketDir, "joyride-proxy.sock");
const codexHome = path.join(home, "codex");
fs.mkdirSync(codexHome);
fs.copyFileSync(path.join(os.homedir(), ".codex/auth.json"), path.join(codexHome, "auth.json"));
fs.chmodSync(path.join(codexHome, "auth.json"), 0o600);
const subjectCwd = path.join(home, "subject");
fs.mkdirSync(subjectCwd);
const labBin = path.join(home, "bin");
fs.mkdirSync(labBin);
fs.writeFileSync(path.join(labBin, "herdr"), `#!/usr/bin/env bash
set -eu
a=()
while [ "$#" -gt 0 ]; do
 if [ "$1" = --session ]; then [ "$2" = "$HERDR_LAB_SESSION" ]; shift 2; else a+=("$1"); shift; fi
done
exec env PATH="$FM_LAB_ORIGINAL_PATH" "$HERDR_LAB_HELPER" run "$HERDR_LAB_SESSION" "\${a[@]}"
`, { mode: 0o700 });
// Preserve the selected source account's pins/catalog. Disable private hooks, as in the proven standalone lab.
const sourceConfig = path.join(os.homedir(), ".codex/config.toml");
const config = parse(fs.readFileSync(sourceConfig, "utf8"));
config.features = { ...(config.features as Record<string, unknown>), hooks: false };
config.projects = { ...(config.projects as Record<string, unknown>), [subjectCwd]: { trust_level: "trusted" } };
fs.writeFileSync(path.join(codexHome, "config.toml"), stringify(config));
fs.copyFileSync(path.join(os.homedir(), ".codex/models_cache.json"), path.join(codexHome, "models_cache.json"));
const configFile = path.join(sb.env.JOYRIDE_HOME, "joyride.config.yaml");
const labConfig = YAML.parse(fs.readFileSync(configFile, "utf8"));
labConfig.usage.accounts = [{ id: "lab-codex", provider: "codex", label: "Private Codex", home: codexHome }];
labConfig.herdr = { ...labConfig.herdr, manage: false };
labConfig.firstmate = { ...labConfig.firstmate, enabled: false };
fs.writeFileSync(configFile, YAML.stringify(labConfig));
fs.writeFileSync(path.join(home, "config/backend"), "herdr\n");
fs.writeFileSync(path.join(home, "data/backlog.md"), "## In flight\n\n## Queued\n\n## Done\n");
// Delay only reads. The native agent, terminal and conversation continue untouched.
let slowReads = false;
const connections = new Set<net.Socket>();
const proxy = net.createServer((browser) => {
  connections.add(browser);
  let text = "";
  browser.on("error", () => {});
  browser.once("close", () => connections.delete(browser));
  browser.on("data", function read(data: Buffer) {
    text += data.toString();
    if (!text.includes("\n")) return;
    browser.removeListener("data", read);
    const request = z.object({ method: z.string() }).parse(JSON.parse(text.split("\n")[0]));
    const forward = () => {
      if (browser.destroyed) return;
      const server = net.createConnection(realSocket);
      connections.add(server);
      server.on("error", () => browser.destroy());
      server.once("close", () => { connections.delete(server); browser.end(); });
      browser.once("close", () => server.destroy());
      server.once("connect", () => { server.write(text); browser.pipe(server); server.pipe(browser); });
    };
    if (slowReads && ["pane.list", "agent.list", "events.subscribe"].includes(request.method)) {
      const timer = setTimeout(forward, 5000);
      browser.once("close", () => clearTimeout(timer));
    } else forward();
  });
});
await new Promise<void>((resolve) => proxy.listen(proxySocket, resolve));
assert(fs.existsSync(proxySocket), "The proxy socket must fit the native UNIX path limit");
Object.assign(process.env, sb.env, { FM_HOME: home, JOYRIDE_HERDR_SOCKET: proxySocket, JOYRIDE_CODEX_DIR: codexHome, JOYRIDE_MANAGE_HERDR: "0", JOYRIDE_HERDR_POLL_MS: "400", JOYRIDE_HERDR_RETRY_MAX_MS: "700" });
const { createDaemon } = await import("../src/server/app.ts");
const daemon = await createDaemon({ only: ["sessions", "live", "firstmate", "missions", "notes", "artifacts", "guard"] });
daemon.ctx.config.herdr.manage = false;
daemon.ctx.config.firstmate.enabled = false;
const server = serve({ fetch: daemon.app.fetch, port: 4326, hostname: "127.0.0.1" });
await daemon.start();
await until(async () => (await fetch("http://127.0.0.1:4326/api/herdr/status").then((r) => r.json())).connected === true, "guarded lab transport connected", 10_000);
const env = { CODEX_HOME: codexHome, CODEX_THREAD_ID: "", CODEX_SESSION_ID: "", CLAUDECODE: "", FM_TASK_ID: "", FM_HOME: home, JOYRIDE_INTERNAL: "1", JOYRIDE_URL: "http://127.0.0.1:4326", TMPDIR: privateSocketDir, FM_BACKEND: "herdr", TASKS_AXI_BACKEND: "markdown", PATH: `${labBin}:${process.env.PATH}`, FM_PROCEVENT_CLAIM_ROOT: path.join(home, "claims"), FM_LAB_ORIGINAL_PATH: process.env.PATH ?? "", HERDR_LAB_HELPER: helper, HERDR_LAB_SESSION: sessionName };
let pane = "", worker = "";
const api = async (p: string) => fetch(`http://127.0.0.1:4326${p}`).then((r) => r.json());
const Worker = z.object({ id: z.string(), pane: z.string(), session: z.string().nullable(), terminal_id: z.string(), controllable: z.boolean(), status: z.string() });
const browser = async (args: string[]) => (await exec("chrome-devtools-axi", args, { timeout: 30_000, maxBuffer: 2 << 20 })).stdout;
const evaluate = async (code: string): Promise<unknown> => {
  const result = YAML.parse(await browser(["eval", code])).result;
  return typeof result === "string" ? JSON.parse(result) : result;
};
const controls = async () => z.object({ composer: z.boolean(), sendDisabled: z.boolean(), recovery: z.boolean(), text: z.string(), value: z.string() }).parse(await evaluate(`() => { const p=document.querySelector('[data-worker-pane]'); const box=p?.querySelector('.reply-input'); return {composer:!!box,sendDisabled:!!p?.querySelector('.reply-row button[type=submit]')?.disabled,recovery:!!p?.querySelector('.wp-outside'),text:p?.querySelector('.wp-reply')?.textContent??'',value:box?.value??''}; }`));
try {
  const h = daemon.ctx.service<HerdrApi>("herdr");
  const nativeLaunch = h.launch;
  // The lab's actual native agent gets the same stable control name Firstmate uses; no saved metadata is injected.
  h.launch = options => nativeLaunch({ ...options, agentName: "firstmate" });
  const launchedAt = Date.now();
  const prompt = `You are a native chat test subject in the marked lab home ${home}. Never inspect other homes or supervise workers. Do not change files or fleet state. Run one foreground checkpoint using ${vendor}/bin/fm-watch-checkpoint.sh --seconds 15. Exit 124 is the expected quiet result. Then reply LAB_READY. For later messages reply LAB_ACK and repeat the message. No report or map edits are required for this test.`;
  const response = await fetch("http://127.0.0.1:4326/api/intents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "launch_session", target: subjectCwd, payload: { agent: "codex", cwd: subjectCwd, account: "lab-codex", here: { kind: "project", title: "firstmate", cwd: subjectCwd }, prompt, env, args: ["--model", "gpt-6.1-sol", "--no-daemon", "--disable", "hooks", "--dangerously-bypass-approvals-and-sandbox"], autoTrust: true } }) });
  const launch = z.object({ id: z.string(), status: z.string(), error: z.string().nullable(), result: z.object({ worker: z.string(), pane_id: z.string(), session: z.string(), account: z.string(), prompt_sent: z.boolean() }).optional() }).parse(await response.json());
  fs.writeFileSync(path.join(home, "launch-receipt.json"), JSON.stringify(launch, null, 2));
  assert.equal(launch.status, "sent", launch.error ?? "Native intake launch failed");
  assert(launch.result?.prompt_sent && launch.result.account === "lab-codex");
  pane = launch.result.pane_id; worker = launch.result.worker;
  const marker = `joyride-launch: ${launch.id}`;
  const { readThreads } = await import("../src/modules/sessions/codex.ts");
  const matches = readThreads(codexHome)?.rows.filter(t => !t.subagent && t.cwd === subjectCwd && t.created_ms >= launchedAt - 1000 && t.first_user_message.split("\n").some(line => line.trim() === marker)) ?? [];
  assert.equal(matches.length, 1, "The real intake marker must identify one exact private native thread");
  const transcript = matches[0].rollout_path, sessionId = matches[0].id;
  assert.equal(launch.result.session, `codex:${sessionId}`);
  assert(transcript.startsWith(codexHome + "/sessions/"));
  await until(async () => Worker.safeParse(await api(`/api/workers/${encodeURIComponent(worker)}`)).success && Worker.parse(await api(`/api/workers/${encodeURIComponent(worker)}`)).session === launch.result!.session, "supported native intake conversation binding");
  const owned = h.snapshot().panes.find(p => p.pane_id === pane)!;
  assert.equal(owned.cwd, subjectCwd);
  assert.equal(owned.agent, "codex");
  assert(owned.fg_pids.length, "The supported identity must retain a native foreground process");
  const rows = () => fs.readFileSync(transcript, "utf8").split("\n").filter(Boolean).map(line => z.object({ type: z.string(), payload: z.record(z.string(), z.unknown()).default({}) }).parse(JSON.parse(line)));
  const assistant = () => rows().filter(r => r.type === "response_item" && r.payload.type === "message" && r.payload.role === "assistant").flatMap(r => z.array(z.object({ text: z.string().optional() })).parse(r.payload.content).map(c => c.text ?? "")).join("\n");
  const before = Worker.parse(await api(`/api/workers/${encodeURIComponent(worker)}`));
  await until(async () => (await api("/api/firstmate/status")).pane?.worker === worker, "lab Firstmate identifies the exact native control worker");
  await browser(["open", "http://127.0.0.1:4326/"]);
  await until(async () => z.boolean().parse(await evaluate(`() => !!document.querySelector('[data-firstmate=running] .fm-title[href]')`)), "running Firstmate home link");
  await evaluate(`() => { document.querySelector('[data-firstmate=running] .fm-title[href]').click(); return true; }`);
  await until(async () => (await controls()).composer, "native composer");
  await until(async () => assistant().includes("LAB_READY"), "foreground checkpoint completion");
  const checkpoint = rows().filter(r => r.type === "event_msg" && r.payload.type === "item_completed").map(r => r.payload.item).find(item => { const parsed = z.object({ type: z.string(), command: z.array(z.string()).optional(), exit_code: z.number().optional() }).safeParse(item); return parsed.success && parsed.data.type === "CommandExecution" && parsed.data.command?.some(command => command.includes("fm-watch-checkpoint.sh --seconds 15")) && parsed.data.exit_code === 124; });
  assert(checkpoint, "The real transcript must contain the foreground checkpoint and its quiet exit 124");
  assert((await controls()).composer, "checkpoint must not remove the composer");
  await evaluate(`() => { const b=document.querySelector('.reply-input'); const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; setter.call(b,'Native draft preserved'); b.dispatchEvent(new Event('input',{bubbles:true})); return true; }`);
  await browser(["screenshot", path.resolve("docs/checkpoints/C7/chat-resume/native-before.png")]);
  slowReads = true;
  await until(async () => !Worker.parse(await api(`/api/workers/${encodeURIComponent(worker)}`)).controllable, "native read timeout");
  await until(async () => (await controls()).text.includes("Reconnecting to Herdr"), "truthful native reconnect UI");
  const during = Worker.parse(await api(`/api/workers/${encodeURIComponent(worker)}`));
  assert.equal(during.session, before.session);
  assert.equal(during.terminal_id, before.terminal_id);
  assert.deepEqual(await controls(), { composer: true, sendDisabled: true, recovery: false, text: (await controls()).text, value: "Native draft preserved" });
  await evaluate(`() => { document.querySelector('.reply-row')?.scrollIntoView({block:'end'}); return true; }`);
  await browser(["screenshot", path.resolve("docs/checkpoints/C7/chat-resume/native-reconnecting.png")]);
  await evaluate("() => { location.reload(); return true; }");
  await until(async () => (await controls()).value === "Native draft preserved" && (await controls()).sendDisabled, "draft after reload");
  slowReads = false;
  await until(async () => !(await controls()).sendDisabled, "native reconnect");
  const recovered = Worker.parse(await api(`/api/workers/${encodeURIComponent(worker)}`));
  assert.equal(recovered.session, before.session);
  assert.equal(recovered.terminal_id, before.terminal_id);
  await browser(["screenshot", path.resolve("docs/checkpoints/C7/chat-resume/native-recovered.png")]);
  // Only this owned lab composer receives a test message.
  await evaluate(`() => { if (location.origin !== 'http://127.0.0.1:4326' || document.querySelector('[data-worker-pane]')?.getAttribute('data-worker-pane') !== ${JSON.stringify(worker)}) throw new Error('Lab composer identity mismatch'); document.querySelector('.reply-row').requestSubmit(); return true; }`);
  await until(async () => assistant().includes("LAB_ACK") && assistant().includes("Native draft preserved"), "native lab reply acknowledgement");
  await cli(["pane", "close", pane]);
  await until(async () => (await controls()).text.includes("not running"), "stopped composer disabled");
  assert((await controls()).sendDisabled);
  const previous = JSON.parse(fs.readFileSync(path.resolve("docs/checkpoints/C7/chat-resume/native-proof.json"), "utf8"));
  fs.writeFileSync(path.resolve("docs/checkpoints/C7/chat-resume/native-proof.json"), JSON.stringify({ ...previous, state: "passed", sessionName, setup: "Real Codex in guarded named Herdr lab, private stores and Joyride on 4326; one-variable RPC read delay", before, during, recovered, launch, identity: { marker, sessionId, transcript, terminal: owned.terminal_id, foreground_pids: owned.fg_pids, method: "Supported launch_session intake; exact delivered marker in selected private native account, cwd/time and terminal/foreground PID binding" }, checkpoint, acknowledgement: assistant(), stopped: "Retained composer disabled after native pane close", actualPrimaryMutated: false }, null, 2));
  console.log(`Native chat lab passed: foreground checkpoint, timeout, reload, reconnect, same binding, LAB_ACK, stopped composer disabled (${sessionName}).`);
} catch (error) {
  const firstmate = await api("/api/firstmate/status").catch(() => null);
  const workerSnapshot = worker ? await api(`/api/workers/${encodeURIComponent(worker)}`).catch(() => null) : null;
  if (pane) await browser(["screenshot", path.join(home, "failure-ui.png")]).catch(() => {});
  const visible = await cli(["pane", "read", pane, "--source", "visible"]).catch(e => String(e));
  const agent = await cli(["agent", "get", pane]).catch(e => String(e));
  fs.writeFileSync(path.join(home, "startup-failure.json"), JSON.stringify({ sessionName, pane, firstmate, workerSnapshot, error: error instanceof Error ? error.message : String(error), visible, agent, transcriptRoot: path.join(codexHome, "sessions"), hooks: false }, null, 2));
  console.log(`Native failure captured in ${home}/startup-failure.json`);
  throw error;
} finally {
  await browser(["stop"]).catch(() => {});
  server.close();
  server.closeAllConnections();
  await daemon.stop();
  for (const connection of connections) connection.destroy();
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
}

// Release the shell's guarded EXIT cleanup after successful one-shot assertions; guard watches retain Node.
process.exit(0);
