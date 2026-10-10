import fs from "node:fs";
import path from "node:path";
import { knowledgePolicy } from "../../core/knowledge-policy.ts";
import { defineModule, type Ctx } from "../../core/context.ts";
import {
  KnowledgeQuery, KnowledgeRef, type KnowledgeAnchor, type KnowledgeItem,
  type KnowledgeRelations, type KnowledgeSearch, type KnowledgeType,
} from "../../shared/knowledge.ts";
import { buildTaskNotesDigest, bulletsOf } from "../../shared/notes.ts";
import { itemLabel, parseBlocks } from "../../shared/board.ts";
import type { Artifact } from "../../shared/schema.ts";
import type { ArtifactsService } from "../artifacts/index.ts";
import { htmlToText, matchesLocalSource } from "../artifacts/store.ts";
import { blobPath, isSha } from "../evidence/blobs.ts";
import type { MissionsService, LensesService } from "../missions/index.ts";
import type { NotesService } from "../notes/index.ts";
import type { SessionsService } from "../sessions/index.ts";
import type { WorkersApi } from "../live/workers.ts";
import type { FirstmateApi } from "../firstmate/index.ts";
import type { Intention } from "../intentions/index.ts";
import { rankText, reciprocalRankFusion, tokens } from "./rank.ts";
import { applyFilters, typeCounts, anchorOptions, projectOptions } from "../../shared/knowledge-filters.ts";

export type KnowledgeService = {
  search(query?: Partial<KnowledgeQuery>): KnowledgeSearch;
  relations(ref: KnowledgeRef): KnowledgeRelations | null;
  prepare(): void;
  invalidate(): void;
  stop(): void;
};
const keyOf = (ref: KnowledgeRef) => `${ref.entity}:${ref.id}`;
function artifactType(kind: Artifact["kind"], url: string | null): KnowledgeType {
  switch (kind) {
    case "claude-artifact": return "pages";
    case "chatgpt": return url && /\/(?:c|share)\//.test(url) ? "chats" : "pages";
    case "pr": return "prs";
    case "report": return "reports";
    case "file": return "files";
    case "session": return "sessions";
    case "other": return "other";
  }
}
/** A board item as one readable line: ticks as boxes, links by their title and place, never raw markdown. */
function noteSummary(body: string): string {
  return parseBlocks(bulletsOf(body)).map((b) => b.kind === "todo" ? `${b.done ? "☑" : "☐"} ${b.text}` : b.kind === "link" ? `${b.link.title}${b.link.where ? ` (${b.link.where})` : ""}` : b.text).join(" · ").slice(0, 320);
}
const anchorParts = (anchor: string) => {
  const split = anchor.indexOf(":");
  const kind = anchor.slice(0, split);
  return { kind: kind === "mission" ? "idea" : kind, id: anchor.slice(split + 1) };
};
const anchorMatches = (a: KnowledgeAnchor, target: ReturnType<typeof anchorParts>) =>
  a.kind === target.kind && (a.id === target.id || (a.kind === "repo" && path.basename(a.id) === target.id));

