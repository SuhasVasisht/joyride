// Missions and lenses: authored files in git (missions/*.md, lenses/*.yaml),
// derived health, done-gating on evidence, and backfill proposals that turn
// unassigned session history into missions.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { knowledgePolicy } from "../../core/knowledge-policy.ts";
import { defineModule, type Ctx } from "../../core/context.ts";
import { commitFiles, commitPaths, fileAt } from "../../core/gitstore.ts";
import { kvGet, kvSet } from "../../core/db.ts";
import { ensureDir, git, now, readJson, repoName, slugify, writeFileAtomic, writeJsonAtomic } from "../../core/util.ts";
import { paths } from "../../shared/paths.ts";
import { DoneCriterion, LEVEL_RANK, Lens, Mission, MissionState, SessionRef, type Level, type WorkerView } from "../../shared/schema.ts";
import { MapActor } from "../../shared/map-actions.ts";
import { readMapHistory, type MapHistoryEntry } from "./map-history.ts";
import { PlaceInput, nextLayout, readLayout, renderLayout, type GroupPos } from "./layout.ts";
import { lensNames, primaryLens } from "../../shared/lens-match.ts";
import type { SessionItem, SessionsService } from "../sessions/types.ts";
import { ID_RE, StoredProposal, dedupeRefs, readLensDir, readMissionDir, refKey, renderLens, renderMission } from "./store.ts";
import { clusterId, clusterSessions, describeCluster, nameClusters, normBranch, placeOf, suggestMerge, type Cluster } from "./backfill.ts";
import { NotFound, createProposalContext, type ProposalContext, type ProposalSummary, type BatchState } from "./proposal-context.ts";

export { normBranch, clusterSessions, placeOf } from "./backfill.ts";
export type { StoredProposal } from "./store.ts";
export type { ProposalContext, ProposalSummary } from "./proposal-context.ts";

type MissionHealth = "active" | "blocked" | "needs-review" | "idle";
export type MissionWithHealth = Mission & { health: MissionHealth; health_why: string };
type RefInput = string | SessionRef;

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export type BackfillResult = {
  ok: boolean;
  error?: string;
  considered: number;
  clusters: number;
  created: string[];
  kept: string[];
  skipped: string[];
  superseded: string[];
  merge_suggestions: number;
  naming: { calls: number; fallbacks: number };
  archived: { sessions: number; missions: string[]; commit: string | null };
  ms: number;
};

export type MissionsService = {
  list(opts?: { state?: string; archive?: boolean }): MissionWithHealth[];
  get(id: string): Mission | null;
  save(m: Mission, msg?: string): Mission;
  create(partial: Partial<Mission> & { title: string }, msg?: string): Mission;
  linkSessions(id: string, refs: RefInput[], msg?: string): Mission;
  unlinkSession(id: string, key: string): Mission;
  missionOfSession(keyOrRawId: string): string | null;
  setState(id: string, state: string, reason?: string): Promise<Mission>;
  proposals(opts?: { status?: string }): StoredProposal[];
  acceptProposal(id: string, edits?: Record<string, any>): Promise<{ proposal: StoredProposal; mission: Mission }>;
  rejectProposal(id: string, reason?: string): StoredProposal;
  runBackfill(): Promise<BackfillResult>;
  pruneHistory(policy: { proposal_days: number; archive_days: number }): { expired: number; archived: number };
  /** Regroup from the map; returns the commit to hand to undoMove. */
  move(input: MoveInput): MoveResult;
  undoMove(commit: string, actor?: MapActor): MoveResult;
  mapHistory(): MapHistoryEntry[];
  /** Where the captain placed groups on the map (near units), in the order they were placed. */
  mapLayout(): Map<string, GroupPos>;
  placeGroups(input: unknown): MoveResult & { group: string };
  /** Write several missions and lenses as one commit (housekeeping); returns the sha, or null when nothing changed. */
  applyGrouping(change: { missions: Mission[]; lenses: Lens[] }, msg: string): string | null;
  /** Undo a housekeeping commit the way undoMove undoes a map move. */
  undoHousekeeping(commit: string, actor?: MapActor): MoveResult;
  /** The mission whose authored crews list names this Firstmate task. */
  missionOfTask(task: string): string | null;
  /** Put a decided proposal back in the queue; an accepted one gives its sessions back unless restore is false. */
  reopenProposal(id: string, opts?: { restore?: boolean }): { proposal: StoredProposal; commit: string | null; message: string };
  health(id: string): MissionHealth;
  healthDetail(id: string): { health: MissionHealth; why: string };
  /** Resolves when start-up work (first-run backfill) has finished. */
  settled(): Promise<void>;
  /** What a proposal's sessions did, why they were grouped, noise, and the cached brief. */
  proposalContext(id: string, opts?: { wait?: boolean; retry?: boolean }): Promise<ProposalContext>;
  proposalSummary(): Promise<ProposalSummary>;
  /** Brief every pending proposal that lacks a fresh brief (the background batch). */
  runBriefs(): Promise<BatchState>;
  /** Resolves when no brief work is running (tests). */
  briefsIdle(): Promise<void>;
  /**
   * Set an unfiled session or worker aside: it leaves the map until it does something new (its
   * `updated` passes the time it was set aside). Agents and the fleet page still list it.
   */
  hideOnMap(key: string, actor?: MapActor): { key: string; at: string; message: string };
  unhideOnMap(key: string, actor?: MapActor): { key: string; message: string };
  hiddenOnMap(): Record<string, string>;
};

/**
 * A regroup on the map: a session to a mission (null = Unfiled), a Firstmate task to a mission (always
 * one: a task never goes back to Unfiled), or a mission to a lens (null = back to its repo group).
 */
export type MoveInput = { actor?: MapActor } & (
  | { session: string; to: { mission: string | null } | { lens: string } | { new_lens: string } }
  | { task: string; to: { mission: string } | string }
  | { mission: string; from?: string | null; to: { lens?: string | null } | { new_lens: string } });
export type MoveResult = { commit: string | null; message: string; lens?: string | null };

/**
 * Renaming a group on the map: a lens keeps its id and takes the new title; an Unfiled group (by its
 * project key) or a repo group (by its repo path, "" for No repo) becomes a new lens that keeps what it held.
 */
export type RenameGroupInput = { title: string; actor?: MapActor } & ({ lens: string } | { unfiled: string } | { repo: string });
export type GroupResult = MoveResult & { lens?: string | null };

export type LensesService = {
  list(): Lens[]; get(id: string): Lens | null; save(l: Partial<Lens> & { title: string }): Lens; remove(id: string): boolean;
  /** The map's group operations: each is one "map move" commit, undone with missions.undoMove(commit). */
  createGroup(input: { title: string; actor?: MapActor }): GroupResult;
  renameGroup(input: RenameGroupInput): GroupResult;
  deleteGroup(input: { lens: string; actor?: MapActor }): GroupResult;
  mergeGroup(input: { lens: string; into: string; actor?: MapActor }): GroupResult;
};

const ACTIVE_MS = 30 * 60e3;
const TASK_RE = /^[A-Za-z0-9._-]{1,128}$/;
const BACKFILL_KV = "missions:backfill_done";
const disposers: (() => void)[] = [];

function checkId(id: string) {
  if (!ID_RE.test(id)) throw new HttpError(400, `"${id}" is not a valid id. Use lowercase letters, digits and dashes.`);
  return id;
}

/** done_when may arrive as strings or partial criteria; give every criterion an id. */
function normCriteria(list: unknown): z.infer<typeof DoneCriterion>[] | undefined {
  if (!Array.isArray(list)) return undefined;
  return list.map((c, i) => DoneCriterion.parse(typeof c === "string" ? { id: `c${i + 1}`, text: c } : { id: (c as any)?.id ?? `c${i + 1}`, ...(c as object) }));
}

function zodMessage(e: any): string {
  if (Array.isArray(e?.issues)) return e.issues.map((i: any) => `${(i.path ?? []).join(".") || "value"}: ${i.message}`).join("; ");
  return String(e?.message ?? e);
}

