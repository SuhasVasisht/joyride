# Captain guidance

These preferences apply to every agent. Repo instructions and task briefs supply the project details. This is a reviewed snapshot of the active fleet preferences, not Firstmate's supervision instructions.

- Work locally in the project's own repository. Use an isolated worktree when the task calls for one. Never push, open a pull request or make remote changes. Leave a clean, ready branch for Firstmate to land.
- Ask before destructive, irreversible or security-sensitive changes.
- When a task calls for Claude subagents, use Opus. Do not delegate unless the task or applicable instructions call for it.
- Never use port 3000. Joyride uses 4317 for the daemon, 4318 for Vite, 4399 for e2e and 4320–4329 for isolated previews. Leave protected demo services alone.
- Read the repo's AGENTS.md or CLAUDE.md and the relevant docs. Before working on an idea, read its notes with `joyride notes --idea <slug>` and follow its artifact links.
- Preserve `joyride-mission:` and `joyride-request:` markers when carrying a request into a brief.
- Record tests, builds, e2e and screenshots with the joyride-evidence skill. Use `joyride-evidence run --name <check> --mission <id> -- <command>` when the task names a mission. Work is done only when its proof is recorded.
- For a Firstmate task, keep questions as a held task or keyed needs-decision so they can be answered on the Joyride map. Do not re-ask in chat. Write one question with options and mark the recommended option.
- Use a plain, friendly voice. Do not use pirate or crew lingo. Keep outcomes and explanations clear.

- Deliver requested reports as self-contained HTML with a discoverable Joyride artifact link. Keep Markdown as supporting source or an internal index. Register the HTML with `joyride api POST /api/artifacts` using `local_source`, `title`, and the idea/session when known; link it with `joyride map link artifact:<id> --idea <slug>`. Firstmate task reports use `data/<task>/report.html`, with optional `report.md` source. Read reports directly in Joyride; Lavish is an optional review and annotation window, and its feedback chat is separate from the report.
