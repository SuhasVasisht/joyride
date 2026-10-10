// `joyride fleet` and `joyride steer`: the fleet as Firstmate reads and steers it (docs/fleet-operator.md).
//   joyride fleet [--brief|--json] [--all]       the roster (--all adds the sessions the captain keeps to themself)
//   joyride fleet show <worker> [--json]         one member, with the prompt on its screen when it waits at one
//   joyride fleet events [--after <seq>] [--json] what the feed delivers to Firstmate
//   joyride fleet hand-back|exclude|include <worker|session|folder>   the captain's own actions
//   joyride steer <worker> <text...|->           Firstmate's guarded steer of a watched session
//   joyride steer <worker> --answer allow|allow_always|deny --why "<reason>"   answer its own permission prompt
// Exit codes: 0 done, 2 refused by the guard (nothing was sent), 1 any other failure.
import fs from "node:fs";
import path from "node:path";
import { DAEMON_URL, paths } from "../shared/paths.ts";

type Member = {
  worker: string; session: string | null; tier: string; task: string | null; state: string; why: string; title: string; goal: string | null;
  cwd: string; repo: string | null; helm: { by: string; since: string | null; until: string | null; via: string | null } | null; controllable: boolean; updated: string;
};
type Roster = { members: Member[]; counts: { crew: number; watched: number; excluded: number; needs_you: number; captain_helm: number }; feed: { attached: boolean; consumers: { id: string; last_poll: string | null; pending: number }[]; last_seq: number }; policy_error: string | null; operator_doc: string };

export class CliError extends Error { constructor(message: string, public code = 1) { super(message); } }

async function call(method: string, p: string, body?: unknown): Promise<{ status: number; body: any }> {
  let r: Response;
  try { r = await fetch(DAEMON_URL + p, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); }
  catch (e: any) { throw new CliError(`The Joyride daemon is not answering at ${DAEMON_URL} (${e?.cause?.code ?? e.message}). Start it with ./bin/joyride up, then try again.`); }
  const t = await r.text();
  let b: any = t;
  try { b = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, body: b };
}

const clock = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "");
const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
const project = (m: Member) => (m.repo || m.cwd || "").split("/").filter(Boolean).pop() ?? "";
export const NEEDS = new Set(["blocked", "needs-decision", "failed"]);

export function helmWord(m: Pick<Member, "helm">): string {
  if (!m.helm) return "-";
  if (m.helm.by !== "captain") return "firstmate";
  return m.helm.until ? `captain until ${clock(m.helm.until)}` : "captain (turn running)";
}

export function summaryLine(r: Pick<Roster, "counts" | "feed">): string {
  const c = r.counts;
  const feed = r.feed.attached ? "feed attached" : r.feed.consumers.length ? "feed not polled lately" : "feed not attached";
  return `Fleet: ${c.crew} crew · ${c.watched} watched${c.excluded ? ` · ${c.excluded} yours only` : ""} · ${c.needs_you} need${c.needs_you === 1 ? "s" : ""} attention · ${c.captain_helm} at the captain's helm · ${feed}`;
}

export function formatRoster(r: Roster, o: { brief?: boolean; all?: boolean } = {}): string {
  const lines = [summaryLine(r)];
  if (r.policy_error) lines.push(`Warning: ${r.policy_error}`);
  let rows = r.members.filter((m) => o.all || m.tier !== "excluded");
  if (o.brief) rows = rows.filter((m) => NEEDS.has(m.state) || m.helm?.by === "captain");
  if (!rows.length) { lines.push(o.brief ? "Nothing needs you right now, and the captain holds no helm." : "No live sessions."); return lines.join("\n"); }
  lines.push(`${pad("TIER", 9)}${pad("WORKER", 16)}${pad("STATE", 16)}${pad("HELM", 24)}${pad("PROJECT", 18)}GOAL`);
  for (const m of rows) {
    const tier = m.tier === "crew" ? `crew` : m.tier === "excluded" ? "yours" : m.tier;
    const goal = `${m.goal || m.title || ""}${m.task ? ` (${m.task})` : ""}${NEEDS.has(m.state) ? ` — ${m.why}` : ""}`.replace(/\s+/g, " ");
    lines.push(`${pad(tier, 9)}${pad(m.worker, 16)}${pad(m.state, 16)}${pad(helmWord(m), 24)}${pad(project(m), 18)}${goal.slice(0, 140)}`);
  }
  if (!o.brief) lines.push(`States are inferred from Herdr, hooks and attention. Rules: ${r.operator_doc}`);
  return lines.join("\n");
}

