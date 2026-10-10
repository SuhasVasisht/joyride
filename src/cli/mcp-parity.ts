// One manifest, four independent client configs. Never read OAuth stores or
// import credentials from another client. State contains only fields we own.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { parse, stringify } from "smol-toml";
import { z } from "zod";
import { paths } from "../shared/paths.ts";

const serverSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  aliases: z.array(z.string().regex(/^[a-zA-Z0-9_-]+$/)).default([]),
  mode: z.enum(["install", "review"]),
  url: z.string().optional(), command: z.string().optional(), args: z.array(z.string()).optional(),
  bearerEnv: z.string().regex(/^[A-Z][A-Z0-9_]+$/).optional(),
  source: z.string(), note: z.string(),
}).strict();
const manifestSchema = z.object({ version: z.literal(1), servers: z.array(serverSchema) }).strict();
type Server = z.infer<typeof serverSchema>;
type Entry = Record<string, any>;
type Target = { id: string; file: string; format: "claude" | "codex" | "cursor" };
type Owned = { key: string; created: boolean; before: Entry; installed: Entry };
type State = { version: 1; files: Record<string, { existed: boolean; entries: Owned[] }> };
export type ParityOptions = { home?: string; runtime?: string; code?: string; manifest?: string; dryRun?: boolean };

export function parityTargets(home = os.homedir()): Target[] {
  return [
    { id: "claude", file: path.join(home, ".claude.json"), format: "claude" },
    { id: "codex", file: path.join(home, ".codex/config.toml"), format: "codex" },
    { id: "codex-2", file: path.join(home, ".codex-2/config.toml"), format: "codex" },
    { id: "cursor", file: path.join(home, ".cursor/mcp.json"), format: "cursor" },
  ];
}

/** The data home's manifest, else the one shipped with the code. */
export const mcpManifestFile = () => [paths.root, paths.code].map((r) => path.join(r, "config/mcp-manifest.json")).find((f) => fs.existsSync(f)) ?? path.join(paths.code, "config/mcp-manifest.json");

export function loadMcpManifest(file = mcpManifestFile()) {
  const m = manifestSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  const names = new Set<string>();
  for (const s of m.servers) {
    for (const n of [s.name, ...s.aliases]) {
      if (names.has(n)) throw new Error(`Duplicate MCP name or alias ${n} in the manifest.`);
      names.add(n);
    }
    if (s.mode === "review") continue;
    if (!s.url || s.command || s.args) throw new Error(`MCP ${s.name} needs one remote URL.`);
    const u = new URL(s.url);
    if (u.username || u.password || u.search || u.hash) throw new Error(`MCP ${s.name} URL must not contain credentials or query parameters.`);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && u.hostname === "127.0.0.1")) throw new Error(`MCP ${s.name} needs HTTPS or a loopback URL.`);
    if (u.port === "3000") throw new Error("MCP servers must not use port 3000.");
  }
  return m;
}

export function renderMcp(s: Server, format: Target["format"], code = paths.code, home = os.homedir()): Entry {
  return {
    ...(format === "claude" ? { type: "http" } : {}), url: s.url,
    ...(s.bearerEnv ? format === "codex" ? { bearer_token_env_var: s.bearerEnv }
      : { headers: { Authorization: format === "cursor" ? `Bearer ${"${env:" + s.bearerEnv + "}"}` : `Bearer ${"${" + s.bearerEnv + "}"}` } } : {}),
  };
}

