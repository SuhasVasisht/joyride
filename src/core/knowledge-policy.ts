import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { execFileSync } from "node:child_process";
import type { Ctx } from "./context.ts";
import { editConfigYaml } from "./config-yaml.ts";
import { commitPaths } from "./gitstore.ts";
import { paths } from "../shared/paths.ts";
import { admitKnowledge, forgeRepo, privatePath, privateSource, type KnowledgeSource } from "../shared/knowledge-admission.ts";
import type { NoteFile } from "../shared/note-files.ts";
import type { ArtifactsService } from "../modules/artifacts/index.ts";
import type { SessionsService } from "../modules/sessions/index.ts";
import type { MissionsService } from "../modules/missions/index.ts";

export function knowledgePolicy(ctx: Ctx) {
  return {
    get policy() { return ctx.config.knowledge; },
    source(input: KnowledgeSource): KnowledgeSource {
      const session = input.session && ctx.services.has("sessions") ? ctx.service<SessionsService>("sessions").get(input.session) : null;
      return { ...input, cwd: input.cwd ?? session?.cwd };
    },
    admits(input: KnowledgeSource) { return admitKnowledge(this.source(input), this.policy); },
    private(input: KnowledgeSource) { return privateSource(this.source(input), this.policy); },
    note(input: Partial<Pick<NoteFile, "id" | "private" | "scope" | "title" | "provenance">>) {
      if (!this.admits(input) || (input.title && !this.admits({ id: `note-title:${input.title.trim().toLowerCase()}` }))) return false;
      const missions = ctx.services.has("missions") ? ctx.service<MissionsService>("missions") : null;
      if (input.scope?.startsWith("mission:") && missions?.get(input.scope.slice(8))?.private) return false;
      for (const provenance of [input.provenance]) {
        if (!provenance) continue;
        for (const ref of provenance.ref.split(";").map(s => s.trim()).filter(Boolean)) {
          const session = provenance.type === "session" || provenance.type === "trace" ? ref : null;
          if (!this.admits({ id: ref, local_source: provenance.type === "imported" ? ref : null, session })) return false;
          const artifact = provenance.type === "artifact" && ctx.services.has("artifacts") ? ctx.service<ArtifactsService>("artifacts").get(ref) : null;
          if (artifact && !this.admits({ ...artifact, url: artifact.detected_from === "transcript" ? artifact.url : null })) return false;
        }
      }
      return true;
    },
    /** Persist discovered remotes so the captain can inspect and edit the allowlist. Private checkouts never contribute. */
    discover() {
      const policy = this.policy;
      const sessions = ctx.services.has("sessions") ? ctx.service<SessionsService>("sessions").list({ limit: 100000 }) : [];
      const missions = ctx.services.has("missions") ? ctx.service<MissionsService>("missions").list() : [];
      const repos = new Set([paths.root, 
        ...missions.flatMap(m => m.repos), ...sessions.filter(s => !this.private({ session: s.key, cwd: s.cwd })).flatMap(s => s.repo ? [s.repo] : [])]);
      const owned = new Set(policy.owned_repos);
      for (const repo of repos) {
        if (!path.isAbsolute(repo) || privatePath(repo, policy) || repo.includes("/vendor/")) continue;
        try {
          const out = execFileSync("git", ["config", "--get-regexp", "^remote\\..*\\.url$"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1000 });
          for (const line of out.trim().split("\n")) { const r = forgeRepo(line.replace(/^\S+\s+/, "")); if (r) owned.add(r); }
        } catch { /* Missing and unreadable checkouts cannot grant admission. */ }
      }
      if ([...owned].every(r => policy.owned_repos.includes(r))) return;
      const config = fs.existsSync(paths.config) ? YAML.parse(fs.readFileSync(paths.config, "utf8")) : {};
      policy.owned_repos = [...owned].sort();
      config.knowledge = { ...config.knowledge, ...policy };
      fs.writeFileSync(paths.config, editConfigYaml(fs.existsSync(paths.config) ? fs.readFileSync(paths.config, "utf8") : "", config));
      commitPaths([paths.config], "knowledge: record owned repository remotes");
    },
  };
}
