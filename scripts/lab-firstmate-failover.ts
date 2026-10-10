import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { z } from "zod";
import { Hono } from "hono";
import { Config } from "../src/shared/schema.ts";
import { isPrimaryIdle } from "../src/shared/firstmate-primary.ts";
import { openDb } from "../src/core/db.ts";
import { Bus } from "../src/core/bus.ts";
import type { Ctx } from "../src/core/context.ts";
import type { HerdrApi, LaunchOpts, LaunchResult } from "../src/modules/live/herdr.ts";
import { resolveAccounts } from "../src/core/accounts.ts";
import { createPrimaryManager } from "../src/modules/firstmate/primary.ts";
import { fileInboxNote, HANDOFF_FILING_TIMEOUT_MS } from "../src/modules/firstmate/inbox.ts";
import { HANDOFF_MAX_BYTES } from "../src/modules/firstmate/failover.ts";
import { codexHookTrustKeys } from "../src/modules/live/screen.ts";
import { readHome } from "../src/modules/firstmate/state.ts";
import { parseQuota } from "../src/modules/usage/quota.ts";
import { claudeLive, codexLive, cursorLive, report } from "../tests/fixtures/quota.ts";
import type { UsageSnapshot } from "../src/shared/usage.ts";

const exec = promisify(execFile);
const home = z.string().parse(process.env.FM_HOME);
const vendor = z.string().parse(process.env.JOYRIDE_FIRSTMATE_DIR);
const helper = z.string().parse(process.env.HERDR_LAB_HELPER);
const session = z.string().regex(/^fm-lab-/).parse(process.env.HERDR_LAB_SESSION);
assert(fs.existsSync(path.join(home, ".fm-lab-home")));
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const quote = (text: string) => `'${text.replace(/'/g, `'\''`)}'`;
const write = (file: string, text: string, executable = false) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, { mode: executable ? 0o700 : 0o600 }); };
async function cli(args: string[]): Promise<string> {
  const r = await exec(helper, ["run", session, ...args], { timeout: 65_000, maxBuffer: 8 << 20 });
  return r.stdout;
}
async function cliJson(args: string[]): Promise<unknown> { return JSON.parse(await cli(args)); }
const Pane = z.object({ pane_id: z.string(), workspace_id: z.string(), tab_id: z.string(), agent_status: z.string(), terminal_id: z.string().optional() });
const Created = z.object({ result: z.object({ root_pane: Pane }) });
const Listed = z.object({ result: z.object({ panes: z.array(Pane) }) });
let control: { pane_id: string; machine: string; status: string; agent: string } | null = null;
let workerPane = "";
let launches = 0;
const bin = path.join(home, "lab-bin");
fs.mkdirSync(bin, { recursive: true });
// All indirect calls made by Firstmate scripts obey the exact same lab helper.
write(path.join(bin, "herdr"), `#!/usr/bin/env bash\nset -eu\na=()\nwhile [ "$#" -gt 0 ]; do\n if [ "$1" = --session ]; then [ "$2" = "$HERDR_LAB_SESSION" ]; shift 2; else a+=("$1"); shift; fi\ndone\nexec env PATH="$FM_LAB_ORIGINAL_PATH" "$HERDR_LAB_HELPER" run "$HERDR_LAB_SESSION" "\${a[@]}"\n`, true);
write(path.join(bin, "quota-axi"), `#!/usr/bin/env bash\ncat "$FM_HOME/quota.json"\n`, true);
write(path.join(bin, "claude"), `#!/usr/bin/env node
import fs from 'node:fs'; import cp from 'node:child_process';
const home = process.env.FM_HOME;
if (!process.argv.includes('--worker')) {
 cp.execFileSync(${JSON.stringify(path.join(vendor, "bin/fm-lock.sh"))}, [], {env: process.env});
 fs.writeFileSync(home + '/state/.session-start-complete', String(process.pid));
}
process.stdout.write('Claude Code lab stub\\n❯ ');
process.stdin.on('data', b => process.stdout.write('\\n' + b + '\\n❯ '));
setInterval(() => {
 if (!process.argv.includes('--worker') && fs.existsSync(home + '/limit')) {
  fs.unlinkSync(home + '/limit'); process.stdout.write("\\nYou've hit your limit · resets tomorrow\\n❯ ");
 }
}, 250);
`, true);
for (const [account, original] of [["codex", ".codex"], ["codex-2", ".codex-2"]]) {
  const folder = path.join(home, account);
  fs.mkdirSync(folder, { recursive: true });
  fs.copyFileSync(path.join(os.homedir(), original, "auth.json"), path.join(folder, "auth.json"));
  fs.chmodSync(path.join(folder, "auth.json"), 0o600);
  write(path.join(folder, "config.toml"), `model = "gpt-6.1-sol"\n[projects.${JSON.stringify(vendor)}]\ntrust_level = "trusted"\n`);
}
const labEnv: Record<string, string> = {
  FM_HOME: home, FM_BACKEND: "herdr", HERDR_SESSION: session, HERDR_LAB_HELPER: helper, HERDR_LAB_SESSION: session,
  PATH: `${bin}:${process.env.PATH}`, FM_LAB_ORIGINAL_PATH: process.env.PATH ?? "", JOYRIDE_INTERNAL: "1", JOYRIDE_URL: "http://127.0.0.1:4329",
  FM_PROCEVENT_CLAIM_ROOT: path.join(home, "procevent"), FM_CODEX_WATCH_CHECKPOINT: "5", TASKS_AXI_BACKEND: "markdown",
  CLAUDECODE: "", CLAUDE_PID: "", CODEX_THREAD_ID: "", FM_TASK_ID: "", FM_SUPERVISION_ACTOR: "",
};
async function makePane(label: string, env: Record<string, string> = {}) {
  return Created.parse(await cliJson(["workspace", "create", "--cwd", vendor, "--label", label, "--no-focus", ...Object.entries({ ...labEnv, ...env }).flatMap(([k, v]) => ["--env", `${k}=${v}`])])).result.root_pane;
}
async function runAgent(pane: z.infer<typeof Pane>, command: string, env: Record<string, string>) {
  const file = path.join(home, "launches", `${pane.workspace_id}.sh`);
  write(file, [...Object.entries({ ...labEnv, ...env }).map(([k, v]) => `export ${k}=${quote(v)}`), `exec ${command}`].join("\n"));
  await delay(800);
  await cli(["pane", "run", pane.pane_id, `source ${quote(file)}`]);
}
async function prompt(pane: string, text: string) { return cli(["agent", "prompt", pane, text]); }
async function until(fn: () => boolean | Promise<boolean>, what: string, timeout = 90_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await delay(500); }
  throw new Error(`Timed out waiting for ${what}`);
}
async function capture(pane: string) { return cli(["pane", "read", pane, "--source", "visible", "--lines", "200"]); }

