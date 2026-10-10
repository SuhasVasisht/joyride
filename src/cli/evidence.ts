#!/usr/bin/env bun
// joyride-evidence: record attested verification evidence (DESIGN §8).
//   joyride-evidence run --name <n> [--mission <id>] [--claim "..."] [--screenshots <glob|dir>]... [--session <key>] -- <cmd...>
//   joyride-evidence add --name <n> --claim "..." [--exit-code N] [--log file] [--screenshot file...] [--results pw.json] [--command "..."]
// Runs the command (streaming its output), blobs the full log and any new
// screenshots, links the record to the calling Claude Code / Codex session,
// and appends an `evidence.added` event to the Joyride event log. Works with
// the daemon down. Exits with the wrapped command's exit code.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import picomatch from "picomatch";
import { z } from "zod";
import { paths } from "../shared/paths.ts";
import { adoptBlob, IMAGE_EXT, putBlobBuffer, putBlobFile } from "../modules/evidence/blobs.ts";
import { parsePlaywrightJson, parseTestSummary, stripAnsi, tailOf, type Assertions } from "../modules/evidence/parse.ts";

const SHOT_DIRS = ["test-results", "playwright-report", "screenshots", "docs/checkpoints"];
const PW_JSON = ["test-results/e2e.json", "test-results/results.json", "playwright-report/results.json", "results.json"];
const MAX_SHOTS = 40;

type Args = { cmd: string; flags: Record<string, string[]>; rest: string[] };

function parseArgs(argv: string[]): Args {
  const [cmd = "help", ...tail] = argv;
  const flags: Record<string, string[]> = {};
  const dd = tail.indexOf("--");
  const own = dd >= 0 ? tail.slice(0, dd) : tail;
  const rest = dd >= 0 ? tail.slice(dd + 1) : [];
  let cur: string | null = null;
  for (const a of own) {
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) { (flags[a.slice(2, eq)] ??= []).push(a.slice(eq + 1)); cur = null; }
      else { cur = a.slice(2); flags[cur] ??= []; }
    } else if (cur) {
      flags[cur].push(a);
      // single-value flags take one value; list flags keep consuming
      if (!["screenshot", "screenshots"].includes(cur)) cur = null;
    }
  }
  return { cmd, flags, rest };
}
const one = (a: Args, k: string) => a.flags[k]?.[a.flags[k].length - 1];
const many = (a: Args, ...ks: string[]) => ks.flatMap((k) => a.flags[k] ?? []);

function die(msg: string, code = 2): never { process.stderr.write(`joyride-evidence: ${msg}\n`); process.exit(code); }

const USAGE = `Usage:
  joyride-evidence run --name <name> [--mission <id>] [--claim "..."] [--screenshots <glob|dir>]... [--session <key>] -- <command...>
  joyride-evidence add --name <name> --claim "..." [--exit-code N] [--log <file>] [--screenshot <file>...] [--results <playwright.json>] [--command "..."] [--mission <id>] [--session <key>]

run   runs the command, streams its output, and records exit code, log, test counts and new screenshots.
add   records evidence produced elsewhere.
Records go to the Joyride event log (${paths.events}); the daemon does not need to be running.`;

// ---------- session linking ----------
const CodexSessionId = z.uuid();

function codexSessionFromEnv(): string | null {
  for (const identity of [process.env.CODEX_THREAD_ID, process.env.CODEX_SESSION_ID]) {
    const parsed = CodexSessionId.safeParse(identity);
    if (parsed.success) return `codex:${parsed.data}`;
  }
  return null;
}

function claudeSessionFromParents(): string | null {
  let pid = process.ppid;
  for (let i = 0; i < 40 && pid > 1; i++) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(paths.claudeDir, "sessions", `${pid}.json`), "utf8"));
      if (j?.sessionId) return `claude:${j.sessionId}`;
    } catch { /* not a Claude Code process */ }
    try { pid = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()); }
    catch { break; }
    if (!Number.isFinite(pid)) break;
  }
  return null;
}

function readTail(file: string, bytes: number): string {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, "r");
  try {
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } finally { fs.closeSync(fd); }
}

const real = (p: string) => { try { return fs.realpathSync(p); } catch { return p; } };
/** True when `dir` is `root` or inside it, comparing real paths (/tmp vs /private/tmp). */
function sameOrInside(dir: string, root: string) {
  if (!root) return false;
  const a = real(dir), b = real(root);
  return a === b || a.startsWith(b.endsWith("/") ? b : b + "/");
}

