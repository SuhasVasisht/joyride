import fs from "node:fs";
import YAML from "yaml";
import { GuardPolicy } from "../../shared/schema.ts";
import { paths } from "../../shared/paths.ts";
import { re, type CompiledPolicy } from "../../shared/guard-match.ts";
import { writeJsonAtomic } from "../../core/util.ts";

export function loadPolicy(file = paths.guard): GuardPolicy {
  return GuardPolicy.parse(YAML.parse(fs.readFileSync(file, "utf8")));
}
export function compilePolicy(p: GuardPolicy): CompiledPolicy {
  for (const r of p.rules) for (const src of [...r.match, ...r.unless]) re(src); // validate early
  return { timeout_seconds: p.timeout_seconds, rules: p.rules.map((r) => ({ id: r.id, title: r.title, tools: r.tools, match: r.match, unless: r.unless, level: r.level })) };
}
export function writeCompiled(file = paths.guard, out = paths.guardCompiled) {
  const compiled = compilePolicy(loadPolicy(file));
  writeJsonAtomic(out, compiled);
  return compiled;
}