const accounts = resolveAccounts([{ provider: "claude", home: path.join(home, "claude") }, { provider: "codex", home: path.join(home, "codex") }, { provider: "codex", home: path.join(home, "codex-2") }, { provider: "cursor" }]);
const exhausted = new Set<string>();
function quota(): UsageSnapshot {
  const now = Date.now();
  const providers = accounts.map((a) => {
    const raw = a.provider === "claude" ? claudeLive(now, { fiveUsed: 0 }) : a.provider === "codex" ? codexLive(now, { fiveUsed: 0 }) : cursorLive(now);
    if (exhausted.has(a.id)) raw.quotaSemantics.effectiveAvailability[0].effectivePercentRemaining = 0;
    return parseQuota(report(now, [raw]), [a])!.providers[0];
  });
  write(path.join(home, "quota.json"), report(now, [claudeLive(now, { fiveUsed: exhausted.has("claude-code") ? 100 : 0 }), codexLive(now), cursorLive(now)]));
  return { fetchedAt: new Date(now).toISOString(), generatedAt: new Date(now).toISOString(), maxAgeSeconds: 60, ageSeconds: 0, refreshing: false, providers };
}
quota();
const worker = await makePane("lab-worker", { FM_TASK_ID: "lab-worker" });
workerPane = worker.pane_id;
await runAgent(worker, `${quote(path.join(bin, "claude"))} --worker`, { FM_TASK_ID: "lab-worker" });
const initial = await makePane("firstmate");
await runAgent(initial, quote(path.join(bin, "claude")), {});
await until(() => fs.existsSync(path.join(home, "state/.lock")), "stub's lock");
control = { machine: "lab", pane_id: initial.pane_id, status: "idle", agent: "claude" };
const initialPid = fs.readFileSync(path.join(home, "state/.lock"), "utf8").trim();
write(path.join(home, "config/backend"), "herdr\n");
write(path.join(home, "config/crew-harness"), "claude\n");
write(path.join(home, "data/projects.md"), "");
write(path.join(home, "data/backlog.md"), "## In flight\n\n- [ ] lab-worker - Verify recovery (kind: scout)\n\n## Queued\n\n## Done\n");
write(path.join(home, "state/lab-worker.meta"), `endpoint_task_id=lab-worker\nwindow=${session}:${workerPane}\nbackend=herdr\nherdr_session=${session}\nherdr_pane_id=${workerPane}\nherdr_workspace_id=${worker.workspace_id}\nharness=claude\nkind=scout\nworktree=${home}\n`);
write(path.join(home, "state/lab-worker.status"), `needs-decision [key=lab-choice] [at=${Math.floor(Date.now()/1000)}]: Keep this worker alive while changing primary.\n`);
write(path.join(home, "data/captain.md"), `# Lab contract\nOnly supervise lab-worker in this marked FM_HOME. Never operate any other home, live daemon or vendor checkout. Do not spawn, tear down, merge or edit code.\nOn recovery, read the primary-handoff note AND its linked saved context JSON. Record the worker id, lab-choice decision, verbatim captain ask, and full-context marker from the transcript in state/observed-$FM_PRIMARY_ACCOUNT.json. The marker starts LAB_FULL_CONTEXT_ and is only in the saved transcript JSON, not its bounded inbox excerpt. Use your own account from FM_PRIMARY_ACCOUNT to name that file. Preserve the worker and pending decision. Follow your harness supervision protocol with 5-second checkpoints.\nWhen an inbox note contains LAB_NEW_WAKE, handle it by writing state/new-wake-$FM_PRIMARY_ACCOUNT.txt containing LAB_NEW_WAKE and acknowledge only that handled wake with the drain's emitted command.\n`);

