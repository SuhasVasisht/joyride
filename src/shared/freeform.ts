import { z } from "zod";
import { IntentKind, LlmBackend } from "./schema.ts";
import { MapActor } from "./map-actions.ts";

export const ScreenElement = z.object({
  kind: z.enum(["idea", "group", "project", "session", "worker", "task", "note", "artifact", "ask", "attention"]),
  id: z.string().min(1).max(500), title: z.string().max(500), scope: z.string().optional(), detail: z.string().max(2000).optional(),
});
export type ScreenElement = z.infer<typeof ScreenElement>;
export const ScreenContext = z.object({
  route: z.string().max(2000),
  view: z.object({ s: z.number(), tx: z.number(), ty: z.number() }).nullable(),
  place: z.union([z.object({ kind: z.enum(["idea", "group"]), id: z.string(), title: z.string() }), z.object({ kind: z.literal("unfiled") })]).nullable(),
  focused: ScreenElement.nullable(), hovered: ScreenElement.nullable(), selected: ScreenElement.nullable(),
  visible: z.array(ScreenElement).max(500),
});
export type ScreenContext = z.infer<typeof ScreenContext>;
export const SessionPlacement = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("new"), title: z.string().trim().min(1).max(120) }),
  z.object({ kind: z.literal("group"), id: z.string().min(1), title: z.string() }),
]);
export type SessionPlacement = z.infer<typeof SessionPlacement>;
export const StandaloneChoice = z.object({ cwd: z.string().min(1), placement: SessionPlacement, model: LlmBackend }).strict();
export type StandaloneChoice = z.infer<typeof StandaloneChoice>;
export type StandaloneOffer = { repos: string[]; groups: { id: string; title: string }[]; cwd: string | null; placement: SessionPlacement | null; model: z.infer<typeof LlmBackend>; reason: string };
export const NewSubmission = z.object({ request: z.string().min(1).max(100), text: z.string().trim().min(1).max(20000), context: ScreenContext, standalone: StandaloneChoice.optional() }).strict();

export const UiAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("navigate"), path: z.string().regex(/^[a-z][^\r\n]*$/).max(2000) }),
  z.object({ action: z.literal("zoom"), level: z.enum(["far", "mid", "near", "fit"]) }),
  z.object({ action: z.literal("archive"), show: z.boolean() }),
  z.object({ action: z.literal("rail"), show: z.boolean() }),
  z.object({ action: z.literal("reveal"), kind: z.enum(["idea", "region", "task", "item", "hub"]), id: z.string().optional() }),
  z.object({ action: z.literal("tab"), tab: z.enum(["chat", "terminal", "context"]) }),
  z.object({ action: z.literal("view"), s: z.number().positive().max(10), tx: z.number().finite(), ty: z.number().finite() }),
  z.object({ action: z.literal("palette"), show: z.boolean() }),
  z.object({ action: z.literal("attention") }),
]);
export type UiAction = z.infer<typeof UiAction>;
export const Resource = z.enum(["new-idea", "edit-idea", "state-idea", "accept-proposal", "reject-proposal", "reopen-proposal", "backfill", "ack", "undo-ack", "snooze", "hand-back", "exclude", "include", "prune", "register-artifact", "edit-artifact", "scan-artifacts", "settings", "open-preferences", "notify-test", "dismiss-request", "nudge-request"]);
export const NewAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("map"), action: z.string(), args: z.record(z.string(), z.unknown()), actor: MapActor.optional() }),
  z.object({ kind: z.literal("intent"), intent: IntentKind, target: z.string(), payload: z.record(z.string(), z.unknown()) }),
  z.object({ kind: z.literal("resource"), action: Resource, target: z.string(), payload: z.record(z.string(), z.unknown()) }),
  z.object({ kind: z.literal("ui"), command: UiAction }),
  z.object({ kind: z.literal("api"), method: z.enum(["POST", "PUT", "PATCH", "DELETE"]), path: z.string().max(2000), body: z.record(z.string(), z.unknown()) }),
]);
export type NewAction = z.infer<typeof NewAction>;
export const AnimationKind = z.enum(["note", "list", "link", "move", "group", "idea", "view", "reply", "attention", "settings", "firstmate", "agent"]);
export type AnimationKind = z.infer<typeof AnimationKind>;
export type NewCandidate = { route: "deterministic"; actions: NewAction[]; animation: AnimationKind; summary: string }
  | { route: "firstmate"; brief: string; idea: string | null; title: string; summary: string }
  | { route: "standalone"; summary: string }
  | { route: "agent"; reason: string };
export type NewReceipt = {
  id: string; route: NewCandidate["route"]; animation: AnimationKind;
  state: "choose" | "running" | "done" | "failed" | "undone"; message: string;
  confidence: number | null; classifier: string; undo: boolean; undoLimit: string | null;
  request: string | null; session: string | null; worker: string | null;
  ui: UiAction[]; landing: ScreenElement | null;
  standalone?: StandaloneOffer;
  launch?: { model: string; backend: string; account: string; cwd: string; warning?: string };
};
