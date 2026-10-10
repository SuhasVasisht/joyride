// Binding the joyride-fleet-feed extension into a Firstmate home, the documented way
// (vendor/firstmate/docs/configuration.md, "Trusted external process-event adapters"): no Firstmate code
// changes, only Firstmate's own commands with FM_HOME set.
//   1. Copy install/firstmate-extension/joyride-fleet-feed to a folder outside every Git project
//      (~/.local/share/joyride/firstmate-packages/<name>-<version>-<digest>, or JOYRIDE_FM_PACKAGES_DIR),
//      because Firstmate refuses to bind a package that lives inside one.
//   2. bin/fm-extension.sh bind <copy> --adapter joyride-fleet-feed --trust-same-user-code --consent network
//   3. bin/fm-procevent.sh register-extension joyride-fleet-feed joyride-fleet --config-ref <daemon URL>
// Firstmate's watcher then runs the source (fm-procevent.sh reconcile) and each fleet event reaches
// it as a process-event result with a `check` wake. What was bound is recorded in
// .joyride/install/firstmate-feed.json, so uninstall retires exactly that registration and binding.
//
// macOS: Firstmate's host copies a package into its store, makes the copy read-only (0555) and then
// renames it into place, and macOS refuses to rename a directory its owner can't write (EACCES), so
// `bind` fails there for every package, Firstmate's own example included. When bind fails that way,
// Joyride seats the store copy itself, exactly as the host lays it out (the path named by the host's
// own tree digest from `fm-extension.sh pack-transfer`, read-only modes, no rename), and runs the same
// bind again: the host finds the copy, validates every byte and mode, and uses it. Firstmate's code is
// not changed; the fix belongs upstream (rename before making the copy read-only).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { paths } from "../shared/paths.ts";

export const FEED_EXTENSION_ID = "dev.joyride.fleet-feed";
export const FEED_ADAPTER = "joyride-fleet-feed";
export const FEED_SOURCE_ID = "joyride-fleet";
export const feedPackageSource = () => path.join(paths.code, "install", "firstmate-extension", "joyride-fleet-feed");
const underTest = () => Boolean(process.env.VITEST || process.env.JOYRIDE_TEST);
export function feedPackagesDir(): string {
  if (process.env.JOYRIDE_FM_PACKAGES_DIR) return process.env.JOYRIDE_FM_PACKAGES_DIR;
  if (underTest()) throw new Error("Tests must set JOYRIDE_FM_PACKAGES_DIR (tests/sandbox.ts does), so no package copy lands in the real ~/.local/share.");
  return path.join(os.homedir(), ".local", "share", "joyride", "firstmate-packages");
}
const manifestFile = () => path.join(paths.runtime, "install", "firstmate-feed.json");

export type FeedOpts = { home: string; firstmateDir: string; daemonUrl: string; packagesDir?: string; env?: NodeJS.ProcessEnv };
export type FeedRecord = { home: string; package: string; binding_digest: string | null; owner_token: string | null; source_id: string; config_ref: string; at: string };

function packageFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? packageFiles(path.join(dir, e.name)).map((f) => path.join(e.name, f)) : e.isFile() ? [e.name] : [])).sort();
}
export function packageDigest(dir: string): string {
  const h = crypto.createHash("sha256");
  for (const f of packageFiles(dir)) { const st = fs.statSync(path.join(dir, f)); h.update(`${f}\0${st.mode & 0o111 ? "x" : "-"}\0`); h.update(fs.readFileSync(path.join(dir, f))); }
  return h.digest("hex");
}

/** The package copy outside every Git project, named by version and content, created when absent. */
export function stagePackage(src: string, packagesDir: string): string {
  const manifest = JSON.parse(fs.readFileSync(path.join(src, "firstmate-extension.json"), "utf8"));
  fs.mkdirSync(packagesDir, { recursive: true, mode: 0o755 });
  const parent = fs.realpathSync(packagesDir);
  const digest = packageDigest(src);
  const dest = path.join(parent, `${FEED_ADAPTER}-${manifest.version}-${digest.slice(0, 12)}`);
  if (fs.existsSync(dest)) {
    if (packageDigest(dest) !== digest) throw new Error(`${dest} exists with different contents. Remove it, then install again.`);
    return dest;
  }
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { mode: 0o755 });
  for (const f of packageFiles(src)) {
    const to = path.join(tmp, f);
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o755 });
    fs.copyFileSync(path.join(src, f), to);
    fs.chmodSync(to, fs.statSync(path.join(src, f)).mode & 0o111 ? 0o755 : 0o644);
  }
  fs.renameSync(tmp, dest);
  return dest;
}

