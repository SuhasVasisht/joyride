import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { localHome } from "../../src/shared/home.ts";

const checkout = () => fs.mkdtempSync(path.join(process.env.JOYRIDE_RUNTIME!, "home-"));

describe("local data home", () => {
  it("reads .joyride.env, expands ~ and relative paths, and lets the environment win", () => {
    const dir = checkout();
    fs.writeFileSync(path.join(dir, ".joyride.env"), "# data home\nJOYRIDE_HOME=~/joyride-data\nJOYRIDE_RUNTIME='../runtime'\nOTHER=1\nJOYRIDE_HOME_EXTRA=x\n");
    expect(localHome(dir, {})).toEqual({ JOYRIDE_HOME: path.join(os.homedir(), "joyride-data"), JOYRIDE_RUNTIME: path.resolve(dir, "../runtime") });
    expect(localHome(dir, { JOYRIDE_HOME: "/elsewhere" })).toEqual({ JOYRIDE_HOME: "/elsewhere", JOYRIDE_RUNTIME: path.resolve(dir, "../runtime") });
  });

  it("is empty without the file, and tests never read it", () => {
    const dir = checkout();
    expect(localHome(dir, {})).toEqual({});
    fs.writeFileSync(path.join(dir, ".joyride.env"), "JOYRIDE_HOME=/real/data\n");
    expect(localHome(dir, { VITEST: "true" })).toEqual({});
    expect(localHome(dir, { JOYRIDE_TEST: "1", JOYRIDE_RUNTIME: "/sandbox" })).toEqual({ JOYRIDE_RUNTIME: "/sandbox" });
  });
});
