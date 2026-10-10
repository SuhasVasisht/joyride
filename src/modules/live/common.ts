// Small helpers shared by the herdr, workers and intents parts of the live module.
import path from "node:path";
import type { AgentKind } from "../../shared/schema.ts";
import type { AgentSessionRef, PaneState } from "./herdr-client.ts";

const KINDS = new Set(["claude", "codex", "pi", "opencode"]);
export function toAgentKind(agent: string | null | undefined): AgentKind | null {
  if (!agent) return null;
  const a = agent.toLowerCase();
  return (KINDS.has(a) ? a : "other") as AgentKind;
}

const UUIDISH = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?!.*[0-9a-f]{8}-)/i;
/** Native session id from a Herdr agent_session ref (kind "id", or a transcript path). */
export function sessionIdFromRef(ref: AgentSessionRef | null | undefined): string | null {
  if (!ref?.value) return null;
  if (ref.kind === "path") {
    const base = path.basename(ref.value).replace(/\.jsonl?$/, "");
    return base.match(UUIDISH)?.[1] ?? base;
  }
  return ref.value;
}

/** Session key `${agent}:${id}` for a pane, or null. */
export function paneSessionKey(p: PaneState): string | null {
  const id = sessionIdFromRef(p.agent_session);
  const agent = toAgentKind(p.agent_session?.agent ?? p.agent);
  return id && agent ? `${agent}:${id}` : null;
}

export function paneTitle(p: PaneState): string {
  return p.title || p.terminal_title || p.label || p.name || (p.cwd ? path.basename(p.cwd) : "") || p.pane_id;
}

export const isUnder = (dir: string | null | undefined, root: string) => Boolean(dir) && (dir === root || dir!.startsWith(root.endsWith("/") ? root : root + "/"));

/** Split a worker id or "machine:pane" into parts, given the known machine labels. */
export function splitPaneRef(ref: string, machines: string[]): { machine: string | null; pane: string } {
  for (const m of machines) if (ref.startsWith(m + ":") && /^w[^:]*:p/.test(ref.slice(m.length + 1))) return { machine: m, pane: ref.slice(m.length + 1) };
  return { machine: null, pane: ref };
}

export const shellQuote = (s: string) => (/^[\w./@%+=:,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

export function resumeCommand(agent: string, sessionId: string | null): string {
  if (agent === "codex") return sessionId ? `codex resume ${sessionId}` : "codex resume --last";
  return sessionId ? `claude --resume ${sessionId}` : "claude --continue";
}
