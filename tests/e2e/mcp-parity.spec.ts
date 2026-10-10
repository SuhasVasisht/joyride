import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { parse } from "smol-toml";
import { shot } from "./shot";

const code = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
test("MCP parity: real installer previews, renders all four configs and reverses its changes", async ({ page }) => {
  const parent = path.join(code, ".joyride/mcp-parity-e2e");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "home-")), home = path.join(root, "home"), runtime = path.join(root, "runtime");
  const files = [".claude.json", ".codex/config.toml", ".codex-2/config.toml", ".cursor/mcp.json"];
  const cli = (...args: string[]) => execFileSync(path.join(code, "bin/joyride"), args, {
    cwd: code, encoding: "utf8", timeout: 30000,
    env: { ...process.env, HOME: home, JOYRIDE_HOME: root, JOYRIDE_RUNTIME: runtime, JOYRIDE_FAKE_MODELS: "1", JOYRIDE_MANAGE_HERDR: "0" },
  });
  const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  try {
    const preview = cli("install", "mcp-parity", "--dry-run");
    expect(preview).toContain("Dry run");
    for (const f of files) expect(fs.existsSync(path.join(home, f))).toBe(false);
    expect(fs.existsSync(runtime)).toBe(false);
    const output = cli("install", "mcp-parity");
    const manifest = JSON.parse(fs.readFileSync(path.join(code, "config/mcp-manifest.json"), "utf8"));
    const wanted = manifest.servers.filter((s: any) => s.mode === "install").map((s: any) => s.name).sort();
    const rows = files.map((f) => {
      const raw = fs.readFileSync(path.join(home, f), "utf8"), data: any = f.endsWith(".toml") ? parse(raw) : JSON.parse(raw);
      const servers = data[f.endsWith(".toml") ? "mcp_servers" : "mcpServers"];
      expect(Object.keys(servers).sort()).toEqual(wanted);
      expect(servers["joyride-memory"]).toBeUndefined();
      return `<tr><th>${escape(f)}</th><td>${wanted.length} configured</td><td>${escape(wanted.join(", "))}</td></tr>`;
    });
    const originals = files.map((f) => fs.readFileSync(path.join(home, f), "utf8"));
    cli("install", "mcp-parity");
    expect(files.map((f) => fs.readFileSync(path.join(home, f), "utf8"))).toEqual(originals);
    expect(fs.readdirSync(path.join(runtime, "backups"))).toHaveLength(1);
    const undoPreview = cli("uninstall", "mcp-parity", "--dry-run");
    expect(undoPreview).toContain("Dry run");
    cli("uninstall", "mcp-parity");
    for (const f of files) expect(fs.existsSync(path.join(home, f))).toBe(false);
    expect(fs.readFileSync(path.join(root, "GLOBAL_CHANGES.md"), "utf8")).toContain("uninstall `mcp-parity`");
    // An inspectable integration-test receipt from the real CLI output. This
    // is deliberately not a claim to have changed Joyride's application UI.
    await page.setContent(`<style>body{background:#eef1f2;color:#172f45;font:18px system-ui;padding:38px}h1{font-size:32px}table{border-collapse:collapse;width:100%;font-size:15px}th,td{padding:14px;text-align:left;border:1px solid #b8c5ce}pre{font:13px monospace;white-space:pre-wrap;background:white;padding:20px}p{max-width:1000px}</style><h1>MCP parity installer evidence</h1><p>Disposable HOME only. Four native configuration files verified. Preview writes nothing. Reinstall is idempotent. Uninstall removes unchanged entries. No daemon or Herdr was started.</p><table><thead><tr><th>Client configuration</th><th>Result</th><th>Portable server set</th></tr></thead><tbody>${rows.join("")}</tbody></table><p>Configured endpoints still need independent authentication. Microsoft 365 and other review entries are withheld pending provisioning.</p><h2>Dry-run output</h2><pre>${escape(preview.replaceAll(root, "$SANDBOX"))}</pre>`);
    await expect(page.getByRole("heading", { name: "MCP parity installer evidence" })).toBeVisible();
    await expect(page.locator("tbody tr")).toHaveCount(4);
    await shot(page, "C10", "mcp-parity-installer", { fullPage: true });
    expect(output).toContain("MCP parity");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
