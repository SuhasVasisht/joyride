import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type NoCavemanOptions = { settings: string; runtime: string };
type Undo = { plugins: Record<string, boolean | null>; backup: string | null; statusLine?: unknown };
const manifest = (o: NoCavemanOptions) => path.join(o.runtime, "install", "no-caveman.json");
const read = (p: string) => fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
function write(p: string, data: unknown) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p + ".tmp", JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(p + ".tmp", p);
}
function pluginFlags(s: any): Record<string, boolean> {
  if (s.enabledPlugins != null && (typeof s.enabledPlugins !== "object" || Array.isArray(s.enabledPlugins))) throw new Error("Claude enabledPlugins is invalid. Repair settings.json before installing no-caveman.");
  return s.enabledPlugins ?? {};
}
function cavemanStatusLine(s: any): boolean {
  return typeof s.statusLine?.command === "string" && /(?:^|\/)plugins\/cache\/caveman(?:\/|$)/.test(s.statusLine.command);
}
export function installNoCaveman(o: NoCavemanOptions, dryRun = false): string[] {
  const s = read(o.settings), flags = pluginFlags(s);
  const keys = [...new Set(["caveman@caveman", ...Object.keys(flags).filter(k => k === "caveman" || k.startsWith("caveman@"))])];
  const changes = keys.filter(k => flags[k] !== false);
  const removeStatusLine = cavemanStatusLine(s);
  if (!changes.length && !removeStatusLine) return ["caveman already disabled; other plugins kept"];
  const prior: Undo | null = fs.existsSync(manifest(o)) ? read(manifest(o)) : null;
  if (prior && (changes.length || prior.statusLine !== undefined)) throw new Error("Caveman changed since Joyride disabled it. Uninstall no-caveman before applying again.");
  if (dryRun) return [`would back up ${o.settings}${changes.length ? ` and disable ${changes.join(", ")}` : ""}${removeStatusLine ? " and remove caveman status line" : ""}; other plugins kept`];
  const dir = path.join(o.runtime, "backups", `no-caveman-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const backup = fs.existsSync(o.settings) ? path.join(dir, "settings.json") : null;
  if (backup) { fs.copyFileSync(o.settings, backup); fs.chmodSync(backup, 0o600); }
  const undo: Undo = { plugins: { ...prior?.plugins, ...Object.fromEntries(changes.map(k => [k, flags[k] ?? null])) }, backup: prior?.backup ?? backup, ...(removeStatusLine ? { statusLine: s.statusLine } : {}) };
  write(manifest(o), undo);
  s.enabledPlugins = { ...flags, ...Object.fromEntries(changes.map(k => [k, false])) };
  if (removeStatusLine) delete s.statusLine;
  try { write(o.settings, s); }
  catch (error) { if (prior) write(manifest(o), prior); else fs.unlinkSync(manifest(o)); throw error; }
  return [`${changes.length ? `disabled ${changes.join(", ")}` : "caveman already disabled"}${removeStatusLine ? "; removed caveman status line" : ""} in ${o.settings}${backup ? ` (backup ${backup})` : " (settings previously absent)"}`, "other plugins kept; plugin hooks stop loading in new Claude sessions; tell existing sessions 'stop caveman; use normal prose'", "undo with ./bin/joyride uninstall no-caveman"];
}
export function uninstallNoCaveman(o: NoCavemanOptions, dryRun = false): string[] {
  if (!fs.existsSync(manifest(o))) return ["no caveman change to undo"];
  const undo: Undo = read(manifest(o)), s = read(o.settings), flags = pluginFlags(s);
  for (const k of Object.keys(undo.plugins)) if (flags[k] !== false) throw new Error(`Plugin setting ${k} changed after installation; your setting was kept. Set it to false before undoing no-caveman.`);
  if (undo.statusLine !== undefined && s.statusLine !== undefined) throw new Error("Claude status line changed after installation; your setting was kept. Remove it before undoing no-caveman.");
  if (dryRun) return [`would restore original caveman flags${undo.statusLine !== undefined ? " and status line" : ""} in ${o.settings}; other settings kept`];
  for (const [k, v] of Object.entries(undo.plugins)) { if (v === null) delete flags[k]; else flags[k] = v; }
  s.enabledPlugins = flags;
  if (undo.statusLine !== undefined) s.statusLine = undo.statusLine;
  if (!undo.backup && Object.keys(s).length === 1 && !Object.keys(flags).length) fs.unlinkSync(o.settings);
  else write(o.settings, s);
  fs.unlinkSync(manifest(o));
  return [`restored original caveman flags${undo.statusLine !== undefined ? " and status line" : ""} in ${o.settings}; kept backups and unrelated settings`];
}
export function noCavemanStatus(o: NoCavemanOptions): string {
  const flags = pluginFlags(read(o.settings));
  const entries = Object.entries(flags).filter(([k]) => k === "caveman" || k.startsWith("caveman@"));
  return cavemanStatusLine(read(o.settings)) || entries.some(([, v]) => v) ? "caveman enabled" : entries.length ? "caveman disabled" : "absent";
}