export function formatMember(m: Member & { prompt?: { question: string; options: string[] } | null }): string {
  const lines = [
    `${m.worker} · ${m.tier}${m.task ? ` on ${m.task}` : ""} · ${m.state} (inferred)`,
    `  goal:    ${m.goal || m.title || "-"}`,
    `  folder:  ${m.cwd || "-"}`,
    `  session: ${m.session ?? "-"}`,
    `  helm:    ${helmWord(m)}${m.helm?.by === "captain" && m.helm.via ? ` (${m.helm.via})` : ""}`,
    `  why:     ${m.why}`,
  ];
  if (m.prompt) {
    lines.push(`  prompt:  ${m.prompt.question || "(no question text)"}`);
    for (const o of m.prompt.options) lines.push(`           ${o}`);
    if (m.tier === "watched") lines.push(`  answer:  joyride steer ${m.worker} --answer allow|allow_always|deny --why "<reason>"`);
  }
  return lines.join("\n");
}

export function formatEvents(events: { seq: number; ts: string; type: string; worker: string; data: any }[]): string {
  if (!events.length) return "No fleet events.";
  return events.map((e) => `${String(e.seq).padStart(5)} ${clock(e.ts).padEnd(8)} ${pad(e.type, 16)} ${e.worker}${e.data?.state ? ` ${e.data.state}` : ""}${e.data?.via ? ` (${e.data.via})` : ""}${e.data?.why ? `: ${String(e.data.why).slice(0, 120)}` : ""}`).join("\n");
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v == null || v.startsWith("--")) throw new CliError(`${name} needs a value.`);
  args.splice(i, 2);
  return v;
}
function has(args: string[], name: string): boolean { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; }

/** What a refused or failed intent says, with the exit code for it. */
function intentOutcome(r: { status: number; body: any }, ok: (it: any) => string): string {
  const it = r.body;
  if (r.status === 200 && it?.status && it.status !== "failed") return ok(it);
  const msg = it?.error ?? (typeof it === "string" ? it : JSON.stringify(it));
  throw new CliError(msg, it?.result?.refused ? 2 : 1);
}

async function readStdin(): Promise<string> {
  try { return fs.readFileSync(0, "utf8"); } catch { return ""; }
}

/**
 * The captain's own commands are refused from a crewmate's shell (FM_TASK_ID) or from Firstmate's
 * checkout or home, where Firstmate's own commands run. The daemon records them as the captain's.
 */
