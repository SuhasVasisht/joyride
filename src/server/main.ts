import { serve } from "@hono/node-server";
import { createDaemon } from "./app.ts";
import { paths } from "../shared/paths.ts";
import { writeJsonAtomic } from "../core/util.ts";
import path from "node:path";
import fs from "node:fs";

import { loadConfig } from "../core/config.ts";
import { checkPortOwner, otherDaemons } from "../cli/daemons.ts";

await checkPortOwner(loadConfig().port);
const daemon = await createDaemon({ watchdogPort: loadConfig().port });
const port = daemon.ctx.config.port;
if (port === 3000) throw new Error("Port 3000 is reserved (dev VM demo rule). Choose another port.");
const server = serve({ fetch: daemon.app.fetch, port, hostname: "127.0.0.1" }, () => {
  daemon.ctx.log(`listening on http://127.0.0.1:${port} (root ${paths.root})`);
});
writeJsonAtomic(path.join(paths.runtime, "daemon.json"), { pid: process.pid, port, code: paths.code, root: paths.root, started: new Date().toISOString() });
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  const deadline = setTimeout(() => process.exit(0), 750);
  deadline.unref();
  daemon.ctx.log("shutting down");
  server.close();
  if ("closeAllConnections" in server) server.closeAllConnections();
  await daemon.stop();
  try { fs.unlinkSync(path.join(paths.runtime, "daemon.json")); } catch {}
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
await daemon.start();
void otherDaemons().then((ds) => { for (const d of ds.filter((d) => d.other_checkout)) daemon.ctx.log("another Joyride daemon", d); });