/** The logical working directory: $PWD when it is the same place as process.cwd(), so records match hook cwds. */
function workingDir() {
  const pwd = process.env.PWD;
  return pwd && real(pwd) === real(process.cwd()) ? pwd : process.cwd();
}

/** Codex (and fallback): the most recent hook event's session for this cwd, preferring Codex. */
function sessionFromHookEvents(cwd: string): string | null {
  let files: string[] = [];
  try { files = fs.readdirSync(paths.events).filter((f) => f.endsWith(".jsonl")).sort().reverse().slice(0, 2); } catch { return null; }
  const cutoff = Date.now() - 12 * 3600e3;
  let anyHook: string | null = null;
  for (const f of files) {
    let lines: string[];
    try { lines = readTail(path.join(paths.events, f), 4 * 1024 * 1024).split("\n"); } catch { continue; }
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"hook.')) continue;
      let e: any;
      try { e = JSON.parse(lines[i]); } catch { continue; }
      if (!e?.session || !String(e.source).startsWith("hook.") || Date.parse(e.ts) < cutoff) continue;
      if (!sameOrInside(cwd, String(e.cwd ?? ""))) continue;
      const agent = e.agent ?? String(e.source).slice(5);
      if (agent === "codex") return `codex:${e.session}`;
      anyHook ??= `${agent}:${e.session}`;
    }
  }
  return anyHook;
}

function resolveSession(a: Args, cwd: string): string | null {
  const explicit = one(a, "session");
  if (explicit) return /^(claude|codex|other):/.test(explicit) ? explicit : `claude:${explicit}`;
  return codexSessionFromEnv() ?? claudeSessionFromParents() ?? sessionFromHookEvents(cwd);
}

// ---------- files ----------
function walk(dir: string, out: string[], depth = 0) {
  if (depth > 8 || out.length > 20000) return;
  let ents: fs.Dirent[];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1);
    else if (e.isFile()) out.push(p);
  }
}

/** Expand a file, directory or glob (relative to cwd) to files. */
function expand(spec: string, cwd: string): string[] {
  const abs = path.resolve(cwd, spec);
  if (!/[*?[\]{}]/.test(spec)) {
    try {
      const st = fs.statSync(abs);
      if (st.isDirectory()) { const out: string[] = []; walk(abs, out); return out; }
      return [abs];
    } catch { return []; }
  }
  const parts = abs.split(path.sep);
  const firstGlob = parts.findIndex((p) => /[*?[\]{}]/.test(p));
  const base = parts.slice(0, firstGlob).join(path.sep) || path.sep;
  const isMatch = picomatch(abs, { dot: false });
  const all: string[] = [];
  walk(base, all);
  return all.filter((f) => isMatch(f));
}

const mtime = (f: string) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };

function gitInfo(cwd: string): { repo: string | null; branch: string | null; sha: string | null } {
  const g = (args: string[]) => { try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; } catch { return null; } };
  return { repo: g(["rev-parse", "--show-toplevel"]), branch: g(["rev-parse", "--abbrev-ref", "HEAD"]), sha: g(["rev-parse", "HEAD"]) };
}

type Snapshot = Map<string, string>;
const stamp = (f: string) => { try { const st = fs.statSync(f); return `${st.mtimeMs}:${st.size}`; } catch { return ""; } };
/** Image files the run may produce: the given globs/dirs, else the usual screenshot dirs. */
function shotCandidates(roots: string[], specs: string[], cwd: string): string[] {
  const files = new Set<string>();
  if (specs.length) for (const s of specs) for (const f of expand(s, cwd)) files.add(f);
  else for (const r of roots) for (const d of SHOT_DIRS) { const out: string[] = []; walk(path.join(r, d), out); out.forEach((f) => files.add(f)); }
  return [...files].filter((f) => IMAGE_EXT.test(f));
}
function pwCandidates(roots: string[]): string[] {
  const cands = new Set<string>();
  for (const env of ["PLAYWRIGHT_JSON_OUTPUT_FILE", "PLAYWRIGHT_JSON_OUTPUT_NAME"]) if (process.env[env]) cands.add(path.resolve(process.env[env]!));
  for (const r of roots) {
    for (const p of PW_JSON) cands.add(path.join(r, p));
    try { for (const f of fs.readdirSync(path.join(r, "test-results"))) if (f.endsWith(".json")) cands.add(path.join(r, "test-results", f)); } catch { /* none */ }
  }
  return [...cands];
}
const snapshot = (files: string[]): Snapshot => new Map(files.map((f) => [f, stamp(f)]));
/** Files created or modified since the snapshot (by mtime and size, independent of the clock). */
const changedSince = (files: string[], before: Snapshot) => files.filter((f) => { const s = stamp(f); return s !== "" && before.get(f) !== s; });

