import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { codexHookStatus } from "../../src/cli/hook-status.ts";

function sandbox() {
  const base = fs.mkdtempSync(path.join(process.env.JOYRIDE_RUNTIME!, "guidance-"));
  const root = path.join(base, "repo"), home = path.join(base, "home");
  fs.mkdirSync(root, { recursive: true });
  for (const dir of [".claude", ".codex"]) fs.mkdirSync(path.join(home, dir), { recursive: true });
  const env = { ...process.env, HOME: home, JOYRIDE_HOME: root, JOYRIDE_RUNTIME: path.join(root, ".joyride"), JOYRIDE_CLAUDE_DIR: path.join(home, ".claude"), JOYRIDE_CODEX_DIR: path.join(home, ".codex") };
  const run = (...args: string[]) => execFileSync(path.resolve("bin/joyride"), args, { env, encoding: "utf8" });
  return { root, home, env, run, claude: path.join(home, ".claude/CLAUDE.md"), codex: path.join(home, ".codex/AGENTS.md") };
}

describe("guidance installer in a temporary HOME", () => {
  it("seeds and commits guidance, backs up empty files, links both runtimes, and restores bytes and modes", () => {
    const s = sandbox();
    fs.writeFileSync(s.claude, "", { mode: 0o640 }); fs.writeFileSync(s.codex, "\n");
    expect(s.run("install", "guidance", "--dry-run")).toContain("would seed");
    expect(fs.existsSync(path.join(s.root, "guidance"))).toBe(false);
    const output = s.run("install", "guidance");
    expect(output).toContain("backups");
    const canonical = path.join(s.root, "guidance/captain.md");
    for (const file of [s.claude, s.codex]) {
      expect(fs.readlinkSync(file)).toBe(canonical);
      expect(fs.readFileSync(file, "utf8")).toContain("Never push");
      expect(fs.readFileSync(file, "utf8")).toContain("joyride notes --idea");
    }
    expect(execFileSync("git", ["show", "HEAD:guidance/captain.md"], { cwd: s.root, encoding: "utf8" })).toContain("Opus");
    const manifest = path.join(s.env.JOYRIDE_RUNTIME, "install/guidance.json");
    const original = fs.readFileSync(manifest, "utf8");
    fs.appendFileSync(canonical, "\nMy new preference.\n");
    s.run("install", "guidance");
    expect(fs.readFileSync(manifest, "utf8")).toBe(original);
    expect(fs.readFileSync(s.codex, "utf8")).toContain("My new preference.");
    s.run("uninstall", "guidance", "--dry-run");
    expect(fs.lstatSync(s.claude).isSymbolicLink()).toBe(true);
    s.run("uninstall", "guidance");
    expect(fs.readFileSync(s.claude, "utf8")).toBe("");
    expect(fs.statSync(s.claude).mode & 0o777).toBe(0o640);
    expect(fs.readFileSync(s.codex, "utf8")).toBe("\n");
    expect(fs.readFileSync(canonical, "utf8")).toContain("My new preference.");
    const log = fs.readFileSync(path.join(s.root, "GLOBAL_CHANGES.md"), "utf8");
    expect(log).toContain("install `guidance`"); expect(log).toContain("uninstall `guidance`");
    expect(s.run("uninstall", "guidance")).toContain("no guidance links");
  });
  it("restores an original relative symlink and removes a previously absent instruction file", () => {
    const s = sandbox(); fs.writeFileSync(path.join(s.home, ".claude/original.md"), "");
    fs.symlinkSync("original.md", s.claude);
    s.run("install", "guidance"); s.run("uninstall", "guidance");
    expect(fs.readlinkSync(s.claude)).toBe("original.md"); expect(fs.existsSync(s.codex)).toBe(false);
  });
  it("retargets installed links when the data home moves, then undoes from the new home", () => {
    const s = sandbox(); fs.writeFileSync(s.claude, ""); s.run("install", "guidance");
    const moved = path.join(path.dirname(s.root), "data"), canonical = path.join(moved, "guidance/captain.md");
    fs.mkdirSync(path.dirname(canonical), { recursive: true });
    fs.renameSync(path.join(s.root, "guidance/captain.md"), canonical);
    const run = (...args: string[]) => execFileSync(path.resolve("bin/joyride"), args, { env: { ...s.env, JOYRIDE_HOME: moved }, encoding: "utf8" });
    expect(run("install", "guidance", "--dry-run")).toContain(`would retarget ${s.claude} -> ${canonical}`);
    expect(fs.readlinkSync(s.claude)).toBe(path.join(s.root, "guidance/captain.md"));
    run("install", "guidance");
    for (const file of [s.claude, s.codex]) expect(fs.readlinkSync(file)).toBe(canonical);
    expect(JSON.parse(fs.readFileSync(path.join(s.env.JOYRIDE_RUNTIME, "install/guidance.json"), "utf8")).source).toBe(canonical);
    expect(run("install", "guidance")).toContain("already installed");
    run("uninstall", "guidance");
    expect(fs.readFileSync(s.claude, "utf8")).toBe(""); expect(fs.existsSync(s.codex)).toBe(false);
  });
  it("can undo broken canonical links and refuses missing backups before a partial undo", () => {
    const s = sandbox(); fs.writeFileSync(s.claude, ""); s.run("install", "guidance");
    fs.unlinkSync(path.join(s.root, "guidance/captain.md"));
    expect(() => s.run("install", "guidance")).toThrow();
    s.run("uninstall", "guidance");
    expect(fs.readFileSync(s.claude, "utf8")).toBe(""); expect(fs.existsSync(s.codex)).toBe(false);
    s.run("install", "guidance");
    const undo = JSON.parse(fs.readFileSync(path.join(s.env.JOYRIDE_RUNTIME, "install/guidance.json"), "utf8"));
    fs.unlinkSync(undo.links[0].original.backup);
    expect(() => s.run("uninstall", "guidance")).toThrow();
    expect(fs.lstatSync(s.codex).isSymbolicLink()).toBe(true);
  });
  it("refuses existing instructions before changing either home and preserves later replacements", () => {
    const s = sandbox(); fs.writeFileSync(s.claude, ""); fs.writeFileSync(s.codex, "Keep my rules.");
    expect(() => s.run("install", "guidance")).toThrow();
    expect(fs.lstatSync(s.claude).isFile()).toBe(true); expect(fs.existsSync(path.join(s.root, "guidance"))).toBe(false);
    fs.writeFileSync(s.codex, ""); s.run("install", "guidance");
    fs.unlinkSync(s.codex); fs.writeFileSync(s.codex, "Replacement");
    expect(() => s.run("uninstall", "guidance")).toThrow();
    expect(fs.lstatSync(s.claude).isSymbolicLink()).toBe(true); expect(fs.readFileSync(s.codex, "utf8")).toBe("Replacement");
  });
});

