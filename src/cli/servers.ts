import fs from "node:fs";
import { DAEMON_URL } from "../shared/paths.ts";
import { ServerAction, ServerDefinition, ServerPurpose } from "../shared/servers.ts";

export const SERVERS_USAGE = `joyride servers list [--purpose review|test]
joyride servers show <id>
joyride servers create <definition.json>
joyride servers save <definition.json>                 update an existing definition
joyride servers start|stop|restart|update <id> [--member <id>] [--purpose review|test] [--request <id>]
joyride servers logs <id> <member>

All results are JSON. Lifecycle defaults to review; test requires --purpose test.
start reuses a verified running instance. update applies pending definitions/change
by restarting affected members; restart restarts every selected member.
Use a stable --request id to replay a restart safely after a lost response.
Definitions are git-backed in servers/*.yaml; runtime ownership is in
.joyride/state/review-servers.json. Foreground commands run in Herdr terminals.
Agent guide and exact examples: docs/review-servers.md`;

export async function runServers(argv: string[]) {
  const [action = "list", ...args] = argv;
  if (["help", "--help", "-h"].includes(action)) return SERVERS_USAGE;
  const request = async (method: string, url: string, body?: unknown) => {
    const r = await fetch(DAEMON_URL + "/api/servers" + url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    const result: unknown = await r.json();
    if (!r.ok) throw new Error(`Joyride refused servers ${action} (${r.status}): ${JSON.stringify(result)}`);
    return JSON.stringify(result, null, 2);
  };
  const enc = encodeURIComponent;
  if (action === "create" || action === "save") {
    if (args.length !== 1 || !args[0]) throw new Error(`servers ${action} needs a JSON definition file.\n${SERVERS_USAGE}`);
    const g = ServerDefinition.parse(JSON.parse(fs.readFileSync(args[0], "utf8")));
    return request(action === "create" ? "POST" : "PUT", action === "create" ? "" : "/" + enc(g.id), g);
  }
  if (action === "list") {
    if (!args.length) return request("GET", "");
    if (args.length !== 2 || args[0] !== "--purpose") throw new Error(SERVERS_USAGE);
    return request("GET", "?purpose=" + ServerPurpose.parse(args[1]));
  }
  if (action === "show" && args.length === 1 && args[0]) return request("GET", "/" + enc(args[0]));
  if (action === "logs" && args.length === 2 && args[0] && args[1]) return request("GET", `/${enc(args[0])}/members/${enc(args[1])}/logs`);
  if (!["start", "stop", "restart", "update"].includes(action)) throw new Error(SERVERS_USAGE);
  const id = args.shift();
  if (!id || id.startsWith("--")) throw new Error(SERVERS_USAGE);
  const input: Record<string, unknown> = { action, purpose: "review" };
  while (args.length) {
    const flag = args.shift(), value = args.shift();
    if (!value || !["--member", "--purpose", "--request"].includes(flag ?? "")) throw new Error(SERVERS_USAGE);
    input[String(flag).slice(2)] = value;
  }
  return request("POST", `/${enc(id)}/action`, ServerAction.parse(input));
}
