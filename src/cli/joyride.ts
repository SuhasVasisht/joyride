// joyride CLI: daemon lifecycle, global install/uninstall, and thin API calls.
import { paths, DAEMON_URL } from "../shared/paths.ts";
import { install, uninstall, status, components } from "./install.ts";
import { vendor, VENDOR } from "./vendor.ts";
import { runNotes } from "./notes.ts";
import { serviceInstalled, serviceUp, serviceDown, serviceRestart } from "./service.ts";
import { otherDaemons } from "./daemons.ts";
import { ownedSupervisor, startSupervisor, stopSupervisor, supervisorState } from "./supervisor.ts";
import { checkRuntimeTools, RuntimeToolCheck, runtimeToolStatus } from "../core/runtime-tools.ts";
import { jobRequest } from "../shared/new-client.ts";

const [cmd, ...rest] = process.argv.slice(2);
const ALL = ["hooks", "skills"];

// Canvas jobs own their mutations through the API; they never administer the host.
if (process.env.JOYRIDE_NEW_JOB && !["map", "notes", "api", "--help"].includes(cmd ?? "--help")) {
  console.error("A New job can use joyride map, notes and api. Host administration requires an explicit captain action.");
  process.exit(1);
}

async function api(method: string, p: string, body?: unknown, timeoutMs?: number) {
  const owned = jobRequest(method, p, body);
  method = owned.method; p = owned.path; body = owned.body;
  const r = await fetch(DAEMON_URL + p, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs) });
  const t = await r.text();
  if (process.env.JOYRIDE_NEW_JOB && !r.ok) throw new Error(`Joyride rejected this job action (${r.status}): ${t}`);
  try { return JSON.parse(t); } catch { return t; }
}
async function waitHealthy(label: string, timeoutMs = 500, previousPid?: number, supervised = false) {
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try { const h = await api("GET", "/api/health", undefined, timeoutMs); if (h?.ok && h.pid !== previousPid && (h.code ?? h.root) === paths.code && h.root === paths.root && (!supervised || supervisorState()?.daemon === h.pid)) { console.log(`${label}: ${DAEMON_URL} (pid ${h.pid})`); return true; } } catch {}
  }
  console.error("daemon did not become healthy; see .joyride/daemon.log and .joyride/supervisor.log");
  return false;
}
async function up(timeoutMs = 500) {
  const owner = await ownedSupervisor();
  if (!owner && serviceInstalled()) { serviceUp(); if (!await waitHealthy("joyride up (launchd)")) process.exitCode = 1; return; }
  try {
    const h = await api("GET", "/api/health", undefined, 500);
    if (h?.ok) {
      if ((h.code ?? h.root) !== paths.code || h.root !== paths.root) throw new Error(`Joyride on ${DAEMON_URL} belongs to ${h.code ?? h.root}. Use that checkout to control it.`);
      if (owner) { console.log(`already running supervisor pid ${owner.pid}, daemon pid ${h.pid} on ${DAEMON_URL}`); return; }
    }
  } catch (error) { if (error instanceof Error && error.message.includes("belongs to")) throw error; }
  await startSupervisor();
  if (!await waitHealthy("joyride up (supervisor)", timeoutMs, undefined, true)) process.exitCode = 1;
}
async function down() {
  if (!await ownedSupervisor() && serviceInstalled()) { console.log(serviceDown() || "stopped (unloaded until joyride up)"); return; }
  await stopSupervisor();
  console.log("supervisor and daemon stopped");
}

switch (cmd) {
  case "up": await up(); break;
  case "down": await down(); break;
  case "restart":
    try {
      const owner = await ownedSupervisor();
      if (owner) {
        const previous = supervisorState()?.daemon ?? undefined;
        process.kill(owner.pid, "SIGUSR1");
        if (!await waitHealthy("joyride restarted (supervisor)", 500, previous)) process.exitCode = 1;
      } else if (serviceInstalled()) {
        serviceRestart();
        if (!await waitHealthy("joyride restarted (launchd)")) process.exitCode = 1;
      } else await up(500);
    } catch (error) {
      console.error(`restart failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
    break;
  case "install": case "uninstall": {
    const names = rest.filter((a) => a !== "--dry-run"), dryRun = rest.includes("--dry-run");
    if (cmd === "install") install(names.length ? (names[0] === "all" ? ALL : names) : ALL, dryRun);
    else uninstall(names.length ? (names[0] === "all" ? Object.keys(components) : names) : [...ALL, "mcp"], dryRun);
    break;
  }
  case "status": {
    status();
    const owner = await ownedSupervisor();
    const state = supervisorState();
    console.log(owner ? `supervisor pid ${owner.pid}, ${state?.phase ?? "starting"}, daemon pid ${state?.daemon ?? "none"}` : `supervisor not running${state?.phase === "stopped" ? "; crash-loop cap reached, see .joyride/supervisor.log" : ""}`);
    for (const d of await otherDaemons()) console.log(`daemon pid ${d.pid}, cwd ${d.cwd}, ports ${d.ports.join(", ")}${d.other_checkout ? " (another checkout)" : ""}`);
    try {
      const health = await api("GET", "/api/health", undefined, 500);
      console.log("daemon", JSON.stringify(health));
      const tools = RuntimeToolCheck.safeParse(health?.runtime_tools);
      console.log("daemon tools", tools.success ? runtimeToolStatus(tools.data) : "unavailable; restart Joyride to run the startup check");
    } catch {
      console.log("daemon     not running");
      console.log("shell tools", runtimeToolStatus(checkRuntimeTools()));
    }
    break;
  }
  case "vendor": vendor(rest); break;
  case "map": {
    const { runMap } = await import("./map.ts");
    try { console.log(await runMap(rest)); }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
    break;
  }
  case "notes":
    try { console.log(await runNotes(rest)); } catch (e: any) { console.error(e.message); process.exit(1); }
    break;
  case "servers": {
    const { runServers } = await import("./servers.ts");
    try { console.log(await runServers(rest)); }
    catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; }
    break;
  }
  case "api": console.log(JSON.stringify(await api(rest[0] ?? "GET", rest[1] ?? "/api/health", rest[2] ? JSON.parse(rest[2]) : undefined), null, 2)); break;
  case "fleet": case "steer": {
    const { fleetCommand, steerCommand, CliError } = await import("./fleet.ts");
    try { console.log(await (cmd === "fleet" ? fleetCommand(rest) : steerCommand(rest))); }
    catch (e: any) { console.error(e.message); process.exit(e instanceof CliError ? e.code : 1); }
    break;
  }
  default:
    console.log(`joyride <command>
  up | down | restart         supervise the daemon in the background (http://127.0.0.1:4317)
  install [component|all]     apply global changes (${Object.keys(components).join(", ")})
  uninstall [component|all]   reverse them (backups in .joyride/backups)
  --dry-run                  preview install/uninstall of guidance, shared-skills, no-caveman or mcp-parity without writes
  status                      component + daemon status
  map <action> …            read and edit map groupings (joyride map --help)
  notes [add|edit|archive] …  the captain's notes on ideas, tasks and agents (joyride notes --help)
  servers <action> …         shared review terminals and private test groups (joyride servers --help)
  vendor [name...]            clone vendor/ at the pins in vendor/PINS.md, plus local patches (${Object.keys(VENDOR).join(", ")})
  api <METHOD> <path> [json]  call the daemon API
  fleet [--brief|--json|--all] the fleet roster (show <worker>, events, hand-back|exclude|include <worker>)
  steer <worker> <text>       Firstmate's guarded steer of a watched session (--answer <choice> --why <reason> answers its prompt)`);
}
