import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const now = () => new Date().toISOString();
export const sha256 = (s: string | Buffer) => crypto.createHash("sha256").update(s).digest("hex");
export function rid(prefix = "") {
  return prefix + crypto.randomBytes(6).toString("base64url").replace(/[-_]/g, "x").toLowerCase();
}
export function slugify(s: string, max = 48) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "") || "untitled";
}
export function ensureDir(p: string) { fs.mkdirSync(p, { recursive: true }); return p; }
export function readJson<T = any>(p: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}
export function writeJsonAtomic(p: string, v: unknown) {
  ensureDir(path.dirname(p));
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
  fs.renameSync(tmp, p);
}
export function writeFileAtomic(p: string, content: string) {
  ensureDir(path.dirname(p));
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, p);
}
export function truncate(s: string | undefined | null, n: number) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

const repoCache = new Map<string, string | null>();
/** git toplevel for a directory (cached; walks up looking for .git). */
export function repoRootOf(dir: string): string | null {
  if (!dir) return null;
  if (repoCache.has(dir)) return repoCache.get(dir)!;
  let cur = dir;
  let found: string | null = null;
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(cur, ".git"))) { found = cur; break; }
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  repoCache.set(dir, found);
  return found;
}
export function repoName(repo: string | null) { return repo ? path.basename(repo) : "(no repo)"; }

export function git(cwd: string, args: string[], opts: { allowFail?: boolean } = {}): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).trim();
  } catch (e: any) {
    if (opts.allowFail) return "";
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${e.stderr || e.message}`);
  }
}
export function pidAlive(pid: number) {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e.code === "EPERM"; }
}
export function msToIso(ms: number | null | undefined) { return ms ? new Date(ms).toISOString() : now(); }
