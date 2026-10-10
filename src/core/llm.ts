// Heavy-reasoning LLM calls. Backend, model and reasoning effort are configurable per task type:
//   codex:  `codex exec --ephemeral` (default: gpt-6-luna)
//   claude: `claude -p --safe-mode` on the subscription
// Internal calls must never show up in the world view or trigger the user's
// hooks: JOYRIDE_INTERNAL=1, no session persistence, hooks disabled, and a
// dedicated cwd (.joyride/llm) that projections filter out.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig } from "./config.ts";
import { launchEnv, readAccounts, type Account } from "./accounts.ts";
import { paths } from "../shared/paths.ts";
import type { LlmBackend } from "../shared/schema.ts";
import { ensureDir, rid } from "./util.ts";
import { fakeModels, fakeLlm } from "./fakes.ts";

export type LlmOpts = {
  choice?: LlmBackend;
  task?: string; // key into config.llm.tasks
  schema?: object; // JSON schema for structured output
  system?: string;
  timeoutMs?: number;
  tools?: string[]; // claude: allowed tools (default none)
  images?: string[]; // file paths the model should look at
  addDirs?: string[];
};

export class LlmError extends Error {}
let stats = { calls: 0, ms: 0, errors: 0, cost_usd: 0 };
export const llmStats = () => ({ ...stats });

/**
 * The environment a task's `account` adds: that login's CODEX_HOME or CLAUDE_CONFIG_DIR. An account on
 * the provider's default login clears the variable (undefined), so the call never inherits another
 * login from the daemon's own environment. No account changes nothing.
 */
