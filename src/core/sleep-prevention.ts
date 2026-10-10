import { execFile, spawn, type ChildProcess } from "node:child_process";
import type { SleepPreventionState } from "../shared/schema.ts";

export function hasSleepAssertion(output: string, pid: number): boolean {
  return output.split("\n").some((line) => line.includes(`pid ${pid}(caffeinate)`) && /PreventUserIdleSystemSleep/.test(line));
}

function assertions(): Promise<string> {
  return new Promise((resolve, reject) => execFile("/usr/bin/pmset", ["-g", "assertions"], { timeout: 2000 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}

/** Owns one helper. -w lets macOS release it even after SIGKILL of the daemon. */
export class SleepPrevention {
  private child: ChildProcess | null = null;
  private state: SleepPreventionState = { state: "off" };
  private enabled = false;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: { platform?: string; binary?: string; changed?: () => void } = {}) {
    if ((options.platform ?? process.platform) !== "darwin") this.state = { state: "unsupported" };
  }

  private publish(state: SleepPreventionState) {
    this.state = state;
    this.options.changed?.();
  }
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.pending.then(fn, fn);
    this.pending = next.catch(() => {});
    return next;
  }
  setEnabled(enabled: boolean): Promise<void> {
    return this.serialize(async () => {
      if (enabled === this.enabled) return;
      this.enabled = enabled;
      if (!enabled) {
        await this.release();
        this.publish({ state: (this.options.platform ?? process.platform) === "darwin" ? "off" : "unsupported" });
        return;
      }
      if ((this.options.platform ?? process.platform) !== "darwin") {
        this.publish({ state: "unsupported" });
        return;
      }
      const child = spawn(this.options.binary ?? "/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" });
      this.child = child;
      child.on("error", (error) => {
        if (this.child === child) this.publish({ state: "error", error: `Could not prevent sleep: ${error.message}. Turn the setting off and on to retry.` });
      });
      child.on("exit", () => {
        if (this.child !== child) return;
        this.child = null;
        this.publish({ state: "error", error: "Sleep prevention stopped. Turn the setting off and on to retry." });
      });
      try {
        await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
        for (let attempt = 0; attempt < 10; attempt++) {
          if (child.pid && hasSleepAssertion(await assertions(), child.pid)) {
            this.publish({ state: "active", pid: child.pid });
            return;
          }
          if (child.exitCode !== null || child.signalCode !== null) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error("macOS did not report the sleep assertion");
      } catch (error) {
        await this.release();
        this.publish({ state: "error", error: `Could not prevent sleep: ${error instanceof Error ? error.message : String(error)}. Turn the setting off and on to retry.` });
      }
    });
  }
  status(): Promise<SleepPreventionState> {
    return this.serialize(async () => {
      if (this.state.state === "active") {
        try {
          if (!hasSleepAssertion(await assertions(), this.state.pid)) {
            await this.release();
            this.publish({ state: "error", error: "macOS no longer reports the sleep assertion. Turn the setting off and on to retry." });
          }
        } catch {
          await this.release();
          this.publish({ state: "error", error: "Could not check the macOS sleep assertion. Turn the setting off and on to retry." });
        }
      }
      return this.state;
    });
  }
  private async release() {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    await new Promise<void>((resolve) => {
      const deadline = setTimeout(() => child.kill("SIGKILL"), 250);
      child.once("exit", () => { clearTimeout(deadline); resolve(); });
      child.kill("SIGTERM");
    });
  }
  stop(): Promise<void> { return this.setEnabled(false); }
}
