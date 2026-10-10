#!/usr/bin/env bun
// Single hook entry for Claude Code and Codex.
//   bun src/hooks/hook.ts <claude|codex> <HookEventName>
// - appends a compact event to .joyride/events/*.jsonl (the daemon tails it)
// - PreToolUse: blast-radius guard (fail-closed for gated actions only)
// - SessionStart: injects a crewmate's task notes (FM_TASK_ID)
// Never blocks or errors for anything else: on internal failure it exits 0.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { matchGuard, type CompiledPolicy } from "../shared/guard-match.ts";
import { taskDigestFile } from "../shared/notes.ts";
import { localHome } from "../shared/home.ts";

if (process.env.JOYRIDE_INTERNAL === "1") process.exit(0);

const CODE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LOCAL = localHome(CODE);
const RUNTIME = LOCAL.JOYRIDE_RUNTIME ?? path.join(LOCAL.JOYRIDE_HOME ?? CODE, ".joyride");
const DAEMON = process.env.JOYRIDE_URL ?? `http://127.0.0.1:${process.env.JOYRIDE_PORT ?? 4317}`;
const agent = (process.argv[2] ?? "claude") as "claude" | "codex";
const argEvent = process.argv[3] ?? "";

const FALLBACK_POLICY: CompiledPolicy = {
  timeout_seconds: 300,
  rules: [{ id: "git-push", title: "git push to a remote", tools: ["Bash", "shell", "exec_command", "local_shell"], match: ["(^|[;&|(\\s])git(\\s+-C\\s+\\S+)?\\s+push\\b"], unless: [], level: "gate" }],
};

function readStdin(): string {
  try { return fs.readFileSync(0, "utf8"); } catch { return ""; }
}
function rid() { return "ev_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }
function clip(s: unknown, n: number): string {
  const t = typeof s === "string" ? s : s == null ? "" : JSON.stringify(s);
  return t.length > n ? t.slice(0, n) + "…" : t;
}
function appendEvent(type: string, input: any, data: Record<string, unknown>) {
  try {
    const ts = new Date().toISOString();
    const dir = path.join(RUNTIME, "events");
    fs.mkdirSync(dir, { recursive: true });
    const rec = {
      ts, id: rid(), source: `hook.${agent}`, type,
      session: input.session_id ?? input.sessionId ?? undefined,
      agent, cwd: input.cwd ?? process.cwd(),
      pane: process.env.HERDR_PANE_ID || undefined,
      // FM_TASK_ID is exported by Firstmate's fm-spawn into a crewmate's pane: the session's crew identity.
      data: { ...data, transcript: input.transcript_path, ppid: process.ppid, herdr_socket: process.env.HERDR_SOCKET_PATH || undefined, fm_task: process.env.FM_TASK_ID || undefined },
    };
    fs.appendFileSync(path.join(dir, `${ts.slice(0, 10)}.jsonl`), JSON.stringify(rec) + "\n");
  } catch { /* never fail the agent over telemetry */ }
}
function out(obj: unknown) { process.stdout.write(JSON.stringify(obj)); }
function loadPolicy(): CompiledPolicy {
  try { return JSON.parse(fs.readFileSync(path.join(RUNTIME, "guard.compiled.json"), "utf8")); } catch { return FALLBACK_POLICY; }
}
async function http(method: string, url: string, body?: unknown, timeoutMs = 4000): Promise<any> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(DAEMON + url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: ac.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

/** Start the daemon if it is not running. Hooks run inside Claude Code / Codex, which already
 * have access to ~/Documents (launchd agents do not, because of macOS privacy protection), so the
 * daemon is kept alive by the sessions that need it. Cheap when it is already up. */
function daemonAlive(): boolean {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(RUNTIME, "daemon.json"), "utf8"));
    process.kill(info.pid, 0);
    return true;
  } catch (e: any) { return e?.code === "EPERM"; }
}
function ensureDaemon(): boolean {
  if (process.env.JOYRIDE_NO_AUTOSTART === "1" || process.env.JOYRIDE_TEST === "1") return daemonAlive();
  if (daemonAlive()) return true;
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(RUNTIME, "supervisor.pid"), "utf8"));
    process.kill(owner.pid, 0);
    return false; // the supervisor owns recovery, including crash-loop backoff
  } catch {}
  try {
    if (JSON.parse(fs.readFileSync(path.join(RUNTIME, "supervisor.json"), "utf8")).phase === "stopped") return false;
  } catch {} // a crash-loop cap needs an explicit joyride up after correcting the error
  const lock = path.join(RUNTIME, "autostart.lock");
  try {
    const st = fs.statSync(lock);
    if (Date.now() - st.mtimeMs < 20000) return false; // another hook is starting it
  } catch {}
  try {
    fs.mkdirSync(RUNTIME, { recursive: true });
    fs.writeFileSync(lock, String(process.pid));
    const tsx = path.join(CODE, "node_modules", ".bin", "tsx");
    if (!fs.existsSync(tsx)) return false;
    const log = fs.openSync(path.join(RUNTIME, "supervisor.log"), "a");
    const child = spawn(tsx, [path.join(CODE, "src", "cli", "supervisor-main.ts")], { cwd: CODE, detached: true, stdio: ["ignore", log, log], env: { ...process.env, JOYRIDE_INTERNAL: "", JOYRIDE_AUTOSTARTED: "1" } });
    child.unref();
    fs.closeSync(log);
  } catch {}
  return false;
}
async function waitForDaemon(ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(DAEMON + "/api/health", { signal: AbortSignal.timeout(800) }); if (r.ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function decide(event: string, decision: "allow" | "deny", reason: string) {
  if (decision === "deny") {
    out({ hookSpecificOutput: { hookEventName: event, permissionDecision: "deny", permissionDecisionReason: reason }, systemMessage: reason });
  } else if (agent === "claude") {
    out({ hookSpecificOutput: { hookEventName: event, permissionDecision: "allow", permissionDecisionReason: reason } });
  }
  process.exit(0);
}

async function guard(input: any, event: string) {
  if (process.env.JOYRIDE_GUARD === "off") return;
  const tool = String(input.tool_name ?? "");
  const toolInput = input.tool_input ?? {};
  const policy = loadPolicy();
  const hit = matchGuard(policy, tool, toolInput);
  if (!hit) return;
  const base = { tool, input: toolInput, rule: hit.rule, title: hit.title, level: hit.level, session: input.session_id ?? null, agent, cwd: input.cwd ?? process.cwd(), pane: process.env.HERDR_PANE_ID ?? null };

  if (hit.level === "ambiguous") {
    // Jev may only escalate; if the daemon is down we let ambiguous actions through.
    try {
      const r = await http("POST", "/api/guard/classify", base, 9000);
      if (!r?.escalate) return;
    } catch { return; }
  }

  let req: any;
  if (!ensureDaemon()) await waitForDaemon(10000);
  try {
    req = await http("POST", "/api/guard/requests", base, 4000);
  } catch {
    decide(event, "deny", `Joyride guard: "${hit.title}" needs human approval, but the Joyride daemon is not reachable (start it with \`./bin/joyride up\` in ${CODE}, or set JOYRIDE_GUARD=off). Continue with other work; do not retry this action in a loop.`);
  }
  if (req?.decision && req.decision !== "pending") return finish(req);
  const deadline = Date.now() + (policy.timeout_seconds ?? 300) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const cur = await http("GET", `/api/guard/requests/${req.id}`, undefined, 3000);
      if (cur?.decision && cur.decision !== "pending") return finish(cur);
    } catch { /* daemon blip: keep waiting until the deadline */ }
  }
  try { await http("POST", `/api/guard/requests/${req.id}/timeout`, {}, 2000); } catch {}
  decide(event, "deny", `Joyride guard: "${hit.title}" was not approved within ${policy.timeout_seconds}s, so it was denied. Continue with other work and mention that this step needs approval in the Joyride approvals tray.`);

  function finish(r: any) {
    if (r.decision === "allow") decide(event, "allow", `Approved in Joyride${r.reason ? `: ${r.reason}` : ""}`);
    decide(event, "deny", `Joyride guard: "${hit!.title}" was denied by the human${r.reason ? `: ${r.reason}` : ""}. Do not retry; continue with other work or ask how to proceed.`);
  }
}

