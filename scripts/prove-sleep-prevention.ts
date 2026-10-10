// Isolated native proof. No live module or Herdr lifecycle calls are loaded.
import { fork, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import YAML from "yaml";
import { editConfigYaml } from "../src/core/config-yaml.ts";
import { buildSandbox } from "../tests/sandbox.ts";
import { hasSleepAssertion } from "../src/core/sleep-prevention.ts";

const mode = process.argv[2];
if (mode === "child") {
  const { createDaemon } = await import("../src/server/app.ts");
  const daemon = await createDaemon({ only: ["system"] });
  await daemon.start();
  process.on("message", async (message) => {
    if (message === "disable") {
      await daemon.app.request("/api/system/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ daemon: { prevent_sleep: false } }) });
      process.send?.({ disabled: true });
    } else if (message === "stop") { await daemon.stop(); process.exit(0); }
  });
  const state = await daemon.ctx.service<import("../src/core/sleep-prevention.ts").SleepPrevention>("sleep-prevention").status();
  process.send?.(state);
} else {
  assert.equal(process.platform, "darwin");
  const dir = path.resolve(".joyride/sleep-proof");
  fs.mkdirSync(dir, { recursive: true });
  const baseline = execFileSync("/usr/bin/pmset", ["-g", "assertions"], { encoding: "utf8" });
  console.log("Native baseline\n" + baseline);
  for (const action of ["disable", "stop", "SIGKILL"]) {
    const sb = buildSandbox(path.join(dir, action), { port: 4329 });
    const file = path.join(sb.env.JOYRIDE_HOME, "joyride.config.yaml");
    const source = fs.readFileSync(file, "utf8");
    const config = YAML.parse(source);
    config.daemon = { ...config.daemon, prevent_sleep: true };
    fs.writeFileSync(file, editConfigYaml(source, config));
    const child = fork(new URL(import.meta.url), ["child"], { env: { ...process.env, ...sb.env }, stdio: ["ignore", "inherit", "inherit", "ipc"] });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      const state = await new Promise<unknown>((resolve, reject) => { child.once("message", resolve); child.once("exit", () => reject(new Error("daemon exited before reporting"))); });
      const { SleepPreventionState } = await import("../src/shared/schema.ts");
      const parsed = SleepPreventionState.parse(state);
      assert.equal(parsed.state, "active");
      if (parsed.state !== "active") throw new Error(JSON.stringify(parsed));
      const active = execFileSync("/usr/bin/pmset", ["-g", "assertions"], { encoding: "utf8" });
      assert(hasSleepAssertion(active, parsed.pid));
      console.log(`Persisted startup, daemon ${child.pid}, helper ${parsed.pid}, action ${action}\n${active}`);
      if (action === "SIGKILL") child.kill("SIGKILL");
      else child.send(action);
      let removed = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        const output = execFileSync("/usr/bin/pmset", ["-g", "assertions"], { encoding: "utf8" });
        if (!hasSleepAssertion(output, parsed.pid)) { console.log(`Removed after ${action}\n${output}`); removed = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert(removed, `assertion leaked after ${action}`);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        if (action === "disable") child.send("stop");
        await exited;
      }
    }
  }
}
