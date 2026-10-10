// `joyride vendor [name...]`: clone the pinned dependencies in vendor/PINS.md
// (gitignored) and check out each pin. Firstmate also gets Joyride's local
// patches from install/firstmate-patches, so re-creating it never drops them.
// A checkout with uncommitted changes, or with local Firstmate commits that are
// not listed patches, is reported and left alone.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { paths } from "../shared/paths.ts";
import { FIRSTMATE_PIN } from "../modules/firstmate/seed.ts";
import { applyFirstmatePatches, checkFirstmateVendor, describeFirstmateVendor } from "../modules/firstmate/vendor.ts";
import { EVALS_PIN, loadPstackPatches } from "./install.ts";

type Dep = { url: string; pin: () => string; sparse?: string; patch?: (dir: string) => string[] };
export const VENDOR: Record<string, Dep> = {
  firstmate: { url: "https://github.com/kunchenguid/firstmate", pin: () => FIRSTMATE_PIN, patch: applyFirstmatePatches },
  "cursor-plugins": { url: "https://github.com/cursor/plugins", pin: () => loadPstackPatches().pin, sparse: "pstack" },
  backpass: { url: "https://github.com/kunchenguid/backpass", pin: () => "0268201c3896f45d3002de0d439b6cefccb39063" },
  "evals-skills": { url: "https://github.com/ai-evals-course/evals-skills", pin: () => EVALS_PIN },
};

const git = (args: string[], cwd?: string) =>
  execFileSync("git", ["-c", "advice.detachedHead=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, JOYRIDE_GUARD: "off" } }).trim();
const tryGit = (args: string[], cwd?: string) => { try { return git(args, cwd); } catch { return null; } };

export function vendorOne(name: string): string[] {
  const dep = VENDOR[name];
  if (!dep) throw new Error(`unknown vendored dependency ${name}; known: ${Object.keys(VENDOR).join(", ")}`);
  const dir = path.join(paths.code, "vendor", name), pin = dep.pin(), out: string[] = [];
  if (!fs.existsSync(path.join(dir, ".git"))) {
    if (dep.sparse) {
      git(["clone", "--quiet", "--filter=blob:none", "--no-checkout", dep.url, dir]);
      git(["sparse-checkout", "set", dep.sparse], dir);
    } else git(["clone", "--quiet", "--no-checkout", dep.url, dir]);
    git(["checkout", "--quiet", "--detach", pin], dir);
    out.push(`cloned ${dep.url} into vendor/${name} at ${pin.slice(0, 7)}`);
  } else if (dep.patch ? checkFirstmateVendor(dir).state === "mismatch" : tryGit(["rev-parse", "HEAD"], dir) !== pin) {
    if (git(["status", "--porcelain"], dir)) return [`skipped vendor/${name}: it has uncommitted changes; commit or discard them, then run ./bin/joyride vendor ${name} again`];
    const extra = dep.patch ? checkFirstmateVendor(dir).extra : [];
    if (extra.length) return [`skipped vendor/${name}: local commits on top of the pin are not in install/firstmate-patches (${extra.join("; ")}); add them there with git format-patch, or check out the pin yourself`];
    if (tryGit(["cat-file", "-e", `${pin}^{commit}`], dir) === null) git(["fetch", "--quiet", "origin"], dir);
    git(["checkout", "--quiet", "--detach", pin], dir);
    out.push(`checked out vendor/${name} at ${pin.slice(0, 7)}`);
  }
  if (dep.patch) {
    const applied = dep.patch(dir);
    if (applied.length) out.push(`applied Joyride's patches to vendor/${name}: ${applied.join(", ")}`);
    out.push(describeFirstmateVendor(checkFirstmateVendor(dir)));
  } else if (!out.length) out.push(`vendor/${name} at pin ${pin.slice(0, 7)}`);
  return out;
}

export function vendor(names: string[]) {
  let failed = false;
  for (const n of names.length ? names : Object.keys(VENDOR)) {
    try { for (const l of vendorOne(n)) console.log(`${n.padEnd(15)} ${l}`); }
    catch (e: any) { failed = true; console.error(`${n.padEnd(15)} FAILED: ${String(e.stderr || e.message).trim()}`); }
  }
  if (failed) process.exitCode = 1;
}
