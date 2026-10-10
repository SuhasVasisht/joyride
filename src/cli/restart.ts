import { pidAlive } from "../core/util.ts";

async function waitForExit(pid: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (pidAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

export async function restartStoppedDaemon({ pid, start, timeoutMs = 15_000 }: {
  pid: number | undefined;
  start: () => Promise<void>;
  timeoutMs?: number;
}) {
  if (pid !== undefined && !await waitForExit(pid, timeoutMs)) {
    try { process.kill(pid, "SIGKILL"); }
    catch (error) { if (pidAlive(pid)) throw error; }
    if (!await waitForExit(pid, 2_000)) {
      throw new Error(`daemon pid ${pid} did not exit after SIGKILL; check the process before retrying restart`);
    }
  }
  await start();
}
