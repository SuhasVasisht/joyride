import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const port = Number(process.env.E2E_PORT ?? 4407);
if (!Number.isInteger(port) || port < 4320 || port > 65535 || port === 4317) throw new Error("Native tests need an isolated spare port.");
const root = process.cwd();
const origin = `http://127.0.0.1:${port}`;
try { await fetch(`${origin}/api/health`); throw new Error(`Port ${port} is already in use. Choose an unused E2E_PORT.`); }
catch (error) { if (error instanceof Error && error.message.includes("already in use")) throw error; }
process.env.E2E_PORT = String(port);
const logPath = path.join(root, ".joyride/mac-e2e-daemon.log");
fs.mkdirSync(path.dirname(logPath), { recursive: true });
const log = fs.openSync(logPath, "w");
const server = spawn(path.join(root, "node_modules/.bin/tsx"), ["tests/e2e/serve.ts"], {
  cwd: root, env: { ...process.env, E2E_PORT: String(port), JOYRIDE_MANAGE_HERDR: "0", E2E_UI_DIR: "dist/ui" }, stdio: ["ignore", log, log],
});
try {
  let ready = false;
  for (let i = 0; i < 300; i++) {
    if (server.exitCode !== null) throw new Error(`Sandbox exited ${server.exitCode}. Read ${logPath}.`);
    try { const r = await fetch(`${origin}/api/health`); if (r.ok) { ready = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error(`Sandbox did not start. Read ${logPath}.`);
  const { seedWorld } = await import("../../../../tests/e2e/map-seed.ts");
  await seedWorld();
  if (process.argv.length > 2) throw new Error("OS UI automation is disabled. Run without arguments for background native journeys.");
  const state = path.join(root, ".joyride/mac-background-state");
  fs.rmSync(state, { recursive: true, force: true });
  const reportFile = path.join(root, ".joyride/native-report-back.html");
  fs.writeFileSync(reportFile, "<!doctype html><title>Native navigation report</title><h1>Native navigation report</h1><p>The expanded snapshot remains readable.</p>");
  const report = await fetch(`${origin}/api/artifacts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ local_source: reportFile, title: "Native navigation report", created: "2026-01-01T00:00:00Z" }) });
  if (!report.ok) throw new Error(`Could not register native report: ${await report.text()}`);
  for (let i = 0; i < 16; i++) {
    const file = path.join(root, `.joyride/native-report-back-${i}.md`);
    fs.writeFileSync(file, `# Native navigation note ${i}\n\nA native navigation fixture.`);
    const created = await fetch(`${origin}/api/artifacts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ local_source: file }) });
    if (!created.ok) throw new Error(`Could not register native note: ${await created.text()}`);
  }
  for (const name of fs.readdirSync(path.join(root, "docs/checkpoints/mac"))) {
    if (name.includes("report-back-before") || name.includes("report-back-repro")) continue;
    if (name.startsWith("background-") && /\.(json|png)$/.test(name)) fs.rmSync(path.join(root, "docs/checkpoints/mac", name));
  }
  let code = 0;
  for (const phase of ["journeys", "relaunch", "cold-worker"]) {
    const runner = spawn("apps/mac/test-native.sh", [], { cwd: root, env: {
      ...process.env, JOYRIDE_MAC_URL: origin, JOYRIDE_MAC_REPO: root,
      JOYRIDE_MAC_TEST_LINK: phase === "cold-worker" ? "joyride://worker/local%3Aw2%3Ap1" : "",
      JOYRIDE_MAC_STATE: state, JOYRIDE_MAC_BACKGROUND_TEST: "1", JOYRIDE_MAC_NO_START: "1", JOYRIDE_MAC_TEST_PHASE: phase,
    }, stdio: "inherit" });
    const timeout = setTimeout(() => runner.kill("SIGTERM"), 180_000);
    code = await new Promise<number>((resolve, reject) => { runner.on("error", reject); runner.on("exit", (code) => resolve(code ?? 1)); });
    clearTimeout(timeout);
    if (code !== 0) break;
  }
  process.exitCode = code;
} finally {
  server.kill("SIGTERM");
  await new Promise<void>((resolve) => { if (server.exitCode !== null) resolve(); else server.once("exit", () => resolve()); });
  fs.closeSync(log);
}