function createService(ctx: Ctx): KnowledgeService {
  const admission = knowledgePolicy(ctx);
  let indexed: ReturnType<typeof snapshot> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let builtAt = 0;
  const prepare = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const data = snapshot();
    data.items.sort((a, b) => b.updated.localeCompare(a.updated) || a.key.localeCompare(b.key));
    indexed = data;
    builtAt = Date.now();
    return data;
  };
  const current = () => {
    if (!indexed) return prepare();
    if (Date.now() - builtAt > 60_000) invalidate();
    return indexed;
  };
  function optional<T>(name: string): T | null { return ctx.services.has(name) ? ctx.service<T>(name) : null; }
  function snapshot() {
    const notices: string[] = [];
    const read = <T>(name: string, fn: () => T, empty: T): T => {
      try { return fn(); } catch (e) {
        notices.push(`Could not read ${name}: ${e instanceof Error ? e.message : String(e)}. Refresh after the source recovers.`);
        return empty;
      }
    };
    const artifacts = optional<ArtifactsService>("artifacts");
    const missionsSvc = optional<MissionsService>("missions");
    const entries = [
      ...read("notes", () => optional<NotesService>("notes")?.list({ include_archived: true, limit: 100000 }) ?? [], []).filter(e => admission.note(e)),
    ];
    const sources = read("artifacts", () => artifacts?.list({ limit: 100000 }) ?? [], []);
    const sessions = read("sessions", () => (optional<SessionsService>("sessions")?.list({ limit: 100000 }) ?? []).filter(s => admission.admits({ session: s.key, cwd: s.cwd })), []);
    const missions = read("ideas", () => missionsSvc?.list() ?? [], []);
    const groups = read("groups", () => optional<LensesService>("lenses")?.list() ?? [], []);
    const crews = read("tasks", () => optional<FirstmateApi>("firstmate")?.tasks() ?? [], []);
    for (const name of ["notes", "artifacts", "sessions", "missions", "firstmate"]) if (!ctx.services.has(name)) notices.push(`The ${name} module is unavailable; results include the other sources.`);
    const texts = new Map<string, string>();
    const items: KnowledgeItem[] = [];
    const bySource = new Map(sources.map((a) => [a.id, a]));
    const answerSources = new Map<string, string>();
    for (const e of entries) if (e.provenance.type === "human" && e.provenance.ref.startsWith("answer_ask:")) {
      const report = e.body.match(/^\s*(?:[-*]\s+)?Report: \[.*\]\((.+)\)$/m)?.[1];
      const source = report ? sources.find((a) => matchesLocalSource(a, report) || a.url === report) : undefined;
      if (source) answerSources.set(e.id, source.id);
    }
    const sessionTasks = new Map<string, string[]>();
    const workers = read("workers", () => optional<WorkersApi>("workers")?.list() ?? [], []);
    for (const worker of workers) if (worker.session && worker.owner.task) {
      sessionTasks.set(worker.session, [...(sessionTasks.get(worker.session) ?? []), worker.owner.task]);
    }
    function anchors(input: { scope?: string; mission?: string | null; session?: string | null; task?: string | null; repos?: string[] }): KnowledgeAnchor[] {
      const out = new Map<string, KnowledgeAnchor>();
      const add = (kind: KnowledgeAnchor["kind"], id: string, direct: boolean, title = id) => {
        const key = `${kind}:${id}`, old = out.get(key);
        out.set(key, { kind, id, direct: direct || Boolean(old?.direct), title });
      };
      if (input.mission) add("idea", input.mission, true);
      if (input.session) add("session", input.session, true);
      if (input.task) add("task", input.task, true);
      for (const repo of input.repos ?? []) add("repo", repo, true, path.basename(repo));
      if (input.scope) {
        const a = anchorParts(input.scope);
        switch (a.kind) {
          case "group": add("group", a.id, true, groups.find((g) => g.id === a.id)?.title ?? a.id); break;
          case "idea": case "task": case "session": case "repo": add(a.kind, a.id, true); break;
        }
      }
      for (const a of [...out.values()]) if (a.kind === "session") {
        const session = sessions.find((s) => s.key === a.id);
        if (session) {
          add("session", a.id, a.direct, session.title);
          if (session.repo) add("repo", session.repo, false, path.basename(session.repo));
          if (session.mission) add("idea", session.mission, false);
        }
        for (const task of sessionTasks.get(a.id) ?? []) add("task", task, false);
      }
      for (const a of [...out.values()]) if (a.kind === "task") {
        add("task", a.id, a.direct, crews.find((t) => t.id === a.id)?.title ?? a.id);
        for (const idea of missions) if (idea.crews.includes(a.id)) add("idea", idea.id, false);
      }
      for (const a of [...out.values()]) if (a.kind === "idea") {
        const idea = missions.find((m) => m.id === a.id);
        if (!idea) continue;
        add("idea", a.id, a.direct, idea.title);
        for (const repo of idea.repos) add("repo", repo, false, path.basename(repo));
        for (const group of idea.lenses) add("group", group, false, groups.find((g) => g.id === group)?.title ?? group);
      }
      return [...out.values()];
    }
    const delivery = new Map<string, Set<string>>();
    const deliver = (id: string, channel: string) => { const channels = delivery.get(id) ?? new Set(); channels.add(channel); delivery.set(id, channels); };
    const taskIds = [...new Set([...missions.flatMap((m) => m.crews), ...entries.filter((e) => e.scope.startsWith("task:")).map((e) => e.scope.slice(5))])];
    for (const notes of read("task notes", () => optional<NotesService>("notes")?.forTasks(taskIds) ?? [], [])) {
      for (const id of buildTaskNotesDigest({ task: notes.task, mission: notes.mission, taskNotes: notes.task_notes, ideaNotes: notes.idea_notes }).ids) deliver(id, `task:${notes.task}`);
    }
    for (const e of entries) {
      const ref = { entity: "note", id: e.id } satisfies KnowledgeRef;
      const source = bySource.get(answerSources.get(e.id) ?? (e.provenance.type === "artifact" ? e.provenance.ref : ""));
      const ownAnchors = anchors({ scope: e.scope,
        session: e.provenance.type === "session" ? e.provenance.ref : null });
      const inherited = source ? anchors({ mission: source.mission, session: source.session, task: source.firstmate?.task }).map((a) => ({ ...a, direct: false })) : [];
      const merged = new Map([...inherited, ...ownAnchors].map((a) => [`${a.kind}:${a.id}`, a]));
      items.push({ key: keyOf(ref), ref, type: "notes", kind: e.kind, title: itemLabel({ title: e.title, bullets: bulletsOf(e.body) }, 120),
        summary: noteSummary(e.body), state: e.status, created: e.created, updated: e.verified_at ?? e.created,
        anchors: [...merged.values()], score: 0, review: [], delivery: e.status === "active" && !e.stale && !e.quarantined ? [...(delivery.get(e.id) ?? [])] : [],
        // A note is a board item: it opens on the Board, where it is ticked, edited and shown on the map.
        href: `#/board?item=${encodeURIComponent(e.id)}`, url: null });
      texts.set(keyOf(ref), e.body);
    }
    for (const idea of missions.filter((m) => !m.private && admission.admits({ id: m.id }))) {
      const ref = { entity: "idea", id: idea.id } satisfies KnowledgeRef;
      items.push({ key: keyOf(ref), ref, type: "ideas", kind: "idea", title: idea.title, summary: idea.goal.slice(0, 320),
        state: idea.archive ? "archived" : idea.state, created: idea.created, updated: idea.updated,
        anchors: anchors({ mission: idea.id, repos: idea.repos }), score: 0, review: [], delivery: [], href: `#/mission/${encodeURIComponent(idea.id)}`, url: null });
      texts.set(keyOf(ref), idea.goal);
    }
    for (const task of crews) {
      const idea = missions.find((m) => m.crews.includes(task.id));
      if (idea?.private || !admission.admits({ id: task.id, cwd: task.worktree ?? task.repo })) continue;
      const ref = { entity: "task", id: task.id } satisfies KnowledgeRef;
      items.push({ key: keyOf(ref), ref, type: "tasks", kind: "task", title: task.title, summary: task.last_event,
        state: task.status, created: task.updated ?? "", updated: task.updated ?? "",
        anchors: anchors({ task: task.id, mission: idea?.id }), score: 0, review: [], delivery: [], href: `#/task/${encodeURIComponent(task.id)}`, url: null });
      texts.set(keyOf(ref), [task.title, task.last_event].join("\n"));
    }
    for (const a of sources) {
      const ref = { entity: "artifact", id: a.id } satisfies KnowledgeRef;
      let text = a.notes;
      if (a.snapshot_blob && isSha(a.snapshot_blob) && /^text\/(?:html|markdown|plain|csv)|^application\/json/.test(a.content_type ?? "")) {
        try {
          const file = blobPath(a.snapshot_blob);
          if (fs.statSync(file).size <= 2_000_000) {
            const body = fs.readFileSync(file, "utf8");
            text += `\n${a.content_type === "text/html" ? htmlToText(body) : body}`;
          }
        } catch { notices.push(`The snapshot for ${a.title} is unavailable; its title and summary are still searchable.`); }
      }
      const session = sessions.find((s) => s.key === a.session);
      const intention = read("session intention", () => a.session ? optional<{ get(key: string): Intention | null }>("intentions")?.get(a.session) : null, null);
      texts.set(keyOf(ref), [text, session?.title, intention?.goal].filter(Boolean).join("\n"));
      items.push({ key: keyOf(ref), ref, type: artifactType(a.kind, a.url), kind: a.kind, title: a.title,
        summary: a.summary || a.notes.slice(0, 320), state: "registered", created: a.created, updated: a.updated ?? a.created,
        anchors: anchors({ mission: a.mission, session: a.session, task: a.firstmate?.task, repos: a.project ? [a.project] : [] }),
        score: 0, review: [], delivery: [], href: `#/artifacts/${encodeURIComponent(a.id)}`, url: a.url });
    }
    for (const s of sessions) {
      const ref = { entity: "session", id: s.key } satisfies KnowledgeRef;
      const intention = read("session intention", () => optional<{ get(key: string): Intention | null }>("intentions")?.get(s.key), undefined);
      items.push({ key: keyOf(ref), ref, type: "sessions", kind: "session", title: s.title,
        summary: intention?.goal || s.first_prompt, state: s.archived ? "archived" : "active", created: s.started, updated: s.updated,
        anchors: anchors({ session: s.key, mission: s.mission, repos: s.repo ? [s.repo] : [] }),
        score: 0, review: [], delivery: [], href: `#/session/${encodeURIComponent(s.key)}`, url: null });
      texts.set(keyOf(ref), [s.first_prompt, intention?.goal].filter(Boolean).join("\n"));
    }
    return { items, entries, sources, answerSources, texts, notices };
  }
  function invalidate() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      prepare();
      ctx.bus.change({ entity: "knowledge" });
    }, 120);
    timer.unref();
  }
  return {
    prepare,
    invalidate,
    stop() { if (timer) clearTimeout(timer); timer = null; },
    search(input = {}) {
      const query = KnowledgeQuery.parse(input), data = current();
      const target = query.anchor ? anchorParts(query.anchor) : null;
      let pool = data.items.filter((item) => (!target || item.anchors.some((a) => anchorMatches(a, target))) &&
        (query.state === "all" || item.state === query.state));
      if (tokens(query.q).length) {
        const ranks = reciprocalRankFusion([
          rankText(pool.map((i) => ({ key: i.key, title: i.title, text: i.summary })), query.q),
          rankText(pool.map((i) => ({ key: i.key, title: "", text: data.texts.get(i.key) ?? "" })), query.q),
        ]);
        pool = pool.filter((i) => ranks.has(i.key)).map((i) => ({ ...i, score: (ranks.get(i.key) ?? 0) *
          (target ? i.anchors.some((a) => a.direct && anchorMatches(a, target)) ? 1.5 : 1.15 : 1) }));
      }
      const facets: KnowledgeSearch["facets"] = {
        types: Object.fromEntries(typeCounts(pool, query)),
        anchors: { idea: anchorOptions(pool, "idea"), task: anchorOptions(pool, "task"), session: anchorOptions(pool, "session") },
        projects: projectOptions(pool),
      };
      pool = applyFilters(pool, query);
      if (tokens(query.q).length) pool.sort((a, b) => b.score - a.score || b.updated.localeCompare(a.updated) || a.key.localeCompare(b.key));
      return { items: pool.slice(query.offset, query.offset + query.limit), total: pool.length, mode: query.mode, notices: data.notices, offset: query.offset, facets };
    },
    relations(ref) {
      const data = current(), item = data.items.find((i) => i.key === keyOf(ref));
      if (!item) return null;
      const relations: KnowledgeRelations["relations"] = [];
      for (const e of data.entries) {
        const from = { entity: "note", id: e.id } satisfies KnowledgeRef;
        for (const source of [e.provenance]) {
          if ((source.type === "artifact" || source.type === "session") && source.ref) relations.push({ kind: "derived-from", from, to: { entity: source.type, id: source.ref } });
        }
        const answerSource = data.answerSources.get(e.id);
        if (answerSource) relations.push({ kind: "answered-by", from: { entity: "artifact", id: answerSource }, to: from });
      }
      for (const a of data.sources) {
        for (const call of a.firstmate?.decisions ?? []) if (!call.open && call.answer) {
          relations.push({ kind: "answered-by", from: { entity: "artifact", id: a.id }, to: { entity: "task", id: call.task } });
        }
      }
      const relevant = relations.filter((r) => keyOf(r.from) === item.key || `${r.to.entity}:${r.to.id}` === item.key);
      for (const a of item.anchors) relevant.push({ kind: "anchored-to", from: ref, to: { entity: a.kind, id: a.id } });
      const unique = [...new Map(relevant.map((r) => [`${r.kind}:${keyOf(r.from)}:${r.to.entity}:${r.to.id}`, r])).values()];
      const neighbors = new Set(unique.flatMap((r) => [keyOf(r.from), `${r.to.entity}:${r.to.id}`]));
      return { item, items: data.items.filter((i) => i.key !== item.key && neighbors.has(i.key)), relations: unique, notices: data.notices };
    },
  };
}

