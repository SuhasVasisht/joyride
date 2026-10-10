import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { shot } from "./shot";

test("shared skills CLI dry-run, install, repeat and undo in an isolated home", async ({ page }) => {
  const root = fs.mkdtempSync(path.resolve(".joyride/skills-e2e-"));
  const home = path.join(root, "home"), runtime = path.join(root, ".joyride");
  const homes = [".claude", ".codex", ".codex-2", ".cursor", ".agents"];
  const env = { ...process.env, HOME: home, JOYRIDE_HOME: root, JOYRIDE_RUNTIME: runtime,
    JOYRIDE_CLAUDE_DIR: path.join(home, ".claude"), JOYRIDE_CODEX_DIR: path.join(home, ".codex"),
    JOYRIDE_CODEX_2_DIR: path.join(home, ".codex-2"), JOYRIDE_CURSOR_DIR: path.join(home, ".cursor"), JOYRIDE_AGENTS_DIR: path.join(home, ".agents"), JOYRIDE_FAKE_MODELS: "1" };
  const cli = (...args: string[]) => execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/cli/joyride.ts", ...args], { env, encoding: "utf8", timeout: 30000 });
  const settings = path.join(home, ".claude/settings.json");
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  const original = JSON.stringify({ enabledPlugins: { "caveman@caveman": true, "slack@official": true } });
  fs.writeFileSync(settings, original);
  const bundled = path.join(home, ".codex-2/skills/.system/provider.txt");
  fs.mkdirSync(path.dirname(bundled), { recursive: true }); fs.writeFileSync(bundled, "Bundled skill");
  try {
    expect(cli("install", "shared-skills", "no-caveman", "mcp-parity", "--dry-run")).toContain("would share");
    expect(fs.existsSync(runtime)).toBe(false);
    expect(fs.existsSync(path.join(root, "GLOBAL_CHANGES.md"))).toBe(false);
    expect(fs.readFileSync(settings, "utf8")).toBe(original);
    cli("install", "shared-skills", "no-caveman");
    expect(cli("install", "skills")).toContain("shared skill links kept");
    expect(cli("uninstall", "skills")).toContain("shared skill links kept");
    const journal = fs.readFileSync(path.join(runtime, "install/shared-skills.json"), "utf8");
    for (const h of homes) expect(fs.readlinkSync(path.join(home, h, "skills/joyride-evidence"))).toBe(path.resolve("skills/joyride-evidence"));
    expect(JSON.parse(fs.readFileSync(settings, "utf8")).enabledPlugins).toEqual({ "caveman@caveman": false, "slack@official": true });
    expect(fs.readFileSync(path.join(root, "GLOBAL_CHANGES.md"), "utf8")).toContain("install `shared-skills`");
    cli("install", "shared-skills", "no-caveman");
    expect(fs.readFileSync(path.join(runtime, "install/shared-skills.json"), "utf8")).toBe(journal);
    expect(cli("uninstall", "shared-skills", "no-caveman", "--dry-run")).toContain("would restore");
    cli("uninstall", "shared-skills", "no-caveman");
    for (const h of homes) expect(fs.existsSync(path.join(home, h, "skills/joyride-evidence"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(settings, "utf8")).enabledPlugins["caveman@caveman"]).toBe(true);
    expect(fs.readFileSync(bundled, "utf8")).toBe("Bundled skill");
    expect(fs.readFileSync(path.join(root, "GLOBAL_CHANGES.md"), "utf8")).toContain("uninstall `no-caveman`");

    // The new components are discoverable on Joyride's existing real settings surface.
    await page.goto("/#/settings");
    const components = page.locator('[data-settings="components"]');
    await components.scrollIntoViewIfNeeded();
    await expect(components.locator('[data-component="shared-skills"]')).toContainText("One Joyride-owned skills tree");
    await expect(components.locator('[data-component="no-caveman"]')).toContainText("Disable Claude's caveman plugin");
    await shot(page, "C-skills-unify", "installer-components");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
