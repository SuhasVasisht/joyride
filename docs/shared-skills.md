# Shared agent skills

Your skill library lives in the data home's `skills/` (see the README). Joyride's own worker skills, `joyride-evidence` and `joyride-verify`, ship in this checkout's `skills/`. `shared-skills` links both trees into every agent home; a name in both stops the install. A provider copy that differs from the canonical one is accepted only when its hash is listed in `<data home>/install/skills-snapshots.json`; keep the differing originals under `<data home>/install/skills-originals/`. All canonical skill definitions need a parseable name and description.

When the data home moves, `install shared-skills` retargets the managed links in place and keeps their original backups. `install guidance` does the same for the guidance links.

After merging, run these from the permanent checkout:

```sh
./bin/joyride install shared-skills no-caveman --dry-run
./bin/joyride install shared-skills no-caveman
```

The installer makes per-folder links from `~/.claude/skills`, `~/.codex/skills`, `~/.codex-2/skills`, `~/.cursor/skills` and `~/.agents/skills` into those two trees. Keep the permanent checkout available. Edit the canonical files; every linked home sees the change. Codex's current [official discovery paths](https://learn.chatgpt.com/docs/build-skills) include `~/.agents/skills`; it supports symlinked skill folders. Cursor 2026.07.17's installed MCP help uses `~/.cursor/mcp.json`, and [Cursor's skills documentation](https://cursor.com/docs/skills) covers both global skill paths and compatibility paths.

Every original path is backed up before the first replacement under `.joyride/backups/shared-skills-<id>/`. A durable manifest under `.joyride/install/` records exact undo paths. Installs and uninstalls are logged to `GLOBAL_CHANGES.md`. Repeating install keeps the same backups. Unrecognized differences, broken links, internal symlinks, symlinked skill roots and later user replacements stop the operation before any provider path changes. Newly discovered skills are copied into the data home's `skills/` when their names do not conflict; review and commit those new files after installation.

```sh
./bin/joyride uninstall shared-skills no-caveman --dry-run
./bin/joyride uninstall shared-skills no-caveman
```

Undo restores original directories and relative links. It keeps canonical files and backups; shared edits remain in the canonical tree. Undo refuses to overwrite later provider replacements. `no-caveman` restores only the original caveman flags, preserving later unrelated settings. It disables the Claude plugin, including its SessionStart hook, through `enabledPlugins`; the cached package is retained. Existing sessions already received the hook's text: tell them `stop caveman; use normal prose`, or start a fresh Claude session after installation. This worker never applied either component to the live home.

Bundled Codex `.system` skills, Cursor `skills-cursor`, plugin caches, hidden archives, managed rules and credentials stay under provider management. Plugin skills can depend on host-specific tools and hooks; sharing local folders does not port a plugin or authenticate its MCPs. Legacy `install pstack` and `install evals` skip the canonical links rather than replacing them. When updating upstream skills, review changes against `skills/` and commit the canonical update. Legacy `uninstall skills` keeps links managed by `shared-skills`.

Embedded `.git` bookkeeping is excluded from canonical copies and content comparisons. Complete original directories, including that bookkeeping, are backed up and restored by the installer. This keeps skills as ordinary tracked files rather than accidental submodules.

For an isolated home, set `HOME`, `JOYRIDE_HOME`, `JOYRIDE_RUNTIME` and the provider overrides `JOYRIDE_CLAUDE_DIR`, `JOYRIDE_CODEX_DIR`, `JOYRIDE_CODEX_2_DIR`, `JOYRIDE_CURSOR_DIR`, `JOYRIDE_AGENTS_DIR`. The integration test demonstrates dry-run, actual install, idempotency and undo without credentials or provider CLI execution.

The separate MCP manifest installer is documented in [shared MCP configuration](mcp-parity.md). Its `--dry-run` can be combined with `shared-skills` and `no-caveman`; authentication remains independent in each client.

## Captain guidance

Run `./bin/joyride install guidance --dry-run`, then `./bin/joyride install guidance` from the permanent checkout. The installer seeds and commits `guidance/captain.md` from the reviewed snapshot at `install/guidance/captain.md`. That snapshot selects fleet preferences for all agents, including local work, evidence and idea notes. It excludes Firstmate's fleet supervision authority and operational learnings. It adds the explicit Opus and port rules requested by the guidance migration. It never imports or distills new preferences automatically.

The installer links `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` directly to that file. Provider overrides `JOYRIDE_CLAUDE_DIR` and `JOYRIDE_CODEX_DIR` select other homes. Install separately for each active Codex home with the appropriate override. Settings shows the canonical file read-only, including its path. Edit it in the repository and commit the change. Reinstall keeps edits.

Empty originals are backed up under `.joyride/backups/guidance-<id>/`; the undo manifest preserves original file modes and relative links. Nonempty global instructions stop installation before either home changes. Merge those instructions into the canonical file, then empty the originals before installing. `./bin/joyride uninstall guidance` restores the original files or links and removes files that were previously absent. It keeps guidance and backups. Undo refuses later replacements or missing backups. Every install and uninstall is logged in `GLOBAL_CHANGES.md`.

## Codex hook approval and visibility

Installing hooks only writes configuration. The default installer home is `~/.codex`; a login using `CODEX_HOME=~/.codex-2` needs its own installation, for example `JOYRIDE_CODEX_DIR="$CODEX_HOME" ./bin/joyride install hooks`. Status warns when the active Codex home differs from the installer home. In each Codex home you use, open an ordinary Codex session, run `/hooks`, review the Joyride commands and approve them once. New or changed commands require review again. Restart the session, run a harmless tool such as `pwd`, then exit. `./bin/joyride status` reports whether `hook.codex` events have ever appeared in Joyride's event log and whether `session.start`, `tool.pre` and `session.end` have been observed. It does not infer approval from installed hook counts. Missing history reports never fired; unreadable history reports unavailable.

Firstmate's `fm-spawn.sh` deliberately launches Codex crewmates and scouts with `--disable hooks`, equivalent to `features.hooks=false`, to avoid parking automated launches at the trust prompt. Their turn-end signal uses `notify` instead. Approving the global hooks does not change this launch flag. Internal Joyride model calls also disable hooks and set `JOYRIDE_INTERNAL=1`. Sparse Codex events therefore do not establish a hook implementation failure or prove that all Codex sessions are guarded. This task leaves Firstmate launch policy unchanged.

For an isolated diagnostic session, use a temporary Codex home, only reviewed Joyride hook commands, `JOYRIDE_NO_AUTOSTART=1`, and a separate `JOYRIDE_RUNTIME`. Do not bypass hook trust for ordinary sessions or modify the user's trust store. The one-time approval remains an operator action after landing.

The isolated 2026-10-05 diagnostic used Codex 0.160.0 with reviewed hooks and per-invocation trust bypass in a disposable home. It observed all three required events and confirmed that a fresh Codex session outside the Joyride repo loaded the symlinked global guidance. No user trust approval was written. Read-only inspection found Joyride hooks in `~/.codex/hooks.json` and no hooks file in the active `~/.codex-2` home. Together with Firstmate's launch flag, this explains sparse events without assuming the user declined hook approval.
