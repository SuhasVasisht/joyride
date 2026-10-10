import { it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { SleepPrevention, hasSleepAssertion } from "../../src/core/sleep-prevention.ts";
import { Config } from "../../src/shared/schema.ts";
import { sandboxDaemon } from "../sandbox.ts";

it("defaults off and rejects nonboolean preferences", () => {
  expect(Config.parse({}).daemon.prevent_sleep).toBe(false);
  expect(Config.safeParse({ daemon: { prevent_sleep: "yes" } }).success).toBe(false);
});
it("reports unsupported platforms honestly", async () => {
  const awake = new SleepPrevention({ platform: "linux" });
  expect(await awake.status()).toEqual({ state: "unsupported" });
  await awake.setEnabled(true);
  await awake.setEnabled(true);
  expect(await awake.status()).toEqual({ state: "unsupported" });
  await awake.stop();
});
it("reports startup failure without retrying repeated enables", async () => {
  const awake = new SleepPrevention({ platform: "darwin", binary: "/nonexistent/joyride-caffeinate" });
  await awake.setEnabled(true);
  expect(await awake.status()).toMatchObject({ state: "error" });
  await awake.setEnabled(true);
  expect(await awake.status()).toMatchObject({ state: "error" });
  await awake.stop();
  expect(await awake.status()).toEqual({ state: "off" });
});
it.skipIf(process.platform !== "darwin")("owns one real native assertion and releases only it", async () => {
  const awake = new SleepPrevention();
  try {
    await Promise.all([awake.setEnabled(true), awake.setEnabled(true)]);
    const state = await awake.status();
    expect(state.state).toBe("active");
    if (state.state !== "active") throw new Error(JSON.stringify(state));
    expect(hasSleepAssertion(execFileSync("/usr/bin/pmset", ["-g", "assertions"], { encoding: "utf8" }), state.pid)).toBe(true);
    await awake.setEnabled(true);
    expect(await awake.status()).toEqual(state);
    process.kill(state.pid, "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await awake.status()).toMatchObject({ state: "error" });
    await awake.setEnabled(true);
    expect(await awake.status()).toMatchObject({ state: "error" });
    await awake.stop();
    await awake.setEnabled(true);
    expect((await awake.status()).state).toBe("active");
    await awake.stop();
    expect(hasSleepAssertion(execFileSync("/usr/bin/pmset", ["-g", "assertions"], { encoding: "utf8" }), state.pid)).toBe(false);
  } finally { await awake.stop(); }
});
it("persists via configuration API and applies without restarting", async () => {
  const sb = await sandboxDaemon("sleep-config", ["system"]);
  try {
    expect((await sb.req("PUT", "/api/system/config", { daemon: { prevent_sleep: "yes" } })).status).toBe(400);
    const saved = await sb.req("PUT", "/api/system/config", { daemon: { prevent_sleep: true } });
    expect(saved.status).toBe(200);
    expect((await sb.req("GET", "/api/system/config")).body.config.daemon.prevent_sleep).toBe(true);
    expect((await sb.req("GET", "/api/system/status")).body.daemon.sleep_prevention.state).toBe(process.platform === "darwin" ? "active" : "unsupported");
    await sb.req("PUT", "/api/system/config", { daemon: { prevent_sleep: false } });
  } finally { await sb.stop(); }
});