const services = new Map<string, any>();
const ctx: Ctx = { app: new Hono(), db: openDb(":memory:"), bus: new Bus(), config: Config.parse({ workers: { permission_mode: "bypassPermissions" }, firstmate: { confirmation_seconds: 5 } }), services,
  log: (s) => process.stdout.write(`${s}\n`), emit: () => { throw new Error("lab must not emit to live events"); }, service: (name) => services.get(name) };
const herdr = {
  defaultMachine: () => "lab",
  call: async (method: string, params: Record<string, unknown>) => {
    if (method === "pane.read") return { read: { text: await capture(String(params.pane_id)) } };
    if (method === "pane.close") { const result = await cli(["pane", "close", String(params.pane_id)]); control = null; return result; }
    throw new Error(`Unimplemented lab call ${method}`);
  },
  refresh: async () => { const p = Listed.parse(await cliJson(["pane", "list"])).result.panes.find((p) => p.pane_id === control?.pane_id); if (p && control) control.status = p.agent_status; else control = null; },
  sendKeys: async (pane: string, keys: string[]) => cli(["pane", "send-keys", pane, ...keys]),
  prompt,
  launch: async (o: LaunchOpts): Promise<LaunchResult> => {
    launches++;
    const account = o.env?.CODEX_HOME === path.join(home, "codex-2") ? "codex-2" : o.agent === "codex" ? "codex" : "claude-code";
    const p = await makePane("firstmate", o.env);
    const executable = o.agent === "codex" ? "codex" : path.join(bin, "claude");
    if (o.agent === "codex") {
      await delay(800);
      await cli(["agent", "start", o.agentName ?? "firstmate", "--kind", "codex", "--pane", p.pane_id, "--", ...(o.args ?? [])]);
    } else await runAgent(p, [quote(executable), ...(o.args ?? []).map(quote)].join(" "), { ...o.env, FM_PRIMARY_ACCOUNT: account });
    control = { machine: "lab", pane_id: p.pane_id, status: "idle", agent: o.agent };
    if (o.agent === "codex") {
      await until(async () => {
        const screen = await capture(p.pane_id);
        const trust = codexHookTrustKeys(screen);
        if (trust) { await cli(["pane", "send-keys", p.pane_id, ...trust]); return false; }
        return /OpenAI Codex/.test(screen) && /^\s*›/m.test(screen);
      }, "Codex TUI");
      await delay(1000);
      await prompt(p.pane_id, o.prompt ?? "");
    }
    return { machine: "lab", pane_id: p.pane_id, workspace_id: p.workspace_id, tab_id: p.tab_id, worker: `lab:${p.pane_id}`, name: "firstmate", argv: [executable, ...(o.args ?? [])], created: "workspace", prompt_sent: true };
  },
};
services.set("herdr", herdr);
services.set("usage", { accounts: () => accounts, report: quota, snapshot: quota });
services.set("workers", { list: () => [
  { id: `lab:${control?.pane_id}`, session: "stub-transcript", owner: { task: null }, status: "blocked", current_action: "handoff", last_message: "" },
  { id: `lab:${workerPane}`, session: null, owner: { task: "lab-worker" }, status: "working", current_action: "waiting for lab-choice", last_message: "" },
] });
const fullContextMarker = `LAB_FULL_CONTEXT_${Date.now()}`;
const largeText = "Large handoff context from a long supervision session.\n".repeat(1200);
services.set("sessions", { transcriptState: async () => ({ turns: [{ role: "user", ts: null, text: "Keep this worker exactly where it is. Preserve the pending choice.", tools: [] }, { role: "assistant", ts: null, text: `${largeText}\n${fullContextMarker}\n${largeText}\nNext I will handle lab-choice after reviewing the worker.`, tools: [] }], queue: [], pulled: [] }) });
async function note(id: string, body: string) {
  if (id.startsWith("primary-handoff-")) {
    assert(Buffer.byteLength(body) <= HANDOFF_MAX_BYTES);
    assert(!body.includes(fullContextMarker), "full-context marker must require reading the linked JSON");
    const contextFile = path.join(home, "joyride/state", `${id}.json`);
    assert(fs.statSync(contextFile).size >= 50 * 1024);
    process.stdout.write(`Large handoff preserved: ${fs.statSync(contextFile).size} bytes in ${contextFile}; inbox excerpt ${Buffer.byteLength(body)} bytes.\n`);
  }
  const result = await fileInboxNote({ script: path.join(vendor, "bin/fm-inbox.sh"), cwd: vendor, requestId: id, body, env: { ...process.env, ...labEnv }, timeoutMs: HANDOFF_FILING_TIMEOUT_MS });
  return { id: result.note };
}
const manager = createPrimaryManager(ctx, { home, dir: vendor, pane: () => control, homeState: () => readHome(home, {}), launched: () => {}, note: async (id, body) => ({ note: (await note(id, body)).id }) });