function playwrightResults(files: string[]): Assertions | null {
  for (const f of files) {
    try { const a = parsePlaywrightJson(JSON.parse(fs.readFileSync(f, "utf8"))); if (a) return a; } catch { /* not a report */ }
  }
  return null;
}

function blobShots(files: string[], base: string) {
  return files.map((f) => ({ blob: putBlobFile(f), name: path.relative(base, f) || path.basename(f), caption: null }));
}

// ---------- event ----------
function appendEvidenceEvent(item: any) {
  const ts = new Date().toISOString();
  const [agent, raw] = item.session ? [item.session.split(":")[0], item.session.slice(item.session.indexOf(":") + 1)] : [undefined, undefined];
  const rec = { ts, id: "ev_" + crypto.randomBytes(6).toString("hex"), source: "evidence", type: "evidence.added", session: raw, agent, cwd: item.cwd, data: { item } };
  fs.mkdirSync(paths.events, { recursive: true });
  fs.appendFileSync(path.join(paths.events, `${ts.slice(0, 10)}.jsonl`), JSON.stringify(rec) + "\n");
}

function summaryLine(item: any) {
  const bits = [item.exit_code == null ? "exit unknown" : `exit ${item.exit_code}`];
  if (item.assertions) bits.push(`${item.assertions.passed} passed, ${item.assertions.failed} failed${item.assertions.skipped ? `, ${item.assertions.skipped} skipped` : ""}`);
  bits.push(`${item.screenshots.length} screenshot${item.screenshots.length === 1 ? "" : "s"}`);
  bits.push(item.session ? `session ${item.session}` : "no session linked");
  if (item.mission) bits.push(`mission ${item.mission}`);
  return `joyride-evidence: recorded "${item.name}" (${bits.join(", ")}) as ${item.id}\n`;
}

function baseItem(a: Args, cwd: string) {
  const name = one(a, "name");
  if (!name) die(`--name is required.\n${USAGE}`);
  const git = gitInfo(cwd);
  return {
    item: {
      id: "evd_" + crypto.randomBytes(6).toString("hex"), mode: "attested" as const, name, command: "", exit_code: null as number | null,
      log_tail: "", log_blob: null as string | null, screenshots: [] as { blob: string; name: string; caption: null }[], assertions: null as Assertions | null,
      claim: one(a, "claim") ?? "", session: resolveSession(a, cwd), mission: one(a, "mission") ?? null, cwd,
      branch: git.branch, sha: git.sha, created: new Date().toISOString(),
    },
    roots: [...new Set([cwd, git.repo].filter((x): x is string => Boolean(x)))],
  };
}

