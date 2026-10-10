import { z } from "zod";

export const ServerId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const ServerPurpose = z.enum(["review", "test"]);
const LocalUrl = z.string().url().refine((s) => {
  const u = new URL(s);
  return ["http:", "https:"].includes(u.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) && u.port !== "3000";
}, "Use a local http or https review URL, away from port 3000.");
export const ServerMember = z.object({
  id: ServerId, name: z.string().trim().min(1).max(100), command: z.string().trim().min(1).max(8000),
  cwd: z.string().startsWith("/"), ports: z.array(z.number().int().min(1024).max(65535).refine((n) => n !== 3000)).default([]),
  url: LocalUrl.optional(),
}).strict();
export const ServerDefinition = z.object({
  id: ServerId, name: z.string().trim().min(1).max(100), purpose: ServerPurpose.default("review"),
  project: z.string().trim().min(1).max(300), change: z.string().trim().min(1).max(500), branch: z.string().max(300).default(""),
  creator: z.string().max(300).default(""), url: LocalUrl.optional(), canvas: z.boolean().default(true),
  members: z.array(ServerMember).min(1).max(12),
}).strict().superRefine((g, ctx) => {
  if (new Set(g.members.map((m) => m.id)).size !== g.members.length) ctx.addIssue({ code: "custom", message: "Member ids must be unique." });
  const ports = g.members.flatMap((m) => m.ports);
  if (new Set(ports).size !== ports.length) ctx.addIssue({ code: "custom", message: "Members must use different ports." });
});
export type ServerDefinition = z.infer<typeof ServerDefinition>;
export type ServerMember = z.infer<typeof ServerMember>;
export const ServerAction = z.object({
  action: z.enum(["start", "stop", "restart", "update"]), purpose: ServerPurpose,
  member: ServerId.optional(), request: z.string().min(1).max(100).optional(),
}).strict();
export type ServerAction = z.infer<typeof ServerAction>;
export const ServerRun = z.object({
  nonce: z.string().uuid(), machine: z.string(), socket: z.string(),
  phase: z.enum(["prepared", "launched", "stopped"]), pane: z.string().nullable(), terminal: z.string().nullable(),
  workspace: z.string().nullable(), member: ServerMember, change: z.string(), branch: z.string(),
  url: LocalUrl.optional(), request: z.string().nullable().default(null),
  error: z.string().nullable(),
});
export type ServerRun = z.infer<typeof ServerRun>;
export const ServerReceipt = z.object({
  nonce: z.string().uuid(), pid: z.number().int().positive(), state: z.enum(["running", "exited"]),
  exit: z.number().int().nullable(), at: z.string(),
});
export type ServerState = "running" | "starting" | "stopped" | "failed" | "unknown";
export type ServerMemberView = ServerMember & {
  state: ServerState; reason: string | null; run: ServerRun | null; pending: boolean;
};
export type ServerGroupView = ServerDefinition & { instances: ServerMemberView[]; state: ServerState | "partial"; pending: boolean };
