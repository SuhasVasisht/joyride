import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { paths } from "../../shared/paths.ts";
import { ServerDefinition, ServerRun } from "../../shared/servers.ts";
import { commitPaths } from "../../core/gitstore.ts";

export const serverRoot = () => path.join(paths.root, "servers");
export const runRoot = () => path.join(paths.runtime, "servers");
export const journalFile = () => path.join(paths.state, "review-servers.json");
export const Journal = z.object({
  runs: z.record(z.string(), ServerRun).default({}),
  requests: z.record(z.string(), z.object({ signature: z.string(), completed: z.array(z.string()), done: z.boolean() })).default({}),
});
export type Journal = z.infer<typeof Journal>;
export function atomicJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".tmp", JSON.stringify(value, null, 2));
  fs.renameSync(file + ".tmp", file);
}
export function definitions(): ServerDefinition[] {
  if (!fs.existsSync(serverRoot())) return [];
  return fs.readdirSync(serverRoot()).filter((f) => f.endsWith(".yaml")).map((f) => {
    const group = ServerDefinition.parse(YAML.parse(fs.readFileSync(path.join(serverRoot(), f), "utf8")));
    if (f !== group.id + ".yaml") throw new Error(`Server definition ${f} must use id ${path.basename(f, ".yaml")}.`);
    return group;
  });
}
export function saveDefinition(g: ServerDefinition) {
  const file = path.join(serverRoot(), g.id + ".yaml");
  fs.mkdirSync(serverRoot(), { recursive: true });
  fs.writeFileSync(file + ".tmp", YAML.stringify(g));
  fs.renameSync(file + ".tmp", file);
  return commitPaths([file], `save server group ${g.name}`);
}
export function readJournal(): Journal {
  if (!fs.existsSync(journalFile())) return { runs: {}, requests: {} };
  return Journal.parse(JSON.parse(fs.readFileSync(journalFile(), "utf8")));
}
