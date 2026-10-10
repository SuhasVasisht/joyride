// Isolated load benchmark. Never connects to the captain's daemon or Herdr.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { buildSandbox } from "../tests/sandbox.ts";
import { startFakeHerdr } from "../tests/fixtures/fake-herdr.ts";

const label = process.argv[2] ?? "after";
if (!/^[a-z0-9][a-z0-9._-]*$/i.test(label)) throw new Error("Use a benchmark label without path separators.");
const port = Number(process.env.BENCH_PORT ?? 4329);
const count = Number(process.env.BENCH_CPUS ?? 8);
const samples = Number(process.env.BENCH_SAMPLES ?? 100);
const pauseMs = Number(process.env.BENCH_PAUSE_MS ?? 100);
if (![port, count, samples, pauseMs].every(Number.isInteger) || count < 1 || samples < 1 || pauseMs < 0) throw new Error("Use positive integer CPU and sample counts, and a nonnegative sample pause.");
if (port < 4320 || port > 4329) throw new Error("Use a private preview port in 4320–4329.");
await new Promise<void>((resolve, reject) => {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  socket.on("connect", () => { socket.destroy(); reject(new Error(`Private port ${port} is occupied. Choose another BENCH_PORT.`)); });
  socket.on("error", (e) => { socket.destroy(); if ("code" in e && e.code === "ECONNREFUSED") resolve(); else reject(e); });
});
const dir = path.resolve(".joyride", `bench-${label}`);
const sb = buildSandbox(dir, { port, knowledgePipeline: "off" });
const profiles = path.join(dir, "profiles");
fs.mkdirSync(profiles);
const env = { ...process.env, ...sb.env, JOYRIDE_WATCHDOG_MS: "10000" };
const profiled = process.env.BENCH_PROFILE === "1";
const fake = process.env.BENCH_HERDR === "1" ? await startFakeHerdr(sb.env.JOYRIDE_HERDR_SOCKET, { scenario: "default" }) : null;
const log = fs.openSync(path.join(dir, "daemon.log"), "a");
const daemon = spawn(process.execPath, [...(profiled ? ["--cpu-prof", `--cpu-prof-dir=${profiles}`] : []), "--import", "tsx", path.resolve("src/server/main.ts")], { env, stdio: ["ignore", log, log] });
const loads: ChildProcess[] = [];
let scanTimer: NodeJS.Timeout | null = null;
let scanning: Promise<void> | null = null;
const rescans = { completed: 0, failed: 0, last: null as unknown };
const url = `http://127.0.0.1:${port}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function stop(p: ChildProcess) {
  if (p.exitCode !== null || p.signalCode !== null) return;
  const exited = once(p, "exit");
  p.kill("SIGTERM");
  const timer = setTimeout(() => p.kill("SIGKILL"), 2000);
  await exited;
  clearTimeout(timer);
}
try {
  const deadline = Date.now() + 30000;
  while (true) {
    try { if ((await fetch(url + "/api/health", { signal: AbortSignal.timeout(1000) })).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error("Private daemon did not start. See " + dir);
    await sleep(100);
  }
  await sleep(1000);
  const identity = await (await fetch(url + "/api/health")).json();
  if (identity.pid !== daemon.pid || identity.root !== sb.env.JOYRIDE_HOME) throw new Error("Benchmark daemon identity does not match its private sandbox.");
  if (!(await (await fetch(url + "/api/sessions")).json()).length) throw new Error("No fixture sessions were indexed.");
  if (fake && (await (await fetch(url + "/api/fleet")).json()).members.length < 3) throw new Error("The fixture fleet was not published.");
  for (let i = 0; i < count; i++) loads.push(spawn(process.execPath, ["-e", "while(true){Math.sqrt(Math.random())}"], { stdio: "ignore" }));
  await sleep(1000);
  const endpoints = ["/api/health", "/", "/api/fleet", "/api/workers", "/api/sessions", "/api/firstmate/status"];
  const started = Date.now();
  if (process.env.BENCH_REINDEX === "1") scanTimer = setInterval(() => {
    if (scanning) return;
    scanning = (async () => {
      const r = await fetch(url + "/api/sessions/reindex?full=1", { method: "POST", signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error(`Session rescan: HTTP ${r.status}`);
      rescans.last = await r.json(); rescans.completed++;
    })().catch(() => { rescans.failed++; }).finally(() => { scanning = null; });
  }, 1000);
  const result: Record<string, { p50: number; p95: number; max: number }> = {};
  await Promise.all(endpoints.map(async (endpoint) => {
    const times: number[] = [];
    for (let i = 0; i < samples; i++) {
      const start = performance.now();
      const r = await fetch(url + endpoint, { signal: AbortSignal.timeout(30000) });
      times.push(performance.now() - start);
      if (!r.ok) throw new Error(`${endpoint}: HTTP ${r.status}`);
      await r.arrayBuffer();
      await sleep(pauseMs);
    }
    times.sort((a, b) => a - b);
    const at = (q: number) => Math.round((times[Math.ceil(times.length * q) - 1] ?? 0) * 100) / 100;
    result[endpoint] = { p50: at(0.5), p95: at(0.95), max: at(1) };
  }));
  const health = await (await fetch(url + "/api/health")).json();
  const samplingMs = Date.now() - started;
  const refreshed = Object.entries(health.refreshers as Record<string, { age_ms: number | null }>).filter(([, r]) => r.age_ms !== null && r.age_ms < samplingMs).map(([name]) => name);
  const report = { label, at: new Date().toISOString(), cpus: count, machine_cpus: os.cpus().length, samples, sample_pause_ms: pauseMs, sampling_ms: samplingMs, profiled, fake_herdr: Boolean(fake), rescans, refreshed_during_sampling: refreshed, metric: "time to response headers (ms)", endpoints: result, health };
  fs.writeFileSync(path.join(dir, "results.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (label !== "before") {
    if (scanTimer && (rescans.completed < 3 || rescans.failed)) throw new Error("Session rescans did not complete reliably during measurement.");
    if (samplingMs >= 6000 && !["workers", "fleet", "firstmate", "Claude registry"].every((name) => refreshed.includes(name))) throw new Error("Background refreshers did not run during measurement.");
    for (const [endpoint, numbers] of Object.entries(result)) {
      const budget = endpoint === "/api/health" ? 50 : 300;
      if (numbers.p95 >= budget) throw new Error(`${endpoint} p95 ${numbers.p95} exceeds ${budget} ms`);
    }
  }
} finally {
  if (scanTimer) clearInterval(scanTimer);
  await scanning;
  await Promise.all(loads.map(stop));
  await stop(daemon);
  await fake?.stop();
  fs.closeSync(log);
}
