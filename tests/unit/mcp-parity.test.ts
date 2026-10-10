import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "smol-toml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installMcpParity, uninstallMcpParity, loadMcpManifest, parityTargets } from "../../src/cli/mcp-parity.ts";

const code = path.resolve(__dirname, "../..");
const roots: string[] = [];
function sandbox() {
  const dir = path.join(code, ".joyride/mcp-parity-tests");
  fs.mkdirSync(dir, { recursive: true });
  const root = fs.mkdtempSync(path.join(dir, "home-")); roots.push(root);
  return { home: path.join(root, "home"), runtime: path.join(root, "runtime"), code, root };
}
function write(file: string, text: string) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
function configs(home: string) {
  return parityTargets(home).map((t) => ({ t, data: t.format === "codex" ? parse(fs.readFileSync(t.file, "utf8")) : JSON.parse(fs.readFileSync(t.file, "utf8")) }));
}
function seed(o: ReturnType<typeof sandbox>) {
  write(path.join(o.home, ".claude.json"), JSON.stringify({ theme: "paper", mcpServers: { sevalla: { type: "http", url: "https://mcp.sevalla.com/mcp", headers: { Authorization: "Bearer claude-sentinel" } }, "joyride-memory": { command: "old-bun", args: ["/old/memory.ts"], env: { PRIVATE: "keep" } } } }));
  write(path.join(o.home, ".codex/config.toml"), '# Keep my comment\nmodel = "test"\n\n[projects."/test.repo"]\ntrust_level = "trusted"\n\n[mcp_servers.sevalla]\nurl = "https://mcp.sevalla.com/mcp"\n[mcp_servers.sevalla.http_headers]\nAuthorization = "Bearer codex-sentinel"\n\n[mcp_servers.node_repl]\ncommand = "app-managed"\n');
  write(path.join(o.home, ".codex-2/config.toml"), '# Second login\nmodel = "test-2"\n');
  write(path.join(o.home, ".cursor/mcp.json"), JSON.stringify({ mcpServers: { "Atlassian-MCP-Server": { url: "https://mcp.atlassian.com/v1/sse", headers: { Private: "cursor-sentinel" } }, slack: { url: "https://mcp.slack.com/mcp", auth: { CLIENT_ID: "existing-client", CLIENT_SECRET: "slack-sentinel" } } } }));
}
afterEach(() => { vi.restoreAllMocks(); for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

describe("MCP parity installer", () => {
  it("renders the same portable set into all four homes and preserves local credentials and settings", () => {
    const o = sandbox(); seed(o);
    const lines = installMcpParity(o);
    const expected = loadMcpManifest().servers.filter((s) => s.mode === "install");
    for (const { t, data } of configs(o.home)) {
      const servers = data[t.format === "codex" ? "mcp_servers" : "mcpServers"] as any;
      for (const s of expected) expect([s.name, ...s.aliases].some((n) => servers[n])).toBe(true);
      expect(servers["joyride-memory"]?.args ?? []).not.toContain(path.join(code, "src/mcp/memory-server.ts"));
      expect(servers.microsoft365).toBeUndefined();
    }
    const [claude, codex, second, cursor] = configs(o.home).map((c) => c.data as any);
    expect(claude.theme).toBe("paper");
    expect(claude.mcpServers.sevalla.headers.Authorization).toBe("Bearer claude-sentinel");
    expect(claude.mcpServers["joyride-memory"].env).toEqual({ PRIVATE: "keep" });
    expect(codex.mcp_servers.sevalla.http_headers.Authorization).toBe("Bearer codex-sentinel");
    expect(codex.mcp_servers.node_repl.command).toBe("app-managed");
    expect(second.mcp_servers.sevalla).toEqual({ url: "https://mcp.sevalla.com/mcp" });
    expect(cursor.mcpServers.slack.auth.CLIENT_SECRET).toBe("slack-sentinel");
    expect(cursor.mcpServers["Atlassian-MCP-Server"]).toEqual({ url: "https://mcp.atlassian.com/v2/mcp", headers: { Private: "cursor-sentinel" } });
    expect(cursor.mcpServers.atlassian).toBeUndefined();
    expect(fs.readFileSync(path.join(o.home, ".codex/config.toml"), "utf8")).toContain('# Keep my comment\nmodel = "test"');
    const state = fs.readFileSync(path.join(o.runtime, "install/mcp-parity.json"), "utf8");
    expect(state + lines.join("\n")).not.toMatch(/claude-sentinel|codex-sentinel|cursor-sentinel|slack-sentinel/);
    const backups = fs.readdirSync(path.join(o.runtime, "backups"));
    for (const file of fs.readdirSync(path.join(o.runtime, "backups", backups[0]))) expect(fs.statSync(path.join(o.runtime, "backups", backups[0], file)).mode & 0o777).toBe(0o600);
  });

  it("dry runs leave every config, runtime and log untouched", () => {
    const o = sandbox(); seed(o);
    const before = configs(o.home).map(({ t }) => fs.readFileSync(t.file, "utf8"));
    expect(installMcpParity({ ...o, dryRun: true }).join("\n")).toContain("Dry run");
    expect(configs(o.home).map(({ t }) => fs.readFileSync(t.file, "utf8"))).toEqual(before);
    expect(fs.existsSync(o.runtime)).toBe(false);
  });

  it("is idempotent without another config write, backup or state write", () => {
    const o = sandbox(); seed(o); installMcpParity(o);
    const times = parityTargets(o.home).map((t) => fs.statSync(t.file).mtimeMs);
    const state = fs.readFileSync(path.join(o.runtime, "install/mcp-parity.json"), "utf8");
    installMcpParity(o);
    expect(parityTargets(o.home).map((t) => fs.statSync(t.file).mtimeMs)).toEqual(times);
    expect(fs.readFileSync(path.join(o.runtime, "install/mcp-parity.json"), "utf8")).toBe(state);
    expect(fs.readdirSync(path.join(o.runtime, "backups"))).toHaveLength(1);
  });

  it("uninstalls only owned fields while preserving later edits and credentials", () => {
    const o = sandbox(); seed(o);
    const before = configs(o.home).map((c) => c.data);
    installMcpParity(o);
    const file = path.join(o.home, ".cursor/mcp.json"), cursor = JSON.parse(fs.readFileSync(file, "utf8"));
    cursor.newPreference = true;
    cursor.mcpServers.granola.headers = { Authorization: "Bearer newly-signed-in" };
    write(file, JSON.stringify(cursor));
    const lines = uninstallMcpParity(o);
    const after = configs(o.home).map((c) => c.data as any);
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).toEqual(before[1]);
    expect(after[2]).toEqual({ ...before[2], mcp_servers: {} });
    expect(after[3].mcpServers["Atlassian-MCP-Server"].url).toBe("https://mcp.atlassian.com/v1/sse");
    expect(after[3].mcpServers.granola.headers.Authorization).toBe("Bearer newly-signed-in");
    expect(after[3].newPreference).toBe(true);
    expect(lines.join("\n")).toContain("keep edited granola");
  });

  it("removes config files it created when they have no subsequent edits", () => {
    const o = sandbox(); installMcpParity(o); uninstallMcpParity(o);
    for (const t of parityTargets(o.home)) expect(fs.existsSync(t.file)).toBe(false);
  });

  it("preflights malformed or unreadable last config before changing any earlier config", () => {
    const o = sandbox(); seed(o); write(path.join(o.home, ".cursor/mcp.json"), "{broken: secret}");
    const before = fs.readFileSync(path.join(o.home, ".claude.json"), "utf8");
    expect(() => installMcpParity(o)).toThrow(/cursor config is unreadable or invalid/);
    expect(fs.readFileSync(path.join(o.home, ".claude.json"), "utf8")).toBe(before);
    expect(fs.existsSync(o.runtime)).toBe(false);
  });

  it("keeps unknown collisions and duplicate aliases for review", () => {
    const o = sandbox();
    write(path.join(o.home, ".claude.json"), JSON.stringify({ mcpServers: { slack: { command: "my-slack" }, atlassian: { url: "https://custom.example/mcp" }, "Atlassian-MCP-Server": { url: "https://mcp.atlassian.com/v1/sse" } } }));
    const lines = installMcpParity(o).join("\n");
    expect(lines).toContain("review conflicting slack"); expect(lines).toContain("review duplicate names for atlassian");
    expect(configs(o.home)[0].data.mcpServers.slack.command).toBe("my-slack");
  });

  it("does not follow symlinks to an unlisted config destination", () => {
    const o = sandbox(); fs.mkdirSync(o.home, { recursive: true });
    write(path.join(o.root, "other.json"), "{}"); fs.symlinkSync(path.join(o.root, "other.json"), path.join(o.home, ".claude.json"));
    expect(() => installMcpParity(o)).toThrow(/config is a symlink/);
    expect(fs.readFileSync(path.join(o.root, "other.json"), "utf8")).toBe("{}");
  });

  it("does not follow client directory symlinks", () => {
    const o = sandbox(); fs.mkdirSync(o.home, { recursive: true });
    const other = path.join(o.root, "other-client"); fs.mkdirSync(other);
    fs.symlinkSync(other, path.join(o.home, ".codex-2"));
    expect(() => installMcpParity(o)).toThrow(/config directory is a symlink/);
    expect(fs.readdirSync(other)).toEqual([]);
  });

  it("renders only env references for new token servers and never replaces later authentication", () => {
    const o = sandbox(), m = loadMcpManifest(), file = path.join(o.root, "manifest.json");
    m.servers.push({ name: "token-service", aliases: [], mode: "install", url: "https://token.example/mcp", bearerEnv: "PER_CLIENT_TOKEN", source: "test", note: "test" });
    write(file, JSON.stringify(m)); installMcpParity({ ...o, manifest: file });
    const [claude, codex, , cursor] = configs(o.home).map((c) => c.data as any);
    expect(claude.mcpServers["token-service"].headers.Authorization).toBe("Bearer ${PER_CLIENT_TOKEN}");
    expect(codex.mcp_servers["token-service"].bearer_token_env_var).toBe("PER_CLIENT_TOKEN");
    expect(cursor.mcpServers["token-service"].headers.Authorization).toBe("Bearer ${env:PER_CLIENT_TOKEN}");
    const cursorFile = path.join(o.home, ".cursor/mcp.json");
    cursor.mcpServers.granola.headers = { Authorization: "Bearer future-sentinel" };
    write(cursorFile, JSON.stringify(cursor));
    m.servers.find((s) => s.name === "granola")!.bearerEnv = "OTHER_TOKEN";
    write(file, JSON.stringify(m)); installMcpParity({ ...o, manifest: file });
    expect(JSON.parse(fs.readFileSync(cursorFile, "utf8")).mcpServers.granola.headers.Authorization).toBe("Bearer future-sentinel");
    expect(fs.readFileSync(path.join(o.runtime, "install/mcp-parity.json"), "utf8")).not.toContain("future-sentinel");
  });

  it("rejects credential-bearing manifest fields and URLs", () => {
    const o = sandbox(); const m = loadMcpManifest();
    const file = path.join(o.root, "manifest.json");
    m.servers[1].url = "https://user:password@example.com/mcp"; write(file, JSON.stringify(m));
    expect(() => installMcpParity({ ...o, manifest: file })).toThrow(/must not contain credentials/);
    const bad = { version: 1, servers: [{ name: "bad", mode: "install", url: "https://example.com/mcp", headers: { Authorization: "secret" }, source: "test", note: "test" }] };
    write(file, JSON.stringify(bad)); expect(() => loadMcpManifest(file)).toThrow();
    expect(fs.existsSync(o.runtime)).toBe(false);
  });

  it("rolls back prior configs when a later write fails", () => {
    const o = sandbox(); seed(o);
    const before = parityTargets(o.home).map((t) => fs.readFileSync(t.file, "utf8"));
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => { if (String(to).endsWith(".cursor/mcp.json")) throw new Error("write refused"); return rename(from, to); });
    expect(() => installMcpParity(o)).toThrow(/restored applied configs/);
    expect(parityTargets(o.home).map((t) => fs.readFileSync(t.file, "utf8"))).toEqual(before);
    expect(fs.existsSync(path.join(o.runtime, "install/mcp-parity.json"))).toBe(false);
  });

  it("refuses unsupported inline TOML without partial writes", () => {
    const o = sandbox(); seed(o);
    write(path.join(o.home, ".codex/config.toml"), 'mcp_servers = { "joyride-memory" = { command = "old", args = ["old"] } }\n');
    expect(() => installMcpParity(o)).toThrow(/Cannot safely update/);
    expect(fs.existsSync(o.runtime)).toBe(false);
  });

  it("supports the real installer CLI, dry-run, logging and uninstall with a temporary HOME", () => {
    const o = sandbox(); seed(o);
    const cli = (args: string[]) => spawnSync(path.join(code, "bin/joyride"), args, { cwd: code, encoding: "utf8", env: { ...process.env, HOME: o.home, CODEX_HOME: "/must-not-use", JOYRIDE_HOME: o.root, JOYRIDE_RUNTIME: o.runtime }, timeout: 30000 });
    const preview = cli(["install", "mcp-parity", "--dry-run"]); expect(preview.status, preview.stderr).toBe(0);
    expect(fs.existsSync(path.join(o.root, "GLOBAL_CHANGES.md"))).toBe(false);
    const result = cli(["install", "mcp-parity"]); expect(result.status, result.stderr).toBe(0);
    const log = fs.readFileSync(path.join(o.root, "GLOBAL_CHANGES.md"), "utf8"); expect(log).toContain("install `mcp-parity`"); expect(log).not.toContain("sentinel");
    const times = parityTargets(o.home).map((t) => fs.statSync(t.file).mtimeMs);
    const undoPreview = cli(["uninstall", "mcp-parity", "--dry-run"]); expect(undoPreview.status, undoPreview.stderr).toBe(0);
    expect(parityTargets(o.home).map((t) => fs.statSync(t.file).mtimeMs)).toEqual(times);
    const undo = cli(["uninstall", "mcp-parity"]); expect(undo.status, undo.stderr).toBe(0);
    expect(fs.readFileSync(path.join(o.root, "GLOBAL_CHANGES.md"), "utf8")).toContain("uninstall `mcp-parity`");
  });
});
