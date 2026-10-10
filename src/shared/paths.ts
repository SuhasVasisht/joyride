// Filesystem locations. Every external store is overridable by env so tests
// can point the daemon at fixtures instead of the user's real home.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { localHome } from "./home.ts";
import { vendorCheckout } from "./vendor.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
/** Where the code lives (src/, skills/, dist/). */
export const CODE_ROOT = path.resolve(here, "..", "..");
const LOCAL = localHome(CODE_ROOT);
/** Where authored data lives (missions/, notes/, ...): JOYRIDE_HOME, else `.joyride.env`, else the code checkout. Tests point this at a temp copy. */
export const REPO_ROOT = LOCAL.JOYRIDE_HOME ?? CODE_ROOT;
const HOME = os.homedir();
if ((process.env.VITEST || process.env.JOYRIDE_TEST) && !process.env.JOYRIDE_RUNTIME) {
  throw new Error("Joyride tests must run inside a sandbox (JOYRIDE_RUNTIME unset) — see tests/setup-env.ts");
}

export const paths = {
  code: CODE_ROOT,
  root: REPO_ROOT,
  runtime: LOCAL.JOYRIDE_RUNTIME ?? path.join(REPO_ROOT, ".joyride"),
  get events() { return path.join(this.runtime, "events"); },
  get index() { return path.join(this.runtime, "index.sqlite"); },
  get blobs() { return path.join(this.runtime, "blobs"); },
  get taskNotes() { return path.join(this.runtime, "task-notes"); },
  get proposals() { return path.join(this.runtime, "proposals"); },
  get guardCompiled() { return path.join(this.runtime, "guard.compiled.json"); },
  get llmCwd() { return path.join(this.runtime, "llm"); },
  get firstmateHome() { return process.env.FM_HOME ?? path.join(this.runtime, "firstmate"); },
  /** Read-only vendor checkout, shared with the main checkout when absent here. */
  vendorCheckout(name: string, override?: string) {
    return vendorCheckout({ name, codeRoot: CODE_ROOT, dataRoot: REPO_ROOT, override });
  },
  get firstmateDir() {
    return this.vendorCheckout("firstmate", process.env.JOYRIDE_FIRSTMATE_DIR);
  },
  get state() { return path.join(this.runtime, "state"); },
  /** Images the captain attached to messages (gitignored with the rest of the runtime folder). */
  get uploads() { return path.join(this.runtime, "uploads"); },
  missions: path.join(REPO_ROOT, "missions"),
  lenses: path.join(REPO_ROOT, "lenses"),
  /** Where the captain placed groups on the map (src/modules/missions/layout.ts). */
  mapLayout: path.join(REPO_ROOT, "map", "layout.yaml"),
  notes: path.join(REPO_ROOT, "notes"),
  artifacts: path.join(REPO_ROOT, "artifacts"),
  workspace: path.join(REPO_ROOT, "workspace.yaml"),
  /** The captain's fleet policy (src/modules/fleet/policy.ts). */
  fleet: path.join(REPO_ROOT, "fleet.yaml"),
  /** The data home's guard policy, else the default one shipped with the code. */
  get guard() {
    const own = path.join(REPO_ROOT, "guard.yaml");
    return fs.existsSync(own) ? own : path.join(CODE_ROOT, "guard.yaml");
  },
  config: path.join(REPO_ROOT, "joyride.config.yaml"),
  judges: path.join(REPO_ROOT, "config", "judges"),
  vendor: path.join(REPO_ROOT, "vendor"),
  // external stores (read-only)
  claudeDir: process.env.JOYRIDE_CLAUDE_DIR ?? path.join(HOME, ".claude"),
  codexDir: process.env.JOYRIDE_CODEX_DIR ?? path.join(HOME, ".codex"),
  herdrSocket: process.env.JOYRIDE_HERDR_SOCKET ?? path.join(HOME, ".config", "herdr", "herdr.sock"),
  herdrBin: process.env.JOYRIDE_HERDR_BIN ?? "/opt/homebrew/bin/herdr",
};

export const DAEMON_URL = process.env.JOYRIDE_URL ?? `http://127.0.0.1:${process.env.JOYRIDE_PORT ?? 4317}`;
