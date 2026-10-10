// The guarded steer path. A reply or prompt answer the captain sends is the captain's own and is never
// refused here. One from anyone else (Firstmate through `joyride steer`, or the evolution mission) is
// refused, before anything is typed, when
//   - the worker is Firstmate's own pane, a crewmate (Firstmate steers its crew with fm-send.sh <task>,
//     a durable inbox the crewmate acknowledges), or a session the captain keeps to themself (fleet.yaml);
//   - fleet.yaml's authority does not grant the action;
//   - the captain holds its helm (helm.ts);
//   - it runs outside Herdr, or is an agent whose input box Joyride can't read.
// Past these checks, a guarded reply never clears the input box: text there is the captain's draft, so
// the reply is refused instead (herdr.ts, keepDraft). A guarded prompt answer must name a choice the
// prompt itself offers and say why (intents.ts, answer_prompt).
import type { WorkerView } from "../../shared/schema.ts";
import { composerAgents } from "./composer.ts";

export type GuardAction = "steer" | "answer_prompt";
/** What the guard needs from fleet.yaml; null when the fleet module is not running. */
export type GuardPolicy = { authority: readonly string[] } | null;
export type Refusal = { code: string; message: string };

const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const ACTION_WORDS: Record<GuardAction, string> = { steer: "steer", answer_prompt: "answer the prompts of" };
const VIA_WORDS: Record<string, string> = { direct: "in its pane", "joyride-reply": "from Joyride", "joyride-terminal": "in Joyride's terminal" };

export function guardRefusal(w: WorkerView, action: GuardAction, policy: GuardPolicy): Refusal | null {
  const name = w.title ? `${w.title} (${w.id})` : w.id;
  const tier = w.owner?.tier ?? "watched";
  if (!policy) return { code: "fleet_unavailable", message: `The fleet module is not running, so Joyride can't check this against the captain's fleet policy. Nothing was sent to ${name}.` };
  if (tier === "control") return { code: "control", message: `${name} is Firstmate's own pane; Firstmate does not steer itself through Joyride.` };
  if (tier === "crew") {
    const task = w.owner?.task ?? w.crew ?? "<task>";
    return { code: "crew", message: `${name} is crew on task ${task}. Steer a crewmate with fm-send.sh ${task} (its durable inbox, which it acknowledges), not through the watched-session path. Nothing was sent.` };
  }
  if (tier === "excluded") return { code: "excluded", message: `The captain keeps ${name} to themself (fleet.yaml excludes it), so Firstmate does not ${ACTION_WORDS[action]} it. Nothing was sent.` };
  if (!policy.authority.includes(action)) return { code: "no_authority", message: `fleet.yaml does not let Firstmate ${ACTION_WORDS[action]} watched sessions (authority: ${policy.authority.join(", ") || "none"}). Ask the captain. Nothing was sent to ${name}.` };
  if (w.helm?.by === "captain") {
    const how = VIA_WORDS[w.helm.via ?? ""] ?? "directly";
    const back = w.helm.until ? `at ${clock(w.helm.until)}` : "15 quiet minutes after the turn ends";
    return { code: "captain_helm", message: `The captain holds the helm of ${name}: they steered it ${how}${w.helm.since ? ` at ${clock(w.helm.since)}` : ""}. It returns to Firstmate ${back}, or sooner when they hand it back. Nothing was sent; try again then.` };
  }
  if (!w.pane) return { code: "not_herdr", message: `${name} runs outside Herdr, so Firstmate can't reach it through Joyride. The captain can move it into Herdr (Move to Herdr on its worker pane). Nothing was sent.` };
  if (!composerAgents.has(w.agent)) return { code: "unreadable_input", message: `Joyride can't read the input box of ${w.agent} agents, so it can't tell whether the captain is typing in ${name}. Nothing was sent.` };
  return null;
}