process.stdout.write("Lab stub primary and live worker are ready; confirming Claude exhaustion.\n");
exhausted.add("claude-code");
write(path.join(home, "limit"), "exhausted");
await delay(600);
await manager.check(); await delay(5100); await manager.check();
assert.equal(manager.status().current?.account, "codex");
assert.equal(launches, 1);
assert.notEqual(fs.readFileSync(path.join(home, "state/.lock"), "utf8").trim(), initialPid);
await until(() => fs.existsSync(path.join(home, "state/observed-codex.json")), "Codex's observed handoff");
process.stdout.write("Codex 6.1 Sol acquired the lock and recorded its recovered context.\n");
const observed = fs.readFileSync(path.join(home, "state/observed-codex.json"), "utf8");
assert(observed.includes("lab-worker") && observed.includes("lab-choice") && observed.includes("Keep this worker exactly where it is"));
assert(observed.includes(fullContextMarker), "Codex must read the full linked handoff, not only the inbox excerpt");
await manager.check(); assert.equal(launches, 1);
await note("new-wake-codex", "LAB_NEW_WAKE: record this new wake as the lab contract says.");
// Native Codex supervision drains wakes at checkpoints. Do not inject a second
// prompt into its in-flight turn: Herdr correctly refuses that while blocked.
await until(() => fs.existsSync(path.join(home, "state/new-wake-codex.txt")), "successor handling a new wake");
process.stdout.write("Codex handled a new wake; confirming its exhaustion for the next account.\n");

exhausted.add("codex");
await manager.check(); await delay(5100); await manager.check();
assert.equal(manager.status().current?.account, "codex-2");
assert.equal(launches, 2);
await until(() => fs.existsSync(path.join(home, "state/observed-codex-2.json")), "Codex 2's recovery");
const observedSecond = fs.readFileSync(path.join(home, "state/observed-codex-2.json"), "utf8");
assert(observedSecond.includes("lab-choice") && observedSecond.includes(fullContextMarker));
exhausted.delete("claude-code");
assert.equal(manager.status().returnToClaude, "claude-code");
await herdr.refresh();
assert(control);
if (!isPrimaryIdle(control.status)) await herdr.sendKeys(control.pane_id, ["ctrl+c"]);
await until(async () => { await herdr.refresh(); return isPrimaryIdle(control?.status); }, "Codex 2's idle return boundary");
await manager.switch("claude-code", "Claude Code reset; switched back at the idle lab boundary.");
assert.equal(manager.status().current?.account, "claude-code");
assert.equal(launches, 3);
assert(Listed.parse(await cliJson(["pane", "list"])).result.panes.some((p) => p.pane_id === workerPane));
assert(fs.readFileSync(path.join(home, "state/lab-worker.status"), "utf8").includes("lab-choice"));
assert(fs.existsSync(path.join(home, "data/backlog.md")));
manager.stop(); ctx.db.close();
process.stdout.write(`Firstmate lab passed: Claude stub → Codex gpt-6.1-sol → Codex 2 gpt-6.1-sol → Claude stub; lock transferred, live worker and pending decision preserved, handoff read, new wake handled. Home: ${home}\n`);
