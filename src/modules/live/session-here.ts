import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Ctx } from "../../core/context.ts";
import { knowledgePolicy } from "../../core/knowledge-policy.ts";
import { paths } from "../../shared/paths.ts";
import { primaryLens } from "../../shared/lens-match.ts";
import type { SessionsService } from "../sessions/index.ts";
import { SessionHere } from "../../shared/session-here.ts";
import type { Mission } from "../../shared/schema.ts";
import type { MissionsService, LensesService } from "../missions/index.ts";
import type { ArtifactsService } from "../artifacts/index.ts";

/** Context is read when launched, so edited goals and links reach the new session. */
export function sessionHere(ctx: Ctx, input: unknown, permissionMode = ctx.config.workers.permission_mode, agent: "claude" | "codex" = "claude", chosenCwd?: string) {
  const parsed = SessionHere.safeParse(input);
  if (!parsed.success) throw new Error("Choose an idea, group or project to start a session here.");
  const target = parsed.data;
  const missions = ctx.service<MissionsService>("missions");
  const lenses = ctx.service<LensesService>("lenses");
  const admission = knowledgePolicy(ctx);
  let ideas: Mission[] = [];
  let title: string;
  let cwd: string | undefined;
  switch (target.kind) {
    case "idea": {
      const m = missions.get(target.id);
      if (!m) throw new Error(`Idea "${target.id}" no longer exists. Choose an idea on the map.`);
      ideas = [m]; title = m.title; cwd = m.repos[0];
      break;
    }
    case "group": {
      const l = lenses.get(target.id);
      if (!l) throw new Error(`Group "${target.id}" no longer exists. Choose a group on the map.`);
      const groups = lenses.list();
      ideas = missions.list().filter(m => !m.archive && primaryLens(m, groups)?.id === l.id)
        .filter(m => !m.private && !m.repos.some(repo => admission.private({ cwd: repo })));
      const sessions = ctx.services.has("sessions") ? ctx.service<SessionsService>("sessions").list({ limit: 100000 }) : [];
      const held = sessions.find(s => (l.sessions.includes(s.key) || l.projects.includes(path.basename(s.repo ?? s.cwd).toLowerCase())) && !admission.private(s));
      title = l.title; cwd = ideas.flatMap(m => m.repos)[0] ?? held?.repo ?? held?.cwd ?? (l.rule.repo?.startsWith("/") ? l.rule.repo : undefined);
      break;
    }
    case "project":
      title = target.title; cwd = target.cwd;
      break;
  }
  cwd = chosenCwd ?? cwd ?? paths.root;
  if (!path.isAbsolute(cwd)) throw new Error("Starting a session needs an absolute checkout path. Pick a project folder.");
  const links = ctx.services.has("artifacts") ? ctx.service<ArtifactsService>("artifacts").list() : [];
  const artifacts = links.filter(a => ideas.some(m => a.mission === m.id) && !a.private && !admission.private(a));
  const prompt = [
    `${target.kind === "idea" ? "Idea" : "Group"}: ${title}`,
    ...ideas.flatMap(m => [m.goal || m.title, `Read the idea's notes: joyride notes --idea ${m.id}`]),
    ...(target.kind === "group" ? [`Read the group's notes: joyride notes --group ${target.id}`] : []),
    ...artifacts.map(a => `${a.title}: ${a.url ?? a.local_source ?? (a.snapshot_blob ? path.join(paths.blobs, a.snapshot_blob) : path.join(paths.artifacts, `${a.id}.md`))}`),
    "Write any report to a file and register it with joyride map link.",
  ].join("\n");
  const id = randomUUID();
  return {
    cwd, prompt, label: title,
    args: agent === "claude" ? ["--session-id", id, "--permission-mode", permissionMode === "manual" ? "default" : permissionMode] : [],
    link(nativeSession = agent === "claude" ? `claude:${id}` : undefined) {
      if (!nativeSession) throw new Error("The native session identity is not available yet. File it from the map once the agent is ready.");
      const nativeId = nativeSession.slice(nativeSession.indexOf(":") + 1);
      if (target.kind === "idea") missions.linkSessions(target.id, [{ source: agent, id: nativeId }]);
      if (target.kind === "group") {
        const l = lenses.get(target.id);
        if (!l) throw new Error(`Group "${target.id}" was removed while the session started.`);
        lenses.save({ ...l, sessions: [...new Set([...l.sessions, nativeSession])] });
      }
    },
    session: agent === "claude" ? `claude:${id}` : undefined,
  };
}
