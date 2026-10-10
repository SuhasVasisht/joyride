import { jev, q, pick, probs } from "../../core/jev.ts";
import type { ScreenContext, NewCandidate } from "../../shared/freeform.ts";
import { candidateNew, placeContext, type NewWorld } from "../../shared/freeform-plan.ts";

export async function classifyNew(text: string, context: ScreenContext, world: NewWorld, judge: typeof jev = jev): Promise<{ candidate: NewCandidate; confidence: number | null; classifier: string }> {
  const candidate = candidateNew(text, world, context);
  if (candidate.route === "standalone") return { candidate, confidence: 1, classifier: "explicit standalone intent" };
  const choices = Object.fromEntries(world.ideas.map((i) => [i.id, `${i.title}. ${i.repo?.title ?? ""}`]));
  try {
    const judgment = await judge({ text, context, candidate, groups: world.groups, ideas: world.ideas, visible: context.visible }, {
      new_route: q.choice("Choose how to handle these words. Use the parsed candidate as evidence. A note, list, URL, artifact:<id>, map edit or view command with a deterministic candidate goes to deterministic. Plain implementation work goes to firstmate. Explicit 'Task:', 'new task:' or 'ask/have/get Firstmate to' always means firstmate, even if the task involves research. Otherwise requests to find, judge, research, summarize or infer missing details go to agent. Saved note/list prose is content, not work to do. Choose agent if the candidate targets the wrong item, loses part of the request, is ambiguous or needs missing parameters. The owner API validates resolved IDs. An explicit reply or permission answer is a deterministic UI action; an agent must never invent one.", {
        deterministic: "Existing UI action: save content, edit the map, navigate, change a setting, or send the exact supplied reply/answer. Candidate route is deterministic and its arguments match.",
        firstmate: "Implementation work or explicit Task:/Firstmate delegation. Send the original text directly to Firstmate, without rewriting it or an intermediate model.",
        agent: "Interpret or search: look up an artifact, summarize, use judgement, or resolve uncertain targets/parameters. No complete deterministic candidate and no explicit Firstmate delegation.",
      }),
      new_idea: q.choice("Which open idea does this Firstmate task belong to? Prefer the explicit joyride-mission marker or current idea. Choose new when none fits. This is placement, never rewriting the task.", { ...choices, new: "A new idea" }),
    }, { retries: 1, timeoutMs: 15000 });
    const route = pick(judgment, "new_route");
    const confidence = route ? probs(judgment, "new_route")[route] ?? judgment.answers.new_route?.confidence ?? 0 : 0;
    if (confidence < 0.8 || route === "agent") return { candidate: { route: "agent", reason: "Jev routed this request to an agent for context and judgement." }, confidence, classifier: judgment.model };
    if (route === "deterministic" && candidate.route === "deterministic") return { candidate, confidence, classifier: judgment.model };
    if (route === "firstmate") {
      const title = text.split("\n").map((line) => line.trim().replace(/^(?:task|new task):\s*/i, "")).find((line) => line && !/^joyride-(?:mission|request):/i.test(line));
      if (!title) return { candidate: { route: "agent", reason: "The submission names a task but contains no work to send. Make the missing detail visible." }, confidence, classifier: judgment.model };
      const explicit = /joyride-mission:\s*([a-z0-9-]+)/.exec(text)?.[1];
      const here = placeContext(context).idea?.id;
      const placed = pick(judgment, "new_idea");
      const idea = explicit ?? here ?? (placed && placed !== "new" && (probs(judgment, "new_idea")[placed] ?? 0) >= 0.75 ? placed : null);
      if (idea && !world.ideas.some((i) => i.id === idea)) return { candidate: { route: "agent", reason: `The requested idea ${idea} no longer exists.` }, confidence, classifier: judgment.model };
      return { candidate: { route: "firstmate", brief: text, idea, title: title.slice(0, 100), summary: "Sent the task directly to Firstmate." }, confidence, classifier: judgment.model };
    }
    return { candidate: { route: "agent", reason: "The request needs parameters the deterministic parser could not resolve." }, confidence, classifier: judgment.model };
  } catch (e) {
    return { candidate: { route: "agent", reason: "Jev could not classify the request. An agent will inspect it." }, confidence: null, classifier: "unavailable" };
  }
}
