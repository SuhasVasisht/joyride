import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { sandboxDaemon } from "../sandbox.ts";
import type { FirstmateApi } from "../../src/modules/firstmate/index.ts";

let d: Awaited<ReturnType<typeof sandboxDaemon>>;
let fm: FirstmateApi;
let home: string;
const originalVendor = process.env.JOYRIDE_FIRSTMATE_DIR;

beforeAll(async () => {
  home = process.env.FM_HOME!;
  const vendor = path.join(process.env.JOYRIDE_RUNTIME!, "answer-owner-scripts");
  fs.mkdirSync(path.join(vendor, "bin"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const script = `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$FM_HOME/argv"
cat > "$FM_HOME/stdin"
for key in FM_STATE_OVERRIDE FM_DATA_OVERRIDE FM_WAKE_QUEUE; do printenv "$key" || printf 'unset\\n'; done > "$FM_HOME/overrides"
printf '%s\\n' "$FM_TEST_ANSWER_OUTPUT"
exit "$FM_TEST_ANSWER_EXIT"
`;
  for (const name of ["fm-captain-hold.sh", "fm-send.sh"]) fs.writeFileSync(path.join(vendor, "bin", name), script, { mode: 0o755 });
  process.env.JOYRIDE_FIRSTMATE_DIR = vendor;
  d = await sandboxDaemon("answer-owner", ["live", "firstmate"]);
  fm = d.ctx.service<FirstmateApi>("firstmate");
});
afterAll(async () => {
  await d.stop();
  if (originalVendor) process.env.JOYRIDE_FIRSTMATE_DIR = originalVendor;
  else delete process.env.JOYRIDE_FIRSTMATE_DIR;
  for (const key of ["FM_TEST_ANSWER_OUTPUT", "FM_TEST_ANSWER_EXIT", "FM_STATE_OVERRIDE", "FM_DATA_OVERRIDE", "FM_WAKE_QUEUE"]) delete process.env[key];
});
beforeEach(() => { process.env.FM_TEST_ANSWER_OUTPUT = "closed: call"; process.env.FM_TEST_ANSWER_EXIT = "0"; });

describe("answer owner transport", () => {
  it.each(["done", "release"] as const)("composes the keyed TSV intake with mode %s and source joyride-map", async (mode) => {
    await fm.answerHold("call", "Use A and B", "Pick the format", mode);
    expect(fs.readFileSync(path.join(home, "argv"), "utf8")).toBe("answers\n--source\njoyride-map\n");
    expect(fs.readFileSync(path.join(home, "stdin"), "utf8")).toBe(`call\tUse A and B\tPick the format\t${mode}\n`);
  });
  it("composes the exact crew task and resolve key, keeping answer text one argument", async () => {
    await fm.answerDecision("crew", "Fix the race\nThen rerun", "flake-cause");
    expect(fs.readFileSync(path.join(home, "argv"), "utf8")).toBe("crew\n--resolve-key\nflake-cause\nFix the race\nThen rerun\n");
  });
  it("accepts a confirmed closed line despite a later script failure", async () => {
    process.env.FM_TEST_ANSWER_EXIT = "7";
    await expect(fm.answerHold("call", "A", "format", "done")).resolves.toEqual({ output: "closed: call" });
  });
  it.each(["0", "1"])("refuses skipped even with exit %s and gives refresh advice", async (code) => {
    process.env.FM_TEST_ANSWER_EXIT = code; process.env.FM_TEST_ANSWER_OUTPUT = "skipped: call (already closed)";
    await expect(fm.answerHold("call", "A", "format", "done")).rejects.toThrow(/refresh the ask/);
  });
  it("reports a missing vendor script with a fix", async () => {
    const saved = process.env.JOYRIDE_FIRSTMATE_DIR;
    process.env.JOYRIDE_FIRSTMATE_DIR = path.join(d.sb.dir, "absent-vendor");
    try { await expect(fm.answerHold("call", "A", "format", "done")).rejects.toThrow(/joyride vendor firstmate/); }
    finally { process.env.JOYRIDE_FIRSTMATE_DIR = saved; }
  });
  it("drops inherited Firstmate home and wake overrides", async () => {
    for (const key of ["FM_STATE_OVERRIDE", "FM_DATA_OVERRIDE", "FM_WAKE_QUEUE"]) process.env[key] = path.join(d.sb.dir, "wrong-home");
    await fm.answerHold("call", "A", "format", "done");
    expect(fs.readFileSync(path.join(home, "overrides"), "utf8")).toBe("unset\nunset\nunset\n");
  });
});