function run(opts: FeedOpts, script: string, args: string[]): string {
  const bin = path.join(opts.firstmateDir, "bin", script);
  // Firstmate's default claim root (~/.local/state/firstmate) is shared machine-wide.
  if (underTest() && !(opts.env?.FM_PROCEVENT_CLAIM_ROOT ?? process.env.FM_PROCEVENT_CLAIM_ROOT)) throw new Error("Tests must set FM_PROCEVENT_CLAIM_ROOT (tests/sandbox.ts does) before running Firstmate's process-event commands.");
  if (!fs.existsSync(bin)) throw new Error(`${bin} is missing: Firstmate is not vendored there. Run ./bin/joyride vendor firstmate first.`);
  try {
    return execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, env: { ...process.env, ...(opts.env ?? {}), FM_HOME: opts.home, JOYRIDE_GUARD: "off" } });
  } catch (e: any) {
    throw new Error(`${script} ${args[0]} failed (exit ${e.status ?? "?"}): ${String(e.stderr || e.stdout || e.message).trim().split("\n").slice(-3).join(" ")}`);
  }
}

const field = (out: string, name: string) => out.match(new RegExp(`^${name}: (\\S+)`, "m"))?.[1] ?? null;
const RENAME_REFUSED = /EACCES[^\n]*rename '[^']*\/\.install-/;

/** Seat the package in the home's store the way Firstmate's host would, minus the rename macOS refuses. */
export function seatPackage(opts: FeedOpts, pkg: string): string {
  const transfer = JSON.parse(run(opts, "fm-extension.mjs", ["pack-transfer", pkg]));
  const digest = String(transfer?.manifest?.package_digest ?? "");
  const id = String(transfer?.manifest?.extension_id ?? ""), version = String(transfer?.manifest?.extension_version ?? "");
  if (!/^sha256:[0-9a-f]{64}$/.test(digest) || id !== FEED_EXTENSION_ID || !version) throw new Error(`fm-extension.sh pack-transfer gave no usable package digest for ${pkg}`);
  let dir = opts.home;
  for (const seg of ["data", "extensions", "packages", id, version]) {
    dir = path.join(dir, seg);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 });
  }
  const dest = path.join(dir, digest.slice("sha256:".length));
  if (fs.existsSync(dest)) return dest;
  fs.mkdirSync(dest, { mode: 0o700 });
  for (const f of packageFiles(pkg)) {
    const to = path.join(dest, f);
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(pkg, f), to, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(to, fs.statSync(path.join(pkg, f)).mode & 0o111 ? 0o555 : 0o444);
  }
  const dirs = packageFiles(pkg).map((f) => path.dirname(f)).filter((x) => x !== ".").sort((a, b) => b.split("/").length - a.split("/").length);
  for (const sub of new Set(dirs)) fs.chmodSync(path.join(dest, sub), 0o555);
  fs.chmodSync(dest, 0o555);
  return dest;
}
const bindingFile = (home: string) => path.join(home, "config", "extensions.d", `${FEED_EXTENSION_ID}.json`);
const sourceFile = (home: string) => path.join(home, "state", "procevent", `${FEED_SOURCE_ID}.source`);

/** The binding's digest, as Firstmate computes it: sha256 over the binding file's bytes. */
export const bindingDigestOf = (home: string) => `sha256:${crypto.createHash("sha256").update(fs.readFileSync(bindingFile(home))).digest("hex")}`;
/** One feed consumer per Firstmate home in the daemon, so two homes never take each other's events. */
export const consumerFor = (home: string) => `home-${crypto.createHash("sha256").update(path.resolve(home)).digest("hex").slice(0, 12)}`;

function saveRecord(r: FeedRecord) {
  fs.mkdirSync(path.dirname(manifestFile()), { recursive: true });
  fs.writeFileSync(manifestFile(), JSON.stringify(r, null, 2) + "\n");
}

/**
 * Bind and register the feed in one Firstmate home. Idempotent: an existing binding of the same copy
 * and an existing source are kept. What was done is recorded after each step, so a failure halfway
 * leaves a record that a second install or an uninstall can finish from.
 */