export default defineModule({
  name: "missions",
  order: 15,

  register(ctx: Ctx) {
    const { app, db } = ctx;
    const missions = new Map<string, Mission>();
    const bySession = new Map<string, string>();
    const byRawId = new Map<string, string>();
    const sessions = (): SessionsService | undefined => ctx.services.get("sessions");
    const optional = (name: string): any => ctx.services.get(name);
    const missionFile = (id: string) => path.join(paths.missions, `${id}.md`);
    const lensFile = (id: string) => path.join(paths.lenses, `${id}.yaml`);
    const proposalDir = () => path.join(paths.proposals, "missions");

    // ---------- index ----------
    function reindexSessions() {
      bySession.clear(); byRawId.clear();
      // Regular missions win over archive missions if a session is in both.
      const ordered = [...missions.values()].sort((a, b) => Number(b.archive) - Number(a.archive));
      for (const m of ordered) for (const r of m.sessions) { bySession.set(refKey(r), m.id); byRawId.set(r.id, m.id); }
    }
    function reload(): boolean {
      const { missions: list, errors } = readMissionDir(paths.missions);
      for (const e of errors) ctx.log(`missions: skipping ${e.file}: ${e.error}`);
      const before = JSON.stringify([...missions.values()]);
      const keep = new Map(missions);
      missions.clear();
      for (const m of list) missions.set(m.id, m);
      // A file that fails to parse keeps its last good version.
      for (const e of errors) { const id = path.basename(e.file, ".md"); const prev = keep.get(id); if (prev && fs.existsSync(e.file)) missions.set(id, prev); }
      reindexSessions();
      return JSON.stringify([...missions.values()]) !== before;
    }
    reload();

    /** The commit the last persist made (null when nothing changed): moves hand it back for undo. */
    let lastCommit: string | null = null;
    /** Write mission files (plus any lens files already written) and commit them together. */
    function persist(list: Mission[], msg: string, lensIds: string[] = []): string | null {
      ensureDir(paths.missions);
      for (const m of list) {
        checkId(m.id);
        writeFileAtomic(missionFile(m.id), renderMission(m));
        missions.set(m.id, m);
      }
      reindexSessions();
      const sha = commitPaths([...list.map((m) => missionFile(m.id)), ...lensIds.map(lensFile)], msg);
      lastCommit = sha;
      for (const m of list) ctx.bus.change({ entity: "missions", id: m.id });
      for (const id of lensIds) ctx.bus.change({ entity: "lenses", id });
      return sha;
    }

    const uniqueId = (base: string) => {
      const b = slugify(base) || "mission";
      if (!missions.has(b) && !fs.existsSync(missionFile(b))) return b;
      for (let i = 2; ; i++) { const id = `${b}-${i}`; if (!missions.has(id) && !fs.existsSync(missionFile(id))) return id; }
    };

    function toRef(x: RefInput): SessionRef | null {
      if (typeof x === "string") {
        const i = x.indexOf(":");
        if (i > 0) {
          const src = x.slice(0, i), id = x.slice(i + 1).trim();
          if (src === "claude" || src === "codex") return id ? { source: src, id } : null;
        }
        const v = sessions()?.get(x);
        return v ? { source: v.source, id: v.id } : null;
      }
      const p = SessionRef.safeParse(x);
      return p.success && p.data.id.trim() ? p.data : null;
    }
    function toRefs(list: unknown): SessionRef[] {
      if (!Array.isArray(list)) return [];
      const out: SessionRef[] = [];
      for (const x of list) { const r = toRef(x as RefInput); if (!r) throw new HttpError(400, `Unknown session ${JSON.stringify(x)}. Use a key like claude:<id> or codex:<id>.`); out.push(r); }
      return dedupeRefs(out);
    }

    /** Remove these sessions from every other mission (one session belongs to one mission). */
    function detachElsewhere(keys: Set<string>, exceptId: string): Mission[] {
      const changed: Mission[] = [];
      for (const m of missions.values()) {
        if (m.id === exceptId || !m.sessions.some((r) => keys.has(refKey(r)))) continue;
        changed.push({ ...m, sessions: m.sessions.filter((r) => !keys.has(refKey(r))), updated: now() });
      }
      return changed;
    }

    function addContext(m: Mission, refs: SessionRef[]): Mission {
      const repos = new Set(m.repos), branches = new Set(m.branches);
      for (const r of refs) {
        const v = sessions()?.get(refKey(r));
        if (v?.repo) repos.add(v.repo);
        if (v?.branch) branches.add(v.branch);
      }
      return { ...m, repos: [...repos], branches: [...branches] };
    }

    // ---------- health ----------
    function healthDetail(id: string): { health: MissionHealth; why: string } {
      const m = missions.get(id);
      if (!m) throw new HttpError(404, `No idea ${id}.`);
      if (m.archive) return { health: "idle", why: "archive" };
      if (m.state === "done" || m.state === "dropped") return { health: "idle", why: `mission is ${m.state}` };
      const keys = new Set(m.sessions.map(refKey));
      let items: any[] = [];
      try {
        const r = optional("attention")?.list({ open: true });
        if (Array.isArray(r)) items = r.filter((i) => !i.resolved && (i.mission === id || (i.session && keys.has(i.session))));
      } catch {}
      let workers: any[] = [];
      try { const w = optional("workers")?.byMission(id); if (Array.isArray(w)) workers = w; } catch {}
      const rank = (l: string) => LEVEL_RANK[l as Level] ?? 0;
      const urgent = items.find((i) => rank(i.level) >= 3);
      if (urgent) return { health: "blocked", why: urgent.title || `open ${urgent.level} item` };
      const stuck = workers.find((w) => w.status === "blocked");
      if (stuck) return { health: "blocked", why: `worker ${stuck.id} is blocked` };
      const review = items.find((i) => i.level === "L2");
      if (review) return { health: "needs-review", why: review.title || "open review item" };
      if (m.done_when.length) {
        try {
          const ev = optional("evidence");
          const list = ev?.list({ mission: id });
          const verdict = ev?.latestVerdict(id);
          if (Array.isArray(list) && list.length && !(verdict instanceof Promise)) {
            const newest = list.reduce((a: string, e: any) => (e.created > a ? e.created : a), "");
            if (!verdict || newest > verdict.created) return { health: "needs-review", why: "evidence is waiting for a verdict" };
          }
        } catch {}
      }
      if (workers.some((w) => w.status === "working")) return { health: "active", why: "a worker is running" };
      const cutoff = new Date(Date.now() - ACTIVE_MS).toISOString();
      const s = sessions();
      if (s) for (const k of keys) { const v = s.get(k); if (v && v.updated >= cutoff) return { health: "active", why: `session updated ${v.updated}` }; }
      return { health: "idle", why: "no recent session activity" };
    }
    const withHealth = (m: Mission): MissionWithHealth => {
      let h: { health: MissionHealth; why: string };
      try { h = healthDetail(m.id); } catch { h = { health: "idle", why: "" }; }
      return { ...m, health: h.health, health_why: h.why };
    };

    // ---------- proposals ----------
    const proposalPath = (id: string) => path.join(proposalDir(), `${checkId(id)}.json`);
    function readProposals(): StoredProposal[] {
      let names: string[] = [];
      try { names = fs.readdirSync(proposalDir()).filter((n) => n.endsWith(".json")); } catch { return []; }
      const out: StoredProposal[] = [];
      for (const n of names) {
        const p = StoredProposal.safeParse(readJson(path.join(proposalDir(), n), null));
        if (p.success && p.data.sessions.every(r => knowledgePolicy(ctx).admits({ session: refKey(r) }))) out.push(p.data);
      }
      return out.sort((a, b) => b.last_ts.localeCompare(a.last_ts));
    }
    const getProposal = (id: string): StoredProposal | null => {
      const p = StoredProposal.safeParse(readJson(proposalPath(id), null));
      return p.success && p.data.sessions.every(r => knowledgePolicy(ctx).admits({ session: refKey(r) })) ? p.data : null;
    };
    const writeProposal = (p: StoredProposal) => writeJsonAtomic(proposalPath(p.id), p);

    // ---------- backfill ----------
    let backfillChain: Promise<unknown> = Promise.resolve();

    async function doBackfill(): Promise<BackfillResult> {
      const t0 = Date.now();
      const res: BackfillResult = { ok: true, considered: 0, clusters: 0, created: [], kept: [], skipped: [], superseded: [], merge_suggestions: 0, naming: { calls: 0, fallbacks: 0 }, archived: { sessions: 0, missions: [], commit: null }, ms: 0 };
      const s = sessions();
      if (!s) return { ...res, ok: false, error: "The sessions module is not loaded, so there is no history to backfill." };
      await s.ready();
      const days = ctx.config.backfill_days;
      const horizon = new Date(Date.now() - days * 864e5).toISOString();
      const all = s.list({ limit: 100_000 }).filter((v) => !missionOfSession(v.key) && knowledgePolicy(ctx).admits({ session: v.key, cwd: v.cwd }));
      const recent = all.filter((v) => v.updated >= horizon);
      const old = all.filter((v) => v.updated < horizon);
      res.considered = all.length;

      // 1. cluster recent sessions
      const clusters = clusterSessions(recent);
      res.clusters = clusters.length;
      const existing = new Map(readProposals().map((p) => [p.id, p]));
      const fresh: { id: string; c: Cluster; merge: string | null }[] = [];
      const regenerated = new Set<string>();
      for (const c of clusters) {
        const id = clusterId(c);
        regenerated.add(id);
        const prev = existing.get(id);
        if (prev) { (prev.status === "pending" ? res.kept : res.skipped).push(id); continue; }
        fresh.push({ id, c, merge: null });
      }
      // 2. Jev: part of an open mission in the same repo?
      const open = [...missions.values()].filter((m) => m.state === "open" && !m.archive);
      for (const f of fresh) {
        const inRepo = f.c.repo ? open.filter((m) => m.repos.includes(f.c.repo!)) : [];
        f.merge = await suggestMerge(f.c, inRepo);
        if (f.merge) res.merge_suggestions++;
      }
      // 3. name the new clusters with the heavy model, in batches
      const toName = fresh.filter((f) => !f.merge);
      const named = await nameClusters(toName.map((f) => f.c), ctx.log);
      res.naming = { calls: named.calls, fallbacks: named.fallbacks };
      const names = new Map(toName.map((f, i) => [f.id, named.names[i]]));
      // 4. store proposals
      for (const f of fresh) {
        const target = f.merge ? missions.get(f.merge) : null;
        const name = names.get(f.id) ?? { title: target?.title ?? "Untitled", goal: target?.goal ?? "" };
        writeProposal(StoredProposal.parse({
          id: f.id, title: name.title, goal: name.goal, repos: f.c.repo ? [f.c.repo] : [], branches: f.c.branches,
          sessions: f.c.sessions.map((v) => ({ source: v.source, id: v.id })), first_ts: f.c.first, last_ts: f.c.last,
          status: "pending", reason: target ? `${describeCluster(f.c)}. Looks like part of "${target.title}".` : describeCluster(f.c),
          merge_into: f.merge, created: now(),
        }));
        res.created.push(f.id);
      }
      // Pending proposals whose session set no longer forms a cluster are stale.
      for (const p of existing.values()) {
        if (p.status !== "pending" || regenerated.has(p.id)) continue;
        try { fs.rmSync(proposalPath(p.id), { force: true }); res.superseded.push(p.id); } catch {}
      }
      // 5. older sessions fold into one archive mission per repo, one commit for all
      if (old.length) {
        const groups = new Map<string, SessionItem[]>();
        for (const v of old) { const k = v.repo ?? ""; const g = groups.get(k); if (g) g.push(v); else groups.set(k, [v]); }
        const changed: Mission[] = [];
        const t = now();
        for (const [repo, list] of groups) {
          const label = repo ? repoName(repo) : "no-repo";
          const id = `archive-${slugify(label) || "repo"}`;
          const base = missions.get(id) ?? Mission.parse({
            id, title: `${repo ? label : "No repo"} archive`, state: "done", archive: true,
            goal: `Sessions${repo ? ` in ${repo}` : " outside any repo"} older than ${days} days, folded in by backfill.`,
            repos: repo ? [repo] : [], created: t, updated: t,
          });
          const refs = list.sort((a, b) => a.started.localeCompare(b.started)).map((v) => ({ source: v.source, id: v.id }));
          changed.push({ ...base, archive: true, repos: repo && !base.repos.includes(repo) ? [...base.repos, repo] : base.repos, sessions: dedupeRefs([...base.sessions, ...refs]), updated: t });
          res.archived.sessions += refs.length;
          res.archived.missions.push(id);
        }
        res.archived.commit = persist(changed, `archive ${res.archived.sessions} sessions older than ${days} days into ${changed.length} archive mission${changed.length === 1 ? "" : "s"}`);
      }
      kvSet(db, BACKFILL_KV, { at: now(), created: res.created.length, archived: res.archived.sessions });
      if (res.created.length || res.superseded.length) ctx.bus.change({ entity: "proposals" });
      res.ms = Date.now() - t0;
      ctx.log(`missions: backfill ${res.clusters} clusters, ${res.created.length} new proposals, ${res.archived.sessions} sessions archived (${res.ms}ms)`);
      return res;
    }
    const runBackfill = (): Promise<BackfillResult> => {
      const p = backfillChain.then(doBackfill);
      backfillChain = p.catch(() => {});
      return p;
    };

    function pruneHistory(policy: { proposal_days: number; archive_days: number }) {
      const at = Date.now();
      const live = new Set((optional("workers")?.list() ?? []).map((w: { session: string | null }) => w.session));
      const expired = readProposals().filter((p) => p.status === "pending" && Date.parse(p.created ?? p.last_ts) <= at - policy.proposal_days * 864e5);
      const keys = new Set<string>();
      for (const p of expired) for (const ref of p.sessions) keys.add(refKey(ref));
      const all = sessions()?.list({ limit: 100_000 }) ?? [];
      for (const s of all) if (Date.parse(s.updated) <= at - policy.archive_days * 864e5) keys.add(s.key);
      const groups = new Map<string, SessionItem[]>();
      for (const s of all) {
        if (!keys.has(s.key) || live.has(s.key) || missionOfSession(s.key)) continue;
        const repo = s.repo ?? "";
        const list = groups.get(repo) ?? [];
        list.push(s); groups.set(repo, list);
      }
      let archived = 0;
      const changes: Mission[] = [];
      for (const [repo, list] of groups) {
        const label = repo ? repoName(repo) : "no-repo";
        const id = `archive-${slugify(label) || "repo"}`;
        const base = missions.get(id) ?? Mission.parse({ id, title: `${label} archive`, state: "done", archive: true, goal: "Preserved sessions from expired proposals and old unlinked history.", repos: repo ? [repo] : [], created: now(), updated: now() });
        changes.push({ ...base, sessions: dedupeRefs([...base.sessions, ...list.map((s) => ({ source: s.source, id: s.id }))]), updated: now() });
        archived += list.length;
      }
      if (changes.length) persist(changes, `prune: archive ${archived} sessions without deleting transcripts`);
      for (const p of expired) writeProposal({ ...p, status: "expired", decided_at: now(), decision_reason: "expired", mission: null });
      if (expired.length) ctx.bus.change({ entity: "proposals" });
      return { expired: expired.length, archived };
    }

    // ---------- service ----------
    function missionOfSession(keyOrRawId: string): string | null {
      if (!keyOrRawId) return null;
      return (keyOrRawId.includes(":") ? bySession.get(keyOrRawId) : byRawId.get(keyOrRawId)) ?? null;
    }

    function save(m: Mission, msg?: string): Mission {
      checkId(m.id);
      const v = Mission.parse({ ...m, updated: now() });
      persist([v], msg ?? `update mission ${v.id}`);
      return v;
    }

    function create(partial: Partial<Mission> & { title: string }, msg?: string): Mission {
      if (!partial?.title || !String(partial.title).trim()) throw new HttpError(400, "An idea needs a title.");
      const id = partial.id ? checkId(partial.id) : uniqueId(partial.title);
      if (missions.has(id)) throw new HttpError(409, `An idea with the id ${id} already exists. Pick another id or edit that idea.`);
      const t = now();
      const refs = toRefs(partial.sessions ?? []);
      let m: Mission;
      try { m = Mission.parse({ ...partial, id, title: String(partial.title).trim(), done_when: normCriteria(partial.done_when), sessions: refs, override: null, created: t, updated: t }); }
      catch (e) { throw new HttpError(400, zodMessage(e)); }
      if (refs.length) m = addContext(m, refs);
      persist([m, ...detachElsewhere(new Set(refs.map(refKey)), id)], msg ?? `create mission ${id}`);
      return m;
    }

    function linkSessions(id: string, input: RefInput[], msg?: string, lensIds: string[] = []): Mission {
      const m = missions.get(id);
      if (!m) throw new HttpError(404, `No idea ${id}.`);
      const refs = toRefs(input);
      if (!refs.length) return m;
      const next = addContext({ ...m, sessions: dedupeRefs([...m.sessions, ...refs]), updated: now() }, refs);
      persist([next, ...detachElsewhere(new Set(refs.map(refKey)), id)], msg ?? `link ${refs.length} session${refs.length === 1 ? "" : "s"} to ${id}`, lensIds);
      return next;
    }

    function unlinkSession(id: string, key: string): Mission {
      const m = missions.get(id);
      if (!m) throw new HttpError(404, `No idea ${id}.`);
      const ref = toRef(key);
      const k = ref ? refKey(ref) : key;
      const next = { ...m, sessions: m.sessions.filter((r) => refKey(r) !== k && r.id !== key), updated: now() };
      if (next.sessions.length === m.sessions.length) return m;
      persist([next], `unlink ${k} from ${id}`);
      return next;
    }

    // ---------- map moves ----------
    // Regrouping on the map edits authored files only: a session's mission (missions/*.md) and a
    // mission's lens (missions/*.md, lenses/*.yaml). One commit per move, so undo restores it exactly.
    function actorOf(value: unknown): MapActor | null {
      if (value === undefined) return null;
      const actor = MapActor.safeParse(value);
      if (!actor.success) throw new HttpError(400, "Send a valid agent actor {kind: agent, id, via: cli or mcp}.");
      return actor.data;
    }
    function attributedBy(value: unknown) {
      const actor = actorOf(value);
      return (message: string) => actor ? `${message}\n\nMap-actor: ${JSON.stringify(actor)}` : message;
    }

    function move(input: MoveInput): MoveResult {
      lastCommit = null;
      const attributed = attributedBy(input?.actor);
      if (input && "session" in input && typeof input.session === "string") {
        const ref = toRef(input.session);
        if (!ref) throw new HttpError(400, `Unknown session ${JSON.stringify(input.session)}. Use a key like claude:<id> or codex:<id>.`);
        const key = refKey(ref);
        const toIn: any = input.to ?? {};
        const lenses = lensService.list();
        // A group holds a session directly; it leaves every group when it moves to an idea or to Unfiled.
        const holders = lenses.filter((l) => l.sessions.includes(key));
        const from = missionOfSession(key);
        if ("lens" in toIn || "new_lens" in toIn) {
          let target: Lens;
          let created = false;
          if ("new_lens" in toIn) { target = Lens.parse({ id: newLensId(String(toIn.new_lens ?? ""), lenses), title: String(toIn.new_lens).trim() }); created = true; }
          else {
            const found = lenses.find((l) => l.id === toIn.lens);
            if (!found) throw new HttpError(404, `No group ${toIn.lens}.`);
            target = found;
          }
          if (!from && holders.length === 1 && holders[0].id === target.id) return { commit: null, message: "Already there." };
          const changed: Lens[] = holders.filter((l) => l.id !== target.id).map((l) => ({ ...l, sessions: l.sessions.filter((x) => x !== key) }));
          changed.push(target.sessions.includes(key) ? target : { ...target, sessions: [...target.sessions, key] });
          writeLenses(changed);
          const m = from ? missions.get(from)! : null;
          persist(m ? [{ ...m, sessions: m.sessions.filter((r) => refKey(r) !== key), updated: now() }] : [], attributed(`map move: session ${key} to lens ${target.id}${created ? " (new)" : ""}`), changed.map((l) => l.id));
          return { commit: lastCommit, lens: target.id, message: `Moved the session to ${created ? "the new group " : ""}${target.title}.` };
        }
        const to = toIn.mission ?? null;
        const changed: Lens[] = holders.map((l) => ({ ...l, sessions: l.sessions.filter((x) => x !== key) }));
        if (to === from && !changed.length) return { commit: null, message: "Already there." };
        if (to) {
          const target = missions.get(to);
          if (!target) throw new HttpError(404, `No idea ${to}.`);
          if (to === from) {
            writeLenses(changed);
            persist([], attributed(`map move: session ${key} to ${to}`), changed.map((l) => l.id));
          } else {
            writeLenses(changed);
            linkSessions(to, [ref], attributed(`map move: session ${key} to ${to}`), changed.map((l) => l.id));
          }
          return { commit: lastCommit, message: `Moved the session to ${target.title}.` };
        }
        writeLenses(changed);
        const m = from ? missions.get(from)! : null;
        persist(m ? [{ ...m, sessions: m.sessions.filter((r) => refKey(r) !== key), updated: now() }] : [], attributed(`map move: session ${key} out of ${m?.id ?? changed.map((l) => l.id).join(", ")}`), changed.map((l) => l.id));
        return { commit: lastCommit, message: `Moved the session out of ${m?.title ?? changed.map((l) => l.title).join(", ")}, to Unfiled.` };
      }
      if (input && "task" in input && typeof input.task === "string") {
        const task = input.task.trim();
        if (!TASK_RE.test(task)) throw new HttpError(400, `"${input.task}" is not a Firstmate task id.`);
        const raw: unknown = (input as any).to;
        const to = typeof raw === "string" ? raw : raw && typeof raw === "object" ? (raw as any).mission ?? null : null;
        if (!to) throw new HttpError(400, "A Firstmate task always sits in an idea. Drop it on another idea instead.");
        const target = missions.get(to);
        if (!target) throw new HttpError(404, `No idea ${to}.`);
        if (target.archive) throw new HttpError(409, `${target.title} is archived. Restore it first, or pick an open idea.`);
        const fm = optional("firstmate");
        if (fm && !fm.task(task)) throw new HttpError(404, `Firstmate has no task ${task}.`);
        const holders = [...missions.values()].filter((m) => m.crews.includes(task));
        if (holders.length === 1 && holders[0].id === to) return { commit: null, message: "Already there." };
        const t = now();
        const changed = holders.filter((m) => m.id !== to).map((m) => ({ ...m, crews: m.crews.filter((x) => x !== task), updated: t }));
        const next = target.crews.includes(task) ? target : { ...target, crews: [...target.crews, task], updated: t };
        persist([next, ...changed], attributed(`map move: task ${task} to ${to}`));
        return { commit: lastCommit, message: `Moved the task to ${target.title}.` };
      }
      if (input && "mission" in input && typeof input.mission === "string") {
        const m = missions.get(input.mission);
        if (!m) throw new HttpError(404, `No idea ${input.mission}.`);
        const lenses = lensService.list();
        const from = input.from === undefined ? primaryLens(m, lenses) ?? null : input.from ? lenses.find((l) => l.id === input.from) ?? null : null;
        const to = input.to ?? {};
        let target: Lens | null = null;
        let created = false;
        if ("new_lens" in to) {
          const title = String(to.new_lens ?? "").trim();
          target = Lens.parse({ id: newLensId(title, lenses), title });
          created = true;
        } else if (to.lens) {
          target = lenses.find((l) => l.id === to.lens) ?? null;
          if (!target) throw new HttpError(404, `No group ${to.lens}.`);
        }
        // The lens it leaves stops naming it; a lens that only picks it up by rule cannot be left by a move.
        const leaving = target ? (from && from.id !== target.id ? [from] : []) : lenses.filter((l) => lensNames(l, m));
        let lensIds = m.lenses.filter((id) => !leaving.some((l) => l.id === id));
        if (target) lensIds = [target.id, ...lensIds.filter((id) => id !== target!.id)];
        const next: Mission = { ...m, lenses: lensIds, updated: now() };
        const changed: Lens[] = leaving.filter((l) => l.missions.includes(m.id)).map((l) => ({ ...l, missions: l.missions.filter((x) => x !== m.id) }));
        if (created) changed.push(target!);
        if (!target) {
          const after = lenses.map((l) => changed.find((c) => c.id === l.id) ?? l);
          const still = primaryLens(next, after);
          if (still) throw new HttpError(409, `The group "${still.title}" picks this idea up by its rule, so a move can't take it out. Edit that group's rule instead.`);
        }
        if (JSON.stringify(next.lenses) === JSON.stringify(m.lenses) && !changed.length) return { commit: null, message: "Already there." };
        ensureDir(paths.lenses);
        for (const l of changed) writeFileAtomic(lensFile(l.id), renderLens(l));
        persist([next], attributed(target ? `map move: mission ${m.id} to lens ${target.id}${created ? " (new)" : ""}` : `map move: mission ${m.id} out of lens groups`), changed.map((l) => l.id));
        return {
          commit: lastCommit, lens: target?.id ?? null,
          message: target ? `Moved ${m.title} to ${created ? "the new group " : ""}${target.title}.` : `Moved ${m.title} back to its repo group.`,
        };
      }
      throw new HttpError(400, "Send {session, to: {mission} | {lens} | {new_lens}}, {task, to: {mission}} or {mission, from, to: {lens} | {new_lens}}.");
    }

    /** A free id for a new group named `title` (a group needs a name). */
    function newLensId(title: string, lenses: Lens[]): string {
      const t = title.trim();
      if (!t) throw new HttpError(400, "A new group needs a name.");
      const b = slugify(t) || "group";
      let id = b;
      for (let i = 2; lenses.some((l) => l.id === id) || fs.existsSync(lensFile(id)); i++) id = `${b}-${i}`;
      return id;
    }
    function writeLenses(list: Lens[]) {
      if (!list.length) return;
      ensureDir(paths.lenses);
      for (const l of list) writeFileAtomic(lensFile(l.id), renderLens(l));
    }

    // ---------- group operations (the map's New group, rename, delete and merge) ----------
    // Each is one "map move" commit over missions/ and lenses/, so undoMove takes it back exactly.
    // Members are never lost: a deleted group's ideas fall back to their next group or repo group,
    // its sessions and projects to their Unfiled groups; a merged group's members all join the other.
    const groupTitle = (title: unknown) => {
      const t = String(title ?? "").trim();
      if (!t) throw new HttpError(400, "A group needs a name.");
      if (t.length > 80) throw new HttpError(400, "Keep a group name under 80 characters.");
      return t;
    };
    const lensOrThrow = (lenses: Lens[], id: unknown) => {
      const l = lenses.find((x) => x.id === id);
      if (!l) throw new HttpError(404, `No group ${String(id)}.`);
      return l;
    };
    /** The ideas the map charts in this group: those whose primary lens it is. */
    const chartedIn = (l: Lens, lenses: Lens[]) => [...missions.values()].filter((m) => primaryLens(m, lenses)?.id === l.id);

    function createGroup(input: { title: string; actor?: MapActor }): GroupResult {
      const attributed = attributedBy(input?.actor);
      lastCommit = null;
      const title = groupTitle(input?.title);
      const lenses = lensService.list();
      const l = Lens.parse({ id: newLensId(title, lenses), title });
      writeLenses([l]);
      persist([], attributed(`map move: group ${l.id} created`), [l.id]);
      return { commit: lastCommit, lens: l.id, message: `Started the group ${title}. Drag ideas or sessions onto it.` };
    }

    function renameGroup(input: RenameGroupInput): GroupResult {
      const attributed = attributedBy(input?.actor);
      lastCommit = null;
      const title = groupTitle(input?.title);
      const lenses = lensService.list();
      if (input && "lens" in input) {
        const l = lensOrThrow(lenses, input.lens);
        if (l.title === title) return { commit: null, lens: l.id, message: "Already called that." };
        writeLenses([{ ...l, title }]);
        persist([], attributed(`map move: group ${l.id} renamed`), [l.id]);
        return { commit: lastCommit, lens: l.id, message: `Renamed ${l.title} to ${title}.` };
      }
      if (input && "unfiled" in input && typeof input.unfiled === "string") {
        // The project's unfiled work (live and quiet workers, recent sessions, proposals) now charts under the new group.
        const key = input.unfiled.trim().toLowerCase();
        const owner = lenses.find((l) => l.projects.includes(key));
        if (owner) throw new HttpError(409, `${owner.title} already holds this project's unfiled work. Rename that group instead.`);
        const l = Lens.parse({ id: newLensId(title, lenses), title, projects: [key] });
        writeLenses([l]);
        persist([], attributed(`map move: group ${l.id} from unfiled ${key || "(no project)"}`), [l.id]);
        return { commit: lastCommit, lens: l.id, message: `Unfiled is now the group ${title}, with everything it held.` };
      }
      if (input && "repo" in input && typeof input.repo === "string") {
        // A repo group is derived; renaming it names a group that lists the ideas it charted.
        const repo = input.repo;
        const ids = [...missions.values()].filter((m) => (m.repos[0] ?? "") === repo && !primaryLens(m, lenses)).map((m) => m.id);
        if (!ids.length) throw new HttpError(404, `No ideas sit in the repo group ${repo || "No repo"}.`);
        const l = Lens.parse({ id: newLensId(title, lenses), title, missions: ids });
        writeLenses([l]);
        persist([], attributed(`map move: group ${l.id} from repo ${repo || "(none)"}`), [l.id]);
        return { commit: lastCommit, lens: l.id, message: `The repo group is now ${title}, with its ${ids.length === 1 ? "idea" : `${ids.length} ideas`}.` };
      }
      throw new HttpError(400, "Send {lens, title}, {unfiled: <project key>, title} or {repo: <repo path>, title}.");
    }

    /** Take a group out: every idea stops naming it; its file goes. Returns the ideas that changed. */
    function stripLens(id: string): Mission[] {
      const t = now();
      return [...missions.values()].filter((m) => m.lenses.includes(id)).map((m) => ({ ...m, lenses: m.lenses.filter((x) => x !== id), updated: t }));
    }

    function deleteGroup(input: { lens: string; actor?: MapActor }): GroupResult {
      const attributed = attributedBy(input?.actor);
      lastCommit = null;
      const lenses = lensService.list();
      const l = lensOrThrow(lenses, input?.lens);
      const changed = stripLens(l.id);
      fs.rmSync(lensFile(l.id), { force: true });
      persist(changed, attributed(`map move: group ${l.id} deleted`), [l.id]);
      return { commit: lastCommit, lens: null, message: `Deleted the group ${l.title}. Its ideas and sessions went back to where they were before.` };
    }

    function mergeGroup(input: { lens: string; into: string; actor?: MapActor }): GroupResult {
      const attributed = attributedBy(input?.actor);
      lastCommit = null;
      const lenses = lensService.list();
      const a = lensOrThrow(lenses, input?.lens), b = lensOrThrow(lenses, input?.into);
      if (a.id === b.id) throw new HttpError(400, "Pick another group to merge into.");
      // Ideas charted in A (by name or by rule) join B explicitly; the rest just stop naming A.
      const moving = new Set(chartedIn(a, lenses).map((m) => m.id));
      const t = now();
      const changed = [...missions.values()].filter((m) => moving.has(m.id) || m.lenses.includes(a.id)).map((m) => {
        const rest = m.lenses.filter((x) => x !== a.id);
        return { ...m, lenses: moving.has(m.id) ? [b.id, ...rest.filter((x) => x !== b.id)] : rest, updated: t };
      });
      const union = (x: string[], y: string[]) => [...new Set([...x, ...y])];
      const next: Lens = { ...b, sessions: union(b.sessions, a.sessions), projects: union(b.projects, a.projects) };
      writeLenses([next]);
      fs.rmSync(lensFile(a.id), { force: true });
      persist(changed, attributed(`map move: group ${a.id} merged into ${b.id}`), [a.id, b.id]);
      return { commit: lastCommit, lens: b.id, message: `Merged ${a.title} into ${b.title}.` };
    }

    /**
     * Undo a map move (or a housekeeping run) by restoring every file it touched, as long as nothing
     * has changed them since.
     */
    function undoGrouping(sha: string, kind: "map move" | "housekeeping", actor?: MapActor): MoveResult {
      const what = kind === "map move" ? "move" : "housekeeping run";
      if (!/^[0-9a-f]{7,40}$/.test(String(sha ?? ""))) throw new HttpError(400, `Send {commit} with the sha the ${what} returned.`);
      const subject = git(paths.root, ["log", "-1", "--format=%s", sha], { allowFail: true });
      if (!subject.startsWith(`joyride: ${kind}`)) throw new HttpError(409, `Commit ${sha.slice(0, 8)} is not a ${kind}, so Joyride won't undo it here.`);
      const files = commitFiles(sha);
      if (!files.length || files.some((f) => !/^(missions|lenses)\/[^/]+$/.test(f) && f !== "map/layout.yaml")) throw new HttpError(409, `Commit ${sha.slice(0, 8)} touched files outside missions/, lenses/ and the map layout, so Joyride won't undo it here.`);
      for (const f of files) {
        const abs = path.join(paths.root, f);
        const cur = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
        if (cur !== fileAt(sha, f)) throw new HttpError(409, `${f} changed after that ${what}, so it can't be undone automatically. Move it back on the map instead.`);
      }
      for (const f of files) {
        const abs = path.join(paths.root, f);
        const before = fileAt(`${sha}^`, f);
        if (before === null) fs.rmSync(abs, { force: true }); else writeFileAtomic(abs, before);
      }
      const commit = commitPaths(files, `undo ${kind} ${sha.slice(0, 8)}${actor ? `\n\nMap-actor: ${JSON.stringify(actor)}` : ""}`);
      reload();
      for (const f of files) ctx.bus.change(f === "map/layout.yaml" ? { entity: "map-layout" } : { entity: f.startsWith("lenses/") ? "lenses" : "missions", id: path.basename(f).replace(/\.(md|ya?ml)$/, "") });
      return { commit, message: kind === "map move" ? "Move undone." : "Housekeeping undone." };
    }
    const undoMove = (sha: string, actor?: MapActor) => undoGrouping(sha, "map move", actor);

    // ---------- where groups sit on the map (map/layout.yaml): one "map move" commit, undone like any move ----------
    function placeGroups(raw: unknown): MoveResult & { group: string } {
      const parsed = PlaceInput.safeParse(raw ?? {});
      if (!parsed.success) throw new HttpError(400, "Send {group, x, y}, {group, reset: true}, or the map's {positions, moved}.");
      const input = parsed.data;
      const attributed = attributedBy(input.actor);
      const current = readLayout(paths.mapLayout);
      let next: ReturnType<typeof nextLayout>;
      try { next = nextLayout(current, input); } catch (e: any) { throw new HttpError(400, e.message); }
      const { groups, moved } = next;
      if (moved.startsWith("lens:") && !lensService.get(moved.slice(5))) throw new HttpError(404, `No group ${moved.slice(5)}.`);
      const title = "title" in input && input.title ? input.title : moved.startsWith("lens:") ? lensService.get(moved.slice(5))?.title ?? moved : moved.replace(/^\w+:/, "");
      const text = renderLayout(groups);
      if (fs.existsSync(paths.mapLayout) && fs.readFileSync(paths.mapLayout, "utf8") === text) return { commit: null, group: moved, message: "Already there." };
      ensureDir(path.dirname(paths.mapLayout));
      writeFileAtomic(paths.mapLayout, text);
      const reset = "reset" in input;
      const commit = commitPaths([paths.mapLayout], attributed(`map move: group ${moved} ${reset ? "back to its flowed spot" : "placed"}`));
      ctx.bus.change({ entity: "map-layout", id: moved });
      return { commit, group: moved, message: reset ? `${title} is back in its usual spot.` : `Moved ${title}.` };
    }
    const mapLayoutJson = () => Object.fromEntries(readLayout(paths.mapLayout));

    // ---------- set aside on the map (a view choice, not grouping: kept in the index, not in git) ----------
    const HIDDEN_KV = "missions:map_hidden";
    const MAP_KEY_RE = /^[A-Za-z0-9:._@-]{1,200}$/;
    const hiddenOnMap = (): Record<string, string> => kvGet<Record<string, string>>(db, HIDDEN_KV, {});
    function hideOnMap(key: string, actorInput?: MapActor) {
      const actor = actorOf(actorInput);
      if (typeof key !== "string" || !MAP_KEY_RE.test(key)) throw new HttpError(400, "Send {key} with a session key (claude:<id>) or a worker id.");
      const at = now();
      kvSet(db, HIDDEN_KV, { ...hiddenOnMap(), [key]: at });
      visibilityEdit(key, at, "hide", actor);
      ctx.bus.change({ entity: "missions", id: key });
      return { key, at, message: "Set aside. It comes back if it does something new; the Agents page still lists it." };
    }
    function unhideOnMap(key: string, actorInput?: MapActor) {
      const actor = actorOf(actorInput);
      if (typeof key !== "string" || !MAP_KEY_RE.test(key)) throw new HttpError(400, "Send {key} with a session key (claude:<id>) or a worker id.");
      const { [key]: _gone, ...rest } = hiddenOnMap();
      kvSet(db, HIDDEN_KV, rest);
      visibilityEdit(key, now(), "unhide", actor);
      ctx.bus.change({ entity: "missions", id: key });
      return { key, message: "Back on the map." };
    }

    const VISIBILITY_KV = "missions:map_visibility_history";
    type VisibilityEdit = { id: string; key: string; at: string; action: "hide" | "unhide"; actor: MapActor | null };
    const visibilityHistory = () => kvGet<VisibilityEdit[]>(db, VISIBILITY_KV, []);
    function visibilityEdit(key: string, at: string, action: VisibilityEdit["action"], actor: MapActor | null) {
      kvSet(db, VISIBILITY_KV, [{ id: randomUUID(), key, at, action, actor }, ...visibilityHistory()].slice(0, 500));
    }
    function mapHistory(): MapHistoryEntry[] {
      const hidden = hiddenOnMap();
      const workers = ctx.services.get("workers") as { list(): Pick<WorkerView, "id" | "session" | "updated">[] } | undefined;
      const activity = new Map<string, string>();
      for (const w of workers?.list() ?? []) {
        activity.set(w.id, w.updated);
        if (w.session) activity.set(w.session, w.updated);
      }
      return [...readMapHistory(), ...visibilityHistory().map((r) => ({
        id: r.id, commit: null, at: r.at, summary: `${r.action === "hide" ? "Set aside" : "Returned to map"}: ${r.key}`,
        actor: r.actor, undone: r.action === "unhide" || hidden[r.key] !== r.at || (activity.get(r.key) ?? sessions()?.get(r.key)?.updated ?? "") > r.at,
        ...(r.action === "hide" ? { key: r.key } : {}),
      }))].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    }
    const hideOnMapInput = (input: { key: string; actor?: MapActor }) => hideOnMap(input.key, input.actor);
    const unhideOnMapInput = (input: { key: string; actor?: MapActor }) => unhideOnMap(input.key, input.actor);

    function applyGrouping(change: { missions: Mission[]; lenses: Lens[] }, msg: string): string | null {
      lastCommit = null;
      const t = now();
      let list: Mission[], lensList: Lens[];
      try {
        list = change.missions.map((m) => Mission.parse({ ...m, id: checkId(m.id), updated: t }));
        lensList = change.lenses.map((l) => Lens.parse({ ...l, id: checkId(l.id) }));
      } catch (e) { throw e instanceof HttpError ? e : new HttpError(400, zodMessage(e)); }
      if (!list.length && !lensList.length) return null;
      ensureDir(paths.lenses);
      for (const l of lensList) writeFileAtomic(lensFile(l.id), renderLens(l));
      return persist(list, msg, lensList.map((l) => l.id));
    }

    function missionOfTask(task: string): string | null {
      for (const m of missions.values()) if (m.crews.includes(task)) return m.id;
      return null;
    }

    /** Closing a mission with done_when criteria needs a passing verdict, or an override reason. */
    async function gateState(m: Mission, state: string, reason?: string): Promise<Pick<Mission, "state" | "override">> {
      const st = MissionState.safeParse(state);
      if (!st.success) throw new HttpError(400, `"${state}" is not an idea state. Use open, paused, done or dropped.`);
      let override = m.override;
      if (st.data === "done" && m.state !== "done" && m.done_when.length) {
        const ev = optional("evidence");
        let pass = false;
        if (ev) { try { pass = (await ev.latestVerdict(m.id))?.verdict === "pass"; } catch {} }
        if (!pass) {
          if (!reason?.trim()) {
            throw new HttpError(409, ev
              ? "This idea's done-when criteria have no passing verdict yet. Run a verdict, or close it with an override reason."
              : "Evidence checks are not available, so closing this idea needs an override reason.");
          }
          override = { reason: reason.trim(), at: now() };
        }
      }
      return { state: st.data, override };
    }

    async function setState(id: string, state: string, reason?: string): Promise<Mission> {
      const m = missions.get(id);
      if (!m) throw new HttpError(404, `No idea ${id}.`);
      const g = await gateState(m, state, reason);
      return save({ ...m, ...g }, `mission ${id}: ${m.state} -> ${g.state}${g.override !== m.override ? " (override)" : ""}`);
    }

    async function acceptProposal(id: string, edits: Record<string, any> = {}) {
      const p = getProposal(id);
      if (!p) throw new HttpError(404, `No proposal ${id}.`);
      if (p.status !== "pending") throw new HttpError(409, `Proposal ${id} is already ${p.status}.`);
      const refs = edits.sessions ? toRefs(edits.sessions) : p.sessions;
      const target: string | null = edits.merge_into !== undefined ? edits.merge_into : p.merge_into;
      let mission: Mission;
      const linked = Boolean(target && missions.has(target));
      if (linked) mission = linkSessions(target!, refs, `accept proposal ${id}: link ${refs.length} sessions to ${target}`);
      else {
        mission = create({
          title: edits.title ?? p.title, goal: edits.goal ?? p.goal, repos: edits.repos ?? p.repos, branches: edits.branches ?? p.branches,
          sessions: refs, done_when: edits.done_when ?? [], lenses: edits.lenses ?? [],
          ...(edits.id ? { id: edits.id } : {}),
        } as any, `accept proposal ${id}`);
      }
      const done = StoredProposal.parse({ ...p, status: "accepted", decided_at: now(), mission: mission.id, created_mission: !linked });
      writeProposal(done);
      ctx.bus.change({ entity: "proposals", id });
      return { proposal: done, mission };
    }

    function rejectProposal(id: string, reason = ""): StoredProposal {
      const p = getProposal(id);
      if (!p) throw new HttpError(404, `No proposal ${id}.`);
      if (p.status !== "pending") throw new HttpError(409, `Proposal ${id} is already ${p.status}.`);
      const done = StoredProposal.parse({ ...p, status: "rejected", decided_at: now(), decision_reason: reason });
      writeProposal(done);
      ctx.bus.change({ entity: "proposals", id });
      return done;
    }

    /**
     * Put a decided proposal back in the queue, keeping the earlier decision in its history. For an
     * accepted one, `restore` (the default) takes its sessions back out of the mission it went to, in one
     * commit; a mission that accept created and that is left with nothing in it is archived, never deleted.
     */
    function reopenProposal(id: string, opts: { restore?: boolean } = {}) {
      const p = getProposal(id);
      if (!p) throw new HttpError(404, `No proposal ${id}.`);
      if (p.status === "pending") throw new HttpError(409, `Proposal ${id} is already waiting for review.`);
      const restore = opts.restore !== false;
      let commit: string | null = null;
      let message = "Proposal reopened.";
      const m = p.status === "accepted" && p.mission ? missions.get(p.mission) : undefined;
      if (m && restore) {
        const keys = new Set(p.sessions.map(refKey));
        const kept = m.sessions.filter((r) => !keys.has(refKey(r)));
        const created = p.created_mission ?? Boolean(p.decided_at && Math.abs(Date.parse(m.created) - Date.parse(p.decided_at)) < 60_000);
        let next: Mission = { ...m, sessions: kept, updated: now() };
        const emptied = created && !kept.length && !m.crews.length;
        if (emptied && !m.archive) next = { ...next, state: "dropped", archive: true };
        if (kept.length !== m.sessions.length || next.archive !== m.archive) {
          lastCommit = null;
          persist([next], `reopen proposal ${id}: take ${m.sessions.length - kept.length} session${m.sessions.length - kept.length === 1 ? "" : "s"} back from ${m.id}${emptied ? " and archive it" : ""}`);
          commit = lastCommit;
          message = emptied ? `Proposal reopened. ${m.title} had nothing else in it, so it is archived.` : `Proposal reopened. Its sessions left ${m.title}.`;
        }
      }
      const history = [...p.history, { status: p.status as "accepted" | "rejected", decided_at: p.decided_at, reason: p.decision_reason, mission: p.mission, reopened_at: now() }];
      const back = StoredProposal.parse({ ...p, status: "pending", decided_at: null, decision_reason: "", mission: null, created_mission: undefined, history });
      writeProposal(back);
      ctx.bus.change({ entity: "proposals", id });
      return { proposal: back, commit, message };
    }

    const pctx = createProposalContext(ctx, { proposals: () => readProposals(), get: getProposal, missionTitle: (id) => missions.get(id)?.title ?? null });
    disposers.push(pctx.dispose);

    let settledP: Promise<void> = Promise.resolve();
    const service: MissionsService = {
      list(opts = {}) {
        let list = [...missions.values()];
        if (opts.state) list = list.filter((m) => m.state === opts.state);
        if (opts.archive !== undefined) list = list.filter((m) => m.archive === opts.archive);
        return list.sort((a, b) => Number(a.archive) - Number(b.archive) || b.updated.localeCompare(a.updated)).map(withHealth);
      },
      get: (id) => missions.get(id) ?? null,
      save, create, linkSessions, unlinkSession, missionOfSession, setState,
      proposals: (opts = {}) => readProposals().filter((p) => !opts.status || opts.status === "all" || p.status === opts.status),
      acceptProposal, rejectProposal, runBackfill, pruneHistory,
      move: (input) => move(input), undoMove: (sha, actor) => undoMove(sha, actor), mapHistory,
      applyGrouping, undoHousekeeping: (sha, actor) => undoGrouping(sha, "housekeeping", actor), missionOfTask, reopenProposal,
      health: (id) => healthDetail(id).health,
      healthDetail,
      settled: () => settledP,
      proposalContext: (id, opts) => pctx.context(checkId(id), opts),
      proposalSummary: () => pctx.summary(),
      runBriefs: () => pctx.runBriefs(),
      briefsIdle: () => pctx.idle(),
      hideOnMap, unhideOnMap, hiddenOnMap,
      mapLayout: () => readLayout(paths.mapLayout), placeGroups,
    };
    ctx.services.set("missions", service);

    // ---------- lenses ----------
    const lensService: LensesService = {
      list: () => readLensDir(paths.lenses),
      get: (id) => readLensDir(paths.lenses).find((l) => l.id === id) ?? null,
      save(input) {
        if (!input?.title || !String(input.title).trim()) throw new HttpError(400, "A group needs a title.");
        let l: Lens;
        try { l = Lens.parse({ ...input, id: checkId(input.id ?? slugify(input.title)) }); } catch (e) { throw e instanceof HttpError ? e : new HttpError(400, zodMessage(e)); }
        ensureDir(paths.lenses);
        const existed = fs.existsSync(lensFile(l.id));
        writeFileAtomic(lensFile(l.id), renderLens(l));
        commitPaths([lensFile(l.id)], `${existed ? "update" : "create"} lens ${l.id}`);
        ctx.bus.change({ entity: "lenses", id: l.id });
        return l;
      },
      remove(id) {
        checkId(id);
        if (!fs.existsSync(lensFile(id))) return false;
        fs.rmSync(lensFile(id));
        commitPaths([lensFile(id)], `remove lens ${id}`);
        ctx.bus.change({ entity: "lenses", id });
        return true;
      },
      createGroup: (i) => createGroup(i),
      renameGroup: (i) => renameGroup(i),
      deleteGroup: (i) => deleteGroup(i),
      mergeGroup: (i) => mergeGroup(i),
    };
    ctx.services.set("lenses", lensService);

    // ---------- routes ----------
    type H = (c: any) => any;
    const wrap = (fn: H): H => async (c) => {
      try { return await fn(c); }
      catch (e: any) {
        if (e instanceof HttpError) return c.json({ error: e.message }, e.status);
        if (e instanceof NotFound) return c.json({ error: e.message }, 404);
        if (Array.isArray(e?.issues)) return c.json({ error: zodMessage(e) }, 400);
        throw e;
      }
    };
    const body = async (c: any) => { try { return (await c.req.json()) ?? {}; } catch { return {}; } };
    const boolQ = (v: string | undefined) => (v === undefined || v === "" ? undefined : v === "1" || v === "true");

    // Static paths first so ":id" never captures "proposals" or "backfill".
    app.get("/api/missions/proposals", wrap((c) => c.json(service.proposals({ status: c.req.query("status") ?? "pending" }))));
    app.get("/api/missions/proposals/summary", wrap(async (c) => c.json(await service.proposalSummary())));
    app.get("/api/missions/proposals/:id/context", wrap(async (c) => c.json(await service.proposalContext(c.req.param("id"), { wait: c.req.query("wait") === "1", retry: c.req.query("retry") === "1" }))));
    app.post("/api/missions/proposals/:id/accept", wrap(async (c) => c.json(await acceptProposal(c.req.param("id"), (await body(c)).edits ?? {}))));
    app.post("/api/missions/proposals/:id/reject", wrap(async (c) => c.json(rejectProposal(c.req.param("id"), (await body(c)).reason ?? ""))));
    app.post("/api/missions/proposals/:id/reopen", wrap(async (c) => c.json(reopenProposal(c.req.param("id"), { restore: (await body(c)).restore }))));
    app.post("/api/missions/backfill", wrap(async (c) => c.json(await runBackfill())));
    app.get("/api/missions/map", wrap((c) => {
      const ideas = service.list({});
      const groups = lensService.list();
      return c.json({ groups, ideas: ideas.map((idea) => ({ ...idea, group: primaryLens(idea, groups)?.id ?? null })), layout: mapLayoutJson() });
    }));
    app.get("/api/missions/map/layout", wrap((c) => c.json(mapLayoutJson())));
    app.post("/api/missions/map/layout", wrap(async (c) => c.json(placeGroups(await body(c)))));
    app.get("/api/missions/move/history", wrap((c) => c.json(mapHistory())));
    app.post("/api/missions/move", wrap(async (c) => c.json(move(await body(c)))));
    app.post("/api/missions/move/undo", wrap(async (c) => {
      const input = await body(c);
      const actor = input.actor === undefined ? undefined : MapActor.safeParse(input.actor);
      if (actor && !actor.success) throw new HttpError(400, "Send a valid agent actor {kind: agent, id, via: cli or mcp}.");
      return c.json(undoMove(input.commit, actor?.success ? actor.data : undefined));
    }));
    app.get("/api/missions/hidden", wrap((c) => c.json(hiddenOnMap())));
    app.post("/api/missions/hide", wrap(async (c) => c.json(hideOnMapInput(await body(c)))));
    app.post("/api/missions/unhide", wrap(async (c) => c.json(unhideOnMapInput(await body(c)))));
    app.get("/api/missions", wrap((c) => c.json(service.list({ state: c.req.query("state") || undefined, archive: boolQ(c.req.query("archive")) }))));
    app.post("/api/missions", wrap(async (c) => c.json(withHealth(create(await body(c))), 201)));
    app.get("/api/missions/:id", wrap((c) => {
      const m = missions.get(c.req.param("id"));
      return m ? c.json(withHealth(m)) : c.json({ error: `No idea ${c.req.param("id")}.` }, 404);
    }));
    app.put("/api/missions/:id", wrap(async (c) => {
      const id = c.req.param("id");
      const m = missions.get(id);
      if (!m) throw new HttpError(404, `No idea ${id}.`);
      const b = await body(c);
      if (b.id && b.id !== id) throw new HttpError(400, "An idea's id cannot change. Create a new idea instead.");
      const { state, reason, sessions: refs, health: _h, health_why: _w, created: _c, override: _o, ...rest } = b;
      let next: Mission = { ...m, ...rest, id };
      if (rest.done_when) next.done_when = normCriteria(rest.done_when)!;
      if (refs) next.sessions = toRefs(refs);
      try { next = Mission.parse(next); } catch (e) { throw new HttpError(400, zodMessage(e)); }
      if (state && state !== m.state) next = { ...next, ...(await gateState({ ...next, state: m.state }, state, reason)) };
      return c.json(withHealth(save(next, `edit mission ${id}`)));
    }));
    app.post("/api/missions/:id/sessions", wrap(async (c) => {
      const b = await body(c);
      const refs = b.refs ?? b.sessions ?? [];
      if (!Array.isArray(refs)) throw new HttpError(400, "Send {refs: [...]} with session keys like claude:<id>.");
      return c.json(withHealth(linkSessions(c.req.param("id"), refs)));
    }));
    app.delete("/api/missions/:id/sessions/:key", wrap((c) => c.json(withHealth(unlinkSession(c.req.param("id"), c.req.param("key"))))));
    app.get("/api/missions/:id/health", wrap((c) => c.json({ id: c.req.param("id"), ...healthDetail(c.req.param("id")) })));
    app.put("/api/missions/:id/state", wrap(async (c) => {
      const b = await body(c);
      return c.json(withHealth(await setState(c.req.param("id"), b.state, b.reason)));
    }));

    app.get("/api/lenses", wrap((c) => c.json(lensService.list())));
    app.post("/api/lenses", wrap(async (c) => c.json(lensService.save(await body(c)))));
    app.post("/api/lenses/create", wrap(async (c) => c.json(createGroup(await body(c)))));
    app.post("/api/lenses/rename", wrap(async (c) => c.json(renameGroup(await body(c)))));
    app.post("/api/lenses/delete", wrap(async (c) => c.json(deleteGroup(await body(c)))));
    app.post("/api/lenses/merge", wrap(async (c) => c.json(mergeGroup(await body(c)))));
    app.delete("/api/lenses/:id", wrap((c) => {
      const ok = lensService.remove(c.req.param("id"));
      return ok ? c.json({ ok }) : c.json({ error: `No group ${c.req.param("id")}.` }, 404);
    }));

    // ---------- background wiring (called from start) ----------
    function autolink(keys: string[]) {
      const s = sessions();
      if (!s || !keys.length) return;
      const plan = new Map<string, string[]>();
      const open = [...missions.values()].filter((m) => m.state === "open" && !m.archive);
      for (const key of keys) {
        if (missionOfSession(key)) continue;
        const v = s.get(key);
        // Only sessions at a repo root auto-link; work in sub-folders of an umbrella repo waits for a proposal.
        if (!v?.repo || placeOf(v) !== v.repo) continue;
        const nb = normBranch(v.branch);
        const match = open.filter((m) => m.repos.includes(v.repo!) && (m.branches.length ? m.branches.map(normBranch) : ["main"]).includes(nb));
        if (match.length !== 1 || match[0].created > v.started) continue;
        const list = plan.get(match[0].id) ?? [];
        list.push(key);
        plan.set(match[0].id, list);
      }
      for (const [id, list] of plan) {
        try { linkSessions(id, list, `auto-link ${list.length} new session${list.length === 1 ? "" : "s"} to ${id}`); }
        catch (e: any) { ctx.log(`missions: auto-link to ${id} failed: ${e.message}`); }
      }
    }

    (service as any)._start = () => {
      const off = ctx.bus.onChange((ch) => {
        if (ch.entity === "proposals") { pctx.scheduleBatch(3000); return; }
        if (ch.entity !== "sessions") return;
        const added = (ch.data as any)?.added;
        if (Array.isArray(added) && added.length) { try { autolink(added); } catch (e: any) { ctx.log(`missions: auto-link failed: ${e.message}`); } }
      });
      disposers.push(off);
      let t: NodeJS.Timeout | null = null;
      try {
        ensureDir(paths.missions);
        const w = fs.watch(paths.missions, () => {
          if (t) return;
          t = setTimeout(() => { t = null; if (reload()) ctx.bus.change({ entity: "missions" }); }, 300);
          t.unref?.();
        });
        w.on("error", () => {});
        disposers.push(() => { w.close(); if (t) clearTimeout(t); });
      } catch {}
      settledP = (async () => {
        const s = sessions();
        if (!s) return;
        await s.ready();
        if (kvGet(db, BACKFILL_KV, null) || missions.size > 0 || readProposals().length > 0) return;
        ctx.log("missions: first start with no missions, running backfill");
        await runBackfill();
      })().catch((e) => ctx.log(`missions: first-run backfill failed: ${e.message}`));
      // Brief every pending proposal in the background once start-up work is done.
      settledP.then(() => pctx.scheduleBatch(1500));
    };
  },

  start(ctx) {
    ctx.service<any>("missions")._start();
  },

  stop() {
    while (disposers.length) { try { disposers.pop()!(); } catch {} }
  },
});
