import { z } from "zod";
import type { Ctx } from "../../core/context.ts";
import { kvGet, kvSet } from "../../core/db.ts";
import { sha256 } from "../../core/util.ts";
import type { Ask } from "../../shared/asks.ts";
import type { createPruning } from "../fleet/pruning.ts";
import type { AsksApi } from "./index.ts";
import type { FirstmateApi } from "../firstmate/index.ts";
import type { AttentionService } from "../attention/index.ts";
import { paths } from "../../shared/paths.ts";
import { readNoteFile, writeNoteFile } from "../../shared/note-files.ts";
import { commitPaths } from "../../core/gitstore.ts";
import { IntentError, type IntentRecord, type IntentsApi } from "../live/intents.ts";

const Payload = z.object({
  answer: z.string().refine((s) => s.trim().length > 0, "Type an answer before sending."),
  mode: z.enum(["done", "release"]).optional(),
}).strict();

type Receipt = {
  ask: Ask; lifecycle: string; request: string; answer: string; mode: "done" | "release" | null;
  delivered: boolean; result: unknown; note: string | null; complete: boolean;
};

const lifecycle = (a: Ask) => sha256(JSON.stringify([a.id, a.opened, a.question, a.answer, a.hold?.set]));

/** One durable receipt per ask lifecycle; serialize concurrent clicks before reading it. */
export function registerAnswers(ctx: Ctx, asks: AsksApi) {
  const available = ctx.services.get("intents") as IntentsApi | undefined;
  if (!available) return;
  const intents = available;
  const queues = new Map<string, Promise<unknown>>();
  intents.registerHandler("answer_ask", (it) => {
    if (it.origin !== "captain") throw new IntentError("Only the captain can answer an ask. Firstmate answers through its own task and fleet paths.", { refused: "captain_only" });
    const prior = queues.get(it.target) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(() => answer(it));
    queues.set(it.target, next);
    void next.finally(() => { if (queues.get(it.target) === next) queues.delete(it.target); }).catch(() => {});
    return next;
  });

  async function answer(it: IntentRecord) {
    const parsed = Payload.safeParse(it.payload);
    if (!parsed.success) throw new IntentError(`The answer is invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    const payload = parsed.data;
    const fm = ctx.services.get("firstmate") as FirstmateApi | undefined;
    fm?.reload();
    const current = asks.get(it.target);
    const key = `asks:answer:${it.target}`;
    const old = kvGet<Receipt | null>(ctx.db, key, null);
    const sameLifecycle = old && (!current || old.lifecycle === lifecycle(current));
    const ask = current ?? (sameLifecycle ? old.ask : null);
    if (!ask) throw new IntentError("This ask is no longer open. Refresh the map to see what still needs an answer.", { refused: "ask_closed" });
    if (ask.read_only || ask.answer.via === "none") throw new IntentError(ask.read_only ?? "Answer this ask in Firstmate.", { refused: "read_only" });
    const mode = ask.answer.via === "fm-captain-hold" ? payload.mode ?? ask.answer.modes[0] : null;
    if (payload.mode && ask.answer.via !== "fm-captain-hold") throw new IntentError("Done and release modes apply only to captain-held tasks.");
    if (ask.answer.via === "fm-captain-hold") {
      if (!mode || !ask.answer.modes.includes(mode)) throw new IntentError("Pick the close mode offered by this call.");
      if (payload.answer.trim().toLowerCase() === "reconcile") throw new IntentError("Reconcile is not a captain answer. Ask Firstmate to re-check this call through an inbox note.", { refused: "reconcile" });
      // The keyed intake sanitizes and truncates each field at 512 bytes. Refuse
      // anything it would alter, so its decision and our note keep the same words.
      if (/[\x00-\x1f\x7f]/.test(payload.answer) || Buffer.byteLength(payload.answer) > 512) throw new IntentError("A held-task answer must be one line without control characters, at most 512 bytes. Edit the answer and retry.");
    }
    if (sameLifecycle && (old.answer !== payload.answer || old.mode !== mode)) throw new IntentError("An answer was already recorded for this ask. Refresh the map before changing it.", { refused: "answer_conflict" });
    const rec: Receipt = sameLifecycle ? old : { ask, lifecycle: lifecycle(ask), request: it.id, answer: payload.answer, mode, delivered: false, result: null, note: null, complete: false };
    if (rec.complete) return { ask: ask.id, replay: true, note: rec.note, delivery: rec.result };
    kvSet(ctx.db, key, rec);
    if (!rec.delivered) {
      rec.result = await deliver(rec, fm);
      rec.delivered = true;
      kvSet(ctx.db, key, rec);
    }
    // A deterministic id makes a crash between the git commit and the receipt update safe.
    const noteId = `note-answer-${sha256(rec.request).slice(0, 24)}`;
    if (!readNoteFile(paths.notes, noteId)) {
      const task = ask.task ? fm?.task(ask.task) : null;
      const gated = typeof ask.ref.gates === "string" ? fm?.task(ask.ref.gates) : null;
      const report = task?.report ?? gated?.report ?? (ask.hold?.origin ? fm?.task(ask.hold.origin)?.report : null);
      const entry = {
        id: noteId, created: new Date().toISOString(), updated: null, tags: [],
        kind: "note" as const, title: `Captain answered: ${ask.title}`, status: "active" as const,
        scope: ask.mission ? `mission:${ask.mission}` : ask.task ? `task:${ask.task}` : ask.session ? `session:${ask.session}` : "global",
        provenance: { type: "human", ref: `answer_ask:${rec.request}` },
        body: `## Question\n\n${ask.question}\n\n## Recommendation\n\n${ask.recommended_answer ?? "No recommendation recorded."}\n\n## Captain's answer\n\n${rec.answer}${rec.mode ? `\n\nClose mode: ${rec.mode}` : ""}${report ? `\n\nReport: [${ask.title}](${report})` : ""}`,
      };
      const file = writeNoteFile(paths.notes, entry);
      commitPaths([file], `notes: captain answer to ${ask.id}`);
      ctx.bus.change({ entity: "notes" });
    }
    rec.note = noteId;
    kvSet(ctx.db, key, rec);
    if (ask.answer.via === "fm-captain-hold") {
      if (!fm) throw new IntentError("Firstmate is unavailable. Restore it and retry to file the wake note.");
      await fm.note(rec.request, `Captain answered ${ask.task} on the map: ${rec.answer}`);
    }
    const attention = ctx.services.get("attention") as AttentionService | undefined;
    if (typeof ask.ref.attention === "string" && ask.kind === "prompt") attention?.resolve(ask.ref.attention, "answered on the map");
    rec.complete = true;
    kvSet(ctx.db, key, rec);
    asks.refresh();
    return { ask: ask.id, replay: false, note: rec.note, delivery: rec.result };
  }

  async function deliver(rec: Receipt, fm: FirstmateApi | undefined): Promise<unknown> {
    const route = rec.ask.answer;
    const needFm = () => { if (!fm) throw new IntentError("Firstmate is unavailable. Restore its module and retry the answer."); return fm; };
    const child = async (kind: string, target: string, payload: Record<string, unknown>) => {
      const result = await intents.create(kind, target, payload, { origin: "captain" });
      if (result.status === "failed" || result.status === "pending") throw new IntentError(result.error ?? "The owner has not confirmed the answer yet.", { child_intent: result.id, result: result.result });
      return { intent: result.id, result: result.result };
    };
    switch (route.via) {
      case "fm-captain-hold": {
        if (!rec.mode) throw new IntentError("Choose done or release for the captain-held task.");
        // Label is TSV metadata, never a second input record.
        return needFm().answerHold(route.target, rec.answer, rec.ask.title.replace(/[\t\r\n]/g, " "), rec.mode);
      }
      case "fm-send-resolve-key": return needFm().answerDecision(route.target, rec.answer, route.key);
      case "fm-send": return needFm().answerDecision(route.target, rec.answer);
      case "answer_prompt": {
        const choice = z.enum(["allow", "allow_always", "deny"]).safeParse(rec.answer);
        if (!choice.success) throw new IntentError("Choose allow, allow_always or deny for this prompt.");
        return child("answer_prompt", route.target, { choice: choice.data });
      }
      case "reply": return child("reply", route.target, { text: rec.answer });
      case "prune": {
        const answer = rec.answer.trim().toLowerCase();
        const approve = ["a", "approve", "allow", "preserve and close when eligible"].includes(answer);
        const deny = ["b", "deny", "reject", "keep the pane open"].includes(answer);
        if (!approve && !deny) throw new IntentError("Choose preserve and close, or keep the pane open, for this prune ask.");
        const fleet: ReturnType<typeof createPruning> | undefined = ctx.services.get("fleet");
        if (!fleet) throw new IntentError("The fleet module is unavailable. Restore it and retry this prune answer.");
        const result = await fleet.decide(route.target, approve);
        const delivered = z.object({ status: z.string(), error: z.string().nullable().optional() }).safeParse(result);
        if (delivered.success && (delivered.data.status === "failed" || delivered.data.status === "pending")) throw new IntentError(delivered.data.error ?? "The pane could not be preserved and closed. Review its prune ask before retrying.");
        return result;
      }
      case "approve_deny": {
        if (!["allow", "approve", "deny"].includes(rec.answer)) throw new IntentError("Choose allow or deny for this guard approval.");
        return child(rec.answer === "deny" ? "deny" : "approve", route.target, { reason: "Captain answered on the Joyride map" });
      }
      case "ack":
      case "nudge": {
        const attention = ctx.services.get("attention") as AttentionService | undefined;
        if (!attention) throw new IntentError("The attention module is unavailable. Restore it and retry the acknowledgement.");
        attention.label(route.target, "ack", { reason: rec.answer });
        return { ack: route.target };
      }
      case "none": throw new IntentError("Answer this ask in Firstmate.");
      default: { const exhaustive: never = route; return exhaustive; }
    }
  }
}
