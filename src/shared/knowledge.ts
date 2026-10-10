import { z } from "zod";
import { Artifact } from "./schema.ts";

export const KnowledgeEntity = z.enum(["idea", "task", "artifact", "session", "note"]);
export const KnowledgeRef = z.object({ entity: KnowledgeEntity, id: z.string().min(1) });
export type KnowledgeRef = z.infer<typeof KnowledgeRef>;
export const KnowledgeAnchor = z.object({
  kind: z.enum(["idea", "task", "session", "repo", "group"]),
  id: z.string().min(1), title: z.string(), direct: z.boolean(),
});
export type KnowledgeAnchor = z.infer<typeof KnowledgeAnchor>;
export const KnowledgeType = z.enum(["ideas", "tasks", "notes", "reports", "pages", "prs", "chats", "files", "sessions", "other"]);
export type KnowledgeType = z.infer<typeof KnowledgeType>;
export const KnowledgeItem = z.object({
  key: z.string(), ref: KnowledgeRef, type: KnowledgeType,
  kind: z.union([z.enum(["idea", "task", "note"]), Artifact.shape.kind]), title: z.string(), summary: z.string(),
  state: z.string(), created: z.string(), updated: z.string(),
  anchors: z.array(KnowledgeAnchor), score: z.number(),
  review: z.array(z.string()), delivery: z.array(z.string()),
  href: z.string(), url: z.string().nullable(),
});
export type KnowledgeItem = z.infer<typeof KnowledgeItem>;
export const KnowledgeMode = z.enum(["all"]);
export const KnowledgeQuery = z.object({
  q: z.string().max(2000).default(""), types: z.array(KnowledgeType).default([]),
  anchor: z.string().regex(/^(idea|mission|task|session|repo|group):.+$/, "Use an anchor such as idea:control-plane or session:claude:<id>.").optional(),
  state: z.enum(["all", "active", "registered", "archived", "open", "paused", "done", "dropped"]).default("all"),
  mode: KnowledgeMode.default("all"), limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
  idea: z.string().max(2000).default(""), task: z.string().max(2000).default(""),
  session: z.string().max(2000).default(""), project: z.string().max(2000).default(""),
});
export type KnowledgeQuery = z.infer<typeof KnowledgeQuery>;
export type KnowledgeSearch = {
  items: KnowledgeItem[]; total: number; mode: KnowledgeQuery["mode"]; notices: string[];
  offset: number;
  facets: {
    types: Partial<Record<KnowledgeType, number>>;
    anchors: Record<"idea" | "task" | "session", { id: string; title: string; n: number }[]>;
    projects: { id: string; title: string; n: number }[];
  };
};
export type KnowledgeRelation = {
  kind: "derived-from" | "supersedes" | "anchored-to" | "answered-by";
  from: KnowledgeRef; to: KnowledgeRef | { entity: KnowledgeAnchor["kind"]; id: string };
};
export type KnowledgeRelations = { item: KnowledgeItem; items: KnowledgeItem[]; relations: KnowledgeRelation[]; notices: string[] };
