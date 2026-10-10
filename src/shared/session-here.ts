import { z } from "zod";

export const SessionHere = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("idea"), id: z.string().min(1) }),
  z.object({ kind: z.literal("group"), id: z.string().min(1) }),
  z.object({ kind: z.literal("project"), title: z.string().min(1), cwd: z.string().optional() }),
]);
export type SessionHere = z.infer<typeof SessionHere>;
