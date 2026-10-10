import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sandboxDaemon } from "../sandbox.ts";
import type { EvidenceService } from "../../src/modules/evidence/index.ts";

// Only type imports above: src/shared/paths.ts reads the sandbox env at import time.
const BIN = path.resolve(__dirname, "../../bin/joyride-evidence");
let d: Awaited<ReturnType<typeof sandboxDaemon>>;
let ev: EvidenceService;
let blobs: string;
let work: string;

function cli(args: string[], env: Record<string, string> = {}) {
  // PWD as a shell would set it (logical path, /tmp rather than /private/tmp).
  const r = spawnSync(BIN, args, { cwd: work, env: { ...process.env, CODEX_THREAD_ID: "", CODEX_SESSION_ID: "", PWD: work, ...env }, encoding: "utf8", timeout: 30000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

beforeAll(async () => {
  d = await sandboxDaemon("evidence-cli", ["evidence"]);
  const { paths } = await import("../../src/shared/paths.ts");
  if (!paths.runtime.startsWith(d.sb.dir)) throw new Error(`refusing to run: runtime ${paths.runtime} is outside the sandbox`);
  blobs = paths.blobs;
  ev = d.ctx.service<EvidenceService>("evidence");
  work = path.join(d.sb.dir, "work");
  fs.mkdirSync(path.join(work, "screenshots"), { recursive: true });
  // This vitest worker is the CLI's parent process: pretend it is a Claude Code session.
  fs.mkdirSync(path.join(d.sb.env.JOYRIDE_CLAUDE_DIR, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(d.sb.env.JOYRIDE_CLAUDE_DIR, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "cli-session-1", cwd: work }));
  // An old screenshot must not be attached to a new run.
  const old = path.join(work, "screenshots", "old.png");
  fs.writeFileSync(old, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
  const past = new Date(Date.now() - 3600e3);
  fs.utimesSync(old, past, past);
});

const records = () => { d.tailer.drain(); return ev.list({ limit: 100 }); };

describe("joyride-evidence CLI", () => {
  it("runs a passing command, streams its output, and records attested evidence", () => {
    const r = cli(["run", "--name", "smoke ok", "--mission", "m-cli", "--claim", "prints hello", "--",
      "echo hello; echo ' Tests  2 passed (2)'; printf '\\211PNG\\r\\n\\032\\nnew-shot' > screenshots/home.png"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("hello");
    expect(r.err).toMatch(/joyride-evidence: recorded "smoke ok" \(exit 0, 2 passed, 0 failed, 1 screenshot, session claude:cli-session-1, mission m-cli\)/);
    const it = records().find((x) => x.name === "smoke ok")!;
    expect(it).toMatchObject({ mode: "attested", exit_code: 0, session: "claude:cli-session-1", mission: "m-cli", claim: "prints hello", cwd: work, assertions: { passed: 2, failed: 0, skipped: 0 } });
    expect(it.screenshots.map((s) => s.name)).toEqual(["screenshots/home.png"]);
    expect(fs.readFileSync(path.join(blobs, it.screenshots[0].blob)).subarray(0, 4).toString("latin1")).toBe("\x89PNG");
    expect(fs.readFileSync(path.join(blobs, it.log_blob!), "utf8")).toContain("hello");
    expect(it.log_tail).toContain("Tests  2 passed");
  });

  it("passes through a failing exit code and records it", () => {
    const r = cli(["run", "--name", "smoke fail", "--", "sh", "-c", "echo boom >&2; exit 3"]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("boom");
    const it = records().find((x) => x.name === "smoke fail")!;
    expect(it).toMatchObject({ exit_code: 3, command: "sh -c 'echo boom >&2; exit 3'", screenshots: [] });
    expect(it.log_tail).toContain("boom");
  });

  it("reports a missing command as exit 127", () => {
    const r = cli(["run", "--name", "missing", "--", "definitely-not-a-command-xyz"]);
    expect(r.code).toBe(127);
    expect(records().find((x) => x.name === "missing")?.exit_code).toBe(127);
  });

  it("adds evidence produced elsewhere", () => {
    fs.writeFileSync(path.join(work, "log.txt"), "=== 5 passed, 1 skipped in 0.3s ===\n");
    fs.writeFileSync(path.join(work, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]));
    const r = cli(["add", "--name", "manual check", "--claim", "looked right", "--exit-code", "0", "--log", "log.txt", "--screenshot", "shot.png", "--session", "codex:abc"]);
    expect(r.code).toBe(0);
    const it = records().find((x) => x.name === "manual check")!;
    expect(it).toMatchObject({ exit_code: 0, session: "codex:abc", assertions: { passed: 5, failed: 0, skipped: 1 }, claim: "looked right" });
    expect(it.screenshots.map((s) => s.name)).toEqual(["shot.png"]);
  });

  it("links a switched Codex thread without hooks, matching an explicit override", () => {
    const thread = "01a11272-fdda-7150-8077-8a1da374de9a";
    const parent = path.join(d.sb.env.JOYRIDE_CLAUDE_DIR, "sessions", `${process.pid}.json`);
    const saved = fs.readFileSync(parent);
    fs.unlinkSync(parent);
    try {
      const automatic = cli(["run", "--name", "switched automatic", "--", "true"], { CODEX_THREAD_ID: thread });
      const explicit = cli(["run", "--name", "switched explicit", "--session", `codex:${thread}`, "--", "true"], { CODEX_THREAD_ID: thread });
      expect(automatic.code).toBe(0);
      expect(explicit.code).toBe(0);
      expect(records().find((x) => x.name === "switched explicit")?.session).toBe(`codex:${thread}`);
      expect(records().find((x) => x.name === "switched automatic")?.session).toBe(`codex:${thread}`);
      const invalid = cli(["run", "--name", "unlinked invalid identity", "--", "true"], { CODEX_THREAD_ID: "invalid", CODEX_SESSION_ID: "../invalid" });
      expect(invalid.code).toBe(0);
      expect(records().find((x) => x.name === "unlinked invalid identity")?.session).toBeNull();
    } finally { fs.writeFileSync(parent, saved); }
  });

  it.each([
    { CODEX_THREAD_ID: "01a11272-fdda-7150-8077-8a1da374de9a", CODEX_SESSION_ID: "01a11268-6e6e-7273-8779-208dc3a9453c", expected: "01a11272-fdda-7150-8077-8a1da374de9a" },
    { CODEX_THREAD_ID: "", CODEX_SESSION_ID: "01a11268-6e6e-7273-8779-208dc3a9453c", expected: "01a11268-6e6e-7273-8779-208dc3a9453c" },
    { CODEX_THREAD_ID: "invalid", CODEX_SESSION_ID: "01a11268-6e6e-7273-8779-208dc3a9453c", expected: "01a11268-6e6e-7273-8779-208dc3a9453c" },
  ])("prefers validated Codex environment identities over an inherited Claude parent: %j", ({ expected, ...env }) => {
    const r = cli(["add", "--name", "environment identity", "--exit-code", "0"], env);
    expect(r.code).toBe(0);
    expect(r.err).toContain(`session codex:${expected}`);
  });

  it.each(["", "not-a-thread", "codex:01a11272-fdda-7150-8077-8a1da374de9a", "../session", "01a11272-fdda-7150-8077-8a1da374de9a\n"])("rejects invalid environment identities and preserves Claude fallback: %j", (identity) => {
    const r = cli(["run", "--name", "invalid environment", "--", "true"], { CODEX_THREAD_ID: identity, CODEX_SESSION_ID: identity });
    expect(r.code).toBe(0);
    expect(r.err).toContain("session claude:cli-session-1");
  });

  it.each(["codex:explicit", "claude:explicit", "other:741127b5-9e0d-48e7-912f-8cbfc6f38ab7", "explicit"])("preserves explicit override precedence: %s", (session) => {
    const r = cli(["add", "--name", "explicit identity", "--exit-code", "0", "--session", session], { CODEX_THREAD_ID: "01a11272-fdda-7150-8077-8a1da374de9a" });
    expect(r.code).toBe(0);
    expect(r.err).toContain(`session ${session.includes(":") ? session : `claude:${session}`}`);
  });

  it("falls back to the latest Codex hook event for this cwd when no Claude parent is found", () => {
    d.ctx.emit({ source: "hook.codex", type: "tool.pre", session: "thread-9", agent: "codex", cwd: work, data: { tool: "shell" } });
    const empty = path.join(d.sb.dir, "empty-claude");
    fs.mkdirSync(empty, { recursive: true });
    const r = cli(["run", "--name", "codex run", "--", "true"], { JOYRIDE_CLAUDE_DIR: empty, CODEX_THREAD_ID: "invalid", CODEX_SESSION_ID: "../invalid" });
    expect(r.code).toBe(0);
    expect(records().find((x) => x.name === "codex run")?.session).toBe("codex:thread-9");
  });

  it("prefers the current thread over a different Codex hook without a Claude parent", () => {
    const empty = path.join(d.sb.dir, "empty-claude");
    const r = cli(["run", "--name", "current over hook", "--", "true"], { JOYRIDE_CLAUDE_DIR: empty, CODEX_THREAD_ID: "01a11272-fdda-7150-8077-8a1da374de9a" });
    expect(r.code).toBe(0);
    expect(records().find((x) => x.name === "current over hook")?.session).toBe("codex:01a11272-fdda-7150-8077-8a1da374de9a");
  });

  it("still runs the command and passes its exit code through when recording fails", () => {
    const r = cli(["run", "--name", "no runtime", "--", "echo still ran; exit 5"], { JOYRIDE_RUNTIME: "/dev/null/not-a-dir" });
    expect(r.code).toBe(5);
    expect(r.out).toContain("still ran");
    expect(r.err).toContain("could not be recorded");
  });

  it("explains usage errors", () => {
    const r = cli(["run", "--", "true"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--name is required");
    expect(cli(["help"]).out).toContain("joyride-evidence run --name");
  });
});
