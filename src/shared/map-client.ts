import { z } from "zod";
import { DAEMON_URL } from "./paths.ts";
import { mapAction, MapActor } from "./map-actions.ts";

const Arguments = z.record(z.string(), z.unknown());
const ErrorBody = z.object({ error: z.string() });
export function mapActor(via: MapActor["via"], explicit?: unknown, env: NodeJS.ProcessEnv = process.env): MapActor {
  return MapActor.parse({ kind: "agent", via, id: explicit ?? [env.FM_TASK_ID, env.CLAUDE_SESSION_ID, env.CODEX_THREAD_ID, env.CODEX_SESSION_ID].find(id => id?.trim()) ?? via });
}
export async function callMap(name: string, args: unknown, actor: MapActor, base = DAEMON_URL, job: string | null = process.env.JOYRIDE_NEW_JOB ?? null): Promise<unknown> {
  const entry = mapAction(name);
  const input = Arguments.parse(args);
  const request = entry.prepare(input);
  const by = MapActor.parse(actor);
  const owned = job && request.method !== "GET" ? { method: "POST", path: `/api/new/jobs/${encodeURIComponent(job)}/actions`, body: { request: crypto.randomUUID(), action: { kind: "map", action: name, args: input, actor: by } } }
    : { ...request, body: request.method === "GET" ? undefined : { ...Arguments.parse(request.body), actor: by } };
  let response: Response;
  try {
    response = await fetch(base + owned.path, {
      method: owned.method, headers: { "content-type": "application/json" },
      body: owned.body === undefined ? undefined : JSON.stringify(owned.body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error(`Joyride is unreachable at ${base}. Check the daemon connection, then read map show or history before retrying the edit.`);
  }
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = ErrorBody.safeParse(body);
    throw new Error(error.success ? error.data.error : `Joyride answered HTTP ${response.status}.`);
  }
  return body;
}
