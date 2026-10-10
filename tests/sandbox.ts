// Builds an isolated Joyride world for tests: data root, runtime, fake
// ~/.claude and ~/.codex stores, and env vars pointing the daemon at them.
// Fixture files may contain time tokens like {{T-2h}} / {{T-3d}} / {{MS:T-5m}}
// which are rewritten relative to now, so horizons behave predictably.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import YAML from "yaml";
import { editConfigYaml } from "../src/core/config-yaml.ts";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const FIX = path.join(ROOT, "tests", "fixtures");

function tokenTime(spec: string): Date {
  const m = spec.match(/^T(?:-(\d+)([smhd]))?$/);
  if (!m) throw new Error(`bad time token ${spec}`);
  const n = Number(m[1] ?? 0), unit = m[2] ?? "s";
  const ms = n * ({ s: 1e3, m: 6e4, h: 36e5, d: 864e5 } as any)[unit];
  return new Date(Date.now() - ms);
}
export function rewriteTimes(text: string) {
  return text
    .replace(/\{\{MS:(T[^}]*)\}\}/g, (_, t) => String(tokenTime(t).getTime()))
    .replace(/\{\{S:(T[^}]*)\}\}/g, (_, t) => String(Math.floor(tokenTime(t).getTime() / 1000)))
    .replace(/\{\{(T[^}]*)\}\}/g, (_, t) => tokenTime(t).toISOString());
}
function copyTree(src: string, dest: string, rewrite = true) {
  if (!fs.existsSync(src)) return;
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name), d = path.join(dest, ent.name);
    if (ent.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyTree(s, d, rewrite); }
    else {
      fs.mkdirSync(path.dirname(d), { recursive: true });
      if (rewrite && /\.(jsonl?|md|ya?ml|txt)$/.test(ent.name)) fs.writeFileSync(d, rewriteTimes(fs.readFileSync(s, "utf8")));
      else fs.copyFileSync(s, d);
    }
  }
}

export type Sandbox = { dir: string; env: Record<string, string> };

/** The accounts every sandbox has, whatever logins the repo's joyride.config.yaml lists. */
export const TEST_ACCOUNTS = [{ provider: "claude", label: "Claude Code" }, { provider: "codex", label: "Codex" }, { provider: "cursor", label: "Cursor" }];
function pinTestAccounts(file: string) {
  const source = fs.readFileSync(file, "utf8");
  const config = YAML.parse(source);
  config.usage = { ...config.usage, accounts: TEST_ACCOUNTS };
  fs.writeFileSync(file, editConfigYaml(source, config));
}

