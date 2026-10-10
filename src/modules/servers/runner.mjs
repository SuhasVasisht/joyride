// A foreground command in an owned Herdr terminal. Herdr owns its lifetime;
// the receipt and log let Joyride reconcile and inspect it after a restart.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const [configFile, nonce] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
if (config.nonce !== nonce) throw new Error("Server launch identity changed.");
const receipt = path.join(path.dirname(configFile), "status.json");
const write = (state, exit = null) => {
  fs.writeFileSync(receipt + ".tmp", JSON.stringify({ nonce, pid: process.pid, state, exit, at: new Date().toISOString() }));
  fs.renameSync(receipt + ".tmp", receipt);
};
const log = fs.createWriteStream(path.join(path.dirname(configFile), "output.log"), { flags: "a" });
write("running");
const child = spawn(config.command, { shell: "/bin/sh", cwd: config.cwd, stdio: ["inherit", "pipe", "pipe"], env: { ...process.env, JOYRIDE_REVIEW_RUN: nonce } });
for (const [source, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
  source.on("data", (data) => { destination.write(data); log.write(data); });
}
let finished = false;
const finish = (code) => { if (finished) return; finished = true; write("exited", code); log.end(() => process.exit(code)); };
child.on("error", (error) => { log.write(error.message + "\n"); process.stderr.write(error.message + "\n"); finish(1); });
child.on("exit", (code, signal) => finish(code ?? (signal ? 128 : 1)));
// The terminal closes its foreground group. Do not detach or create a second
// supervisor; descendants stay in Herdr's owned terminal process group.
for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"]) process.on(signal, () => { child.kill(signal); });
