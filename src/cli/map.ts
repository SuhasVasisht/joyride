import { z } from "zod";
import { MAP_ACTIONS, mapAction, MapActor } from "../shared/map-actions.ts";
import { callMap, mapActor } from "../shared/map-client.ts";

const options = (entry: (typeof MAP_ACTIONS)[number]) => {
  const json = z.toJSONSchema(entry.schema);
  return Object.entries(entry.cli.flags).map(([flag, field]) => {
    const property = json.properties?.[field];
    const boolean = typeof property === "object" && property.type === "boolean";
    const option = `--${flag}${boolean ? "" : " <value>"}`;
    return json.required?.includes(field) ? ` ${option}` : ` [${option}]`;
  }).join("");
};
export const MAP_USAGE = ["joyride map <action> [--agent <id>]", ...MAP_ACTIONS.map((a) =>
  `  ${a.name}${a.cli.positional.map((p) => ` <${p}>`).join("")}${a.cli.rest ? ` <${a.cli.rest}>...` : ""}${options(a)}\n    ${a.description}`),
  "All output is JSON. Grouping edits return commits for undo; notes/lists return ids for archive-note and restore-note. Hide is undone with unhide. Agent identity defaults to FM_TASK_ID or the session id.",
].join("\n");
export function parseMapArgs(argv: string[]): { name: string; args: Record<string, unknown>; agent?: string } {
  const [name = "show", ...rest] = argv;
  const entry = mapAction(name);
  const args: Record<string, unknown> = {};
  let agent: string | undefined;
  let position = 0;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token.startsWith("--")) {
      const flag = token.slice(2);
      const field = flag === "agent" ? "agent" : entry.cli.flags[flag];
      if (!field) throw new Error(`Unknown option ${token} for map ${name}.`);
      if ((field === "agent" && agent !== undefined) || field in args) throw new Error(`Duplicate option ${token}.`);
      const property = z.toJSONSchema(entry.schema).properties?.[field];
      if (typeof property === "object" && property.type === "boolean") { args[field] = true; continue; }
      const value = rest[++i];
      if (!value || value.startsWith("--")) throw new Error(`${token} needs a value.`);
      if (field === "agent") agent = MapActor.shape.id.parse(value); else args[field] = value;
    } else {
      const field = entry.cli.positional[position++];
      if (field) args[field] = token;
      else if (entry.cli.rest) {
        const values = args[entry.cli.rest];
        args[entry.cli.rest] = [...(Array.isArray(values) ? values : []), token];
      } else throw new Error(`Unexpected argument ${token} for map ${name}.`);
    }
  }
  entry.schema.parse(args);
  return { name, args, agent };
}
export async function runMap(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (argv.includes("--help") || argv[0] === "help") return MAP_USAGE;
  const input = parseMapArgs(argv);
  return JSON.stringify(await callMap(input.name, input.args, mapActor("cli", input.agent, env), env.JOYRIDE_URL, env.JOYRIDE_NEW_JOB ?? null), null, 2);
}