let disposeChanges: (() => void) | null = null;
let stopIndex: (() => void) | null = null;

export default defineModule({
  name: "knowledge", order: 90,
  register(ctx) {
    const service = createService(ctx);
    stopIndex = service.stop;
    ctx.services.set("knowledge", service);
    ctx.app.get("/api/knowledge/search", (c) => {
      const q = c.req.query();
      const result = KnowledgeQuery.safeParse({ ...q, types: q.types?.split(",").map((t) => t.trim()).filter(Boolean) });
      if (!result.success) return c.json({ error: result.error.issues.map((i) => i.message).join(" ") }, 400);
      return c.json(service.search(result.data));
    });
    ctx.app.get("/api/knowledge/relations", (c) => {
      const parsed = KnowledgeRef.safeParse(c.req.query());
      if (!parsed.success) return c.json({ error: "Give entity=idea|task|artifact|session|note and the item's id." }, 400);
      const result = service.relations(parsed.data);
      return result ? c.json(result) : c.json({ error: "This knowledge item is missing. Refresh the search." }, 404);
    });
    disposeChanges = ctx.bus.onChange((change) => {
      if (["artifacts", "sessions", "missions", "lenses", "tasks", "workers", "intentions", "notes", "system"].includes(change.entity)) {
        service.invalidate();
      }
    });
  },
  start(ctx) { ctx.service<KnowledgeService>("knowledge").prepare(); },
  stop() { disposeChanges?.(); disposeChanges = null; stopIndex?.(); stopIndex = null; },
});
