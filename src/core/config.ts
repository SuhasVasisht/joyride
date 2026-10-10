import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { Config } from "../shared/schema.ts";
import { paths } from "../shared/paths.ts";
import { unknownLlmTasks, unknownLlmTasksWarning } from "../shared/llm-tasks.ts";

let cached: Config | null = null;
let warned = "";
export function loadEnv() {
  const envFile = path.join(paths.root, ".env");
  if (!fs.existsSync(envFile)) return;
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
}
export function loadConfig(fresh = false): Config {
  if (cached && !fresh) return cached;
  loadEnv();
  let raw: unknown = {};
  if (fs.existsSync(paths.config)) raw = YAML.parse(fs.readFileSync(paths.config, "utf8")) ?? {};
  cached = Config.parse(raw);
  if (process.env.JOYRIDE_PORT) cached.port = Number(process.env.JOYRIDE_PORT);
  const unknown = unknownLlmTasks(cached.llm.tasks);
  // Warn once per distinct set: loadConfig(true) runs on every Settings read.
  if (unknown.join() !== warned) { warned = unknown.join(); if (unknown.length) console.warn(`[config] ${unknownLlmTasksWarning(unknown)}`); }
  return cached;
}
