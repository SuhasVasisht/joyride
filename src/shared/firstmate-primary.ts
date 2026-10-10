import { z } from "zod";

const PrimaryInfoSchema = z.object({ account: z.string(), label: z.string(), harness: z.enum(["claude", "codex", "cursor"]), model: z.string().nullable() });
export type PrimaryInfo = z.infer<typeof PrimaryInfoSchema>;
export const isPrimaryIdle = (status: string | undefined): boolean => status === "idle" || status === "done";
export const PrimaryStateSchema = z.object({
  current: PrimaryInfoSchema.nullable(),
  phase: z.enum(["ready", "handoff", "stopping", "starting", "failed"]),
  lastSwitch: z.object({ id: z.string(), from: z.string(), to: z.string(), reason: z.string(), at: z.string(), note: z.string().nullable(), attempts: z.number().int().nonnegative().optional(), retryAt: z.number().nullable().optional() }).nullable(),
  error: z.string().nullable(),
});
export type PrimaryState = z.infer<typeof PrimaryStateSchema>;
export type PrimaryStatus = PrimaryState & {
  choices: (PrimaryInfo & { available: boolean })[];
  returnToClaude: string | null;
};