export function llmAccountEnv(choice: Pick<LlmBackend, "backend" | "account">, accounts: Account[] = readAccounts()): Record<string, string | undefined> {
  const id = choice.account?.trim();
  if (!id) return {};
  const a = accounts.find((x) => x.id === id);
  if (!a) throw new LlmError(`The llm task account "${id}" is not in usage.accounts. Use one of: ${accounts.filter((x) => x.provider === choice.backend).map((x) => x.id).join(", ") || "none"}, or remove the account.`);
  if (a.provider !== choice.backend) throw new LlmError(`The llm task account "${id}" is a ${a.provider} login, but the task runs on ${choice.backend}. Pick a ${choice.backend} account.`);
  if (a.home) return launchEnv(a);
  return { [choice.backend === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"]: undefined };
}

function run(cmd: string, args: string[], input: string | null, timeoutMs: number, cwd: string, extraEnv: Record<string, string | undefined> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, JOYRIDE_INTERNAL: "1", JOYRIDE_GUARD: "off" };
    for (const [k, v] of Object.entries(extraEnv)) { if (v === undefined) delete env[k]; else env[k] = v; }
    const child = spawn(cmd, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    let inputError: Error | null = null;
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new LlmError(`${cmd} timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => { clearTimeout(timer); reject(new LlmError(`${cmd}: ${e.message}`)); });
    child.stdin.on("error", (error) => { inputError = error; });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (inputError) reject(new LlmError(`${cmd} could not read its prompt input: ${inputError.message}`));
      else resolve({ code: code ?? -1, stdout, stderr });
    });
    if (input != null) child.stdin.end(input); else child.stdin.end();
  });
}

/** Codex enforces OpenAI strict structured output: every object closed (additionalProperties
 * false) with all properties required. Returns null when the schema has a free-form object,
 * in which case we rely on the prompt + JSON extraction instead of --output-schema. */
export function strictify(schema: any): any | null {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) { const out = schema.map(strictify); return out.some((x) => x === null) ? null : out; }
  const s: any = { ...schema };
  if (s.type === "object" || s.properties) {
    if (!s.properties || !Object.keys(s.properties).length) return null;
    const props: any = {};
    for (const [k, v] of Object.entries(s.properties)) { const sv = strictify(v); if (sv === null) return null; props[k] = sv; }
    s.properties = props; s.required = Object.keys(props); s.additionalProperties = false;
  }
  if (s.items) { const it = strictify(s.items); if (it === null) return null; s.items = it; }
  for (const key of ["anyOf", "oneOf", "allOf"]) if (s[key]) { const v = strictify(s[key]); if (v === null) return null; s[key] = v; }
  return s;
}

function extractJson(text: string): any {
  const t = text.trim();
  try { return JSON.parse(t); } catch {}
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch {} }
  const start = t.search(/[[{]/);
  if (start >= 0) {
    for (let end = t.length; end > start; end--) {
      const ch = t[end - 1];
      if (ch !== "}" && ch !== "]") continue;
      try { return JSON.parse(t.slice(start, end)); } catch {}
    }
  }
  throw new LlmError(`no JSON in model output: ${t.slice(0, 300)}`);
}

/** Ask the configured heavy model. Returns parsed JSON when `schema` is given, else text. */
export async function llm<T = any>(prompt: string, opts: LlmOpts = {}): Promise<T> {
  if (fakeModels()) { stats.calls++; return fakeLlm(prompt, opts) as T; }
  const cfg = loadConfig();
  const choice = opts.choice ?? ((opts.task && cfg.llm.tasks[opts.task]) || cfg.llm.default);
  const cwd = ensureDir(paths.llmCwd);
  const timeoutMs = opts.timeoutMs ?? 180000;
  const t0 = Date.now();
  stats.calls++;
  try {
    const accountEnv = llmAccountEnv(choice);
    let text: string;
    let wrapped = false;
    const imagesNote = opts.images?.length ? `\n\nImages to inspect (read these files): ${opts.images.join(", ")}` : "";
    const schemaNote = opts.schema ? `\n\nRespond with ONLY a JSON value matching this JSON schema, no prose:\n${JSON.stringify(opts.schema)}` : "";
    const fullPrompt = (opts.system ? `${opts.system}\n\n` : "") + prompt + imagesNote + schemaNote;
    const userPrompt = prompt + imagesNote; // claude gets the schema natively via --json-schema
    if (choice.backend === "codex") {
      const args = ["exec", "--ephemeral", "--disable", "hooks", "--skip-git-repo-check", "-s", "read-only", "-m", choice.model];
      if (choice.effort) args.push("-c", `model_reasoning_effort=${choice.effort}`);
      let schemaFile: string | null = null;
      let strict = opts.schema ? strictify(opts.schema) : null;
      // The top level must be an object; wrap anything else as {value: …} and unwrap after.
      if (strict && strict.type !== "object") { strict = { type: "object", properties: { value: strict }, required: ["value"], additionalProperties: false }; wrapped = true; }
      if (strict) { schemaFile = path.join(os.tmpdir(), `joyride-schema-${rid()}.json`); fs.writeFileSync(schemaFile, JSON.stringify(strict)); args.push("--output-schema", schemaFile); }
      const outFile = path.join(os.tmpdir(), `joyride-out-${rid()}.txt`);
      args.push("-o", outFile);
      for (const img of opts.images ?? []) args.push("-i", img);
      args.push("-");
      const r = await run("codex", args, fullPrompt, timeoutMs, cwd, accountEnv);
      if (schemaFile) fs.rmSync(schemaFile, { force: true });
      if (r.code !== 0 && !fs.existsSync(outFile)) throw new LlmError(`codex exec failed (${r.code}): ${r.stderr.slice(-500)}`);
      text = fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : r.stdout;
      fs.rmSync(outFile, { force: true });
    } else {
      const tools = opts.tools ?? (opts.images?.length ? ["Read"] : []);
      // --safe-mode drops plugins, skills, MCP servers, CLAUDE.md and hooks (≈130K tokens of context;
      // ~56x cheaper per call) while keeping the user's subscription login, unlike --bare.
      const args = ["-p", "--model", choice.model, "--output-format", "json", "--no-session-persistence", "--safe-mode", "--strict-mcp-config",
        "--settings", JSON.stringify({ disableAllHooks: true }),
        "--system-prompt", opts.system ?? "You are a precise assistant inside a developer tool. Follow the instructions exactly and return only what is asked."];
      if (choice.effort) args.push("--effort", choice.effort);
      args.push("--tools", tools.join(","));
      if (tools.length) args.push("--allowedTools", tools.join(","));
      if (opts.schema) args.push("--json-schema", JSON.stringify(opts.schema));
      for (const d of [...(opts.addDirs ?? []), ...(opts.images ?? []).map((i) => path.dirname(i))]) args.push("--add-dir", d);
      const r = await run("claude", args, userPrompt, timeoutMs, cwd, accountEnv);
      if (r.code !== 0) throw new LlmError(`claude -p failed (${r.code}): ${(r.stderr || r.stdout).slice(-500)}`);
      const env = extractJson(r.stdout);
      if (env.is_error) throw new LlmError(`claude -p error: ${String(env.result).slice(0, 400)}`);
      stats.cost_usd += Number(env.total_cost_usd ?? 0);
      if (opts.schema && env.structured_output != null) return env.structured_output as T;
      text = String(env.result ?? "");
    }
    if (!opts.schema) return text as T;
    const parsed = extractJson(text);
    return (wrapped && parsed && typeof parsed === "object" && "value" in parsed ? parsed.value : parsed) as T;
  } catch (e) {
    stats.errors++;
    throw e;
  } finally {
    stats.ms += Date.now() - t0;
  }
}
