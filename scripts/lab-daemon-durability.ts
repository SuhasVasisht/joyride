import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { buildSandbox } from "../tests/sandbox.ts";
import { waitFor } from "../tests/fixtures/fake-herdr.ts";
import type { HerdrApi } from "../src/modules/live/herdr.ts";

const session = process.env.HERDR_LAB_SESSION ?? "";
if (!/^fm-lab-jr-ui-durable-[\w-]+$/.test(session)) throw new Error("A named jr-ui-durable Herdr lab is required.");
const helper = process.env.HERDR_LAB_HELPER;
if (!helper) throw new Error("Use lab-daemon-durability.sh to install guarded cleanup before provisioning.");
const lifecycle = (command: "stop" | "provision") => new Promise<void>((resolve, reject) => {
  execFile(helper, [command, session], { timeout: 60000 }, (e, out, err) => {
    if (out) process.stdout.write(out);
    if (err) process.stderr.write(err);
    e ? reject(e) : resolve();
  });
});
const sb = buildSandbox(path.resolve(".joyride/durability-herdr"), { knowledgePipeline: "off" });
Object.assign(process.env, sb.env, { JOYRIDE_HERDR_SOCKET: path.join(os.homedir(), ".config/herdr/sessions", session, "herdr.sock"), JOYRIDE_HERDR_POLL_MS: "250", JOYRIDE_HERDR_RETRY_MAX_MS: "500" });
const { createDaemon } = await import("../src/server/app.ts");
const daemon = await createDaemon({ only: ["sessions", "live"], quiet: false });
await daemon.start();
try {
  const h = daemon.ctx.service<HerdrApi>("herdr");
  await waitFor(() => h.connected() && h.machines().some((m) => m.last_refresh), 15000);
  const initial = h.machines()[0]?.last_refresh;
  console.log(`lab connected: ${session}`);
  await lifecycle("stop");
  await waitFor(() => !h.connected(), 5000);
  assert.equal(h.machines()[0]?.last_refresh, initial);
  assert.equal(h.machines()[0]?.stale, true);
  const start = performance.now();
  assert.equal((await (await daemon.app.request("/api/health")).json()).ok, true);
  console.log(`health while Herdr is stopped: ${(performance.now() - start).toFixed(2)} ms`);
  await lifecycle("provision");
  await waitFor(() => h.connected() && h.machines()[0]?.last_refresh !== initial && !h.machines()[0]?.stale, 15000);
  console.log("lab reconnected on a fresh socket; health remained available");
} finally { await daemon.stop(); }