// ---------- commands ----------
async function run(a: Args) {
  if (!a.rest.length) die(`nothing to run; put the command after --.\n${USAGE}`);
  const cwd = workingDir();
  const { item, roots } = baseItem(a, cwd);
  const specs = many(a, "screenshots", "screenshot");
  const shotsBefore = snapshot(shotCandidates(roots, specs, cwd));
  const pwBefore = snapshot(pwCandidates(roots));
  const [file, args] = a.rest.length === 1 ? ["/bin/sh", ["-c", a.rest[0]]] : [a.rest[0], a.rest.slice(1)];
  item.command = a.rest.length === 1 ? a.rest[0] : a.rest.map((x) => (/^[\w@%+=:,./-]+$/.test(x) ? x : `'${x.replace(/'/g, "'\\''")}'`)).join(" ");

  // Recording problems must never stop the command from running or change its exit code.
  let logTmp = "";
  let fd: number | null = null;
  try {
    const tmpDir = path.join(paths.runtime, "tmp");
    fs.mkdirSync(tmpDir, { recursive: true });
    logTmp = path.join(tmpDir, `evlog-${process.pid}-${crypto.randomBytes(4).toString("hex")}.log`);
    fd = fs.openSync(logTmp, "w");
  } catch (e: any) { process.stderr.write(`joyride-evidence: could not open a log file (${e.message}); only the output tail will be kept.\n`); }
  const hash = crypto.createHash("sha256");
  let size = 0;
  let tail = Buffer.alloc(0);
  const capture = (chunk: Buffer) => {
    if (fd != null) { try { fs.writeSync(fd, chunk); } catch { fd = null; } }
    hash.update(chunk); size += chunk.length;
    tail = Buffer.concat([tail, chunk]);
    if (tail.length > 65536) tail = tail.subarray(tail.length - 65536);
  };

  const code: number = await new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn(file, args, { cwd, stdio: ["inherit", "pipe", "pipe"], env: process.env }); }
    catch (e: any) { capture(Buffer.from(`joyride-evidence: could not start ${file}: ${e.message}\n`)); return resolve(127); }
    // Ctrl-C reaches the child through the terminal's process group; stay alive to record the result.
    process.on("SIGINT", () => {});
    process.on("SIGTERM", () => { try { child.kill("SIGTERM"); } catch { /* gone */ } });
    child.stdout!.on("data", (d: Buffer) => { process.stdout.write(d); capture(d); });
    child.stderr!.on("data", (d: Buffer) => { process.stderr.write(d); capture(d); });
    child.on("error", (e) => { const m = Buffer.from(`joyride-evidence: could not start ${file}: ${e.message}\n`); process.stderr.write(m); capture(m); resolve(127); });
    child.on("close", (c, sig) => resolve(c ?? (sig ? 128 + (os.constants.signals[sig] ?? 1) : 1)));
  });
  const logComplete = fd != null;
  if (fd != null) { try { fs.closeSync(fd); } catch { /* ignore */ } }

  try {
    item.exit_code = code;
    const sha = hash.digest("hex");
    if (logComplete && size > 0) item.log_blob = adoptBlob(logTmp, sha); else if (logTmp) fs.rmSync(logTmp, { force: true });
    const tailText = tail.toString("utf8");
    item.log_tail = tailOf(tailText, 4096);
    item.assertions = playwrightResults(changedSince(pwCandidates(roots), pwBefore)) ?? parseTestSummary(stripAnsi(tailText));
    const shots = changedSince(shotCandidates(roots, specs, cwd), shotsBefore).sort((x, y) => mtime(y) - mtime(x)).slice(0, MAX_SHOTS);
    item.screenshots = blobShots(shots, cwd);
    appendEvidenceEvent(item);
    process.stderr.write(summaryLine(item));
  } catch (e: any) {
    process.stderr.write(`joyride-evidence: the command ran (exit ${code}), but its evidence could not be recorded: ${e.message}. Check that ${paths.runtime} is writable.\n`);
  }
  process.exit(code);
}

function add(a: Args) {
  const cwd = workingDir();
  const { item, roots } = baseItem(a, cwd);
  if (!item.claim && !one(a, "log") && !one(a, "exit-code") && !many(a, "screenshot", "screenshots").length) die("add needs at least a --claim, --log, --exit-code or --screenshot.");
  item.command = one(a, "command") ?? "";
  const ec = one(a, "exit-code");
  if (ec != null) { if (!/^-?\d+$/.test(ec)) die(`--exit-code must be a number, got "${ec}".`); item.exit_code = Number(ec); }
  const log = one(a, "log");
  if (log) {
    const p = path.resolve(cwd, log);
    if (!fs.existsSync(p)) die(`log file not found: ${p}`);
    const buf = fs.readFileSync(p);
    item.log_blob = putBlobBuffer(buf);
    const text = buf.toString("utf8");
    item.log_tail = tailOf(text, 4096);
    item.assertions = parseTestSummary(text.length > 65536 ? text.slice(-65536) : text);
  }
  const results = one(a, "results");
  if (results) {
    if (!fs.existsSync(path.resolve(cwd, results))) die(`Playwright results not found: ${path.resolve(cwd, results)}`);
    try { item.assertions = playwrightResults([path.resolve(cwd, results)]) ?? item.assertions; }
    catch (e: any) { die(`could not read Playwright results ${results}: ${e.message}`); }
  } else if (!item.assertions) item.assertions = null;
  const shots: string[] = [];
  for (const s of many(a, "screenshot", "screenshots")) {
    const files = expand(s, cwd).filter((f) => IMAGE_EXT.test(f));
    if (!files.length) die(`no image found at ${s}`);
    shots.push(...files);
  }
  item.screenshots = blobShots(shots.slice(0, MAX_SHOTS), cwd);
  void roots;
  appendEvidenceEvent(item);
  process.stderr.write(summaryLine(item));
  process.exit(0);
}

const a = parseArgs(process.argv.slice(2));
if (a.cmd === "run") await run(a);
else if (a.cmd === "add") add(a);
else { process.stdout.write(USAGE + "\n"); process.exit(a.cmd === "help" || a.cmd === "--help" || a.cmd === "-h" ? 0 : 2); }