export function buildSandbox(dir: string, opts: { port?: number; knowledgePipeline?: "on" | "off" } = {}): Sandbox {
  fs.rmSync(dir, { recursive: true, force: true });
  const home = path.join(dir, "home"), runtime = path.join(dir, "runtime"), claude = path.join(dir, "claude"), codex = path.join(dir, "codex");
  for (const d of [home, runtime, claude, codex]) fs.mkdirSync(d, { recursive: true });
  // data root: repo defaults, then fixture overrides (tests/fixtures/data)
  fs.copyFileSync(path.join(ROOT, "guard.yaml"), path.join(home, "guard.yaml"));
  fs.copyFileSync(path.join(ROOT, "joyride.config.example.yaml"), path.join(home, "joyride.config.yaml"));
  pinTestAccounts(path.join(home, "joyride.config.yaml"));
  if (opts.knowledgePipeline) {
    const file = path.join(home, "joyride.config.yaml");
    const source = fs.readFileSync(file, "utf8");
    const config = YAML.parse(source);
    config.knowledge.pipeline = opts.knowledgePipeline;
    fs.writeFileSync(file, editConfigYaml(source, config));
  }
  for (const d of ["missions", "lenses", "memory/entries", "artifacts", "config/judges"]) fs.mkdirSync(path.join(home, d), { recursive: true });
  if (fs.existsSync(path.join(ROOT, "config/judges"))) copyTree(path.join(ROOT, "config/judges"), path.join(home, "config/judges"), false);
  copyTree(path.join(FIX, "data"), home);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: home });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: home });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "sandbox", "--allow-empty"], { cwd: home });
  // external stores
  copyTree(path.join(FIX, "claude"), claude);
  copyTree(path.join(FIX, "codex"), codex);
  const threadsJson = path.join(codex, "threads.json");
  if (fs.existsSync(threadsJson)) {
    const db = new Database(path.join(codex, "state_5.sqlite"));
    db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, source TEXT NOT NULL DEFAULT 'cli', model_provider TEXT NOT NULL DEFAULT 'openai', cwd TEXT NOT NULL, title TEXT NOT NULL, sandbox_policy TEXT NOT NULL DEFAULT '', approval_mode TEXT NOT NULL DEFAULT 'on-request', tokens_used INTEGER NOT NULL DEFAULT 0, has_user_event INTEGER NOT NULL DEFAULT 1, archived INTEGER NOT NULL DEFAULT 0, archived_at INTEGER, git_sha TEXT, git_branch TEXT, git_origin_url TEXT, cli_version TEXT NOT NULL DEFAULT '', first_user_message TEXT NOT NULL DEFAULT '', model TEXT, created_at_ms INTEGER, updated_at_ms INTEGER, preview TEXT NOT NULL DEFAULT '', name TEXT)`);
    const ins = db.prepare(`INSERT INTO threads (id, rollout_path, created_at, updated_at, cwd, title, tokens_used, git_branch, first_user_message, model, created_at_ms, updated_at_ms, preview, archived) VALUES (@id, @rollout_path, @created_at, @updated_at, @cwd, @title, @tokens_used, @git_branch, @first_user_message, @model, @created_at_ms, @updated_at_ms, @preview, @archived)`);
    for (const t of JSON.parse(fs.readFileSync(threadsJson, "utf8"))) {
      ins.run({ tokens_used: 0, git_branch: null, model: "gpt-5.1-codex", preview: t.title, archived: 0, ...t, rollout_path: path.join(codex, t.rollout_path), created_at: Math.floor(t.created_at_ms / 1000), updated_at: Math.floor(t.updated_at_ms / 1000) });
    }
    db.close();
  }
  const port = String(opts.port ?? 4399);
  const env = {
    JOYRIDE_HOME: home, JOYRIDE_RUNTIME: runtime, JOYRIDE_CLAUDE_DIR: claude, JOYRIDE_CODEX_DIR: codex,
    JOYRIDE_HERDR_SOCKET: path.join(dir, "herdr.sock"), JOYRIDE_PORT: port, JOYRIDE_URL: `http://127.0.0.1:${port}`,
    JOYRIDE_FAKE_MODELS: "1", JOYRIDE_NO_NOTIFY: "1", JOYRIDE_TEST: "1",
    // Idea housekeeping never files or tidies on its own in tests; tests drive it through its routes.
    JOYRIDE_HOUSEKEEPING: "0",
    FM_HOME: path.join(runtime, "firstmate"), // never the real Firstmate home, even when a crewmate's shell sets FM_HOME
    // The fleet feed's package copy and Firstmate's process-event claims, which default to the real ~/.local.
    JOYRIDE_FM_PACKAGES_DIR: path.join(dir, "fm-packages"), FM_PROCEVENT_CLAIM_ROOT: path.join(dir, "procevent-claims"),
  };
  fs.writeFileSync(path.join(dir, "env.json"), JSON.stringify(env, null, 2));
  return { dir, env };
}

/** For vitest: build a sandbox, set env, then import the daemon (paths read env at import). */
export async function sandboxDaemon(name: string, only?: string[]) {
  // tests/setup-env.ts already built a per-file sandbox and set the env before
  // any src import; reuse it so module-level paths stay consistent.
  const existing = process.env.JOYRIDE_SANDBOX_DIR;
  const sb: Sandbox = existing
    ? { dir: existing, env: JSON.parse(fs.readFileSync(path.join(existing, "env.json"), "utf8")) }
    : buildSandbox(path.join("/tmp", `joyride-unit-${name}-${process.pid}`));
  Object.assign(process.env, sb.env);
  const { createDaemon } = await import("../src/server/app.ts");
  const d = await createDaemon({ only, quiet: true });
  const req = async (method: string, url: string, body?: unknown) => {
    const r = await d.app.request(url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text();
    return { status: r.status, body: t ? JSON.parse(t) : null };
  };
  return { ...d, sb, req };
}
