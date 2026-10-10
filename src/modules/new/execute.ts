import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Ctx } from "../../core/context.ts";
import { commitPaths, commitFiles } from "../../core/gitstore.ts";
import { loadConfig } from "../../core/config.ts";
import { paths } from "../../shared/paths.ts";
import { mapAction, type MapRequest } from "../../shared/map-actions.ts";
import { bindArgs } from "../../shared/new-plan.ts";
import type { NewAction, UiAction } from "../../shared/freeform.ts";
import type { IntentsApi } from "../live/intents.ts";

export type FileChange = { file: string; before: string | null; after: string | null };
export type Effect = { files: FileChange[]; inverse: MapRequest | null; ui: UiAction | null; message: string; result: unknown; limit: string | null };
const enc = encodeURIComponent;
// Agent parity is limited to existing UI owners. No arbitrary HTTP, lifecycle or guard bypass.
const apiOwners = [
  /^(POST|PUT|DELETE) \/api\/(missions|lenses|notes|artifacts)(?:\/[^?]*)?$/,
  /^POST \/api\/(ideas\/(place|undo)|evidence(?:\/verdict\/[^/]+)?|sessions\/reindex)$/,
  /^POST \/api\/nudges\/(feedback|briefs\/[^/]+\/refresh|undo-toasts\/[^/]+\/undo|[^/]+\/act)$/,
  /^POST \/api\/system\/(install|setup\/(ack|seen|gh-login(?:\/(answer|focus))?)|firstmate-files\/[^/]+\/open|notify-test)$/,
  /^PUT \/api\/system\/config$/,
  /^POST \/api\/workers\/[^/]+\/input$/,
  /^DELETE \/api\/guard\/rules\/[^/]+$/,
  /^POST \/api\/uploads$/,
];
export function apiRequest(a: Extract<NewAction, { kind: "api" }>, agentJob: boolean): MapRequest {
  if (!apiOwners.some((pattern) => pattern.test(`${a.method} ${a.path}`)) || /%2f|%5c|\.\.|[\r\n]/i.test(a.path)) throw new Error("This is not an existing UI owner action. Use a map action, intent or supported resource.");
  if (agentJob && (/^\/api\/workers\//.test(a.path) || /^\/api\/system\/(install|setup\/gh-login)/.test(a.path))) throw new Error("Terminal input, installation and login require an explicit captain submission. The job may explain the next step in a note.");
  return { method: a.method, path: a.path, body: a.body };
}
export function resourceRequest(a: Extract<NewAction, { kind: "resource" }>): MapRequest {
  const body = a.payload, id = enc(a.target);
  switch (a.action) {
    case "new-idea": return { method: "POST", path: "/api/missions", body };
    case "edit-idea": return { method: "PUT", path: `/api/missions/${id}`, body };
    case "state-idea": return { method: "PUT", path: `/api/missions/${id}/state`, body };
    case "accept-proposal": return { method: "POST", path: `/api/missions/proposals/${id}/accept`, body };
    case "reject-proposal": return { method: "POST", path: `/api/missions/proposals/${id}/reject`, body };
    case "reopen-proposal": return { method: "POST", path: `/api/missions/proposals/${id}/reopen`, body };
    case "backfill": return { method: "POST", path: "/api/missions/backfill", body };
    case "ack": return { method: "POST", path: `/api/attention/${id}/label`, body: { label: "ack", ...body } };
    case "undo-ack": return { method: "POST", path: `/api/attention/${id}/undo-ack`, body };
    case "snooze": return { method: "POST", path: `/api/attention/${id}/snooze`, body };
    case "hand-back": case "exclude": case "include": return { method: "POST", path: `/api/fleet/${a.action}`, body: { ...body, worker: a.target } };
    case "prune": return { method: "POST", path: "/api/fleet/propose-prune", body: { ...body, worker: a.target } };
    case "register-artifact": return { method: "POST", path: "/api/artifacts", body };
    case "edit-artifact": return { method: "PUT", path: `/api/artifacts/${id}`, body };
    case "scan-artifacts": return { method: "POST", path: "/api/artifacts/scan", body };
    case "settings": return { method: "PUT", path: "/api/system/config", body };
    case "open-preferences": return { method: "POST", path: `/api/system/firstmate-files/${id}/open`, body };
    case "notify-test": return { method: "POST", path: "/api/system/notify-test", body };
    case "dismiss-request": return { method: "POST", path: `/api/firstmate/requests/${id}/dismiss`, body };
    case "nudge-request": return { method: "POST", path: `/api/firstmate/requests/${id}/nudge`, body };
    default: { const exhaustive: never = a.action; throw new Error(`Unknown action ${exhaustive}`); }
  }
}

function snapshot(): Map<string, string> {
  const entries = new Map<string, string>();
  for (const dir of ["missions", "lenses", "notes", "artifacts", "map"]) {
    const base = path.join(paths.root, dir);
    if (!fs.existsSync(base)) continue;
    for (const f of fs.readdirSync(base)) if (/\.(md|ya?ml)$/.test(f) && fs.statSync(path.join(base, f)).isFile()) entries.set(`${dir}/${f}`, fs.readFileSync(path.join(base, f), "utf8"));
  }
  for (const f of ["workspace.yaml", "joyride.config.yaml", "fleet.yaml", "guard.yaml"]) if (fs.existsSync(path.join(paths.root, f))) entries.set(f, fs.readFileSync(path.join(paths.root, f), "utf8"));
  return entries;
}
const getFile = (file: string) => fs.existsSync(path.join(paths.root, file)) ? fs.readFileSync(path.join(paths.root, file), "utf8") : null;
export async function call(ctx: Ctx, req: MapRequest): Promise<unknown> {
  const r = await ctx.app.request(req.path, { method: req.method, headers: { "content-type": "application/json" }, ...(req.body ? { body: JSON.stringify(req.body) } : {}) });
  const result: unknown = await r.json();
  const failure = z.object({ error: z.string() }).safeParse(result);
  if (!r.ok || failure.success) throw new Error(failure.success ? failure.data.error : `Action failed (${r.status}).`);
  const intent = z.object({ status: z.literal("failed"), error: z.string().nullable() }).safeParse(result);
  if (intent.success) throw new Error(intent.data.error ?? "The owner could not complete this action.");
  return result;
}

/** Every New mutation runs through the existing owner. No endpoint is silently treated as successful. */
export async function execute(ctx: Ctx, a: NewAction, earlier: ({ lens?: string | null } | null)[], agentJob = false): Promise<Effect> {
  if (a.kind === "ui") return { files: [], inverse: null, ui: a.command, message: "Changed the view.", result: null, limit: null };
  if (agentJob && a.kind === "intent" && ["approve", "deny", "answer_prompt", "answer_ask", "retire_worker"].includes(a.intent)) throw new Error("This action requires a captain submission. The job cannot answer permissions or decisions for you.");
  const before = snapshot();
  const attention = a.kind === "resource" && ["ack", "undo-ack", "snooze"].includes(a.action) ? z.object({ resolution: z.string().nullable(), snoozed_until: z.string().nullable() }).parse(await call(ctx, { method: "GET", path: `/api/attention/${enc(a.target)}` })) : null;
  let result: unknown;
  let inverse: MapRequest | null = null;
  if (a.kind === "intent") {
    const intents = ctx.service<IntentsApi>("intents");
    const r = await intents.create(a.intent, a.target, a.payload, { origin: agentJob ? "firstmate" : "captain" });
    if (r.status === "failed" || r.status === "pending") throw new Error(r.error ?? "The owner has not confirmed this action.");
    result = r;
  } else {
    const req = a.kind === "map" ? mapAction(a.action).prepare(bindArgs(a.args, earlier)) : a.kind === "api" ? apiRequest(a, agentJob) : resourceRequest(a);
    if (a.kind === "map" && a.actor) req.body = { ...z.record(z.string(), z.unknown()).parse(req.body ?? {}), actor: a.actor };
    if (a.kind === "resource" && a.action === "settings") {
      // The settings owner merges top-level keys. Preserve nested settings for text-sized edits.
      const current = z.object({ config: z.record(z.string(), z.unknown()) }).parse(await call(ctx, { method: "GET", path: "/api/system/config" })).config;
      const merge = (base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> => Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(patch)])].map((k) => {
        const prior = z.record(z.string(), z.unknown()).safeParse(base[k]), next = z.record(z.string(), z.unknown()).safeParse(patch[k]);
        return [k, k in patch ? prior.success && next.success ? merge(prior.data, next.data) : patch[k] : base[k]];
      }));
      req.body = merge(current, a.payload);
    }
    result = await call(ctx, req);
    const committed = z.object({ commit: z.string().nullable().optional() }).safeParse(result);
    if ((a.kind === "map" && a.action !== "undo" || /^\/api\/(?:lenses\/(?:create|rename|merge|delete)|missions\/(?:move|map\/layout))$/.test(req.path)) && committed.success && committed.data.commit) inverse = { method: "POST", path: "/api/missions/move/undo", body: { commit: committed.data.commit } };
    if (/^\/api\/missions\/(?:hide|unhide)$/.test(req.path)) inverse = { method: "POST", path: req.path.endsWith("/hide") ? "/api/missions/unhide" : "/api/missions/hide", body: req.body };
    if (a.kind === "resource" && a.action === "ack" && attention?.resolution !== "acknowledged") inverse = { method: "POST", path: `/api/attention/${enc(a.target)}/undo-ack`, body: {} };
    if (a.kind === "resource" && a.action === "undo-ack" && attention?.resolution === "acknowledged") inverse = { method: "POST", path: `/api/attention/${enc(a.target)}/label`, body: { label: "ack" } };
    if (a.kind === "resource" && a.action === "snooze") inverse = { method: "POST", path: `/api/attention/${enc(a.target)}/snooze`, body: { until: attention?.snoozed_until ?? new Date(0).toISOString() } };
    const proposal = /^\/api\/missions\/proposals\/([^/]+)\/(?:accept|reject)$/.exec(req.path);
    if (proposal) inverse = { method: "POST", path: `/api/missions/proposals/${proposal[1]}/reopen`, body: { restore: false } };
    if (a.kind === "resource" && (a.action === "exclude" || a.action === "include")) inverse = { method: "POST", path: `/api/fleet/${a.action === "exclude" ? "include" : "exclude"}`, body: { worker: a.target } };
  }
  const after = snapshot();
  const responseCommit = z.object({ commit: z.string().nullable().optional() }).safeParse(result);
  const response = z.object({ id: z.string().optional(), result: z.object({ mission: z.string().optional(), note: z.string().nullable().optional() }).passthrough().optional() }).passthrough().safeParse(result);
  const owned = new Set<string>();
  if (response.success && response.data.id) {
    if (a.kind === "map" && ["note", "list", "link", "edit-note", "edit-list", "archive-note", "restore-note", "move-note"].includes(a.action)) owned.add(`notes/${response.data.id}.md`);
    if (a.kind === "resource" && /idea$/.test(a.action)) owned.add(`missions/${response.data.id}.md`);
    if (a.kind === "resource" && ["register-artifact", "edit-artifact"].includes(a.action)) owned.add(`artifacts/${response.data.id}.md`);
    if (a.kind === "api") {
      const domain = /^\/api\/(missions|lenses|notes|artifacts)(?:\/[^/]+(?:\/(?:archive|restore|state|sessions))?)?$/.exec(a.path)?.[1];
      if (domain) owned.add(`${domain}/${response.data.id}.${domain === "lenses" ? "yaml" : "md"}`);
    }
  }
  if (a.kind === "intent") {
    if (response.success && response.data.result?.mission) owned.add(`missions/${response.data.result.mission}.md`);
    if (response.success && response.data.result?.note) owned.add(`notes/${response.data.result.note}.md`);
    const here = z.object({ kind: z.enum(["idea", "group"]), id: z.string() }).safeParse(a.payload.here);
    if (here.success) owned.add(`${here.data.kind === "idea" ? "missions" : "lenses"}/${here.data.id}.${here.data.kind === "idea" ? "md" : "yaml"}`);
    if (a.intent === "tell_note") owned.add(`notes/${a.target}.md`);
    if (["exclude_session", "include_session"].includes(a.intent)) owned.add("fleet.yaml");
  }
  const touched = responseCommit.success && responseCommit.data.commit ? new Set(commitFiles(responseCommit.data.commit)) : a.kind === "intent" || owned.size ? owned : null;
  const files = [...new Set([...before.keys(), ...after.keys()])].filter((file) => !touched || touched.has(file)).flatMap((file): FileChange[] => before.get(file) === after.get(file) ? [] : [{ file, before: before.get(file) ?? null, after: after.get(file) ?? null }]);
  const out = z.object({ message: z.string().optional() }).passthrough().safeParse(result);
  const limit = a.kind === "intent" ? "Delivered messages, answers and started processes cannot be undone. Undo restores only their canvas changes." : files.length || inverse ? null : "This action has no reversible canvas change.";
  return { files, inverse, ui: null, result, message: out.success ? out.data.message ?? "Applied." : "Applied.", limit };
}

/** Check the complete chain before restoring anything, so conflict means no partial Undo. */
export function checkUndo(effects: Effect[]) {
  const expected = new Map<string, string | null>();
  for (const e of effects) for (const change of e.files) expected.set(change.file, change.after);
  for (const [file, value] of expected) if (getFile(file) !== value) throw new Error(`${file} changed after this request. Undo would overwrite later work; nothing was restored.`);
}
export async function undoEffects(ctx: Ctx, effects: Effect[]) {
  checkUndo(effects);
  for (const effect of [...effects].reverse()) {
    if (effect.inverse) await call(ctx, effect.inverse);
    for (const f of effect.files) {
      const abs = path.join(paths.root, f.file);
      if (f.before === null) fs.rmSync(abs, { force: true });
      else { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, f.before); }
    }
    if (effect.files.length) commitPaths(effect.files.map((f) => f.file), "new: undo canvas action");
  }
  if (effects.some((e) => e.files.some((f) => f.file === "joyride.config.yaml"))) Object.assign(ctx.config, loadConfig(true));
  for (const entity of ["missions", "lenses", "notes", "artifacts", "fleet", "system", "new"]) ctx.bus.change({ entity });
}