export function captainOnly(cmd: string, cwd = process.cwd()) {
  const fmPlaces = [paths.firstmateDir, process.env.FM_HOME].filter((p): p is string => Boolean(p)).map((p) => path.resolve(p));
  const inFirstmate = fmPlaces.some((p) => cwd === p || cwd.startsWith(p + path.sep));
  if (process.env.FM_TASK_ID || inFirstmate) throw new CliError(`joyride fleet ${cmd} is the captain's, and this shell is ${process.env.FM_TASK_ID ? `a crewmate's (task ${process.env.FM_TASK_ID})` : "in Firstmate's checkout or home"}, so it was not sent. Run it from your own terminal, or use the fleet page in Joyride.`, 2);
}

export async function fleetCommand(argv: string[]): Promise<string> {
  const args = [...argv];
  const sub = args[0] && !args[0].startsWith("--") ? args.shift()! : "list";
  const json = has(args, "--json");
  switch (sub) {
    case "list": case "ls": {
      const brief = has(args, "--brief"), all = has(args, "--all");
      const r = await call("GET", "/api/fleet");
      if (r.status !== 200) throw new CliError(r.body?.error ?? `GET /api/fleet answered ${r.status}`);
      return json ? JSON.stringify(r.body, null, 2) : formatRoster(r.body, { brief, all });
    }
    case "prune": {
      if (!has(args, "--dry-run")) throw new CliError("Start with joyride fleet prune --dry-run. To close one eligible pane, use joyride fleet retire <worker>.");
      const r = await call("GET", "/api/fleet/prune");
      if (r.status !== 200) throw new CliError(r.body?.error ?? "Could not read prune candidates.");
      if (json) return JSON.stringify(r.body, null, 2);
      return ["Dry run: no panes closed.", ...r.body.candidates.map((c: any) => `${c.eligible ? "Would preserve and close" : "Keep"} ${c.worker}: ${c.why}${c.git ? `; branch ${c.git.branch ?? "none"}; ${c.git.dirty ? "uncommitted changes" : "clean"}; unpushed ${c.git.unpushed ?? "unknown"}; shared by ${c.shared} session(s)` : ""}`)].join("\n");
    }
    case "propose-prune": {
      const worker = args.shift();
      if (!worker) throw new CliError("Usage: joyride fleet propose-prune <worker> [reason]");
      const r = await call("POST", "/api/fleet/propose-prune", { worker, why: args.join(" ") || "Firstmate proposes saving and closing this idle pane." });
      if (r.status !== 200) throw new CliError(r.body?.error ?? "Could not propose prune.");
      return json ? JSON.stringify(r.body, null, 2) : `Prune ask ${r.body.id} raised for ${worker}; expires ${r.body.expires}.`;
    }
    case "retire": {
      const worker = args.shift();
      if (!worker) throw new CliError("Usage: joyride fleet retire <worker>");
      const r = await call("POST", "/api/fleet/retire", { worker });
      return intentOutcome(r, (it) => json ? JSON.stringify(it, null, 2) : `Saved ${worker} as session artifact ${it.result.artifact}, then closed its pane. Resume: ${it.result.resume.command}`);
    }
    case "show": {
      const id = args[0];
      if (!id) throw new CliError("Usage: joyride fleet show <worker>");
      const r = await call("GET", `/api/fleet/members/${encodeURIComponent(id)}`);
      if (r.status !== 200) throw new CliError(r.body?.error ?? `GET /api/fleet/members answered ${r.status}`);
      return json ? JSON.stringify(r.body, null, 2) : formatMember(r.body);
    }
    case "events": {
      const after = flag(args, "--after");
      const r = await call("GET", `/api/fleet/events${after != null ? `?after=${encodeURIComponent(after)}` : ""}`);
      if (r.status !== 200) throw new CliError(r.body?.error ?? `GET /api/fleet/events answered ${r.status}`);
      return json ? JSON.stringify(r.body, null, 2) : formatEvents(r.body.events);
    }
    case "hand-back": case "exclude": case "include": {
      const target = args[0];
      if (!target) throw new CliError(`Usage: joyride fleet ${sub} <worker|session key|folder>`);
      captainOnly(sub);
      const r = await call("POST", `/api/fleet/${sub}`, { target });
      return intentOutcome(r, (it) => sub === "hand-back"
        ? (it.result?.already ? `Firstmate already has the helm of ${target}.` : `Handed the helm of ${target} back to Firstmate.`)
        : it.result?.changed === false ? `Nothing changed: ${target} is already ${sub === "exclude" ? "yours only" : "in the fleet"}.` : `${sub === "exclude" ? "Kept" : "Included"} ${target}${sub === "exclude" ? " out of the fleet" : " in the fleet"} (fleet.yaml, commit ${String(it.result?.commit ?? "").slice(0, 8) || "none"}).`);
    }
    default:
      throw new CliError(`Unknown fleet command "${sub}". Use: joyride fleet [--brief|--json|--all], show <worker>, events, hand-back|exclude|include <worker>.`);
  }
}

export async function steerCommand(argv: string[]): Promise<string> {
  const args = [...argv];
  const answer = flag(args, "--answer");
  const why = flag(args, "--why");
  const worker = args.shift();
  if (!worker) throw new CliError('Usage: joyride steer <worker> "<text>"  |  joyride steer <worker> --answer allow|allow_always|deny --why "<reason>"');
  if (answer != null) {
    if (args.length) throw new CliError("An answer carries no text; steer the session separately.");
    if (!why?.trim()) throw new CliError("Say why with --why: it is recorded with the answer for the captain.");
    const r = await call("POST", "/api/fleet/answer", { worker, choice: answer, why });
    return intentOutcome(r, (it) => `Answered ${worker}'s prompt with "${it.result?.picked ?? answer}"${it.result?.prompt?.question ? ` (${it.result.prompt.question})` : ""}. Recorded as ${it.id}.`);
  }
  const text = (args.length === 1 && args[0] === "-" ? await readStdin() : args.join(" ")).trim();
  if (!text) throw new CliError(`Nothing to send. Usage: joyride steer ${worker} "<text>" (or - to read it from stdin).`);
  const r = await call("POST", "/api/fleet/steer", { worker, text });
  return intentOutcome(r, (it) => `Sent to ${worker}${it.result?.queued ? " (it is working, so the message waits in its queue until the turn ends)" : ""}. Recorded as ${it.id}.`);
}
