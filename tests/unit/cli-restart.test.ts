import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, test } from "vitest";
import { pidAlive } from "../../src/core/util.ts";
import { restartStoppedDaemon } from "../../src/cli/restart.ts";

async function standIn(delayMs: number | null) {
  const child = spawn(process.execPath, ["-e", `
    process.on('SIGTERM', () => {
      ${delayMs === null ? "" : `setTimeout(() => process.exit(0), ${delayMs});`}
    });
    setInterval(() => {}, 1000);
    console.log('ready');
  `], { stdio: ["ignore", "pipe", "pipe"] });
  await once(child.stdout!, "data");
  if (child.pid === undefined) throw new Error("stand-in failed to start");
  return { child, pid: child.pid };
}

test("restart waits for a daemon that takes longer than 800 ms to stop", async () => {
  const { child, pid } = await standIn(1_200);
  try {
    child.kill("SIGTERM");
    const stoppedAt = Date.now();
    let started = false;
    await restartStoppedDaemon({ pid, start: async () => {
      expect(pidAlive(pid)).toBe(false);
      expect(Date.now() - stoppedAt).toBeGreaterThanOrEqual(1_200);
      started = true;
    } });
    expect(started).toBe(true);
  } finally { if (pidAlive(pid)) child.kill("SIGKILL"); }
});

test("restart kills a daemon that ignores SIGTERM before starting", async () => {
  const { child, pid } = await standIn(null);
  const exited = once(child, "exit");
  try {
    child.kill("SIGTERM");
    let started = false;
    await restartStoppedDaemon({ pid, timeoutMs: 200, start: async () => {
      expect(pidAlive(pid)).toBe(false);
      started = true;
    } });
    expect(started).toBe(true);
    expect((await exited)[1]).toBe("SIGKILL");
  } finally { if (pidAlive(pid)) child.kill("SIGKILL"); }
});

test("restart propagates a failed start", async () => {
  await expect(restartStoppedDaemon({ pid: undefined, start: async () => {
    throw new Error("start failed");
  } })).rejects.toThrow("start failed");
});