describe("Codex hook visibility", () => {
  it("distinguishes missing history, other agents, partial events and a complete lifecycle", () => {
    const s = sandbox(), events = path.join(s.root, "events");
    expect(codexHookStatus(events)).toContain("have never fired");
    fs.mkdirSync(events); const log = path.join(events, "2026-10-05.jsonl");
    fs.writeFileSync(log, JSON.stringify({ source: "hook.claude", type: "session.start", ts: "2026-10-05" }) + '\n{"source":"hook.codex"');
    expect(codexHookStatus(events)).toContain("have never fired");
    fs.writeFileSync(log, JSON.stringify({ source: "hook.codex", type: "session.start", ts: "2026-10-05T00:00:00Z" }) + "\n");
    expect(codexHookStatus(events)).toContain("not yet observed: tool.pre, session.end");
    for (const type of ["tool.pre", "session.end"]) fs.appendFileSync(log, JSON.stringify({ source: "hook.codex", type, ts: "2026-10-05T01:00:00Z" }) + "\n");
    expect(codexHookStatus(events)).toContain("session.start, tool.pre and session.end observed");
  });
});

it("Settings reads canonical guidance, reports missing or unreadable files, and exposes no editor", async () => {
  const { sandboxDaemon } = await import("../sandbox.ts");
  const d = await sandboxDaemon("guidance-settings", ["system"]);
  const { paths } = await import("../../src/shared/paths.ts");
  expect(paths.root.startsWith(d.sb.dir)).toBe(true);
  const file = path.join(paths.root, "guidance/captain.md");
  try {
    expect((await d.req("GET", "/api/system/guidance")).body.state).toBe("absent");
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "My preferences.\n");
    expect((await d.req("GET", "/api/system/guidance")).body).toEqual({ path: file, state: "ready", text: "My preferences.\n" });
    expect((await d.app.request("/api/system/guidance", { method: "PUT" })).status).toBe(404);
    expect(fs.readFileSync(file, "utf8")).toBe("My preferences.\n");
    fs.unlinkSync(file); fs.mkdirSync(file);
    const failed = await d.req("GET", "/api/system/guidance");
    expect(failed.status).toBe(500); expect(failed.body.error).toContain("could not be read");
  } finally { fs.rmSync(file, { recursive: true, force: true }); await d.stop(); }
});
