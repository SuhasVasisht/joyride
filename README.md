# Joyride

A local workspace for running an organization of coding agents. Joyride shows you what Claude Code and Codex are doing across your repos and machines, tells you which agents need you right now, keeps evidence that work is actually done, and builds up memory your agents read at the start of every session. You can reshape the workspace itself just by describing the change you want.

Joyride never decides who does the work. **Herdr** runs the agent sessions and **Firstmate** delegates the work. Joyride owns the world model, attention, evidence, memory and the workspace around them. Every command you give from the UI becomes an *intent* that the right owner carries out.

```
open http://127.0.0.1:4317
```

## What you can do

- **See everything at once on the map.** Missions sit on a pannable chart, grouped by lens or repo. Zoom out for mission titles; zoom in to see live workers and what each one is doing right now.
- **See who needs you in the rail.** Each item has a "why" line taken from the agent's own words.
  - Items are sorted by how urgently they need you: L4 urgent, L3 blocked on you, L2 ready for review, L1 digest.
  - Jev classifies each item, and a deterministic floor means a stuck agent is never hidden.
- **Unblock agents from Joyride**, without switching to the terminal:
  - Reply in place.
  - Answer a terminal permission menu (Allow, Always allow, Deny).
  - Approve or deny a held risky action.
- **Hold only risky actions, everywhere.** A global guard covers every Claude Code and Codex session. It holds only actions that reach the outside world: pushes, Jira or Slack writes, cloud changes, remote shells, publishing. Everything else runs freely.
- **Get proof before "done".**
  - Agents wrap their checks with `joyride-evidence`, which records exit codes, logs and screenshots.
  - Jev judges each done-when criterion: pass, fail or insufficient.
  - A mission can close only on a pass, or with an override reason you write.
- **Memory that stays honest.**
  - One markdown file per decision or learning, with provenance and supersession.
  - An entry goes stale when the code it describes changes, and stale entries stop being injected.
  - Agents get a short digest at session start, plus MCP tools to dig deeper.
- **Learnings from traces.**
  - Extract learnings on demand, with nudges when you forget.
  - Artifacts (Claude, ChatGPT, PRs) are detected and distilled into memory candidates.
- **An evolving workspace.**
  - Describe a change ("a view of blocked workers by repo"). Joyride previews it as a spec diff; you accept or revert it.
  - Bigger changes run as a code mission on a branch, with a preview port and evidence.
- **Hill-climbing.**
  - Joyride tunes its own Jev judges against your labels. A change only applies if it beats the current judge on held-out cases and you accept it.
  - backpass proposes evidence-backed edits to your agents' instructions.
- **Crews.**
  - Firstmate tasks for a mission show up as a crew.
  - You can apply capabilities (arena, interrogate, tdd, blast-radius, verification, show-me-your-work, eval-this) to a mission or worker.

## Run it

Joyride runs on macOS with Node 20 or later, Bun (the hooks run on it) and Herdr (agent sessions).

```sh
git clone git@github.com:SuhasVasisht/joyride.git && cd joyride
npm install
./bin/joyride vendor   # pinned third-party checkouts, listed in vendor/PINS.md
npm run build          # UI -> dist/ui
./bin/joyride up       # supervised daemon on 127.0.0.1:4317 (hooks also auto-start it)
./bin/joyride status   # components + daemon
```

### Your data home

Joyride commits everything you author to git: missions, notes, artifacts, your skill library, guidance and config. Keep that in its own private repo so this checkout stays code-only. Set it up before the first `up`:

```sh
mkdir -p ~/joyride-data && git -C ~/joyride-data init -q -b main
cp joyride.config.example.yaml ~/joyride-data/joyride.config.yaml
printf 'JOYRIDE_HOME=~/joyride-data\n' > .joyride.env
```

- `.joyride.env` is gitignored. The environment variable `JOYRIDE_HOME` overrides it.
- `JOYRIDE_RUNTIME` (default `<data home>/.joyride`) holds the event log, index, blobs and install backups. It can go in `.joyride.env` too.
- Secrets such as `JEV_API_KEY` go in `<data home>/.env`, which you should gitignore there.
- The data home's `guard.yaml`, `config/judges/` and `config/mcp-manifest.json` win over the defaults shipped here.
- Without a data home, Joyride writes into this checkout. Don't push that.

Everything Joyride changes outside this folder is applied by `./bin/joyride install <component>`, logged in `<data home>/GLOBAL_CHANGES.md`, and reversible with `./bin/joyride uninstall <component>`. The components:

| component | what it changes |
|---|---|
| `hooks` | Claude Code and Codex hooks: event capture, the blast-radius guard, the memory digest |
| `mcp` | `joyride-memory` MCP server for Claude Code and Codex |
| `skills` | `joyride-evidence` and `joyride-verify` worker skills |
| `shared-skills` | links your skill library (`<data home>/skills`) and Joyride's own skills into every agent's skills folder |
| `guidance` | links `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` to `<data home>/guidance/captain.md` |
| `pstack`, `agents` | Poteto's P-Stack (canonical cursor/plugins, adapted for Claude Code and Codex) and its agents |
| `evals` | ai-evals-course evals skills for both agents |
| `firstmate` | pinned Firstmate distro, with its data folder `FM_HOME` in `.joyride/firstmate` |
| `backpass` | `acpx`, which backpass needs, under Node 22 |
| `herdr` | upgrades Herdr through brew |
| `service` | optional launchd agent for unprotected folders; `up` already supervises crashes |

## Develop

- `npm test`: vitest. Each test file runs in its own sandbox and can never touch the real `.joyride/`.
- `npm run e2e`: Playwright. Each spec runs against its own sandbox daemon, with fake models and a fake Herdr.
- `npm run typecheck`

Read `AGENTS.md` first, then `docs/DESIGN.md` (the settled design), `docs/DECISIONS.md` (why), `docs/CONTRACTS.md` and `docs/API.md` (module contracts, every route) and `docs/CHECKPOINTS.md` (how each part was verified).

To dogfood, add a mission for this repo in the UI: crews, evidence and evolution all work on Joyride itself.

## License

MIT. See `LICENSE`. Adapted third-party material is listed in `THIRD_PARTY_NOTICES.md`.
