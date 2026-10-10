import { z } from "zod";
import { NewAction } from "./freeform.ts";

/** Agent jobs may use the normal CLI; mutations still belong to their recorded request. */
export function jobRequest(method: string, path: string, body: unknown, job: string | null = process.env.JOYRIDE_NEW_JOB ?? null) {
  const root = job ? `/api/new/jobs/${encodeURIComponent(job)}` : null;
  if (!root || method === "GET" || path === `${root}/actions` || path === `${root}/complete`) return { method, path, body };
  const input = z.record(z.string(), z.unknown()).parse(body ?? {});
  const action = path === "/api/intents" ? NewAction.parse({ ...input, kind: "intent", intent: input.kind }) : NewAction.parse({ kind: "api", method, path, body: input });
  return { method: "POST", path: `${root}/actions`, body: { request: crypto.randomUUID(), action } };
}
