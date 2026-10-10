// vendor/firstmate counts as pinned when it is the upstream pin plus Joyride's
// local patches (install/firstmate-patches), matched by patch-id so a re-applied
// patch with a new SHA still passes; missing patches are applied, and anything
// else is a mismatch.
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { applyFirstmatePatches, checkFirstmateVendor, checkFirstmateVendorAsync, describeFirstmateVendor, loadFirstmatePatches } from "../../src/modules/firstmate/vendor.ts";
import { FIRSTMATE_PIN } from "../../src/modules/firstmate/seed.ts";

process.env.GIT_COMMITTER_NAME = process.env.GIT_AUTHOR_NAME = "t";
process.env.GIT_COMMITTER_EMAIL = process.env.GIT_AUTHOR_EMAIL = "t@t";
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let root: string, upstream: string, patchesDir: string, pin: string;
const fresh = (name: string) => { const d = path.join(root, name); git(root, "clone", "-q", upstream, d); git(d, "checkout", "-q", "--detach", pin); return d; };
const commitFile = (d: string, file: string, text: string, msg: string) => { fs.writeFileSync(path.join(d, file), text); git(d, "add", file); git(d, "commit", "-qm", msg); };

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jr-fm-vendor-"));
  upstream = path.join(root, "upstream");
  fs.mkdirSync(upstream);
  git(upstream, "init", "-q");
  fs.writeFileSync(path.join(upstream, "lib.sh"), "a\nb\n");
  fs.writeFileSync(path.join(upstream, "other.sh"), "x\n");
  git(upstream, "add", "-A");
  git(upstream, "commit", "-qm", "upstream");
  pin = git(upstream, "rev-parse", "HEAD");
  const work = fresh("work");
  commitFile(work, "lib.sh", "a\nB\n", "fix lib");
  commitFile(work, "other.sh", "y\n", "fix other");
  patchesDir = path.join(root, "patches");
  fs.mkdirSync(patchesDir);
  git(work, "format-patch", "-q", "-2", "--zero-commit", "--no-signature", "-o", patchesDir);
  const files = fs.readdirSync(patchesDir).sort();
  fs.writeFileSync(path.join(patchesDir, "patches.json"), JSON.stringify({ pin, patches: [{ id: "lib", file: files[0], why: "" }, { id: "other", file: files[1], why: "" }] }));
});

describe("firstmate vendor pin", () => {
  it("the daemon's async reader agrees with the installer and detects a changed HEAD", async () => {
    const d = fresh("async");
    const opts = { pin, patchesDir };
    expect(await checkFirstmateVendorAsync(d, opts)).toEqual(checkFirstmateVendor(d, opts));
    applyFirstmatePatches(d, opts);
    const pinned = await checkFirstmateVendorAsync(d, opts);
    expect(pinned).toEqual(checkFirstmateVendor(d, opts));
    expect(await checkFirstmateVendorAsync(d, opts, pinned)).toEqual(pinned);
    commitFile(d, "extra", "new", "unlisted");
    expect(await checkFirstmateVendorAsync(d, opts, pinned)).toEqual(checkFirstmateVendor(d, opts));
  });
  it("applies the missing patches on top of the bare pin, then counts it as pinned", () => {
    const d = fresh("bare");
    const opts = { pin, patchesDir };
    expect(checkFirstmateVendor(d, opts)).toMatchObject({ state: "unpatched", applied: [], missing: ["lib", "other"] });
    expect(applyFirstmatePatches(d, opts)).toEqual(["lib", "other"]);
    const c = checkFirstmateVendor(d, opts);
    expect(c).toMatchObject({ state: "pinned", applied: ["lib", "other"], missing: [], extra: [] });
    expect(fs.readFileSync(path.join(d, "lib.sh"), "utf8")).toBe("a\nB\n");
    expect(describeFirstmateVendor(c, pin)).toBe(`vendor/firstmate at pin ${pin.slice(0, 7)} with Joyride's patches (lib, other)`);
    expect(applyFirstmatePatches(d, opts)).toEqual([]);
  });

  it("accepts the original local commits too, whatever their SHA", () => {
    expect(checkFirstmateVendor(path.join(root, "work"), { pin, patchesDir }).state).toBe("pinned");
  });

  it("applies only the rest when the first patch is already there", () => {
    const d = fresh("half");
    git(d, "am", "-q", path.join(patchesDir, fs.readdirSync(patchesDir).sort()[0]));
    expect(checkFirstmateVendor(d, { pin, patchesDir })).toMatchObject({ state: "unpatched", applied: ["lib"], missing: ["other"] });
    expect(applyFirstmatePatches(d, { pin, patchesDir })).toEqual(["other"]);
    expect(checkFirstmateVendor(d, { pin, patchesDir }).state).toBe("pinned");
  });

  it("calls an unlisted local commit, or a checkout off the pin, a mismatch", () => {
    const d = fresh("extra");
    commitFile(d, "other.sh", "z\n", "my own change");
    const c = checkFirstmateVendor(d, { pin, patchesDir });
    expect(c).toMatchObject({ state: "mismatch", extra: [expect.stringMatching(/ my own change$/)] });
    expect(describeFirstmateVendor(c, pin)).toMatch(/^WARNING .*unlisted commits: .* my own change/);
    expect(applyFirstmatePatches(d, { pin, patchesDir })).toEqual([]);
    const off = path.join(root, "off");
    git(root, "init", "-q", off);
    commitFile(off, "x", "1", "unrelated");
    expect(checkFirstmateVendor(off, { pin, patchesDir }).state).toBe("mismatch");
    expect(checkFirstmateVendor(path.join(root, "nope"), { pin, patchesDir }).state).toBe("missing");
  });

  it("refuses patches written for another pin", () => {
    expect(() => loadFirstmatePatches({ pin: "0".repeat(40), patchesDir })).toThrow(/regenerate the patches/);
  });

  it("ships patches for FIRSTMATE_PIN that are readable", () => {
    const p = loadFirstmatePatches();
    expect(p.pin).toBe(FIRSTMATE_PIN);
    expect(p.patches.map((x) => x.id)).toContain("bash32-bashpid");
    for (const x of p.patches) expect(fs.readFileSync(path.join(process.cwd(), "install", "firstmate-patches", x.file), "utf8")).toMatch(/^diff --git /m);
  });
});
