import type { NewWorld } from "./freeform-plan.ts";
import type { ScreenContext, SessionPlacement, StandaloneOffer } from "./freeform.ts";
import { LlmBackend } from "./schema.ts";

export function standaloneIntent(text: string): boolean {
  if (/^(?:note|list|link|(?:new )?task)\s*:/i.test(text) && !/^task:\s*(?:start|launch|open)\b/i.test(text)) return false;
  return /\b(?:standalone|stand-alone|independent|user-owned|my own|personal)\s+(?:repo\s+)?session\b|\b(?:session|task)\b[\s\S]*\b(?:without|no|outside|independent of)\s+firstmate\b|\b(?:start|launch|open)\b[\s\S]*\b(?:deep work|solo session)\b/i.test(text)
    || /\bfirstmate\s+(?:is\s+)?(?:down|unavailable|offline|not running|broken)\b/i.test(text) && /\b(?:start|launch|open)\b[\s\S]*\bsession\b/i.test(text);
}
const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, "");
function namedGroup(text: string, world: NewWorld) {
  const normalized = unquote(text).toLowerCase();
  const matches = world.groups.filter(g => g.id.toLowerCase() === normalized || g.title.toLowerCase() === normalized);
  return matches.length === 1 ? matches[0] : null;
}
export function standaloneOffer(text: string, context: ScreenContext, world: NewWorld, configured: LlmBackend): StandaloneOffer {
  const groups = world.groups.map(g => ({ id: g.id, title: g.title }));
  const repos = [...new Set(world.elements.filter(e => e.kind === "project").map(e => e.id))].filter(p => p.startsWith("/"));
  const refs = [context.place, context.focused, context.selected, context.hovered];
  const current = refs.find(e => e?.kind === "idea" || e?.kind === "group" || e?.kind === "project");
  const own = /\b(?:own|new|separate)\s+(?:canvas\s+)?group\b/i.test(text);
  const groupMatch = /\b(?:join|in|into)\s+(?:the |an? )?(?:existing )?(?:canvas )?group\s+(.+?)(?=\s+(?:in (?:repo|\/)|using\b|with model\b|on account\b)|[\n:;.]|$)/i.exec(text) ?? /\bjoin\s+(?:the )?(.+?)(?=\s+(?:in (?:repo|\/)|using\b|with model\b|on account\b)|[\n:;.]|$)/i.exec(text);
  let placement: SessionPlacement | null = null;
  if (own) {
    const title = /\b(?:own|new|separate)\s+(?:canvas\s+)?group\s+(?:called|named)\s+([\w '"-]+?)(?=\s+(?:in|using|with|on)\b|[\n:;.]|$)/i.exec(text)?.[1];
    placement = { kind: "new", title: title ? unquote(title) : /triage|troubleshoot/i.test(text) ? "Repo triage" : "Deep work" };
  } else if (groupMatch) {
    const g = /^(?:here|this|current)$/i.test(unquote(groupMatch[1])) ? world.groups.find(g => current?.kind === "group" && g.id === current.id) : namedGroup(groupMatch[1].replace(/\s+group$/i, ""), world);
    if (g) placement = { kind: "group", id: g.id, title: g.title };
  } else if (current?.kind === "group") {
    const g = world.groups.find(g => g.id === current.id);
    if (g) placement = { kind: "group", id: g.id, title: g.title };
  } else if (current?.kind === "idea") {
    const idea = world.ideas.find(i => i.id === current.id), g = groups.find(g => g.id === idea?.group);
    placement = g ? { kind: "group", ...g } : { kind: "new", title: "Deep work" };
  } else if (!groupMatch) placement = { kind: "new", title: /triage|troubleshoot/i.test(text) ? "Repo triage" : "Deep work" };
  const explicitPath = /(?:\b(?:repo|folder|cwd|at|in)\s+)(?:"(\/[^"\n]+)"|'(\/[^'\n]+)'|(\/[^\s:;]+))/i.exec(text);
  const repoName = /\bin repo\s+([\w.-]+)\b/i.exec(text)?.[1];
  let candidates: string[] = [];
  if (repoName) candidates = repos.filter(p => p.split("/").filter(Boolean).at(-1)?.toLowerCase() === repoName.toLowerCase());
  else if (groupMatch && placement?.kind === "group") candidates = world.groupRepos?.[placement.id] ?? world.ideas.filter(i => i.group === placement.id).flatMap(i => i.repo?.path ? [i.repo.path] : []);
  else if (current?.kind === "project") candidates = repos.filter(p => p === current.id);
  else if (current?.kind === "idea") candidates = world.ideaRepos?.[current.id] ?? world.ideas.filter(i => i.id === current.id).flatMap(i => i.repo?.path ? [i.repo.path] : []);
  else if (placement?.kind === "group") candidates = world.groupRepos?.[placement.id] ?? world.ideas.filter(i => i.group === placement.id).flatMap(i => i.repo?.path ? [i.repo.path] : []);
  const cwd = explicitPath ? (explicitPath[1] ?? explicitPath[2] ?? explicitPath[3]).replace(/[.,]$/, "") : [...new Set(candidates)].length === 1 ? candidates[0] : null;
  const model = { ...configured };
  const provider = /\b(?:using|with)\s+(codex|claude)\b/i.exec(text)?.[1]?.toLowerCase();
  const modelName = /\bmodel\s+([\w.-]+)/i.exec(text)?.[1] ?? /\busing\s+(?:codex\s+|claude\s+)?(gpt-[\w.-]+|claude-[\w.-]+|luna|haiku|sonnet|opus)\b/i.exec(text)?.[1];
  if (provider && provider !== model.backend) { model.backend = provider === "codex" ? "codex" : "claude"; model.model = provider === "codex" ? "gpt-6-luna" : "sonnet"; delete model.account; delete model.effort; }
  if (modelName) model.model = modelName.toLowerCase() === "luna" ? "gpt-6-luna" : modelName;
  const effort = /\b(?:reasoning )?effort\s+(low|medium|high|xhigh|max)\b|\b(low|medium|high|xhigh|max)\s+(?:reasoning(?: effort)?|effort)\b/i.exec(text);
  if (effort) model.effort = LlmBackend.shape.effort.parse((effort[1] ?? effort[2]).toLowerCase());
  const accountName = /\b(?:on |using )?account\s+([\w.-]+)/i.exec(text)?.[1];
  const accountLabel = /\b(?:using|with|on)\s+(.+?)(?=\s+(?:model|for|in|join)\b|[\n:;.]|$)/i.exec(text)?.[1]?.trim().toLowerCase();
  const selectedAccount = world.accounts.filter(a => a.id.toLowerCase() === accountLabel || a.label.toLowerCase() === accountLabel);
  if (accountName) model.account = accountName;
  else if (selectedAccount.length === 1) model.account = selectedAccount[0].id;
  return { repos: cwd && !repos.includes(cwd) ? [cwd, ...repos] : repos, groups, cwd, placement, model,
    reason: !cwd ? "Choose the repo folder for your session." : !placement ? "Choose the canvas group. The requested group could not be resolved." : "Ready to start your session." };
}
