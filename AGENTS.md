# Joyride — agent guide

Joyride is a local agent workspace. Read `docs/DESIGN.md` first; it records every settled design decision. `docs/CONTRACTS.md` lists the service and API contracts between modules.

Read the repo's instructions, the idea's notes with `joyride notes --idea <slug>` and the linked artifacts. Write notes and register artifacts through `joyride map note|list|link`, and record proof with `joyride-evidence`.

## Commands

- `npm start`: run the daemon in the foreground on 127.0.0.1:4317. `./bin/joyride up|down|restart` runs it in the background.
- `npm run build`: build the UI into `dist/ui`. The daemon serves it.
- `npm test`: vitest unit tests (`tests/unit/**`).
- `npm run e2e`: Playwright end-to-end tests (`tests/e2e/**`).
  - Each run gets a fresh sandbox at /tmp/joyride-e2e on port 4399, with fake models and fake stores.
  - Run `npm run build` first.
- `npm run typecheck`: TypeScript check.
- `./bin/joyride install|uninstall <component>`: the only way to touch anything outside this repo. Every change is logged to `GLOBAL_CHANGES.md` in the data home.

## Layout

- `src/shared/`: zod schemas (`schema.ts`), paths (`paths.ts`, with the data home from `home.ts`), and the pure guard matcher. Imported by every runtime: daemon, hooks, CLI, UI.
- `src/core/`: daemon infrastructure:
  - event log, SQLite index, bus
  - Jev client (`jev.ts`), heavy LLM (`llm.ts`), test fakes (`fakes.ts`)
  - git-backed store (`gitstore.ts`)
- `src/modules/<name>/index.ts`: daemon feature modules. Each one default-exports `defineModule({ name, order, migrations, register(ctx), start(ctx) })`.
  - Modules are discovered automatically; never edit a central list.
  - A module registers its routes under `/api/<name>/…` and exposes its API with `ctx.services.set(name, svc)`.
  - It announces UI-visible changes with `ctx.bus.change({ entity })`.
  - It reacts to events with `ctx.bus.onEvent(fn)`.
- `src/hooks/hook.ts`: the single Claude Code and Codex hook entry, run by bun. It must stay fast and dependency-light.
- `src/cli/`: the `joyride` CLI, the installer, and `joyride-evidence`.
- `src/ui/`: React UI. Each feature contributes routes, rail sections, palette commands and nav from `src/ui/views/<feature>/contribute.tsx`, discovered with `import.meta.glob`.
  - Design tokens live in `src/ui/styles/tokens.css`.
  - The look is "chart room": cool paper, navy ink, and the signal orange reserved for "needs you".
- `tests/sandbox.ts`: an isolated world for tests.
  - `sandboxDaemon(name, onlyModules)` builds a temp data root and fake `~/.claude` and `~/.codex` from `tests/fixtures/`, sets the env, and gives you `req(method, url, body)` against the in-process app.
  - Fixture text files may use time tokens: `{{T-2h}}`, `{{MS:T-3d}}` and `{{S:T-1d}}`.

## Rules

- **Never use port 3000.** The daemon runs on 4317, Vite dev on 4318, e2e on 4399, and tier-2 previews on 4320–4329.
- **Never write outside this repo, except through the installer.** The external stores `~/.claude` and `~/.codex` are read-only.
- **No pushes, PRs, Jira, Slack or other remote writes.** The global PreToolUse guard will hold them anyway.
- **Mark internal LLM and Jev calls.** Use `src/core/llm.ts` and `src/core/jev.ts`; they set `JOYRIDE_INTERNAL=1`, so the calls never show up in the world view or fire hooks.
- **Tests run with `JOYRIDE_FAKE_MODELS=1`.** For realistic shapes, register task-specific fakes with `registerLlmFake(task, fn)`.
- **Authored data is written through `commitPaths()`.** That covers missions, lenses, notes, artifacts and `workspace.yaml`, so every change is a git commit in the data home (`paths.root`). The data home is `JOYRIDE_HOME`, else the gitignored `.joyride.env`, else this checkout. Never commit personal data to this repo; it is public.
- **Handle no-data and failure states.** Sources can be missing or unreadable, Herdr can be down, and the daemon must keep running.
- **The daemon starts Herdr.** When the local socket is down it runs `herdr server` itself (`herdr.manage`, `src/modules/live/herdr-manager.ts`). Tests never spawn a real Herdr unless the sandbox sets `JOYRIDE_MANAGE_HERDR=1`; experiments with a real server use their own `XDG_CONFIG_HOME`, never the user's.
- **Copy:** sentence case, plain verbs, no all-caps labels. Errors say what happened and how to fix it.
- **Prove every feature with evidence:** unit tests, plus Playwright e2e with screenshots saved via `tests/e2e/shot.ts` to `docs/checkpoints/<C#>/`. `docs/checkpoints/` and `docs/reports/` are gitignored local evidence.