export function installFleetFeed(opts: FeedOpts): { lines: string[]; record: FeedRecord } {
  const lines: string[] = [];
  if (!fs.existsSync(opts.home)) throw new Error(`Firstmate home ${opts.home} does not exist. Run ./bin/joyride install firstmate to seed it first.`);
  const pkg = stagePackage(feedPackageSource(), opts.packagesDir ?? feedPackagesDir());
  lines.push(`package copy ${pkg} (outside every Git project, as Firstmate requires)`);
  const prev = readFeedRecord();
  const configRef = `${opts.daemonUrl.replace(/\/+$/, "")}/?consumer=${consumerFor(opts.home)}`;
  const record: FeedRecord = { home: opts.home, package: pkg, binding_digest: null, owner_token: prev?.home === opts.home ? prev.owner_token : null, source_id: FEED_SOURCE_ID, config_ref: configRef, at: new Date().toISOString() };
  if (fs.existsSync(bindingFile(opts.home))) {
    const b = JSON.parse(fs.readFileSync(bindingFile(opts.home), "utf8"));
    const from = typeof b.source === "string" ? b.source : b.source?.path;
    if (from !== pkg) throw new Error(`${opts.home} already binds ${FEED_EXTENSION_ID} from ${from ?? "another package"}. Run ./bin/joyride uninstall firstmate-feed to retire it, then install again.`);
    lines.push(`kept binding ${bindingFile(opts.home)}`);
  } else {
    const bind = () => run(opts, "fm-extension.sh", ["bind", pkg, "--adapter", FEED_ADAPTER, "--trust-same-user-code", "--consent", "network", "--timeout-ms", "120000"]);
    let out: string;
    try { out = bind(); }
    catch (e: any) {
      if (!RENAME_REFUSED.test(e.message)) throw e;
      lines.push(`seated the store copy ${seatPackage(opts, pkg)} (Firstmate's bind can't rename a read-only folder on macOS)`);
      out = bind();
    }
    lines.push(`bound ${FEED_EXTENSION_ID} into ${bindingFile(opts.home)}: handshake ${out.match(/^verified: (.*)$/m)?.[1] ?? "passed"}`);
  }
  record.binding_digest = bindingDigestOf(opts.home);
  saveRecord(record);
  if (fs.existsSync(sourceFile(opts.home))) lines.push(`kept source ${FEED_SOURCE_ID} (${sourceFile(opts.home)})`);
  else {
    const out = run(opts, "fm-procevent.sh", ["register-extension", FEED_ADAPTER, FEED_SOURCE_ID, "--config-ref", configRef]);
    record.owner_token = field(out, "owner-token");
    saveRecord(record);
    lines.push(`registered source ${FEED_SOURCE_ID} polling ${opts.daemonUrl}/api/fleet/feed as consumer ${consumerFor(opts.home)}; Firstmate's watcher runs it`);
  }
  return { lines, record };
}

export function readFeedRecord(): FeedRecord | null {
  try { return JSON.parse(fs.readFileSync(manifestFile(), "utf8")); } catch { return null; }
}

/** Captured feed results Firstmate has not handled yet: Firstmate refuses to retire a binding they depend on. */
export function unhandledResults(home: string): string[] {
  const dir = path.join(home, "state", "procevent-inbox");
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((n) => n.startsWith(`${FEED_SOURCE_ID}.`) && n.endsWith(".result") && !names.includes(n.replace(/\.result$/, ".handled"))).sort();
}

/**
 * Retire the registration, then the binding, recorded at install. Refused before anything changes
 * while a captured result is unhandled. The package copies stay (Firstmate keeps retired identities restorable).
 */
export function uninstallFleetFeed(opts: Omit<FeedOpts, "daemonUrl" | "home"> & { home?: string }): string[] {
  const rec = readFeedRecord();
  if (!rec) return ["no joyride-fleet-feed install recorded; nothing to retire"];
  const o = { ...opts, home: opts.home ?? rec.home, daemonUrl: rec.config_ref };
  const pending = unhandledResults(o.home);
  if (pending.length) throw new Error(`Firstmate has not handled ${pending.length} fleet feed result${pending.length === 1 ? "" : "s"} yet (${pending.join(", ")}), and it won't retire a binding they depend on. Let Firstmate handle them (fm-procevent.sh handled ${FEED_SOURCE_ID} <seq>), then uninstall again. Nothing was retired.`);
  const lines: string[] = [];
  if (fs.existsSync(sourceFile(o.home))) {
    if (!rec.owner_token) throw new Error(`Source ${FEED_SOURCE_ID} has no recorded owner token, so Joyride can't retire exactly its registration. Retire it with Firstmate: FM_HOME=${o.home} bin/fm-procevent.sh list, then retire ${FEED_SOURCE_ID} --if-owner <token>.`);
    run(o, "fm-procevent.sh", ["retire", FEED_SOURCE_ID, "--if-owner", rec.owner_token]);
    lines.push(`retired source ${FEED_SOURCE_ID}`);
  }
  if (fs.existsSync(bindingFile(o.home))) {
    run(o, "fm-extension.sh", ["retire-binding", FEED_EXTENSION_ID, "--if-binding-digest", rec.binding_digest ?? bindingDigestOf(o.home)]);
    lines.push(`retired binding ${FEED_EXTENSION_ID} (Firstmate keeps it under data/extensions/retired-bindings)`);
  }
  fs.rmSync(manifestFile(), { force: true });
  lines.push(`kept package copy ${rec.package}`);
  return lines;
}

export function fleetFeedStatus(home: string): string {
  const bound = fs.existsSync(bindingFile(home)), source = fs.existsSync(sourceFile(home));
  return bound && source ? "feed bound and registered" : bound ? "feed bound, source not registered" : "feed not bound";
}
