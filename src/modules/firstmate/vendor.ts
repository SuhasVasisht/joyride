// The vendored Firstmate is the upstream pin plus Joyride's local patches in
// install/firstmate-patches (patches.json, applied in order with `git am`).
// The patches never reach upstream, so a re-applied patch gets a new SHA: each
// commit after the pin is matched to its patch by `git patch-id --stable`.
import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { paths } from "../../shared/paths.ts";
import { FIRSTMATE_PIN } from "./seed.ts";

export type FirstmatePatch = { id: string; file: string; why: string };
export type FirstmatePatches = { pin: string; patches: FirstmatePatch[] };
/** pinned: the pin plus every patch. unpatched: the pin plus a prefix of the patches. */
export type VendorState = "pinned" | "unpatched" | "mismatch" | "missing";
export type VendorCheck = { head: string | null; state: VendorState; applied: string[]; missing: string[]; extra: string[] };

export const firstmatePatchesDir = () => path.join(paths.code, "install", "firstmate-patches");

export type VendorOpts = { pin?: string; patchesDir?: string };

export function loadFirstmatePatches({ pin = FIRSTMATE_PIN, patchesDir = firstmatePatchesDir() }: VendorOpts = {}): FirstmatePatches {
  const p = JSON.parse(fs.readFileSync(path.join(patchesDir, "patches.json"), "utf8")) as FirstmatePatches;
  if (p.pin !== pin) throw new Error(`${path.join(patchesDir, "patches.json")} targets ${p.pin.slice(0, 7)} but the Firstmate pin is ${pin.slice(0, 7)}; regenerate the patches for the new pin`);
  return p;
}

const git = (dir: string, args: string[], input?: string) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], env: { ...process.env, JOYRIDE_GUARD: "off" } }).trim();
const tryGit = (dir: string, args: string[]) => { try { return git(dir, args); } catch { return null; } };
const patchId = (dir: string, diff: string) => git(dir, ["patch-id", "--stable"], diff).split(/\s+/)[0] ?? "";

export function checkFirstmateVendor(dir: string, opts: VendorOpts = {}): VendorCheck {
  const { pin = FIRSTMATE_PIN, patchesDir = firstmatePatchesDir() } = opts;
  const head = tryGit(dir, ["rev-parse", "HEAD"]);
  const none = { applied: [], missing: [], extra: [] };
  if (!head) return { head: null, state: "missing", ...none };
  const { patches } = loadFirstmatePatches(opts);
  if (tryGit(dir, ["merge-base", "--is-ancestor", pin, head]) === null) return { head, state: "mismatch", ...none, missing: patches.map((p) => p.id) };
  const commits = git(dir, ["rev-list", "--reverse", "--topo-order", `${pin}..${head}`]).split("\n").filter(Boolean);
  const applied: string[] = [], extra: string[] = [];
  commits.forEach((c, i) => {
    const want = patches[i] && patchId(dir, fs.readFileSync(path.join(patchesDir, patches[i].file), "utf8"));
    if (want && !extra.length && patchId(dir, git(dir, ["diff-tree", "-p", "--no-color", c])) === want) applied.push(patches[i].id);
    else extra.push(git(dir, ["log", "-1", "--format=%h %s", c]));
  });
  const missing = patches.slice(applied.length).map((p) => p.id);
  return { head, state: extra.length ? "mismatch" : missing.length ? "unpatched" : "pinned", applied, missing, extra };
}

/** Daemon refreshes must never wait synchronously for Git, including patch-id checks. */
export async function checkFirstmateVendorAsync(dir: string, opts: VendorOpts = {}, previous?: VendorCheck): Promise<VendorCheck> {
  const run = (args: string[], input?: string): Promise<string> => new Promise((resolve, reject) => {
    let inputError: Error | null = null;
    const child = execFile("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 2000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => err || inputError ? reject(err ?? inputError) : resolve(stdout.trim()));
    child.stdin?.on("error", (error) => { inputError = error; });
    child.stdin?.end(input);
  });
  const { pin = FIRSTMATE_PIN, patchesDir = firstmatePatchesDir() } = opts;
  let head: string;
  try { head = await run(["rev-parse", "HEAD"]); }
  catch { return { head: null, state: "missing", applied: [], missing: [], extra: [] }; }
  if (previous?.head === head) return previous;
  const { patches } = loadFirstmatePatches(opts);
  try { await run(["merge-base", "--is-ancestor", pin, head]); }
  catch { return { head, state: "mismatch", applied: [], missing: patches.map((p) => p.id), extra: [] }; }
  const commits = (await run(["rev-list", "--reverse", "--topo-order", `${pin}..${head}`])).split("\n").filter(Boolean);
  const applied: string[] = [], extra: string[] = [];
  for (const [i, commit] of commits.entries()) {
    const patch = patches[i];
    const want = patch ? (await run(["patch-id", "--stable"], await fs.promises.readFile(path.join(patchesDir, patch.file), "utf8"))).split(/\s+/)[0] : null;
    const actual = want ? (await run(["patch-id", "--stable"], await run(["diff-tree", "-p", "--no-color", commit]))).split(/\s+/)[0] : null;
    if (patch && want && !extra.length && want === actual) applied.push(patch.id);
    else extra.push(await run(["log", "-1", "--format=%h %s", commit]));
  }
  const missing = patches.slice(applied.length).map((p) => p.id);
  return { head, state: extra.length ? "mismatch" : missing.length ? "unpatched" : "pinned", applied, missing, extra };
}

/** Apply the patches that are not yet on top of the pin. Throws (after `git am --abort`) when one does not apply. */
export function applyFirstmatePatches(dir: string, opts: VendorOpts = {}): string[] {
  const c = checkFirstmateVendor(dir, opts);
  if (c.state !== "unpatched") return [];
  const { patches } = loadFirstmatePatches(opts);
  const patchesDir = opts.patchesDir ?? firstmatePatchesDir();
  for (const id of c.missing) {
    const p = patches.find((x) => x.id === id)!;
    try { git(dir, ["am", "--quiet", path.join(patchesDir, p.file)]); }
    catch (e: any) { tryGit(dir, ["am", "--abort"]); throw new Error(`Firstmate patch ${p.file} did not apply to ${c.head?.slice(0, 7)}: ${String(e.stderr || e.message).trim()}`); }
  }
  return c.missing;
}

/** One line for install and status output. */
export function describeFirstmateVendor(c: VendorCheck, pin = FIRSTMATE_PIN): string {
  const at = `vendor/firstmate at pin ${pin.slice(0, 7)}`;
  if (c.state === "pinned") return c.applied.length ? `${at} with Joyride's patches (${c.applied.join(", ")})` : at;
  if (c.state === "missing") return `WARNING vendor/firstmate is missing; run ./bin/joyride vendor firstmate (see vendor/PINS.md)`;
  if (c.state === "unpatched") return `WARNING ${at} without Joyride's patches ${c.missing.join(", ")}; run ./bin/joyride vendor firstmate to apply them`;
  return `WARNING vendor/firstmate is at ${c.head!.slice(0, 7)}, which is not pin ${pin.slice(0, 7)} plus the patches in install/firstmate-patches${c.extra.length ? ` (unlisted commits: ${c.extra.join("; ")})` : ""} (see vendor/PINS.md)`;
}