/** The captain's notes for a crewmate's task and its idea (src/modules/notes), when Firstmate spawned this session. */
function taskNotesFor(task: string | undefined): { text: string; file: string } | null {
  const file = task ? taskDigestFile(task) : null;
  if (!file) return null;
  try {
    const text = fs.readFileSync(path.join(RUNTIME, "task-notes", file), "utf8").trim();
    return text ? { text: text.slice(0, 4500), file } : null;
  } catch { return null; }
}

async function main() {
  const raw = readStdin();
  let input: any = {};
  try { input = raw.trim() ? JSON.parse(raw) : {}; } catch { input = {}; }
  const event = String(input.hook_event_name ?? argEvent);

  switch (event) {
    case "SessionStart": {
      ensureDaemon();
      const n = taskNotesFor(process.env.FM_TASK_ID);
      appendEvent("session.start", input, { source: input.source, model: input.model, injected_notes: n?.file ?? null });
      const text = n?.text ?? "";
      if (text) {
        if (agent === "claude") out({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } });
        else process.stdout.write(text);
      }
      return;
    }
    case "UserPromptSubmit":
      appendEvent("prompt.submit", input, { prompt: clip(input.prompt, 500), prompt_id: input.prompt_id });
      return;
    case "PreToolUse":
      appendEvent("tool.pre", input, { tool: input.tool_name, input: clip(input.tool_input, 400), tool_use_id: input.tool_use_id, mode: input.permission_mode });
      await guard(input, event);
      return;
    case "PermissionRequest":
      appendEvent("permission.request", input, { tool: input.tool_name, input: clip(input.tool_input, 600), mode: input.permission_mode });
      return;
    case "Notification":
      appendEvent("notification", input, { kind: input.notification_type ?? input.type ?? null, title: input.title ?? null, message: clip(input.message, 600) });
      return;
    case "Stop":
      appendEvent("turn.stop", input, { last: clip(input.last_assistant_message, 4000), stop_hook_active: input.stop_hook_active ?? false });
      return;
    case "StopFailure":
      appendEvent("turn.stop_failure", input, { error: clip(input.error ?? input.message ?? input, 800) });
      return;
    case "SessionEnd":
      appendEvent("session.end", input, { reason: input.reason ?? null });
      return;
    default:
      appendEvent(`hook.${event || "unknown"}`, input, {});
  }
}

main().catch(() => process.exit(0));
