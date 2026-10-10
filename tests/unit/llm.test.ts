import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Config } from "../../src/shared/schema.ts";

// Capture argv instead of running codex or claude; each fake child answers like the real CLI.
const calls: { cmd: string; args: string[] }[] = [];
let closesInput = false;
vi.mock("node:child_process", async (orig) => ({
  ...(await orig<typeof import("node:child_process")>()),
  spawn: (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const child: any = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => {};
    setImmediate(() => {
      if (closesInput) {
        child.stdin.destroy(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
        setImmediate(() => child.emit("close", 1));
        return;
      }
      child.stdout.end(cmd === "claude" ? JSON.stringify({ result: "ok", total_cost_usd: 0 }) : "ok");
      child.emit("close", 0);
    });
    return child;
  },
}));

let cfg = Config.parse({});
vi.mock("../../src/core/config.ts", () => ({ loadConfig: () => cfg }));

const { llm } = await import("../../src/core/llm.ts");

beforeEach(() => { calls.length = 0; closesInput = false; process.env.JOYRIDE_FAKE_MODELS = "0"; });
afterEach(() => { process.env.JOYRIDE_FAKE_MODELS = "1"; });

const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

it("rejects a CLI that closes its prompt input without crashing the daemon", async () => {
  closesInput = true;
  cfg = Config.parse({ llm: { default: { backend: "codex", model: "gpt-6-luna" } } });
  await expect(llm("prompt that must be delivered", { timeoutMs: 500 })).rejects.toThrow(/codex.*input.*EPIPE/);
});

describe("llm effort", () => {
  it("passes -c model_reasoning_effort to codex exec", async () => {
    cfg = Config.parse({ llm: { default: { backend: "codex", model: "gpt-6-luna", effort: "medium" }, tasks: { session_intent: { backend: "codex", model: "gpt-6-luna", effort: "low" } } } });
    expect(await llm("hi", { task: "session_intent" })).toBe("ok");
    const { cmd, args } = calls[0];
    expect(cmd).toBe("codex");
    expect(args.slice(0, 9)).toEqual(["exec", "--ephemeral", "--disable", "hooks", "--skip-git-repo-check", "-s", "read-only", "-m", "gpt-6-luna"]);
    expect(after(args, "-c")).toBe("model_reasoning_effort=low");
    await llm("hi", { task: "mission_naming" });
    expect(after(calls[1].args, "-c")).toBe("model_reasoning_effort=medium");
  });

  it("passes --effort to claude -p", async () => {
    cfg = Config.parse({ llm: { tasks: { idea_naming: { backend: "claude", model: "claude-sonnet-5", effort: "max" } } } });
    expect(await llm("hi", { task: "idea_naming" })).toBe("ok");
    const { cmd, args } = calls[0];
    expect(cmd).toBe("claude");
    expect(after(args, "--model")).toBe("claude-sonnet-5");
    expect(after(args, "--effort")).toBe("max");
  });

  it("leaves effort to the CLI when unset", async () => {
    cfg = Config.parse({ llm: { default: { backend: "codex", model: "gpt-6-luna" }, tasks: { idea_naming: { backend: "claude", model: "claude-sonnet-5" } } } });
    await llm("hi");
    await llm("hi", { task: "idea_naming" });
    expect(calls[0].args).not.toContain("-c");
    expect(calls[1].args).not.toContain("--effort");
  });
});

describe("llm config", () => {
  it("rejects unknown efforts and the removed gateway backend", () => {
    expect(() => Config.parse({ llm: { default: { backend: "codex", model: "m", effort: "ultra" } } })).toThrow();
    expect(() => Config.parse({ llm: { default: { backend: "gateway", model: "m" } } })).toThrow();
  });

  it("names llm.tasks keys no call site uses", async () => {
    const { unknownLlmTasks, unknownLlmTasksWarning } = await import("../../src/shared/llm-tasks.ts");
    expect(unknownLlmTasks({ session_intent: {}, memory_merge: {}, sesion_intent: {} })).toEqual(["memory_merge", "sesion_intent"]);
    expect(unknownLlmTasksWarning(["memory_merge"])).toMatch(/memory_merge.*fall back to llm.default/);
  });

  it("every task key in the repo config is known and the call sites use only known keys", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const YAML = (await import("yaml")).default;
    const { LLM_TASKS, unknownLlmTasks } = await import("../../src/shared/llm-tasks.ts");
    const root = path.resolve(__dirname, "..", "..");
    const repoCfg = Config.parse(YAML.parse(fs.readFileSync(path.join(root, "joyride.config.example.yaml"), "utf8")));
    expect(unknownLlmTasks(repoCfg.llm.tasks)).toEqual([]);
    const used = new Set<string>();
    const walk = (d: string) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (p.endsWith(".ts")) for (const m of fs.readFileSync(p, "utf8").matchAll(/\btask: (?:opts\.task \?\? )?"([a-z_]+)"/g)) used.add(m[1]); } };
    walk(path.join(root, "src", "modules"));
    expect([...used].sort()).toEqual(Object.keys(LLM_TASKS).sort());
  });
});
