import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { defineModule, type Ctx } from "../../core/context.ts";
import { kvGet, kvSet } from "../../core/db.ts";
import { classifyNew } from "./classify.ts";
import { paths } from "../../shared/paths.ts";
import { NewAction, NewSubmission, type NewReceipt, type ScreenContext } from "../../shared/freeform.ts";
import { placeContext } from "../../shared/freeform-plan.ts";
import { readWorld } from "./world.ts";
import { execute, undoEffects, type Effect } from "./execute.ts";
import type { WorkersApi } from "../live/workers.ts";
import { newModelAccount, newModelArgs, newModelCatalog } from "../../core/new-models.ts";
import { readAccounts } from "../../core/accounts.ts";
import { standaloneOffer } from "../../shared/standalone-plan.ts";
import { newJudge } from "./judge.ts";

type Record = { receipt: NewReceipt; text: string; context: ScreenContext; effects: Effect[]; fingerprint: string; job: boolean; jobNote: string | null; started?: number };
const result = z.object({ id: z.string().optional(), scope: z.string().optional(), lens: z.string().nullable().optional(), result: z.object({ worker: z.string().optional(), session: z.string().optional(), warning: z.string().optional(), cwd: z.string().optional(), mission: z.string().optional(), mission_title: z.string().optional() }).passthrough().optional() }).passthrough();
const err = (e: unknown) => e instanceof Error ? e.message : String(e);
const enc = encodeURIComponent;

