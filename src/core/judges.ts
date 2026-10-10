// Jev judge prompts live in config/judges/<name>.yaml so the hill-climb engine
// can tune them (each accepted improvement is a git commit). Modules read them
// through loadJudge(), which falls back to built-in defaults when the file is
// missing or invalid. Cached by mtime.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { paths } from "../shared/paths.ts";

const cache = new Map<string, { mtime: number; value: any }>();

export function judgeFile(name: string) { return path.join(paths.judges, `${name}.yaml`); }

export function loadJudge<T>(name: string, defaults: T, validate?: (v: any) => boolean): T {
  const file = judgeFile(name);
  try {
    const st = fs.statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtime === st.mtimeMs) return hit.value;
    const v = YAML.parse(fs.readFileSync(file, "utf8"));
    const value = v && (!validate || validate(v)) ? { ...defaults, ...v } : defaults;
    cache.set(file, { mtime: st.mtimeMs, value });
    return value;
  } catch { return defaults; }
}
/** For the hill-climb engine: evaluate a candidate config without writing it. */
let override: { name: string; value: any } | null = null;
export function withJudgeOverride<T>(name: string, value: any, fn: () => Promise<T>): Promise<T> {
  override = { name, value };
  return fn().finally(() => { override = null; });
}
export function overrideFor(name: string) { return override?.name === name ? override.value : null; }
