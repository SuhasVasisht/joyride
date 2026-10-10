import fs from "node:fs";
import path from "node:path";
import { test, expect } from "vitest";
import { serviceEnvironment, serviceOptions, servicePlist } from "../../src/cli/service.ts";
import { checkRuntimeTools, RUNTIME_TOOLS, runtimeToolStatus } from "../../src/core/runtime-tools.ts";
import { sandboxDaemon } from "../sandbox.ts";

const options = { home: "/home/user", node: "/node/bin/node", root: "/data", runtime: "/data/.joyride" };

test("service captures the installing PATH in order and appends deduplicated fallbacks", () => {
  const o = { ...options, shellPath: "/custom/bin:/usr/bin:/custom/bin:/home/user/.local/bin:/node/bin" };
  expect(serviceEnvironment(o).PATH.split(":")).toEqual([
    "/custom/bin", "/usr/bin", "/home/user/.local/bin", "/node/bin", "/home/user/.bun/bin", "/opt/homebrew/bin", "/usr/local/bin", "/bin",
  ]);
  expect(serviceOptions().shellPath).toBe(process.env.PATH);
  const plist = servicePlist({ ...o, shellPath: "/tools/a&b:/tools/<bin>", code: "/code", uid: 501, launchctl: () => "" });
  expect(plist).toContain(`<key>PATH</key><string>/tools/a&amp;b:/tools/&lt;bin&gt;:/node/bin:/home/user/.local/bin:/home/user/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>`);
});

test("an empty installing PATH still includes every service fallback", () => {
  expect(serviceEnvironment({ ...options, shellPath: "" }).PATH).toBe("/node/bin:/home/user/.local/bin:/home/user/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
});

test("the startup check resolves executables in PATH order and reports each missing tool", () => {
  const root = path.join(process.env.JOYRIDE_SANDBOX_DIR!, "runtime-tools");
  const first = path.join(root, "first"), second = path.join(root, "second");
  fs.mkdirSync(first, { recursive: true }); fs.mkdirSync(second, { recursive: true });
  for (const name of RUNTIME_TOOLS) fs.writeFileSync(path.join(second, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(first, "git"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(first, "claude"), "not executable", { mode: 0o644 });
  fs.mkdirSync(path.join(first, "codex"));
  fs.symlinkSync(path.join(second, "bun"), path.join(first, "bun"));
  fs.symlinkSync(path.join(root, "absent"), path.join(first, "treehouse"));
  const logs: string[] = [];
  const complete = checkRuntimeTools({ PATH: `${first}:${second}:${first}` }, (s) => logs.push(s));
  expect(complete.missing).toEqual([]);
  expect(logs).toEqual([]);
  expect(complete.tools.find((t) => t.name === "git")?.path).toBe(path.join(first, "git"));
  expect(complete.tools.find((t) => t.name === "claude")?.path).toBe(path.join(second, "claude"));
  expect(complete.tools.find((t) => t.name === "codex")?.path).toBe(path.join(second, "codex"));
  expect(complete.tools.find((t) => t.name === "bun")?.path).toBe(path.join(first, "bun"));
  expect(runtimeToolStatus(complete)).toContain("all 13 tools resolve");
  const partial = checkRuntimeTools({ PATH: first }, (s) => logs.push(s));
  expect(partial.missing).toEqual(RUNTIME_TOOLS.filter((t) => t !== "git" && t !== "bun"));
  expect(logs).toHaveLength(partial.missing.length);
  for (const name of partial.missing) expect(logs.some((s) => s.includes(`Cannot resolve ${name} on daemon PATH`))).toBe(true);
  expect(runtimeToolStatus(partial)).toContain("missing on PATH: herdr, claude, codex");
});

test("health exposes the daemon startup snapshot without repeating filesystem checks", async () => {
  const d = await sandboxDaemon("runtime-tool-health", []);
  try {
    const health = await d.req("GET", "/api/health");
    expect(health.body.runtime_tools).toEqual(checkRuntimeTools());
  } finally { await d.stop(); }
});
