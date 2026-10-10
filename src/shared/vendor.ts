import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const mainCheckouts = new Map<string, string | null>();

function mainCheckout(codeRoot: string): string | null {
  if (mainCheckouts.has(codeRoot)) return mainCheckouts.get(codeRoot) ?? null;
  let root: string | null = null;
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: codeRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000,
    }).trim();
    if (path.basename(common) === ".git") root = path.dirname(common);
  } catch { /* A source archive has no main checkout to borrow from. */ }
  mainCheckouts.set(codeRoot, root);
  return root;
}

/** Locate read-only vendor inputs, including those shared by linked worktrees.
 * An explicit override is authoritative, even when missing. */
export function vendorCheckout(o: { name: string; codeRoot: string; dataRoot?: string; override?: string }): string {
  if (o.override) return path.resolve(o.override);
  const local = path.join(o.codeRoot, "vendor", o.name);
  for (const root of [o.dataRoot, o.codeRoot]) {
    if (root) {
      const dir = path.join(root, "vendor", o.name);
      if (fs.existsSync(dir)) return dir;
    }
  }
  const main = mainCheckout(o.codeRoot);
  if (main) {
    const dir = path.join(main, "vendor", o.name);
    if (fs.existsSync(dir)) return dir;
  }
  return local;
}
