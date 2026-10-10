import { z } from "zod";
import type { Ctx } from "../../core/context.ts";
import type { NewWorld } from "../../shared/freeform-plan.ts";
import type { ScreenElement } from "../../shared/freeform.ts";
const repoLabel = (s: string) => s.split("/").filter(Boolean).at(-1);

const Idea = z.object({ id: z.string(), title: z.string(), group: z.string().nullable().optional(), repos: z.array(z.string()), sessions: z.array(z.object({ source: z.string(), id: z.string() })).default([]) });
const Group = z.object({ id: z.string(), title: z.string(), sessions: z.array(z.string()).default([]) });
const Named = z.object({ id: z.string(), title: z.string().default("") });
const Session = z.object({ key: z.string(), title: z.string().nullable().default(""), mission: z.string().nullable().optional(), cwd: z.string(), source: z.enum(["claude", "codex"]), id: z.string() });
const Worker = Named.extend({ session: z.string().nullable(), mission: z.string().nullable().optional(), cwd: z.string().default(""), status: z.string().optional(), owner: z.object({ tier: z.string() }).passthrough().nullable().optional(), crew: z.string().nullable().optional() });
const Note = Named.extend({ bullets: z.array(z.string()), scope: z.string(), status: z.string() });
const History = z.object({ commit: z.string().nullable(), key: z.string().optional(), summary: z.string(), undone: z.boolean() });

export async function readWorld(ctx: Ctx): Promise<NewWorld> {
  const read = async (p: string): Promise<unknown> => {
    const r = await ctx.app.request(p);
    if (!r.ok) throw new Error(`Reading ${p} failed (${r.status}).`);
    return r.json();
  };
  const soft = (p: string) => read(p).catch(() => []);
  const [chart, workersRaw, sessionsRaw, tasksRaw, notesRaw, artifactsRaw, asksRaw, attentionRaw, accountsRaw, historyRaw, hiddenRaw] = await Promise.all([
    read("/api/missions/map"), soft("/api/workers"), soft("/api/sessions"), soft("/api/firstmate/tasks"), soft("/api/notes?include_archived=1&limit=10000"), soft("/api/artifacts"), soft("/api/asks"), soft("/api/attention"), soft("/api/usage/accounts"), soft("/api/missions/move/history"), read("/api/missions/hidden").catch(() => ({})),
  ]);
  const { groups, ideas } = z.object({ groups: z.array(Group), ideas: z.array(Idea) }).parse(chart);
  const workers = z.array(Worker).parse(workersRaw);
  const sessions = z.array(Session).safeParse(sessionsRaw);
  const tasks = z.array(Named.extend({ mission: z.string().nullable().optional() })).parse(tasksRaw);
  const notes = z.array(Note).parse(notesRaw);
  const artifacts = z.array(Named).parse(artifactsRaw);
  const asks = z.object({ asks: z.array(Named) }).safeParse(asksRaw);
  const attention = z.array(z.object({ id: z.string(), title: z.string(), why: z.string().default(""), kind: z.string() })).safeParse(attentionRaw);
  const accounts = z.array(z.object({ id: z.string(), label: z.string(), provider: z.string() })).safeParse(accountsRaw);
  const hidden = z.record(z.string(), z.string()).parse(hiddenRaw);
  const refs: ScreenElement[] = [
    ...ideas.map((e): ScreenElement => ({ kind: "idea", id: e.id, title: e.title })),
    ...groups.map((e): ScreenElement => ({ kind: "group", id: e.id, title: e.title })),
    ...[...new Set([...ideas.flatMap((i) => i.repos), ...workers.map((w) => w.cwd)])].filter((p) => p.startsWith("/")).map((p): ScreenElement => ({ kind: "project", id: p, title: repoLabel(p) ?? p })),
    ...workers.map((e): ScreenElement => ({ kind: "worker", id: e.id, title: e.title })),
    ...(sessions.success ? sessions.data : []).map((e): ScreenElement => ({ kind: "session", id: e.key, title: e.title || e.key })),
    ...tasks.map((e): ScreenElement => ({ kind: "task", id: e.id, title: e.title })),
    ...notes.map((e): ScreenElement => ({ kind: "note", id: e.id, title: e.title })),
    ...artifacts.map((e): ScreenElement => ({ kind: "artifact", id: e.id, title: e.title })),
    ...(asks.success ? asks.data.asks : []).map((e): ScreenElement => ({ kind: "ask", id: e.id, title: e.title })),
    ...(attention.success ? attention.data : []).map((e): ScreenElement => ({ kind: "attention", id: e.id, title: e.title })),
  ];
  const held = new Map(groups.flatMap((g) => g.sessions.map((s) => [s, g.id] satisfies [string, string])));
  const inIdea = new Map(ideas.flatMap((i) => i.sessions.map((s) => [`${s.source}:${s.id}`, i.id] satisfies [string, string])));
  const mergedSessions = new Map((sessions.success ? sessions.data : []).map((s) => [s.key, { key: s.key, title: s.title || s.key, idea: s.mission ?? inIdea.get(s.key) ?? null, group: held.get(s.key) ?? null, hidden: Boolean(hidden[s.key]) }]));
  for (const w of workers) if (w.session && !w.crew && w.owner?.tier !== "control" && w.owner?.tier !== "crew") mergedSessions.set(w.session, { key: w.session, title: w.title || w.session, idea: w.mission ?? inIdea.get(w.session) ?? null, group: held.get(w.session) ?? null, hidden: Boolean(hidden[w.id] || hidden[w.session]) });
  // Archived ideas remain addressable for unarchive and navigation.
  return {
    ideaRepos: Object.fromEntries(ideas.map(i => [i.id, i.repos])),
    groupRepos: Object.fromEntries(groups.map(g => [g.id, [...new Set([...ideas.filter(i => i.group === g.id).flatMap(i => i.repos), ...(sessions.success ? sessions.data.filter(s => g.sessions.includes(s.key)).map(s => s.cwd) : [])])]])),
    ideas: ideas.map((i) => ({ id: i.id, title: i.title, group: i.group ?? null, repo: { path: i.repos[0] ?? "", title: repoLabel(i.repos[0] ?? "") || "No repo" } })),
    groups, repoGroups: [...new Map(ideas.filter((i) => !i.group).map((i) => [i.repos[0] ?? "", { path: i.repos[0] ?? "", title: repoLabel(i.repos[0] ?? "") || "No repo" }])).values()],
    unfiled: [...new Map(workers.filter((w) => !w.mission && !w.crew).map((w) => [w.cwd, { project: w.cwd.split("/").at(-1) ?? "", title: w.cwd.split("/").at(-1) || "No project" }])).values()],
    tasks: tasks.map((t) => ({ ...t, idea: t.mission ?? null })), sessions: [...mergedSessions.values()], history: z.array(History).parse(historyRaw),
    elements: refs, notes, accounts: accounts.success ? accounts.data : [], resumable: sessions.success ? sessions.data : [],
  };
}
