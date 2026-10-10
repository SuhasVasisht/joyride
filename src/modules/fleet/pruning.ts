import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { paths } from "../../shared/paths.ts";
import { z } from "zod";
import type { Ctx } from "../../core/context.ts";
import { kvGet, kvSet } from "../../core/db.ts";
import { sha256 } from "../../core/util.ts";
import type { Ask } from "../../shared/asks.ts";
import type { AttentionItem, GuardRequest, WorkerView } from "../../shared/schema.ts";
import type { AsksApi } from "../asks/index.ts";
import type { SessionsService } from "../sessions/types.ts";
import type { MissionsService } from "../missions/index.ts";
import type { HerdrApi } from "../live/herdr.ts";
import { readClaudeRegistry, type WorkersApi } from "../live/workers.ts";
import { IntentError, type IntentsApi } from "../live/intents.ts";
import { sessionIdFromRef, toAgentKind } from "../live/common.ts";
import { readComposer } from "../live/composer.ts";
import { fileSignature, gitContext, initPreservationFake, preserveSession, sessionConfigDir } from "./preserve.ts";
import type { FleetPolicy } from "./policy.ts";

const H = 3600e3, D = 24 * H;
const Proposal = z.object({
  id: z.string(), worker: z.string(), session: z.string().nullable(), title: z.string(), mission: z.string().nullable(),
  checkout: z.string().default(""), shared: z.number().default(1),
  reason: z.string(), created: z.string(), expires: z.string(), status: z.enum(["pending", "closed", "rejected", "expired"]),
});
export type PruneProposal = z.infer<typeof Proposal>;
export type PruneCandidate = { worker: string; session: string | null; title: string; eligible: boolean; why: string; idle_hours: number | null; git: ReturnType<typeof gitContext> | null; shared: number };
const Props = z.array(Proposal);
const SessionRef = z.object({ source: z.string(), agent: z.string(), kind: z.string(), value: z.string() });
const AgentList = z.object({ agents: z.array(z.object({ pane_id: z.string(), agent_status: z.string().optional(), status: z.string().optional(), agent_session: SessionRef.nullable().optional() }).passthrough()) });
const PaneList = z.object({ panes: z.array(z.object({ pane_id: z.string(), agent_session: SessionRef.nullable().optional() }).passthrough()) });
const ProcessInfo = z.object({ process_info: z.object({ foreground_processes: z.array(z.object({ pid: z.number() }).passthrough()) }).passthrough() });
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

