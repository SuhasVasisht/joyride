// "This looks moot" (control plane §3): the captain thinks a Firstmate-owned call no longer applies. That is
// not an answer, so it never goes through answer_ask or a reconcile request (board-style reconcile needs a
// bound source). The captain-only recheck_ask intent files one captain inbox note asking Firstmate to
// re-check the call and close it its own way, or keep it and say why. Idempotent per intent id.
import type { Ctx } from "../../core/context.ts";
import { canRecheck, type Ask } from "../../shared/asks.ts";
import type { FirstmateApi } from "../firstmate/index.ts";
import { IntentError, type IntentsApi } from "../live/intents.ts";
import type { AsksApi } from "./index.ts";

export function recheckText(ask: Ask, requestId: string, words?: string): string {
  const where = ask.task ? `task ${ask.task}` : "no task";
  const how = ask.answer.via === "fm-captain-hold"
    ? "If it no longer applies, close the held task your usual way (reconcile it against its bound source, or record why it is moot)."
    : "If it no longer applies, resolve the decision with its worker your usual way.";
  return [
    `The captain looked at this call on the Joyride map and thinks it may be moot: "${ask.title}" (${ask.id}, ${where}).`,
    "",
    `The question: ${ask.question.replace(/\s+/g, " ").trim().slice(0, 600)}`,
    ...(words?.trim() ? ["", `The captain's words: ${words.trim().slice(0, 500)}`] : []),
    "",
    `Re-check it. ${how} If it still applies, keep it open and reply to this note with fm-inbox.sh reply to say why; the card stays on the map until you close it.`,
    ...(ask.mission ? [`joyride-mission: ${ask.mission}`] : []),
    `joyride-request: ${requestId}`,
  ].join("\n");
}

export function registerRecheck(ctx: Ctx, asks: AsksApi) {
  const intents = ctx.services.get("intents") as IntentsApi | undefined;
  intents?.registerHandler("recheck_ask", async (it) => {
    if (it.origin !== "captain") throw new IntentError("Only the captain can send a call back to Firstmate as moot.", { refused: "captain_only" });
    const ask = asks.get(it.target);
    if (!ask) throw new IntentError("This ask is no longer open. Refresh the map to see what still needs an answer.", { refused: "ask_closed" });
    if (!canRecheck(ask)) throw new IntentError("Only Firstmate's own calls (held tasks and crew decisions) can be sent back as moot. Answer this one instead.", { refused: "not_firstmate_call" });
    const fm = ctx.services.get("firstmate") as FirstmateApi | undefined;
    if (!fm) throw new IntentError("Firstmate is unavailable. Restore its module and retry.");
    const words = typeof it.payload?.words === "string" ? it.payload.words : undefined;
    const note = await fm.note(it.id, recheckText(ask, it.id, words));
    return { ask: ask.id, via: "inbox", note: note.note, outcome: note.outcome, announced: note.announced };
  });
}
