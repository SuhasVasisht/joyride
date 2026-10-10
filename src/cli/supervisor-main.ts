import fs from "node:fs";
import path from "node:path";
import { paths } from "../shared/paths.ts";
import { acquireSupervisorLock, Supervisor, daemonHealthy, stopManualDaemon } from "./supervisor.ts";

const log = (message: string) => fs.writeSync(1, `${new Date().toISOString()} [joyride supervisor] ${message}\n`);
const owner = { pid: process.pid, code: paths.code, root: paths.root };
const release = acquireSupervisorLock(paths.runtime, owner);
if (!release) { log("another supervisor already owns this runtime; exiting"); process.exit(0); }
let supervisor: Supervisor | null = null;
let stopping = false;
const stop = () => { stopping = true; supervisor?.stop(); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("SIGHUP", () => {});
process.on("SIGUSR1", () => supervisor?.restart());
try {
  await stopManualDaemon();
  if (stopping) { release(); process.exit(0); }
  supervisor = new Supervisor({
    owner, runtime: paths.runtime, command: process.execPath,
    args: ["--import", "tsx", path.join(paths.code, "src/server/main.ts")],
    env: process.env, log, healthy: daemonHealthy,
    watchdogMs: Number(process.env.JOYRIDE_WATCHDOG_MS ?? 10000),
    release, onStop: () => process.exit(0),
  });
  supervisor.start();
} catch (error) { log(`cannot start: ${String(error)}`); release(); process.exit(1); }