export function createPruning(ctx: Ctx, policy: () => FleetPolicy, policyError: () => string | null) {
  const service = <T,>(name: string): T | undefined => ctx.services.get(name);
  const workers = () => ctx.service<WorkersApi>("workers");
  const herdr = () => ctx.service<HerdrApi>("herdr");
  const intents = () => ctx.service<IntentsApi>("intents");
  const proposals = (): PruneProposal[] => Props.parse(kvGet(ctx.db, "fleet:prunes", []));
  const save = (ps: PruneProposal[]) => { kvSet(ctx.db, "fleet:prunes", ps); ctx.bus.change({ entity: "fleet" }); };
  initPreservationFake();

  function propose(worker: string, reason: string): PruneProposal {
    const w = workers().get(worker);
    if (!w) throw new IntentError(`Worker ${worker} is not running. Refresh the fleet.`);
    if (w.owner.tier !== "watched") throw new IntentError("Only watched sessions can be proposed for retirement.", { refused: w.owner.tier });
    const shared = workers().list().filter((x) => x.cwd === w.cwd).length;
    let checkout: string;
    try {
      const git = gitContext(w.cwd);
      checkout = `Repo ${git.repo ?? "none"}; branch ${git.branch ?? "none"}; ${git.dirty ? "uncommitted changes" : "clean"}; unpushed ${git.unpushed ?? "unknown"}. ${shared > 1 ? `Shared by ${shared} sessions; changes are not attributable.` : "One session in this folder."}${git.dirty ? " Ask the session to commit or write a handoff first if needed." : ""}`;
    } catch (e) { checkout = `Checkout status unavailable: ${errorText(e)}`; }
    const all = proposals();
    const old = all.find((p) => p.worker === worker && p.session === w.session && p.status === "pending" && Date.parse(p.expires) > Date.now());
    if (old) {
      if (old.reason !== reason) { const next = { ...old, reason, checkout, shared }; save(all.map((p) => p.id === old.id ? next : p)); return next; }
      return old;
    }
    const created = new Date().toISOString();
    const p: PruneProposal = { id: `prune-${sha256(`${worker}:${w.session}:${created}`).slice(0, 16)}`, worker, session: w.session, title: w.title, mission: w.mission, reason, checkout, shared, created, expires: new Date(Date.now() + policy().pruning.proposal_days * D).toISOString(), status: "pending" };
    save([...all, p]);
    return p;
  }

  function asks(): Ask[] {
    return proposals().filter((p) => p.status === "pending" && Date.parse(p.expires) > Date.now()).map((p) => ({
      id: p.id, kind: "approval", source: "fleet", title: `Retire ${p.title || p.worker}`, question: p.reason, preamble: `Save the session before closing its idle pane. ${p.checkout}`,
      calls: [{ n: null, question: p.reason, options: [{ id: "A", label: "Preserve and close when eligible", recommended: false }, { id: "B", label: "Keep the pane open", recommended: false }] }],
      options_source: "parsed", recommended_answer: null, needs_you: true, owner: "captain", state: "Prune proposed", level: "L2", task: null,
      worker: p.worker, session: p.session, mission: p.mission, place: { on: "worker", id: p.worker }, answer: { via: "prune", target: p.id },
      opened: p.created, read_only: null, ref: { prune: p.id, checkout: p.checkout, shared: p.shared, expires: p.expires, decide: `/api/fleet/prunes/${p.id}/decide` },
    }));
  }

  function lastActivity(w: WorkerView): number | null {
    const s = w.session ? service<SessionsService>("sessions")?.get(w.session) : null;
    if (!s) return null;
    const row = ctx.db.prepare(`SELECT MAX(ts) AS at FROM events
      WHERE ts > ? AND ((session = ? AND agent = ?) OR json_extract(json, '$.data.worker') = ? OR json_extract(json, '$.data.target') = ? OR json_extract(json, '$.data.session') = ?)
      AND (type IN ('prompt.submit','tool.pre','turn.stop','turn.stop_failure','steer.attributed') OR (type = 'intent.sent' AND json_extract(json, '$.data.kind') = 'reply'))`).get(s.updated, s.id, s.source, w.id, w.id, w.session);
    const latest = z.object({ at: z.string().nullable() }).parse(row).at;
    const at = Math.max(Date.parse(s.updated), latest ? Date.parse(latest) : 0);
    return Number.isFinite(at) ? at : null;
  }

  function refusal(w: WorkerView): string | null {
    if (w.owner.tier !== "watched") return `${w.owner.tier} sessions are never closed by fleet pruning`;
    if (policyError()) return "fleet.yaml is unreadable or invalid; fix it before pruning";
    if (w.helm?.by === "captain") return "the captain holds the helm";
    if (!w.pane || !w.controllable) return "the worker is not in a connected Herdr pane";
    if (w.machine !== herdr().defaultMachine()) return "remote preservation is not supported; save it on its own machine";
    if (!w.session || !w.cwd || !["claude", "codex"].includes(w.agent)) return "a supported session id and folder are required";
    if (!["idle", "done"].includes(w.status)) return `the agent is ${w.status}, not idle`;
    const at = lastActivity(w);
    if (at == null) return "the session has no readable last-turn timestamp";
    if (Date.now() - at < policy().pruning.idle_hours * H) return `idle less than ${policy().pruning.idle_hours} hours`;
    const recent = ctx.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE ts >= ?
      AND ((type = 'steer.attributed' AND json_extract(json, '$.data.by') = 'captain') OR (type = 'intent.sent' AND json_extract(json, '$.data.kind') = 'reply' AND COALESCE(json_extract(json, '$.data.origin'), 'captain') = 'captain'))
      AND (json_extract(json, '$.data.worker') = ? OR json_extract(json, '$.data.target') = ? OR json_extract(json, '$.data.session') = ?)`).get(new Date(Date.now() - D).toISOString(), w.id, w.id, w.session);
    if (z.object({ n: z.number() }).parse(recent).n) return "the captain steered it within the last 24 hours";
    const attention = service<{ list(o: { open: boolean }): AttentionItem[] }>("attention");
    const guard = service<{ pending(): GuardRequest[] }>("guard");
    if (!attention || !guard) return "attention or guard state is unavailable";
    if (attention.list({ open: true }).some((a) => a.worker === w.id || a.session === w.session)) return "the session has open attention";
    if (guard.pending().some((g) => g.session === w.session || g.session === w.session?.split(":").slice(1).join(":"))) return "the session has a pending guard request";
    return null;
  }

  async function check(w: WorkerView, fresh = false) {
    const why = refusal(w);
    if (why) throw new IntentError(`Cannot retire ${w.title || w.id}: ${why}.`, { refused: w.helm?.by === "captain" ? "captain_helm" : w.owner.tier !== "watched" ? w.owner.tier : "not_eligible" });
    if (fresh) {
      const result = AgentList.parse(await herdr().call("agent.list", {}, { machine: w.machine }));
      const a = result.agents.find((a) => a.pane_id === w.pane);
      if (!a || !["idle", "done"].includes(a.agent_status ?? a.status ?? "")) throw new IntentError("The pane is no longer confirmed idle; nothing was closed.", { refused: "not_idle" });
      const panes = PaneList.parse(await herdr().call("pane.list", {}, { machine: w.machine }));
      const ref = a.agent_session ?? panes.panes.find((p) => p.pane_id === w.pane)?.agent_session;
      const id = sessionIdFromRef(ref);
      let confirmed = id != null && `${toAgentKind(ref?.agent)}:${id}` === w.session;
      // Herdr can omit native references for Claude. Verify its current foreground process against
      // the session's own live registry instead of trusting cached hooks or a cached pid.
      if (!ref && w.agent === "claude") {
        const session = service<SessionsService>("sessions")?.get(w.session!);
        if (session) {
          const info = ProcessInfo.parse(await herdr().call("pane.process_info", { pane_id: w.pane }, { machine: w.machine }));
          const pids = new Set(info.process_info.foreground_processes.map((p) => p.pid));
          const live = readClaudeRegistry(path.join(sessionConfigDir(w.agent, session.transcript), "sessions")).filter((r) => r.alive && pids.has(r.pid));
          confirmed = live.length === 1 && `claude:${live[0].sessionId}` === w.session && fs.realpathSync(live[0].cwd) === fs.realpathSync(w.cwd);
        }
      }
      if (!confirmed) throw new IntentError("Herdr cannot confirm the same session is still in this pane; nothing was closed.", { refused: "changed" });
    }
    const read = z.object({ read: z.object({ text: z.string() }) }).parse(await herdr().call("pane.read", { pane_id: w.pane, source: "visible", format: "ansi", strip_ansi: false, lines: 60 }, { machine: w.machine }));
    const screen = read.read.text;
    const composer = readComposer(screen, w.agent);
    if (!composer.found || composer.text.trim()) throw new IntentError(composer.found ? "The input box holds a draft; nothing was closed." : "The input box could not be read; nothing was closed.", { refused: "composer_draft" });
  }

  async function candidates(): Promise<PruneCandidate[]> {
    const all = workers().list();
    const result: PruneCandidate[] = [];
    for (const w of all) {
      let why = refusal(w), git: ReturnType<typeof gitContext> | null = null;
      if (!why) {
        try { await check(w); git = gitContext(w.cwd); } catch (e) { why = errorText(e); }
      }
      const at = lastActivity(w);
      result.push({ worker: w.id, session: w.session, title: w.title, eligible: !why, why: why ?? `Idle at least ${policy().pruning.idle_hours} hours; preserve context and artifacts, then close only the pane`, idle_hours: at == null ? null : (Date.now() - at) / H, git, shared: all.filter((x) => x.cwd === w.cwd).length });
    }
    return result;
  }

  const retiring = new Set<string>();
  intents().registerHandler("retire_worker", async (it) => {
    if (it.origin === "evolution") throw new IntentError("Evolution cannot retire sessions.", { refused: "origin" });
    if (it.origin === "firstmate" && !policy().authority.includes("retire_worker")) throw new IntentError("fleet.yaml does not grant retire_worker authority.", { refused: "authority" });
    if (retiring.has(it.target)) throw new IntentError("This worker is already being preserved; wait for that intent.", { refused: "in_progress" });
    const w = workers().get(it.target);
    if (!w) throw new IntentError("The worker is no longer live; resume its saved session instead.", { refused: "not_live" });
    retiring.add(w.id);
    try {
      await check(w, true);
      const saved = await preserveSession(ctx, w);
      const current = workers().get(w.id);
      if (!current || current.session !== w.session || current.cwd !== w.cwd) throw new IntentError("The pane changed while saving; nothing was closed.", { refused: "changed" });
      await check(current, true);
      const session = ctx.service<SessionsService>("sessions").get(w.session!);
      if (!session || fileSignature(session.transcript) !== saved.signature) throw new IntentError("The transcript changed while saving; nothing was closed.", { refused: "changed" });
      const after = gitContext(w.cwd);
      let unchanged = JSON.stringify(after) === JSON.stringify(saved.git);
      // When this session works in Joyride's data repo, preservation itself creates authored commits.
      // Accept only those commits; user changes to the branch, dirty status or other paths still refuse.
      if (!unchanged && saved.git.repo === fs.realpathSync(paths.root) && after.repo === fs.realpathSync(paths.root) && after.branch === saved.git.branch && after.status === saved.git.status && saved.git.head && after.head) {
        const changed = execFileSync("git", ["diff", "--name-only", `${saved.git.head}..${after.head}`], { cwd: paths.root, encoding: "utf8" }).trim().split("\n").filter(Boolean);
        unchanged = changed.length > 0 && changed.every((file) => file.startsWith("artifacts/"));
      }
      if (!unchanged) throw new IntentError("The checkout changed while saving; nothing was closed.", { refused: "changed" });
      for (const output of saved.outputs) if (output.path && fileSignature(output.path) !== output.snapshot) throw new IntentError("An output changed while saving; nothing was closed.", { refused: "changed" });
      // Herdr closes only this pane's process. No checkout, transcript or git mutation occurs here.
      await herdr().call("pane.close", { pane_id: w.pane }, { machine: w.machine });
      try {
        save(proposals().map((p) => p.worker === w.id && p.session === w.session && p.status === "pending" ? { ...p, status: "closed" } : p));
        ctx.emit({ source: "fleet", type: "fleet.member.retired", data: { worker: w.id, session: w.session, artifact: saved.artifact, resume: saved.resume } });
      } catch (e) { ctx.log(`fleet: ${w.id} closed with artifact ${saved.artifact}, but retirement bookkeeping failed: ${errorText(e)}`); }
      return { worker: w.id, ...saved, closed: true };
    } catch (e) {
      if (w.owner.tier === "watched") propose(w.id, `Preserve and close failed: ${errorText(e)} Review the saved context and fix the failure before retrying.`);
      throw e instanceof IntentError ? e : new IntentError(`Preservation failed: ${errorText(e)} The pane stays open; review its prune ask.`, { refused: "preserve_failed" });
    } finally { retiring.delete(w.id); }
  });

  async function decide(id: string, approve: boolean) {
    const p = proposals().find((p) => p.id === id);
    if (p?.status === "closed" && approve) return { proposal: id, status: "closed", replay: true };
    if (p?.status === "rejected" && !approve) return { proposal: id, status: "rejected", replay: true };
    if (!p || p.status !== "pending" || Date.parse(p.expires) <= Date.now()) throw new IntentError("This prune proposal is no longer pending.");
    if (!approve) { save(proposals().map((x) => x.id === id ? { ...x, status: "rejected" } : x)); return { proposal: id, status: "rejected" }; }
    if (workers().get(p.worker)?.session !== p.session) throw new IntentError("The pane now has a different session; propose its current session instead.");
    return intents().create("retire_worker", p.worker, {}, { origin: "captain" });
  }

  function housekeeping() {
    const at = Date.now();
    const all = proposals();
    const next = all.map((p) => p.status === "pending" && Date.parse(p.expires) <= at ? { ...p, status: "expired" as const } : p);
    if (next.some((p, i) => p.status !== all[i].status)) save(next);
    if (policyError()) return;
    service<MissionsService>("missions")?.pruneHistory(policy().pruning);
  }
  let tick: NodeJS.Timeout | null = null;
  let off: (() => void) | undefined;
  return { candidates, propose, proposals, asks, decide, housekeeping,
    retire: (worker: string) => intents().create("retire_worker", worker, {}, { origin: "firstmate" }),
    start() { off = service<AsksApi>("asks")?.registerSource("fleet-prunes", asks); housekeeping(); tick = setInterval(() => { try { housekeeping(); } catch (e) { ctx.log(`fleet: pruning failed: ${errorText(e)}`); } }, 3600e3); tick.unref(); },
    stop() { if (tick) clearInterval(tick); off?.(); },
  };
}
