import { z } from "zod";
import { jev, type JevResult } from "../../core/jev.ts";
import { llm } from "../../core/llm.ts";
import { newModelAccount } from "../../core/new-models.ts";
import type { Config } from "../../shared/schema.ts";

const Judgment = z.object({ route: z.enum(["deterministic", "firstmate", "agent"]), idea: z.string(), confidence: z.number().min(0).max(1) });
export function newJudge(cfg: Config): typeof jev {
  const choice = cfg.new_models.routing;
  if (choice.backend === "jev") return (state, questions, opts) => jev(state, questions, { ...opts, model: choice.model ?? cfg.jev.model });
  return async (state, questions): Promise<JevResult> => {
    const account = newModelAccount(choice, cfg);
    const answer = Judgment.parse(await llm(`Route the New submission using these questions. Return route, idea (an existing id or new), and confidence.\n${JSON.stringify({ state, questions })}`, { choice: { ...choice, account: account.id }, schema: z.toJSONSchema(Judgment), timeoutMs: 30000 }));
    return { model: choice.model, ms: 0, usage: {}, answers: { new_route: { type: "choice", choice: answer.route, probabilities: { [answer.route]: answer.confidence } }, new_idea: { type: "choice", choice: answer.idea, probabilities: { [answer.idea]: answer.confidence } } } };
  };
}
