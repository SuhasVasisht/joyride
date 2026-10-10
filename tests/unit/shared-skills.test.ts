import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { installSharedSkills, uninstallSharedSkills, sharedSkillsPlan, sharedSkillsStatus, skillFingerprint, type SharedSkillsOptions } from "../../src/cli/shared-skills.ts";
import { installNoCaveman, uninstallNoCaveman, noCavemanStatus } from "../../src/cli/no-caveman.ts";

function sandbox(): SharedSkillsOptions {
  const base = fs.mkdtempSync(path.join(process.env.JOYRIDE_RUNTIME!, "skills-"));
  const source = path.join(base, "repo", "skills");
  fs.mkdirSync(source, { recursive: true });
  return { source, runtime: path.join(base, "repo", ".joyride"), homes: ["claude", "codex", "codex-2", "cursor", "agents"].map(name => ({ name, dir: path.join(base, "home", `.${name}`, "skills") })) };
}
function skill(root: string, name: string, body = "A skill") {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${path.basename(name)}\ndescription: ${body}\n---\n${body}\n`);
  fs.writeFileSync(path.join(dir, "asset.bin"), Buffer.from([0, 255, 42]));
  fs.writeFileSync(path.join(dir, "run.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return dir;
}

describe("shared skills installer", () => {
  it("backs up every variant, links all five homes, reflects edits and restores originals", () => {
    const o = sandbox();
    const claude = skill(o.homes[0].dir, "demo"), original = skillFingerprint(claude);
    fs.mkdirSync(path.join(claude, ".git")); fs.writeFileSync(path.join(claude, ".git/HEAD"), "ref: refs/heads/main\n");
    fs.mkdirSync(o.homes[1].dir, { recursive: true });
    const relative = path.relative(o.homes[1].dir, claude);
    fs.symlinkSync(relative, path.join(o.homes[1].dir, "demo"));
    skill(o.homes[1].dir, ".system/provider-skill", "Bundled");
    skill(o.homes[0].dir, ".archive-old", "Archived");
    skill(o.source, "synced/group/nested", "Nested skill");
    expect(installSharedSkills(o, true).join("\n")).toContain("would copy");
    expect(fs.existsSync(o.runtime)).toBe(false);
    installSharedSkills(o);
    expect(fs.existsSync(path.join(o.source, "demo/.git"))).toBe(false);
    for (const h of o.homes) {
      expect(fs.readlinkSync(path.join(h.dir, "demo"))).toBe(path.join(o.source, "demo"));
      expect(fs.readFileSync(path.join(h.dir, "demo/asset.bin"))).toEqual(Buffer.from([0, 255, 42]));
      expect(fs.existsSync(path.join(h.dir, "synced/group/nested/SKILL.md"))).toBe(true);
    }
    expect(fs.statSync(path.join(o.source, "demo/run.sh")).mode & 0o111).toBeTruthy();
    const journal = fs.readFileSync(path.join(o.runtime, "install/shared-skills.json"), "utf8");
    installSharedSkills(o);
    expect(fs.readFileSync(path.join(o.runtime, "install/shared-skills.json"), "utf8")).toBe(journal);
    fs.writeFileSync(path.join(o.source, "demo/SKILL.md"), "Shared update");
    for (const h of o.homes) expect(fs.readFileSync(path.join(h.dir, "demo/SKILL.md"), "utf8")).toBe("Shared update");
    uninstallSharedSkills(o);
    expect(skillFingerprint(claude)).toBe(original);
    expect(fs.readFileSync(path.join(claude, ".git/HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
    expect(fs.readlinkSync(path.join(o.homes[1].dir, "demo"))).toBe(relative);
    expect(fs.existsSync(path.join(o.homes[2].dir, "demo"))).toBe(false);
    expect(fs.existsSync(path.join(o.homes[1].dir, ".system/provider-skill/SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(o.homes[0].dir, ".archive-old/SKILL.md"))).toBe(true);
    expect(fs.readFileSync(path.join(o.source, "demo/SKILL.md"), "utf8")).toBe("Shared update");
    expect(uninstallSharedSkills(o)[0]).toContain("restored 0");
  });

  it("links bundled skills beside the library and retargets managed links when the library moves", () => {
    const o = sandbox(), base = path.dirname(path.dirname(o.source));
    const bundled = path.join(base, "code", "skills");
    skill(bundled, "joyride-evidence", "Bundled");
    skill(o.source, "demo");
    installSharedSkills({ ...o, bundled });
    for (const h of o.homes) expect(fs.readlinkSync(path.join(h.dir, "joyride-evidence"))).toBe(path.join(bundled, "joyride-evidence"));
    expect(fs.existsSync(path.join(o.source, "joyride-evidence"))).toBe(false);
    // A new data home: the library moves and its old links dangle.
    const moved = path.join(base, "data", "skills");
    fs.mkdirSync(path.dirname(moved), { recursive: true });
    fs.renameSync(o.source, moved);
    const next = { ...o, source: moved, bundled };
    expect(installSharedSkills(next, true)).toContain(`would retarget ${path.join(o.homes[0].dir, "demo")} -> ${path.join(moved, "demo")}`);
    installSharedSkills(next);
    for (const h of o.homes) {
      expect(fs.readlinkSync(path.join(h.dir, "demo"))).toBe(path.join(moved, "demo"));
      expect(fs.readlinkSync(path.join(h.dir, "joyride-evidence"))).toBe(path.join(bundled, "joyride-evidence"));
    }
    expect(sharedSkillsStatus(next)).toBe(`${o.homes.length * 2}/${o.homes.length * 2} managed links present`);
    expect(fs.readdirSync(path.join(o.runtime, "backups"))).toHaveLength(1);
    expect(installSharedSkills(next).some(l => l.includes("retarget"))).toBe(false);
    uninstallSharedSkills(next);
    for (const h of o.homes) expect(fs.existsSync(path.join(h.dir, "demo"))).toBe(false);
  });

  it("refuses a skill that is both in the library and bundled", () => {
    const o = sandbox(), bundled = path.join(path.dirname(o.source), "bundled");
    skill(o.source, "joyride-verify"); skill(bundled, "joyride-verify");
    expect(() => sharedSkillsPlan({ ...o, bundled })).toThrow(/in both/);
  });

  it("rejects conflicting content before changing or backing up any home", () => {
    const o = sandbox();
    skill(o.homes[0].dir, "demo", "One"); skill(o.homes[3].dir, "demo", "Two");
    expect(() => installSharedSkills(o)).toThrow("Different copies");
    expect(fs.existsSync(o.runtime)).toBe(false);
    expect(fs.existsSync(path.join(o.source, "demo"))).toBe(false);
    expect(fs.lstatSync(path.join(o.homes[0].dir, "demo")).isSymbolicLink()).toBe(false);
  });

  it("accepts only reviewed variant hashes and preserves their content in backups", () => {
    const o = sandbox();
    skill(o.source, "demo", "Canonical");
    const variant = skill(o.homes[4].dir, "demo", "Reviewed variant");
    const digest = skillFingerprint(variant);
    o.accepted = path.join(o.source, "..", "accepted.json");
    fs.writeFileSync(o.accepted, JSON.stringify({ demo: [digest] }));
    installSharedSkills(o);
    uninstallSharedSkills(o);
    expect(skillFingerprint(variant)).toBe(digest);
    fs.writeFileSync(path.join(variant, "SKILL.md"), "Unreviewed update");
    expect(() => installSharedSkills(o)).toThrow("Different copies");
  });

  it("keeps a user replacement on reinstall and uninstall without a partial undo", () => {
    const o = sandbox(); skill(o.source, "demo"); installSharedSkills(o);
    const replaced = path.join(o.homes[3].dir, "demo");
    fs.unlinkSync(replaced); skill(o.homes[3].dir, "demo", "My replacement");
    expect(() => installSharedSkills(o)).toThrow();
    expect(() => uninstallSharedSkills(o)).toThrow("Managed skill changed");
    expect(fs.readFileSync(path.join(replaced, "SKILL.md"), "utf8")).toContain("My replacement");
    expect(fs.lstatSync(path.join(o.homes[0].dir, "demo")).isSymbolicLink()).toBe(true);
  });

  it("fails closed for broken links, symlinked roots, internal symlinks and missing backups", () => {
    const o = sandbox(); skill(o.source, "demo");
    fs.mkdirSync(o.homes[0].dir, { recursive: true });
    fs.symlinkSync("missing", path.join(o.homes[0].dir, "broken"));
    expect(() => sharedSkillsPlan(o)).toThrow();
    fs.unlinkSync(path.join(o.homes[0].dir, "broken"));
    fs.rmdirSync(o.homes[0].dir); fs.symlinkSync(o.source, o.homes[0].dir);
    expect(() => sharedSkillsPlan(o)).toThrow("Skills root is a symlink");
    fs.unlinkSync(o.homes[0].dir);
    const from = skill(o.homes[0].dir, "demo");
    fs.symlinkSync("asset.bin", path.join(from, "internal"));
    expect(() => sharedSkillsPlan(o)).toThrow("internal symlink");
    fs.unlinkSync(path.join(from, "internal"));
    installSharedSkills(o);
    const state = JSON.parse(fs.readFileSync(path.join(o.runtime, "install/shared-skills.json"), "utf8"));
    fs.rmSync(state.links[0].backup, { recursive: true });
    expect(() => uninstallSharedSkills(o)).toThrow("Missing skill backup");
  });

  it("restores all originals when a link cannot be created after replacements begin", () => {
    const o = sandbox(); skill(o.homes[0].dir, "demo"); skill(o.homes[1].dir, "demo");
    const original = skillFingerprint(path.join(o.homes[0].dir, "demo"));
    const symlink = fs.symlinkSync;
    const spy = vi.spyOn(fs, "symlinkSync").mockImplementation((target, dest, type) => {
      if (String(dest) === path.join(o.homes[1].dir, "demo")) throw new Error("link creation refused");
      return symlink(target, dest, type);
    });
    try { expect(() => installSharedSkills(o)).toThrow("link creation refused"); }
    finally { spy.mockRestore(); }
    for (const h of o.homes.slice(0, 2)) {
      expect(fs.lstatSync(path.join(h.dir, "demo")).isDirectory()).toBe(true);
      expect(skillFingerprint(path.join(h.dir, "demo"))).toBe(original);
    }
    expect(JSON.parse(fs.readFileSync(path.join(o.runtime, "install/shared-skills.json"), "utf8")).links).toEqual([]);
    installSharedSkills(o); uninstallSharedSkills(o);
  });
});

describe("caveman removal", () => {
  const cavemanLine = { type: "command", command: 'bash "/tmp/home/.claude/plugins/cache/caveman/caveman/hash/hooks/caveman-statusline.sh"' };
  function options() {
    const o = sandbox();
    const settings = path.join(o.homes[0].dir, "..", "settings.json");
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ enabledPlugins: { "caveman@caveman": true, "slack@official": true }, hooks: { SessionStart: [{ hooks: [{ command: "keep this hook" }] }] } }));
    return { settings, runtime: o.runtime };
  }
  it("disables only caveman, records a byte-identical backup, and preserves later settings on undo", () => {
    const o = options(), original = fs.readFileSync(o.settings);
    installNoCaveman(o, true);
    expect(fs.readFileSync(o.settings)).toEqual(original);
    expect(fs.existsSync(o.runtime)).toBe(false);
    installNoCaveman(o);
    const undo = JSON.parse(fs.readFileSync(path.join(o.runtime, "install/no-caveman.json"), "utf8"));
    expect(fs.readFileSync(undo.backup)).toEqual(original);
    const s = JSON.parse(fs.readFileSync(o.settings, "utf8"));
    expect(s.enabledPlugins).toEqual({ "caveman@caveman": false, "slack@official": true });
    expect(s.hooks.SessionStart[0].hooks[0].command).toBe("keep this hook");
    expect(installNoCaveman(o)[0]).toContain("already disabled");
    s.enabledPlugins["slack@official"] = false; s.theme = "new";
    fs.writeFileSync(o.settings, JSON.stringify(s));
    uninstallNoCaveman(o, true);
    uninstallNoCaveman(o);
    expect(JSON.parse(fs.readFileSync(o.settings, "utf8"))).toMatchObject({ enabledPlugins: { "caveman@caveman": true, "slack@official": false }, theme: "new" });
    expect(uninstallNoCaveman(o)[0]).toBe("no caveman change to undo");
  });
  it("handles absent settings and refuses to clobber a later plugin decision", () => {
    const o = options(); fs.unlinkSync(o.settings);
    installNoCaveman(o); uninstallNoCaveman(o);
    expect(fs.existsSync(o.settings)).toBe(false);
    installNoCaveman(o);
    fs.writeFileSync(o.settings, JSON.stringify({ enabledPlugins: { "caveman@caveman": true } }));
    expect(() => uninstallNoCaveman(o)).toThrow("changed after installation");
  });
  it("refuses malformed settings without a backup or a write", () => {
    const o = options(); fs.writeFileSync(o.settings, '{"enabledPlugins":[] }');
    expect(() => installNoCaveman(o)).toThrow("invalid");
    expect(fs.existsSync(o.runtime)).toBe(false);
  });
  it("removes and restores only a caveman cache status line when the plugin is already disabled", () => {
    const o = options();
    const original = JSON.stringify({ enabledPlugins: { "caveman@caveman": false }, statusLine: cavemanLine, theme: "dark" });
    fs.writeFileSync(o.settings, original);
    expect(noCavemanStatus(o)).toBe("caveman enabled");
    expect(installNoCaveman(o, true)[0]).toContain("remove caveman status line");
    expect(fs.readFileSync(o.settings, "utf8")).toBe(original);
    installNoCaveman(o);
    const undo = JSON.parse(fs.readFileSync(path.join(o.runtime, "install/no-caveman.json"), "utf8"));
    expect(fs.readFileSync(undo.backup, "utf8")).toBe(original);
    expect(JSON.parse(fs.readFileSync(o.settings, "utf8"))).toEqual({ enabledPlugins: { "caveman@caveman": false }, theme: "dark" });
    expect(installNoCaveman(o)[0]).toContain("already disabled");
    uninstallNoCaveman(o);
    expect(JSON.parse(fs.readFileSync(o.settings, "utf8"))).toEqual(JSON.parse(original));
  });
  it("keeps unrelated or newly set status lines", () => {
    const o = options();
    const other = { type: "command", command: "bash /tmp/other-status.sh" };
    fs.writeFileSync(o.settings, JSON.stringify({ enabledPlugins: { "caveman@caveman": false }, statusLine: other }));
    expect(installNoCaveman(o)[0]).toContain("already disabled");
    expect(fs.existsSync(o.runtime)).toBe(false);
    fs.writeFileSync(o.settings, JSON.stringify({ enabledPlugins: { "caveman@caveman": false }, statusLine: cavemanLine }));
    installNoCaveman(o);
    fs.writeFileSync(o.settings, JSON.stringify({ enabledPlugins: { "caveman@caveman": false }, statusLine: other }));
    expect(() => uninstallNoCaveman(o)).toThrow("status line changed");
    expect(JSON.parse(fs.readFileSync(o.settings, "utf8")).statusLine).toEqual(other);
  });
  it("upgrades an existing plugin-only installation when a leftover status line appears", () => {
    const o = options();
    installNoCaveman(o);
    const s = JSON.parse(fs.readFileSync(o.settings, "utf8"));
    s.statusLine = cavemanLine;
    fs.writeFileSync(o.settings, JSON.stringify(s));
    installNoCaveman(o);
    expect(JSON.parse(fs.readFileSync(o.settings, "utf8")).statusLine).toBeUndefined();
    uninstallNoCaveman(o);
    const restored = JSON.parse(fs.readFileSync(o.settings, "utf8"));
    expect(restored.enabledPlugins["caveman@caveman"]).toBe(true);
    expect(restored.statusLine).toEqual(cavemanLine);
  });
});