const equal = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const ak = Object.keys(a), bk = Object.keys(b);
  return ak.length === bk.length && ak.every((k) => Object.hasOwn(b, k) && equal((a as Entry)[k], (b as Entry)[k]));
};
function readConfig(t: Target) {
  let parent = path.dirname(t.file);
  const home = t.format === "claude" ? parent : path.dirname(parent);
  while (parent !== home) {
    if (fs.existsSync(parent) && fs.lstatSync(parent).isSymbolicLink()) throw new Error(`${t.id} config directory is a symlink. Review its destination before installing.`);
    parent = path.dirname(parent);
  }
  if (fs.existsSync(t.file) && fs.lstatSync(t.file).isSymbolicLink()) throw new Error(`${t.id} config is a symlink. Review its destination before installing.`);
  const text = fs.existsSync(t.file) ? fs.readFileSync(t.file, "utf8") : "";
  let data: Entry;
  try { data = text ? t.format === "codex" ? parse(text) : JSON.parse(text) : {}; }
  catch { throw new Error(`${t.id} config is unreadable or invalid. Repair ${t.file} and retry; no configs were changed.`); }
  if (!data || Array.isArray(data) || typeof data !== "object") throw new Error(`${t.id} config must be an object.`);
  const key = t.format === "codex" ? "mcp_servers" : "mcpServers";
  if (data[key] != null && (typeof data[key] !== "object" || Array.isArray(data[key]))) throw new Error(`${t.id} MCP servers must be an object.`);
  const servers: Record<string, Entry> = data[key] ?? {};
  for (const v of Object.values(servers)) if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${t.id} has an invalid MCP entry.`);
  return { text, data, servers, key };
}

// Rewrite only the changed MCP table ranges. Other TOML (including comments)
// stays byte-for-byte. Parse-and-compare catches unsupported inline tables or
// apparent headers inside multiline strings before any external write.
export function patchMcpToml(text: string, expected: Entry, changed: Set<string>): string {
  const headers = [...text.matchAll(/^\s*\[([^\n]+)\][^\n]*$/gm)];
  const ranges: { start: number; end: number; name: string }[] = [];
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    try {
      const table = parse(h[0] + "\n__joyride_marker__ = true\n");
      const names = Object.keys((table.mcp_servers as Entry) ?? {});
      if (names.length === 1 && changed.has(names[0])) ranges.push({ start: h.index!, end: headers[i + 1]?.index ?? text.length, name: names[0] });
    } catch { /* validation below refuses ambiguous syntax */ }
  }
  let result = text;
  for (const r of ranges.toReversed()) result = result.slice(0, r.start) + result.slice(r.end);
  const entries: Entry = {};
  for (const n of changed) if (expected.mcp_servers?.[n]) entries[n] = expected.mcp_servers[n];
  if (Object.keys(entries).length) result = result.replace(/\s*$/, "") + "\n\n" + stringify({ mcp_servers: entries });
  else if (expected.mcp_servers && !Object.keys(expected.mcp_servers).length && !parse(result).mcp_servers) result = result.replace(/\s*$/, "") + "\n\n[mcp_servers]\n";
  let valid = false;
  try { valid = equal(parse(result), expected); } catch { /* don't print config snippets containing secrets */ }
  if (!valid) throw new Error("Cannot safely update this TOML layout. Expand inline MCP entries into [mcp_servers.<name>] tables and retry; no configs were changed.");
  return result;
}

function context(o: ParityOptions) {
  const runtime = o.runtime ?? paths.runtime;
  const stateFile = path.join(runtime, "install/mcp-parity.json");
  let state: State = { version: 1, files: {} };
  if (fs.existsSync(stateFile)) {
    try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")); }
    catch { throw new Error("MCP parity install state is invalid. Restore its backup before retrying."); }
    if (state.version !== 1 || !state.files) throw new Error("Unsupported MCP parity install state.");
  }
  return { runtime, stateFile, state, targets: parityTargets(o.home), code: o.code ?? paths.code, home: o.home ?? os.homedir() };
}
type Update = { target: Target; text: string; original: string; remove: boolean };
function applyUpdates(updates: Update[], c: ReturnType<typeof context>, dryRun: boolean) {
  if (dryRun || !updates.length) return [];
  // Back up every affected config before the first write. Backups may contain
  // existing credentials, so they and the directory are private.
  const dir = path.join(c.runtime, "backups", `mcp-parity-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lines: string[] = [];
  for (const u of updates) {
    if (fs.existsSync(u.target.file)) {
      fs.writeFileSync(path.join(dir, `${u.target.id}.config`), u.original, { mode: 0o600 });
      lines.push(`backup ${u.target.id} -> ${path.join(dir, `${u.target.id}.config`)}`);
    }
  }
  for (const u of updates) {
    // Refuse concurrent config changes rather than trampling a login or edit.
    if ((fs.existsSync(u.target.file) ? fs.readFileSync(u.target.file, "utf8") : "") !== u.original) throw new Error(`${u.target.id} config changed while planning. Retry the installer.`);
  }
  const applied: Update[] = [];
  const existed = new Set(updates.filter((u) => fs.existsSync(u.target.file)).map((u) => u.target.id));
  try {
    for (const u of updates) {
      if (u.remove) fs.unlinkSync(u.target.file);
      else {
        fs.mkdirSync(path.dirname(u.target.file), { recursive: true });
        const tmp = u.target.file + `.joyride-${process.pid}.tmp`;
        try {
          fs.writeFileSync(tmp, u.text, { mode: fs.existsSync(u.target.file) ? fs.statSync(u.target.file).mode & 0o777 : 0o600 });
          fs.renameSync(tmp, u.target.file);
        } finally { fs.rmSync(tmp, { force: true }); }
      }
      applied.push(u);
    }
    fs.mkdirSync(path.dirname(c.stateFile), { recursive: true });
    const tmp = c.stateFile + `.tmp-${process.pid}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(c.state, null, 2) + "\n", { mode: 0o600 });
      fs.renameSync(tmp, c.stateFile);
    } finally { fs.rmSync(tmp, { force: true }); }
  } catch {
    for (const u of applied.toReversed()) {
      if (existed.has(u.target.id)) fs.writeFileSync(u.target.file, u.original, { mode: 0o600 });
      else fs.rmSync(u.target.file, { force: true });
    }
    throw new Error(`MCP install failed; restored applied configs. Backups are in ${dir}. Check file permissions and retry.`);
  }
  return lines;
}

export function installMcpParity(o: ParityOptions = {}): string[] {
  const c = context(o), m = loadMcpManifest(o.manifest);
  const lines = [o.dryRun ? "Dry run: no files, backups, state or log will be written." : "MCP parity: authentication stays with each client."];
  const updates: Update[] = [];
  // Preflight all four files and every render before mutating any of them.
  for (const t of c.targets) {
    const cfg = readConfig(t), servers = structuredClone(cfg.servers);
    const state = c.state.files[t.id] ?? { existed: fs.existsSync(t.file), entries: [] };
    const changed = new Set<string>();
    for (const s of m.servers.filter((s) => s.mode === "install")) {
      const wanted = renderMcp(s, t.format, c.code, c.home);
      const existingNames = [s.name, ...s.aliases].filter((n) => Object.hasOwn(servers, n));
      if (existingNames.length > 1) { lines.push(`${t.id}: review duplicate names for ${s.name}; kept existing entries`); continue; }
      const key = existingNames[0] ?? s.name, current = servers[key];
      let own = state.entries.find((e) => e.key === key);
      if (!current) {
        servers[key] = wanted;
        own = { key, created: true, before: {}, installed: wanted };
        state.entries.push(own); changed.add(key);
        lines.push(`${t.id}: add ${key}${s.bearerEnv ? ` (requires ${s.bearerEnv} in this client's environment)` : ""}`);
        continue;
      }
      if (own && !Object.entries(own.installed).every(([k, v]) => equal(current[k], v))) {
        lines.push(`${t.id}: review edited ${key}; kept your changes`); continue;
      }
      // Adopt only the known retired
      // Atlassian endpoint. Other pre-existing servers and all auth stay intact.
      const adopt = (s.name === "atlassian" && ["https://mcp.atlassian.com/v1/sse", "https://mcp.atlassian.com/v1/mcp"].includes(current.url));
      if (!own && !adopt) {
        lines.push(`${t.id}: ${current.url === wanted.url ? "keep" : "review conflicting"} ${key} (existing configuration)`); continue;
      }
      // Authentication can be provisioned after installation. A later
      // manifest update never replaces those values, even in an owned entry.
      const fields = own ? Object.keys(wanted).filter((k) => ["url", "type", "command", "args"].includes(k)) : s.name === "atlassian" ? ["url", ...(t.format === "claude" ? ["type"] : [])] : Object.keys(wanted);
      const delta = fields.filter((k) => !equal(current[k], wanted[k]));
      if (!delta.length) { lines.push(`${t.id}: keep ${key}`); continue; }
      if (!own) { own = { key, created: false, before: {}, installed: {} }; state.entries.push(own); }
      for (const k of delta) {
        if (!Object.hasOwn(own.installed, k)) own.before[k] = Object.hasOwn(current, k) ? current[k] : null;
        current[k] = wanted[k]; own.installed[k] = wanted[k];
      }
      changed.add(key); lines.push(`${t.id}: update ${key} (${delta.join(", ")}; authentication preserved)`);
    }
    if (!changed.size) continue;
    c.state.files[t.id] = state;
    const data = { ...cfg.data, [cfg.key]: servers };
    const text = t.format === "codex" ? patchMcpToml(cfg.text, data, changed) : JSON.stringify(data, null, 2) + "\n";
    updates.push({ target: t, text, original: cfg.text, remove: false });
  }
  for (const s of m.servers.filter((s) => s.mode === "review")) lines.push(`review ${s.name}: ${s.note}`);
  lines.push(...applyUpdates(updates, c, !!o.dryRun));
  return lines;
}

export function uninstallMcpParity(o: ParityOptions = {}): string[] {
  const c = context(o), lines = [o.dryRun ? "Dry run: no files, backups, state or log will be written." : "Restore only unchanged Joyride fields; preserve subsequent edits and authentication."];
  const updates: Update[] = [];
  for (const t of c.targets) {
    const state = c.state.files[t.id];
    if (!state) continue;
    const cfg = readConfig(t), servers = structuredClone(cfg.servers), changed = new Set<string>(), remaining: Owned[] = [];
    for (const e of state.entries) {
      const current = servers[e.key];
      if (!current) continue;
      if (e.created) {
        if (!equal(current, e.installed)) { remaining.push(e); lines.push(`${t.id}: keep edited ${e.key}; review it manually`); continue; }
        delete servers[e.key]; changed.add(e.key); lines.push(`${t.id}: remove ${e.key}`);
      } else {
        const kept: Owned = { ...e, before: {}, installed: {} };
        for (const [k, v] of Object.entries(e.installed)) {
          if (!equal(current[k], v)) { kept.before[k] = e.before[k]; kept.installed[k] = v; lines.push(`${t.id}: keep edited ${e.key}.${k}`); continue; }
          if (e.before[k] === null) delete current[k]; else current[k] = e.before[k];
          changed.add(e.key);
        }
        if (Object.keys(kept.installed).length) remaining.push(kept);
        if (changed.has(e.key)) lines.push(`${t.id}: restore ${e.key}`);
      }
    }
    c.state.files[t.id] = { ...state, entries: remaining };
    if (!changed.size) continue;
    const data = { ...cfg.data, [cfg.key]: servers };
    const remove = !state.existed && !Object.keys(servers).length && Object.keys(data).every((k) => k === cfg.key);
    const text = t.format === "codex" ? patchMcpToml(cfg.text, data, changed) : JSON.stringify(data, null, 2) + "\n";
    updates.push({ target: t, text, original: cfg.text, remove });
  }
  lines.push(...applyUpdates(updates, c, !!o.dryRun));
  return lines;
}

export function mcpParityStatus() {
  return parityTargets().map((t) => {
    try { return `${t.id}: ${Object.keys(readConfig(t).servers).length} configured`; }
    catch { return `${t.id}: config needs repair`; }
  }).join(", ");
}
