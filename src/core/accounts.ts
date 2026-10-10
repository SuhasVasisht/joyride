// Subscription accounts (`usage.accounts` in joyride.config.yaml): the Claude, Codex and Cursor
// logins Joyride shows usage for and can launch sessions on. An account off the default login is a
// credential folder, handed to quota-axi and to launched agents as CODEX_HOME or CLAUDE_CONFIG_DIR.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { Config, type UsageAccount } from "../shared/schema.ts";
import { paths } from "../shared/paths.ts";
import { loadConfig } from "./config.ts";
import { slugify } from "./util.ts";

export type AccountProvider = UsageAccount["provider"];
export type Account = {
  id: string;
  provider: AccountProvider;
  label: string;
  /** Absolute credential folder; null for the provider's default login. */
  home: string | null;
  /** The folder as typed in commands the user copies ("~/.codex-2"); null for the default login. */
  homeLabel: string | null;
  /** The variable that points the provider's CLI at `home`. */
  envVar: "CODEX_HOME" | "CLAUDE_CONFIG_DIR" | null;
};

export const PROVIDER_TITLES: Record<AccountProvider, string> = { claude: "Claude Code", codex: "Codex", cursor: "Cursor" };
const ENV_VAR = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME", cursor: null } as const;
export const DEFAULT_ACCOUNTS: UsageAccount[] = [{ provider: "claude" }, { provider: "codex" }, { provider: "cursor" }];

const expand = (p: string) => (p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : path.resolve(p));
const tildify = (p: string) => (p.startsWith(os.homedir() + "/") ? `~${p.slice(os.homedir().length)}` : p);
const defaultHomes = (provider: AccountProvider) =>
  provider === "codex" ? [path.join(os.homedir(), ".codex"), paths.codexDir] : provider === "claude" ? [path.join(os.homedir(), ".claude"), paths.claudeDir] : [];

/** Configured accounts with ids, labels and folders filled in. A folder that is the provider's default counts as the default login. */
export function resolveAccounts(list: UsageAccount[] = DEFAULT_ACCOUNTS): Account[] {
  const perProvider = new Map<AccountProvider, number>();
  const ids = new Set<string>();
  return list.map((a) => {
    const n = (perProvider.get(a.provider) ?? 0) + 1;
    perProvider.set(a.provider, n);
    const label = a.label?.trim() || (n > 1 ? `${PROVIDER_TITLES[a.provider]} ${n}` : PROVIDER_TITLES[a.provider]);
    const base = slugify(a.id?.trim() || label, 32);
    let id = base;
    for (let i = 2; ids.has(id); i++) id = `${base}-${i}`;
    ids.add(id);
    const typed = ENV_VAR[a.provider] ? a.home?.trim() : undefined;
    const abs = typed ? expand(typed) : null;
    const home = abs && !defaultHomes(a.provider).includes(abs) ? abs : null;
    const homeLabel = home ? (typed!.startsWith("~") ? typed! : tildify(home)) : null;
    return { id, provider: a.provider, label, home, homeLabel, envVar: home ? ENV_VAR[a.provider] : null };
  });
}

/** The accounts as joyride.config.yaml says now, so a newly added login shows up without a daemon restart. */
export function readAccounts(): Account[] {
  let list: UsageAccount[] | undefined;
  try {
    const raw = fs.existsSync(paths.config) ? YAML.parse(fs.readFileSync(paths.config, "utf8")) ?? {} : {};
    list = Config.shape.usage.parse(raw.usage ?? {}).accounts;
  } catch {
    list = loadConfig().usage.accounts;
  }
  return resolveAccounts(list?.length ? list : DEFAULT_ACCOUNTS);
}

/** The folder as a shell word: "~/.codex-2" stays unquoted so the shell expands it. */
const shellHome = (a: Account) => (/^[\w./~@%+=:,-]+$/.test(a.homeLabel!) ? a.homeLabel! : `'${a.home!.replace(/'/g, `'\\''`)}'`);

/** Environment for a session launched on this account; empty for the default login. */
export const launchEnv = (a: Account): Record<string, string> => (a.home && a.envVar ? { [a.envVar]: a.home } : {});

/** How to sign this account in, e.g. `mkdir -p ~/.codex-2 && CODEX_HOME=~/.codex-2 codex login`. Null for Cursor (sign in in the app). */
export function loginCommand(a: Account): string | null {
  const cmd = a.provider === "codex" ? "codex login" : a.provider === "claude" ? "claude auth login" : null;
  if (!cmd) return null;
  return a.home ? `mkdir -p ${shellHome(a)} && ${a.envVar}=${shellHome(a)} ${cmd}` : cmd;
}

/** The quota-axi run that shows why this account's reading failed. */
export const quotaCheckCommand = (a: Account) =>
  a.home ? `${a.envVar}=${shellHome(a)} quota-axi --provider ${a.provider} --profile-only --full` : `quota-axi --provider ${a.provider} --full`;
