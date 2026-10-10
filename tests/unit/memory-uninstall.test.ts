import fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, expect, it, vi } from "vitest";
import { paths } from "../../src/shared/paths.ts";
import { components, install, uninstall } from "../../src/cli/install.ts";

afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); delete process.env.JOYRIDE_MCP_HOME; });

it("backs up both providers before removal, logs the commands, and preserves unrelated config", () => {
  const home = path.join(paths.runtime, "mcp-home");
  process.env.JOYRIDE_MCP_HOME = home;
  const files = [path.join(home, ".claude.json"), path.join(paths.claudeDir, "settings.json"), path.join(paths.codexDir, "config.toml")];
  const original = files.map((f, i) => `provider ${i} config with unrelated settings\n`);
  for (const [i, file] of files.entries()) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, original[i]); }
  const calls: unknown[][] = [];
  vi.spyOn(childProcess, "execFileSync").mockImplementation((...args: unknown[]) => {
    calls.push(args);
    const backups = fs.readdirSync(path.join(paths.runtime, "backups")).flatMap(dir => fs.readdirSync(path.join(paths.runtime, "backups", dir)).map(file => fs.readFileSync(path.join(paths.runtime, "backups", dir, file), "utf8")));
    expect(backups).toEqual(expect.arrayContaining(original));
    return "Removed joyride-memory";
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  syncBuiltinESMExports();
  uninstall(["mcp"]);
  expect(calls.map(c => c.slice(0, 2))).toEqual([
    ["claude", ["mcp", "remove", "--scope", "user", "joyride-memory"]],
    ["codex", ["mcp", "remove", "joyride-memory"]],
  ]);
  for (const [i, file] of files.entries()) expect(fs.readFileSync(file, "utf8")).toBe(original[i]);
  const log = fs.readFileSync(path.join(paths.root, "GLOBAL_CHANGES.md"), "utf8");
  expect(log).toContain("uninstall `mcp`");
  expect(log).toContain("claude mcp remove joyride-memory");
  expect(log).toContain("codex mcp remove joyride-memory");
  expect(log).toContain("backup");
});

it("refuses to reinstall the removed server and offers a removal preview without commands", () => {
  const command = vi.spyOn(childProcess, "execFileSync");
  expect(() => install(["mcp"])).toThrow(/retired/);
  expect(components.mcp.preview?.("uninstall").join(" ")).toContain("joyride-memory");
  expect(command).not.toHaveBeenCalled();
});
