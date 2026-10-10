// Resolve repository and worktree identity with filesystem reads.
import fs from "node:fs";
import path from "node:path";

/** git toplevel for a dir: the nearest folder up holding a `.git` entry. */
export function findRepo(dir: string | null | undefined): string | null {
  if (!dir) return null;
  let cur = path.resolve(dir);
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(cur, ".git"))) return cur;
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
  return null;
}

/**
 * The main checkout behind a linked worktree (`git worktree add`, treehouse, Orca): the folder
 * holding the shared `.git` dir. The repo itself when it is the main checkout; null when that
 * cannot be told (bare repo, submodule, unreadable `.git`).
 */
export function mainCheckout(repo: string): string | null {
  try {
    const dotGit = path.join(repo, ".git");
    if (fs.statSync(dotGit).isDirectory()) return repo;
    const m = fs.readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)$/m);
    if (!m) return null;
    const gitDir = path.resolve(repo, m[1].trim());
    const common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim());
    return path.basename(common) === ".git" ? path.dirname(common) : null;
  } catch { return null; }
}
