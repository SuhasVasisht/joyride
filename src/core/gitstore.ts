// Authored data lives in git: every write to missions/, lenses/, notes/,
// artifacts/, workspace.yaml is committed so history, diff and revert are free.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { paths } from "../shared/paths.ts";
import { git } from "./util.ts";

const ENV_ID = ["-c", "user.name=Joyride", "-c", "user.email=joyride@localhost"];

function ensureRepo() {
  if (!fs.existsSync(path.join(paths.root, ".git"))) git(paths.root, ["init", "-q", "-b", "main"]);
}

/** Stage and commit only the given paths (relative to the data root or absolute). Returns the commit sha or null if nothing changed. */
export function commitPaths(files: string[], message: string): string | null {
  ensureRepo();
  const rel = files.map((f) => (path.isAbsolute(f) ? path.relative(paths.root, f) : f));
  const existing = rel.filter((f) => fs.existsSync(path.join(paths.root, f)));
  if (existing.length) git(paths.root, ["add", "--", ...existing]);
  const removed = rel.filter((f) => !fs.existsSync(path.join(paths.root, f)));
  if (removed.length) git(paths.root, ["rm", "-q", "--cached", "--ignore-unmatch", "--", ...removed], { allowFail: true });
  const status = git(paths.root, ["status", "--porcelain", "--", ...rel], { allowFail: true });
  if (!status) return null;
  git(paths.root, [...ENV_ID, "commit", "-q", "--no-verify", "-m", `joyride: ${message}`, "--", ...rel]);
  return git(paths.root, ["rev-parse", "HEAD"]);
}

export function revertCommit(sha: string, message?: string): string {
  git(paths.root, [...ENV_ID, "revert", "--no-edit", sha]);
  if (message) git(paths.root, [...ENV_ID, "commit", "--amend", "-q", "-m", `joyride: ${message}`]);
  return git(paths.root, ["rev-parse", "HEAD"]);
}

/** A file's exact content at a commit (path relative to the data root), or null when it did not exist there. */
export function fileAt(sha: string, rel: string): string | null {
  try { return execFileSync("git", ["show", `${sha}:${rel}`], { cwd: paths.root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }); }
  catch { return null; }
}

/** The paths a commit touched, relative to the data root. */
export function commitFiles(sha: string): string[] {
  const out = git(paths.root, ["show", "--name-only", "--format=", "--no-renames", sha], { allowFail: true });
  return out ? out.split("\n").filter(Boolean) : [];
}

export function fileHistory(file: string, limit = 20) {
  const rel = path.isAbsolute(file) ? path.relative(paths.root, file) : file;
  const out = git(paths.root, ["log", `-n${limit}`, "--format=%H%x09%aI%x09%s", "--", rel], { allowFail: true });
  return out ? out.split("\n").map((l) => { const [sha, date, subject] = l.split("\t"); return { sha, date, subject }; }) : [];
}
export function diffFor(sha: string, file?: string) {
  return git(paths.root, ["show", "--format=", sha, ...(file ? ["--", file] : [])], { allowFail: true });
}