export default defineModule({
  name: "new", order: 99,
  register(ctx: Ctx) {
    // Submission retries share one promise and durable receipt. Mutations are serialized within New.
    const running = new Map<string, { fingerprint: string; work: Promise<NewReceipt> }>();
    let tail = Promise.resolve();
    const serial = <T,>(fn: () => Promise<T>): Promise<T> => {
      const work = tail.then(fn, fn);
      tail = work.then(() => {}, () => {});
      return work;
    };
    const get = (id: string) => kvGet<Record | null>(ctx.db, `new:receipt:${id}`, null);
    const save = (r: Record) => { kvSet(ctx.db, `new:receipt:${r.receipt.id}`, r); ctx.bus.change({ entity: "new", id: r.receipt.id }); };
    const addEffect = (r: Record, effect: Effect) => {
      r.effects.push(effect);
      if (effect.ui) r.receipt.ui.push(effect.ui);
      r.receipt.undo = r.effects.some((e) => e.files.length || e.inverse || e.ui);
      if (effect.limit) r.receipt.undoLimit = effect.limit;
      const parsed = result.safeParse(effect.result);
      if (parsed.success) {
        const p = parsed.data;
        if (p.result?.worker && (!r.job || !r.receipt.worker)) r.receipt.worker = p.result.worker;
        if (p.result?.session && (!r.job || !r.receipt.session)) r.receipt.session = p.result.session;
        if (p.result?.mission) r.receipt.landing = { kind: "idea", id: p.result.mission, title: p.result.mission_title ?? p.result.mission };
        if (p.id && r.receipt.animation === "firstmate") r.receipt.request = p.id;
        if (p.id && effect.files.some((f) => f.file.startsWith("notes/"))) r.receipt.landing = { kind: "note", id: p.id, title: r.receipt.message, scope: p.scope };
      }
      save(r);
    };
    const jobAction = (r: Record, a: NewAction): NewAction => {
      const actor = { kind: "agent", via: "cli", id: r.receipt.session ?? r.receipt.worker ?? "new" } as const;
      return a.kind === "map" ? { ...a, actor: a.actor ?? actor } : a.kind === "api" && /^\/api\/notes(?:\/|$)/.test(a.path) ? { ...a, body: { ...a.body, actor } } : a;
    };

    async function apply(r: Record, actions: NewAction[], job = false) {
      const prior: ({ lens?: string | null } | null)[] = [];
      for (const a of actions) {
        const e = await execute(ctx, job ? jobAction(r, a) : a, prior, job);
        addEffect(r, e);
        if (a.kind === "resource" && ["new-idea", "edit-idea", "state-idea"].includes(a.action)) {
          const parsed = result.safeParse(e.result);
          const id = parsed.success ? parsed.data.id ?? a.target : a.target;
          if (id) r.receipt.landing = { kind: "idea", id, title: id };
        }
        if (a.kind === "map") {
          const parsed = result.safeParse(e.result);
          const id = a.args.idea ?? a.args.note ?? a.args.group ?? (parsed.success ? parsed.data.lens : null);
          if (typeof id === "string") r.receipt.landing = { kind: a.args.idea ? "idea" : a.args.note ? "note" : "group", id, title: id, scope: parsed.success ? parsed.data.scope : undefined };
        }
        save(r);
        const parsed = result.safeParse(e.result);
        prior.push(parsed.success ? { lens: parsed.data.lens } : null);
      }
    }

    const classify = async (text: string, context: ScreenContext) => classifyNew(text, context, await readWorld(ctx), newJudge(ctx.config));
    function launchModel(choice: typeof ctx.config.new_models.standalone) {
      const account = newModelAccount(choice, ctx.config);
      return { agent: choice.backend, account: account.id, args: newModelArgs(choice, ctx.config.workers.permission_mode),
        permission_mode: ctx.config.workers.permission_mode === "auto" && choice.backend === "claude" && /haiku/.test(choice.model) ? "acceptEdits" : ctx.config.workers.permission_mode,
        env: { JOYRIDE_URL: `http://127.0.0.1:${ctx.config.port}`, JOYRIDE_HOME: paths.root, JOYRIDE_RUNTIME: paths.runtime, FM_HOME: paths.firstmateHome, FM_TASK_ID: "", JOYRIDE_NEW_JOB: "", PATH: `${paths.code}/bin:${process.env.PATH ?? ""}`, [choice.backend === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"]: account.home ?? (choice.backend === "codex" ? paths.codexDir : paths.claudeDir) } };
    }

    async function launchStandalone(r: Record, input: z.infer<typeof NewSubmission>) {
      const offer = standaloneOffer(r.text, r.context, await readWorld(ctx), ctx.config.new_models.standalone);
      const chosen = input.standalone ?? (offer.cwd && offer.placement ? { cwd: offer.cwd, placement: offer.placement, model: offer.model } : null);
      if (!chosen) { r.receipt.standalone = offer; r.receipt.state = "choose"; r.receipt.message = offer.reason; save(r); return; }
      if (!path.isAbsolute(chosen.cwd) || !fs.statSync(chosen.cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Repo folder "${chosen.cwd}" does not exist. Choose an existing absolute folder.`);
      const model = launchModel(chosen.model);
      let group = chosen.placement;
      if (group.kind === "new") {
        const effect = await execute(ctx, { kind: "map", action: "new-empty-group", args: { title: group.title } }, []);
        addEffect(r, effect);
        const created = z.object({ lens: z.string() }).parse(effect.result);
        group = { kind: "group", id: created.lens, title: group.title };
      }
      r.receipt.landing = { kind: "group", id: group.id, title: group.title };
      r.receipt.launch = { model: chosen.model.model, backend: chosen.model.backend, account: model.account, cwd: chosen.cwd };
      save(r);
      await apply(r, [{ kind: "intent", intent: "launch_session", target: chosen.cwd, payload: { ...model, cwd: chosen.cwd, here: { kind: "group", id: group.id }, personal: true, prompt: `This is the user's standalone repo session. Work directly with the user and keep this session open for follow-up.\n\nOriginal request:\n${r.text}`, autoTrust: true } }]);
      const launchResult = result.safeParse(r.effects.at(-1)?.result);
      const warning = launchResult.success ? launchResult.data.result?.warning : undefined;
      r.receipt.launch.warning = warning;
      r.receipt.state = "done";
      r.receipt.message = `Your session opened in ${group.title}. ${chosen.model.model} on ${model.account}.${warning ? ` ${warning}` : ""}`;
      save(r);
    }

    async function launchJob(r: Record, reason: string) {
      const choice = ctx.config.new_models.small_job;
      const model = launchModel(choice);
      const c = placeContext(r.context);
      const project = [r.context.selected, r.context.hovered, r.context.focused].find((e) => e?.kind === "project");
      const here = c.idea ? { kind: "idea", id: c.idea.id } : c.group ? { kind: "group", id: c.group.id } : { kind: "project", title: project?.title ?? "New job", cwd: project?.id ?? paths.root };
      const prompt = [
        "You are handling a small Joyride New-box job. Do the user's request and make the result visible on the canvas. Work on your own. Do not delegate or administer Firstmate, shared infrastructure or any other Herdr session.",
        `Request: ${r.text}`, `Routing reason: ${reason}`,
        `Screen context, captured at submission:\n${JSON.stringify(r.context, null, 2)}`,
        `Job id: ${r.receipt.id}`,
        "The joyride CLI is already on PATH and points to this job's daemon. Run it directly from the current project folder; changing into Joyride's code folder is unnecessary. Ordinary joyride map, notes and api mutations are automatically recorded under this job.",
        "Read joyride map show, joyride map board and joyride notes for context. Find artifacts through joyride api GET /api/artifacts or /api/knowledge/search?q=<words>.",
        "Every canvas mutation MUST use this recorded owner route so its outcome can be undone:",
        `joyride api POST /api/new/jobs/${r.receipt.id}/actions '{"request":"unique-step-id","action":{"kind":"map","action":"link","args":{"links":["artifact:<id>"],"scope":"${c.idea ? `mission:${c.idea.id}` : c.group ? `group:${c.group.id}` : "global"}"}}}'`,
        `Map actions and arguments are listed by joyride map --help. Read ${paths.code}/docs/API.md for the existing owners. The recorded route accepts kind resource with action new-idea/edit-idea/register-artifact/edit-artifact/settings, target and payload, kind intent with intent/target/payload, kind api with method/path/body for existing UI owners, or kind ui with command navigate/zoom/reveal/view. UI results return to the browser that submitted the job.`,
        "Do not directly edit authored map files or bypass the recorded route. Never approve permissions or answer held decisions. If the target is still ambiguous, save a note explaining the exact missing detail rather than guessing. External/security-sensitive actions retain the existing guard and need the captain's authorization.",
        `When finished, call joyride api POST /api/new/jobs/${r.receipt.id}/complete '{"message":"What happened, including the result's title or link"}'. If unable to finish, use the same route with {"error":"What failed and how to fix it"}.`,
      ].join("\n\n");
      await apply(r, [{ kind: "intent", intent: "launch_session", target: c.idea?.id ?? c.group?.id ?? paths.root, payload: {
        ...model, here, prompt, args: [...model.args, "--add-dir", paths.code, ...(choice.backend === "claude" ? ["--allowedTools", "Read,Bash(joyride:*),Bash(cd:*),WebSearch,WebFetch"] : [])], autoTrust: true,
        env: { ...model.env, JOYRIDE_NEW_JOB: r.receipt.id },
      } }]);
      if (!r.receipt.session || !r.receipt.worker) throw new Error("The agent started without a session identity. Open Agents to recover it.");
      const launched = result.safeParse(r.effects.at(-1)?.result);
      r.receipt.launch = { model: choice.model, backend: choice.backend, account: model.account, cwd: launched.success ? launched.data.result?.cwd ?? paths.root : paths.root };
      await apply(r, [{ kind: "map", action: "note", args: { text: `Working on: ${r.text}\nOpen the agent from the New receipt.`, title: "New agent job", scope: c.idea ? `mission:${c.idea.id}` : c.group ? `group:${c.group.id}` : "global" } }], true);
      r.jobNote = r.receipt.landing?.kind === "note" ? r.receipt.landing.id : null;
      r.receipt.message = `${choice.model} job started on ${model.account}. Its session and result are on the canvas.`;
      r.receipt.state = "running";
      save(r);
    }

    async function submit(input: z.infer<typeof NewSubmission>): Promise<NewReceipt> {
      const id = input.request;
      const fingerprint = JSON.stringify([input.text, input.context, input.standalone]);
      const old = get(id);
      if (old) {
        if (old.fingerprint !== fingerprint) throw new Error("This request id was used for different words. Submit with a new id.");
        return old.receipt;
      }
      const classified = await classify(input.text, input.context);
      const candidate = classified.candidate;
      const r: Record = { text: input.text, context: input.context, fingerprint, effects: [], job: candidate.route === "agent", jobNote: null, started: Date.now(), receipt: {
        id, route: candidate.route, animation: candidate.route === "deterministic" ? candidate.animation : candidate.route === "standalone" ? "agent" : candidate.route, state: "running",
        message: candidate.route === "agent" ? "Starting an agent job…" : candidate.summary,
        confidence: classified.confidence, classifier: classified.classifier, undo: false, undoLimit: null, request: null, session: null, worker: null, ui: [], landing: null,
      } };
      save(r);
      try {
        if (input.standalone && candidate.route !== "standalone") throw new Error("Session choices apply only to a standalone session request.");
        if (candidate.route === "standalone") await launchStandalone(r, input);
        else if (candidate.route === "agent") await launchJob(r, candidate.reason);
        else {
          await apply(r, candidate.route === "firstmate" ? [{ kind: "intent", intent: "create_task", target: candidate.idea ?? "new", payload: { brief: candidate.brief, title: candidate.title } }] : candidate.actions);
          r.receipt.state = "done";
          save(r);
        }
      } catch (e) { r.receipt.state = "failed"; r.receipt.message = `${err(e)}${r.effects.length ? " Completed canvas changes can still be undone." : ""}`; save(r); }
      return r.receipt;
    }

    ctx.services.set("new", { classify });
    ctx.app.get("/api/new/models", c => c.json(readAccounts().filter(a => a.provider === "codex" || a.provider === "claude").map(a => ({ id: a.id, label: a.label, provider: a.provider, ...newModelCatalog(a) }))));
    ctx.app.post("/api/new", async (c) => {
      try {
        const input = NewSubmission.parse(await c.req.json());
        const existing = running.get(input.request);
        if (existing) {
          if (existing.fingerprint !== JSON.stringify([input.text, input.context, input.standalone])) throw new Error("This request id was used for different words. Submit with a new id.");
          return c.json(await existing.work);
        }
        const work = serial(() => submit(input));
        running.set(input.request, { fingerprint: JSON.stringify([input.text, input.context, input.standalone]), work });
        try { return c.json(await work); } finally { running.delete(input.request); }
      } catch (e) { return c.json({ error: err(e) }, 400); }
    });
    async function finish(r: Record, message: string, failed: boolean) {
      const landing = r.receipt.landing;
      if (r.jobNote) await apply(r, [{ kind: "map", action: "edit-note", args: { note: r.jobNote, text: `${message}\nOpen the agent from the New receipt.` } }], true);
      r.receipt.landing = landing;
      r.receipt.state = failed ? "failed" : "done"; r.receipt.message = message; save(r);
      return r.receipt;
    }
    ctx.app.get("/api/new/:id", async (c) => {
      const receipt = await serial(async () => {
        const r = get(c.req.param("id"));
        if (!r) return null;
        // Idle can mean waiting for a tool or captain. Only a confirmed terminal state is a failure.
        const worker = r.receipt.worker && ctx.services.has("workers") ? ctx.service<WorkersApi>("workers").get(r.receipt.worker) : null;
        if (r.job && r.receipt.state === "running" && Date.now() - (r.started ?? 0) > 3000 && worker && ["done", "exited"].includes(worker.status)) {
          await finish(r, "The agent ended before reporting its result. Open its session to inspect what happened. Recorded canvas changes can be undone.", true);
        }
        return r.receipt;
      });
      return receipt ? c.json(receipt) : c.json({ error: "This New request was not found." }, 404);
    });
    ctx.app.post("/api/new/:id/undo", async (c) => {
      try {
        return c.json(await serial(async () => {
          const r = get(c.req.param("id"));
          if (!r) throw new Error("This request was not found.");
          if (r.receipt.state === "undone") return r.receipt;
          if (r.receipt.state === "running") throw new Error("The agent is still running. Let it finish before undoing its canvas changes.");
          await undoEffects(ctx, r.effects);
          r.receipt.state = "undone"; r.receipt.message = "Restored the canvas changes."; r.receipt.undo = false; save(r);
          return r.receipt;
        }));
      } catch (e) { return c.json({ error: err(e) }, 409); }
    });
    ctx.app.post("/api/new/jobs/:id/actions", async (c) => {
      try {
        const b = z.object({ request: z.string().min(1).max(100), action: NewAction }).strict().parse(await c.req.json());
        return c.json(await serial(async () => {
          const r = get(c.req.param("id"));
          if (!r?.job || r.receipt.state !== "running") throw new Error("This agent job is not running. Nothing was changed.");
          const key = `new:step:${r.receipt.id}:${b.request}`;
          const prior = kvGet<{ action: string; effect: Effect } | null>(ctx.db, key, null);
          if (prior) { if (prior.action !== JSON.stringify(b.action)) throw new Error("Step id already used for a different action."); return prior.effect.result; }
          const effect = await execute(ctx, jobAction(r, b.action), [], true);
          addEffect(r, effect); kvSet(ctx.db, key, { action: JSON.stringify(b.action), effect });
          return effect.result;
        }));
      } catch (e) { return c.json({ error: err(e) }, 400); }
    });
    ctx.app.post("/api/new/jobs/:id/complete", async (c) => {
      try {
        const b = z.union([z.object({ message: z.string().min(1).max(4000) }).strict(), z.object({ error: z.string().min(1).max(4000) }).strict()]).parse(await c.req.json());
        return c.json(await serial(async () => {
          const r = get(c.req.param("id"));
          if (!r?.job) throw new Error("This agent job was not found.");
          if (r.receipt.state !== "running") return r.receipt;
          return finish(r, "error" in b ? b.error : b.message, "error" in b);
        }));
      } catch (e) { return c.json({ error: err(e) }, 400); }
    });
  },
});
