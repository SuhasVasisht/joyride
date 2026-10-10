# Joyride — Design

Joyride is a local workspace for one person who runs many coding agents (Claude Code, Codex) on one or more machines. It sits *above* the runtime (**Herdr**) and the orchestrator (**Firstmate**). It owns the **world model**, **attention**, **evidence**, **notes**, **artifacts**, and the map layout.

It never decides who does the work. Every human command becomes an **intent**, and the owner of that thing executes it.

> Design a management interface for an organization whose workers happen to be agents.

These decisions were settled in a 26-question grilling session on 2026-10-03. Active captain decisions are copied into `docs/decisions/*.md`; `docs/DECISIONS.md` indexes them. Git history retains earlier versions of the decisions.

---

## 1. Ownership

| Layer | Owner | Joyride's relation |
|---|---|---|
| Sessions, panes, processes, resume, remote machines | **Herdr** (`/opt/homebrew/bin/herdr`, socket `~/.config/herdr/herdr.sock`) | read via socket and events; write only through intents (`agent.prompt`, `send_keys`, `tab.create`, `agent.start`) |
| Delegation, crews, task backlog, worktrees, supervision of the whole fleet | **Firstmate** (`vendor/firstmate`, `FM_HOME=.joyride/firstmate`) | read its state files; write intents via `bin/fm-send.sh` (steers) or a captain inbox note with `bin/fm-inbox.sh note` (new tasks, fleet notes); Firstmate reads the fleet through `joyride fleet`, steers the captain's sessions through `joyride steer`, and hears fleet events from the `joyride-fleet-feed` extension (§12) |
| Missions, lenses, workspace spec, notes, artifact registry, guard policy | **Joyride** (files in git) | authored, canonical |
| Transcripts | Claude Code (`~/.claude/projects`) and Codex (`~/.codex/sessions`, `~/.codex/state_5.sqlite`) | read-only projection |

**Litmus test.** If it changes who gets spawned or delegated, it belongs to Firstmate. If it changes what we know, what we see, or how history is organized, it belongs to Joyride.

## 2. Glossary (world model)

The authored and projected world uses six nouns:

- **Idea**: one stream of the captain's intent, stored as `missions/<slug>.md`. Files, routes and APIs keep the name mission. The captain sets `state` (open, paused, done, dropped); Joyride derives `health` (active, blocked, needs-review, idle). An idea links sessions, Firstmate tasks through `crews`, notes, artifacts and optional `done_when` evidence criteria. Placement files unplaced tasks into ideas; the captain authors names, merges and archives.
- **Group**: an area of ideas, stored as `lenses/<slug>.yaml`, with canvas positions in `map/layout.yaml`. APIs keep the name lens. A group can hold sessions directly and a project's unfiled work. Grouping never changes execution.
- **Note**: an authored board item in `notes/<id>.md`, placed on an idea, group or Unfiled. Its lines can mix text, checkboxes and links. Task and session anchors also support contextual notes.
- **Session**: one transcript projected from Claude Code or Codex sources. A live process can have several sessions over time. Sessions launched outside Firstmate remain visible on Agents, can auto-link to ideas and join the watched fleet.
- **Task**: a Firstmate backlog item, projected read-only. Changes go through owner intents. Its authored idea link in `Mission.crews` wins over the `joyride-mission:` marker in its brief. Firstmate owns its workers and any secondmates.
- **Artifact**: a link card in `artifacts/<id>.md` with a title, kind, URL or local path, idea and session links, summary and private flag. Local files retain snapshots; hosted pages open at their links.

Workers, ownership, helm, attention, dependencies and intents describe live state around these nouns. A worker is one live agent process. Its owner tier is `crew` (Firstmate launched it for a task, matched by recorded pane, pid or `FM_TASK_ID`, never cwd), `control` (Firstmate's own process), `watched` (the captain started it) or `excluded` (kept to the captain through `fleet.yaml`).

Firstmate sees the fleet, including sessions started outside Firstmate, through `joyride fleet`, `joyride steer` and the process-event feed (§12). It may guide watched sessions through the guarded path in `docs/fleet-operator.md`. Retirement requires an idle pane and preservation of session context and artifacts; it never removes transcripts or checkouts.

Firstmate holds the helm by default. A captain steer takes it until the turn ends plus 15 quiet minutes, or until hand-back. Firstmate's steers, prompt answers and retirement are refused while the captain holds it. Evidence records from `joyride-evidence` supply proof. Repo choices and their reasons live in `docs/decisions/`.

## 3. Storage

```
joyride/
  missions/*.md            authored (frontmatter + goal body)
  lenses/*.yaml            authored
  notes/*.md               authored board items (place, title and dates in frontmatter; lines in the body)
  docs/decisions/*.md      authored decisions, indexed by docs/DECISIONS.md
  artifacts/*.md           artifact registry entries
  map/layout.yaml          authored group positions
  workspace.yaml           map settings (title, home, theme)
  guidance/captain.md       global agent instructions installed into runtime instruction files
  fleet.yaml               fleet policy: membership, the captain's own sessions, Firstmate's authority over them
  guard.yaml               blast-radius guard policy
  joyride.config.yaml      LLM backends, ports, horizons, notification policy
  config/judges/*.yaml     Jev judge instructions for attention and evidence
  .joyride/                gitignored runtime
    events/YYYY-MM-DD.jsonl  append-only event log (hooks + daemon). Durable, never deleted.
    index.sqlite             disposable projection/index; rebuildable from sources + events
    blobs/<sha256>           screenshots, logs (content addressed)
    task-notes/              task-only notes context consumed by the SessionStart hook
    guard.compiled.json      compiled guard policy consumed by the PreToolUse hook
    proposals/missions/      session-backed idea proposals awaiting review
    firstmate/               FM_HOME
    llm/                     cwd for internal LLM calls (filtered out of the world)
  vendor/                  gitignored pinned clones (see vendor/PINS.md)
```

## 4. Runtime architecture

```
 hooks (bun, fast) ─┐ append events / guard long-poll
 Claude Code ───────┤
 Codex ─────────────┘
                     ▼
 .joyride/events/*.jsonl ──► joyride daemon (Node 20 + tsx, 127.0.0.1:4317)
 ~/.claude, ~/.codex ──────►   readers → projection → SQLite index
 Herdr socket (events) ────►   attention (rules floor + Jev) → notifications
 Firstmate state files ────►   intents → herdr / fm-send
                               ideas/groups/notes/artifact cards (git)
                               guidance + repo docs + skills (native agent context)
                               evidence records + fleet process-event feed
                               REST + SSE ──► React UI (served by daemon)
```

- **Daemon**: `npm start` runs `tsx src/server/main.ts`. Port 4317. `joyride up` starts a detached, single-instance supervisor; SessionStart and guard hooks start the same supervisor on demand. It survives the launching terminal closing and restarts a crashed or unresponsive daemon with bounded backoff. A launchd agent is optional (the `service` component), because macOS privacy protection blocks launchd jobs from reading ~/Documents unless node has Full Disk Access. Tier-2 preview instances use 4320–4329. Vite dev uses 4318. **Port 3000 is never used.**
- **Herdr server**: the daemon owns it, so nobody has to run `herdr` in a terminal first (`src/modules/live/herdr-manager.ts`).
  - When the default machine's socket does not answer at startup, or has been unreachable for more than 10 s, the daemon runs `herdr server` detached (its own session and process group) with every `CLAUDE*`/`JOYRIDE*` variable stripped, logging to `.joyride/herdr-server.log`.
  - It never starts a second server: a socket that answers (or is there but slow) counts as running, a server it or another daemon started in the last 20 s gets time to come up (`.joyride/state/herdr-server.json`), repeated failures back off, and Herdr itself refuses a second server on one socket.
  - `herdr.manage: false` in `joyride.config.yaml` turns it off; tests never spawn a real Herdr unless the sandbox sets `JOYRIDE_MANAGE_HERDR=1`. `POST /api/herdr/start` is the manual button. A `herdr` TUI attached later shows the same server.
- **UI**: React and Vite, built into `dist/ui` and served by the daemon. The SwiftPM macOS app in `apps/mac` hosts that same frontend in WKWebView; Swift owns only native shell behavior. Build and sandbox verification are documented in `docs/mac-app.md`.
- **Hooks**: `bun src/hooks/hook.ts <Event>`. One entry point handles every Claude Code and Codex hook event.
  - It appends events to the log.
  - The PreToolUse guard is fail-closed for gated actions only.
  - SessionStart records the session and adds task notes when `FM_TASK_ID` is set.
  - `JOYRIDE_INTERNAL=1` turns it into a no-op.
- **Internal LLM calls** never pollute the world view:
  - Claude: `claude -p --model haiku --no-session-persistence --settings '{"disableAllHooks":true}'`
  - Codex: `codex exec --ephemeral --disable hooks`

  Both run with `JOYRIDE_INTERNAL=1` and `cwd=.joyride/llm`.

## 5. Events (canonical)

Each event is one JSON line:

```
{ ts, id, source, type, session?, agent?, cwd?, pane?, data }
```

| source | types |
|---|---|
| `hook.claude` / `hook.codex` | `session.start`, `prompt.submit`, `tool.pre`, `permission.request`, `notification` (data.kind = permission_prompt, idle_prompt, …), `turn.stop`, `turn.stop_failure`, `session.end` |
| `herdr` | `pane.created`, `pane.closed`, `agent.status` (idle, working, blocked, done, unknown), `pane.focused` |
| `guard` | `guard.request`, `guard.decision` (allow, deny, timeout), `guard.rule_added` |
| `attention` | `attention.open`, `attention.update`, `attention.resolve` |
| `intent` | `intent.created`, `intent.sent`, `intent.acked`, `intent.failed` |
| `evidence` | `evidence.added`, `evidence.verdict` |
| `live` | `steer.attributed` (who put each prompt in), `helm.released` (the captain handed a helm back) |
| `fleet` | `fleet.member.state`, `fleet.helm.captain`, `fleet.helm.firstmate`, `fleet.member.excluded`, `fleet.member.included` (each also a fleet feed event for Firstmate) |

## 6. Attention

| Level | Meaning | Delivery |
|---|---|---|
| L0 | ambient state change | visible only when zoomed in |
| L1 | progress digest, nudges | digest panel |
| L2 | review: done with evidence, path overlap | badge and review queue |
| L3 | blocked on human: question, decision, permission, crash | macOS notification |
| L4 | urgent: a gated action waiting (it has a timeout), runaway spend | macOS notification with sound |

- **Classification:** Jev (`choice` over L0–L4, plus a `noul` for "needs human judgment", plus a `choice` for kind). It runs only on state transitions: turn stop, notification, permission request, idle, crash.
- **Hard floor:**
  - A pending permission, Herdr `blocked`, a crash or a stop failure is at least L3.
  - A pending guard request is L4.
  - Jev may only raise a level above the floor.
- **"Why" line:** taken from the hook payload (tool and input, or the last assistant message). No model is involved.
- **Resolution:** a human prompt submit, an approval, or a UI reply resolves the item. A later turn or tool activity supersedes a session question or decision; permission prompts clear when the session resumes. Needs-you counts use the actionable `/api/asks` list and open its controls in the rail. Progress and Firstmate control-session messages never create needs-you items; Firstmate captain calls come through held tasks.
- **Acknowledgement:** "Got it" acknowledges the item and removes the item from Needs you and its counts. Seen history keeps the item with Undo. A new question, block or failure from the session can open another item; reclassifying the acknowledged event or sending an idle reminder cannot.
- **Metrics:**
  - Blocked→unblocked latency: from an L3/L4 item opening to its resolution.
  - "Checking" proxy: Herdr pane focus switches while nothing is pending.

## 7. Guard (blast-radius only)

- **Default:** agents proceed freely. Only actions with real-world reach are held. The global PreToolUse hook covers every Claude Code and Codex session.
- **Gated by default** (`guard.yaml`):
  - `git push`
  - Writes to Jira, Confluence, Slack, email, Teams or SharePoint (MCP or curl)
  - Cloud and infra changes: gcloud, aws, kubectl apply/delete, terraform apply, docker push
  - `ssh` and `scp` to remote hosts
  - `rm -rf` outside the repo or worktree
  - Package publishing
  - `curl` or wget doing POST, PUT, PATCH or DELETE to non-local hosts
- **Flow:**
  1. The hook POSTs `/api/guard/requests` to the daemon.
  2. It long-polls until the human decides in the UI.
  3. Timeout after 5 minutes, or daemon unreachable: **deny** with a reason, so the agent continues with other work.
- **Ambiguous commands** (scripts named deploy, push or release, curl without a method) go to Jev. Jev can only *escalate*.
- **Command position only:** rules match a command only where it would actually run (`{{CMD}}` = line start, after `; && || | ( $(`, or after `sudo`, `env`, `then`, `xargs` and `VAR=x` prefixes). Data heredoc bodies (`cat <<EOF`, `python3 - <<EOF`) are ignored. Prose that merely mentions a command never triggers the guard.
- **Anti-fatigue:**
  - A batched approval tray.
  - "Allow this pattern for this session or mission" rules, stored in `.joyride` with an expiry.
- **Override:** `JOYRIDE_GUARD=off`.
- **Extension point:** `guard.yaml` has an `auto_approve` tier (empty by default) where Jev may later auto-approve classes of action.

## 8. Evidence

- **Writing evidence:** the worker skill `joyride-evidence` tells agents to run checks through `joyride-evidence run --name <n> -- <cmd>`.
  - The CLI records the exit code, a log tail and the screenshots it finds (blobbed).
  - It links the record to an explicit `--session` override first, then a validated `CODEX_THREAD_ID` or `CODEX_SESSION_ID`, then the parent process chain in `~/.claude/sessions/<pid>.json`, then recent hooks matching the working directory.
  - Records are *attested*.
- **Inferred evidence:** test runs mined from transcripts are labelled *inferred*.
- **Judging:**
  - Playwright and test assertions decide.
  - A Claude vision caption of a screenshot may only *downgrade* a pass to insufficient.
  - Jev returns pass, fail or insufficient against the mission's `done_when`.
- **Re-verify** is an intent.
- **Closing a mission** requires `done_when` to be satisfied, or an override with a written reason.

## 9. Guidance and notes

Repo decisions live in `docs/decisions/`, indexed by `docs/DECISIONS.md`. Agents read repo instructions, the idea's notes and linked artifacts, write notes and register artifacts through the `joyride` CLI, and record proof with `joyride-evidence`.

Notes are authored files in `notes/`, committed through `commitPaths()`. The Board, map cards, `/api/notes`, `joyride notes` and `joyride map note|list|link|move-note|board` share those files. Firstmate task notes remain available through `/api/notes/task/:id`, `joyride notes --task <id>` and the task-only SessionStart context cached in `.joyride/task-notes/`. Ordinary sessions read their native runtime instructions.

Firstmate's `captain.md`, `captain-shared.md`, `learnings.md` and `memory-archive.md` are canonical files. Joyride never renders or captures them. Settings reads them directly and offers Open file. Edit them in an editor or through Firstmate's `/stow`. Global runtime guidance comes from `guidance/captain.md`, installed through the reversible guidance installer.

Search at `#/knowledge` finds ideas, notes, artifacts, sessions and tasks, with type and place filters. Artifact cards and saved session handoffs open from the search results. Private sources remain available to the captain in artifact cards; private sessions and private ideas stay out of aggregate agent context.

Agents use the canonical `skills/` tree directly. `workspace.yaml` holds `title`, `home` and `theme`; the read-only `/api/workspace/spec` endpoint serves those map settings. Missing files use defaults; invalid YAML keeps the last readable layout until corrected. Idea panels use their default order.

## 12. Firstmate and P-Stack

- **Firstmate:**
  - Pinned in `vendor/firstmate` and run with Herdr as its backend.
  - Ship mode is a local branch merge: **no push, no PRs**.
  - It runs in a long-lived Herdr pane.
  - Joyride confirms primary exhaustion for 15 seconds using fresh quota-axi account readings or a usage-limit banner on a stalled pane. It hands off through `fm-inbox.sh note`, closes only the outgoing primary, waits for its lock pid to exit, then launches the next account in the same `firstmate` slot and FM_HOME. A successor must acquire the lock and finish `fm-session-start.sh` before the handoff is ready.
  - `firstmate.primaries` selects account ids from `usage.accounts` in priority order, with an optional model per account. The shipped order is Claude Code, Codex, Codex 2, Cursor; Codex defaults to `gpt-6.1-sol`. Unset priority follows the usage screen. Unknown or stale successor capacity keeps the current primary and shows an error. The hub and rail show the account and switch reason, offer a manual handoff, and offer Claude again when it has capacity. Returning to Claude waits for an idle primary.
  - `.joyride/state/firstmate-primary.json` preserves the handoff phase and inbox note across daemon restarts. Recovery never removes Firstmate's lock or home. Codex primaries use `--no-daemon` so their lock anchor exits with their pane, independently of the shared server used by crew. In bypass mode the owned Firstmate hooks are trusted for the invocation. Worker harness selection remains Firstmate's responsibility.
  - Intents reach it via `fm-send.sh` or by prompting its pane.
  - Its guidance files (captain preferences, shared preferences, learnings, archive) are canonical; Settings shows them read-only (§9).
  - It supervises the whole fleet through supported seams only, with no core patch (`dec-one-fleet`, `docs/fleet-operator.md`):
    - a fleet preference in `captain.md` points it at `joyride fleet --brief` and `joyride steer`;
    - captain inbox notes tell it which sessions joined and what the captain said before handing a helm back;
    - the `joyride-fleet-feed` process-event-adapter/1 extension (`install/firstmate-extension/joyride-fleet-feed`, bound by `./bin/joyride install firstmate-feed`) long-polls `/api/fleet/feed` and brings each fleet event to it as a process-event result.
  - On macOS, Firstmate's `bind` can't rename the read-only store copy it makes. Joyride's installer seats that copy itself, exactly as the host lays it out, and runs the same `bind` again (`src/cli/fleet-feed.ts`).
- **P-Stack:**
  - The canonical `cursor/plugins/pstack`, pinned at `e43c7ee` in `vendor/pstack`.
  - `skills/` is the canonical local skills tree, including reviewed P-Stack snapshots. `install shared-skills` backs up and links each skill folder into `~/.claude/skills`, `~/.codex/skills`, `~/.codex-2/skills`, `~/.cursor/skills` and `~/.agents/skills`; uninstall restores the originals. Provider-managed plugins and bundled skills stay separate. `install no-caveman` disables only Claude's caveman plugin with targeted undo.
  - Cursor-specific skills are adapted with patches in `install/pstack-patches/`.
  - `swarm`, `recall`, `correct` and `reflect` are not installed. Firstmate owns delegation; agents use the repo instructions and installed skills.

## 13. UI

- **Style:** light editorial theme (paper, ink, one warm accent reserved for attention), built on theme tokens.
- **Semantic zoom:** Map (missions as regions) → Mission (crews, sessions, tasks, dependencies, evidence, decisions) → Worker (live state, current action, reply, approvals) → Session (condensed transcript, diffs, tests, artifacts).
- **Grouping on the map:** groups say what the work is (mission, then lens, then project), never who launched it. A worker sits in its session's mission, else its crew task's mission, else the group that names its session; everything else is unfiled, one group per project (a crewmate's project is its task's repo), unless a group holds that project's unfiled work. Firstmate's own pane is the Firstmate node.
  - **Unfiled holds only work with something to act on:** a live worker that is working, blocked or active in the last 30 minutes. Each card can be opened, filed (drag, or File in… for Move to), set aside, or filed by accepting the idea Joyride suggests for it (a pending proposal that holds its session). Set aside keeps it off the chart until it does something new (`POST /api/missions/hide`, kept in the index, not in git). Quiet workers and finished sessions leave the chart; the Agents page still lists them. An Unfiled group with nothing in it is not drawn.
  - **Archived, dropped and done ideas leave the chart;** Show archive brings them back.
- **Ownership is shown, not grouped:** every unfiled worker card, and every worker line on an opened idea, carries an owner chip (crew, with its task, or watched) and a helm chip (Firstmate, or you); at Far zoom only a crew chip and your helm show. Navy marks your helm; signal orange stays reserved for needs-you.
- **An idea card answers four questions, in order:** what needs me, what is stuck, what is moving, what is up next; then what just finished (landed tasks, Firstmate's replies). Far shows them as one line ("1 needs you · 2 moving"), else what the idea holds. Mid and Near sort the idea's tasks and live workers under those headings: Mid one line each with what it is doing now, Near a brief card with each ask folded to its question and recommended answer; Answer opens its controls in place. The captain's board (notes, lists, links) sits above the work; done-when progress, artifacts and repo fold into one quiet footer; idle sessions fold into a count. An idea has one + for work, notes, lists and links. Who runs a task, ids, chips, last events and crew lines show when the idea is opened; its asks stay folded until Answer opens them (`src/ui/views/map/glance.ts`).
- **Opening a group or an idea:** a click on a group's name or its open water opens it in place on the same canvas: the camera flies to frame it, it shows Near detail whatever the zoom, its neighbours move aside and everything else steps back. Tall groups reflow into the narrowest readable columns that frame the whole group. A click on an idea's card opens it in full, with its overview beside its work on a wide canvas. The zoom chip says Focus while Near detail is forced; the camera keeps its smooth scale. Focus puts breadcrumbs, needs-you and zoom controls above the canvas, hides the hint and legend, and keeps Undo feedback outside the canvas. Measured reflow preserves the interacting idea's screen position. Breadcrumbs at the top left (Map › group › idea), Esc and back step out, each to the camera it came from. The URL carries it (`#/map?focus=<group>&idea=<idea>`), so back, forward and links work; a sheet opened over the map keeps it (`src/ui/views/map/focus.ts`).
- **Groups sit where the captain puts them:** a group is dragged by its name (Alt and an arrow key on the name moves it a step) and lands on the free spot nearest the drop, so groups never overlap. Positions are authored data in `map/layout.yaml`, in Near units, spread per zoom level so the arrangement keeps its shape (`src/ui/views/map/arrange.ts`). A move stores the whole arrangement as one map move commit with Undo; agents move a group with `joyride map move-group`, and a group's menu puts it back in its usual spot. Unplaced groups keep their flowed spot, and Firstmate's hub stays top left.
- **The Firstmate node is the fleet bridge.** Besides Firstmate's own state, tasks in flight and captain calls, it counts:
  - the fleet's crew;
  - watched sessions;
  - sessions that need you (blocked at a prompt, or an open item at L3 or above);
  - sessions at your helm.

  Each count opens the Agents page on that filter.
- **Agents page** (`#/agents`, `src/ui/views/agents`): every agent and session in one place (it replaced the Proposals, Fleet, Crew and Views pages). Firstmate's tasks with their crewmates, the captain's watched and kept sessions, and sessions closed in the last week are grouped by the map's groups and ideas, with "Not in an idea yet" by project; closed ones fold under each idea.
  - Filters: needs you, at your helm, suggested ideas; crew or yours; running, idle or done; by idea or most recent. The URL carries them, and the old routes (`#/fleet`, `#/task`, `#/crew`, `#/proposals`, `#/view`) redirect to the matching filter. A task id still opens its sheet.
  - Quick actions on each row: open it; steer it (a reply from you takes the helm; a task's steer goes to its inbox); hand its helm back to Firstmate; keep it to yourself, or put it back in the fleet; save and close an idle watched session (its prune ask, answered in place); answer what it asks; open a task's sheet.
  - A pending idea proposal shows on the unsorted session it covers ("looks like idea X": file it, make it an idea, or not an idea); "Suggested ideas" is the full triage.

  The page also says whether Firstmate reads the fleet feed.
- **Regrouping on the map:** drag and drop edits only authored groupings, one commit per move (`POST /api/missions/move`), with an undo that restores exactly what the move changed.
  - A session dropped on a mission is assigned to it (and leaves its old mission); dropped on an Unfiled group, it leaves its mission. Who works on it never changes.
  - A Firstmate task moved to a mission (`{task, to}`) joins that mission's `crews` and leaves any other. A task always sits in an idea, so it has no Unfiled.
  - A session dropped on a group sits in it directly (the lens's `sessions`), leaving its mission and any other group; dropped on "New group", it starts one.
  - A mission dropped on a lens group joins that lens and leaves the one it came from; dropped on "New group", it starts a lens. A mission's own `lenses` win over a lens that lists it or claims it by rule.
  - Repo and health groups are derived, so they never take a mission from elsewhere. A mission dropped on its own repo group leaves its lens, unless a lens rule claims it.
  - Every movable card shows a grip on hover or focus. Pressing anywhere on the card (or its grip) and dragging carries it; the target under the pointer names the move ("Move to <idea>") before the drop. A crewmate line carries its task, never its own session. An archived idea takes no tasks.
  - Every drag has a no-drag path: clicking the grip, or pressing Enter on it, opens Move to with the same targets. A keyboard move puts focus on Undo.
  - **Making groups** (`POST /api/lenses/{create, rename, delete, merge}`), each one map-move commit with Undo:
    - New group in the strip names a group in place; every group is charted, an empty one as a drop spot.
    - Double-clicking a group's name, or choosing Rename from its ⋯ menu, renames it in place; a single click opens focus. Renaming an Unfiled group makes a group that holds that project's unfiled work (`projects`); renaming a repo group makes a group that lists its ideas.
    - A group's menu merges it into another (its ideas, sessions and projects all join) or deletes it (its ideas fall back to their next group or repo group, its sessions and projects to Unfiled).
  - Artifacts linked to a mission or session show as chips on its card and open the artifact; any kind renders.
- **Idea housekeeping** (`src/modules/ideas`, `dec-ideas-auto-tidy`): Joyride files unplaced Firstmate tasks into ideas.
  - **Placement.** Every Firstmate task without an idea is filed: Jev picks an open idea (`idea_place`); below 0.75, or when it says "new", the heavy model decides (`idea_naming`, gpt-6.1-sol) and names a new idea when none fits. The first run after start-up files the existing tasks (the backfill).
  - **Guardrails, in code.** The captain's moves win: a task, session or idea-to-group move from the map is pinned for good, and an idea the captain created or edited is pinned for seven days. A change the captain undid is never made again.
  - **Visible and reversible.** Each run is one commit (`joyride: housekeeping: …`) with an undo that restores exactly what it changed, and a ledger (`/api/ideas/log`) of applied and rejected changes with reasons.
  - **Accounts.** Housekeeping runs on Joyride's own Codex login (`llm.tasks.<task>.account`, an id from `usage.accounts`), so Codex 2 stays free for workers. Runs are rate-limited.
- **Worker pane:** three tabs under a header that says what the agent is trying to do.
  - **Chat** (default): the live conversation as a chat (your prompts right, the agent's messages as markdown left, tool calls folded into one-line chips), newest at the bottom and followed while you are there, a prompt it is stuck on answered inline, and the reply box pinned underneath. The session pane uses the same renderer, read only.
  - **Terminal**: the Herdr pane in the browser (xterm.js). The daemon polls `pane.read` (visible, ANSI) about four times a second while someone watches and streams changed frames over SSE; typing goes to `POST /api/workers/:id/input`, mapped to Herdr key names where Herdr has one (it encodes them for the pane's real terminal modes) and raw bytes otherwise. The pane keeps its own size. "Open in Herdr" stays for people who run a Herdr window.
  - **Details**: where it runs, current action, last message, recent tools.
- **New, the one box** (`src/ui/views/new`): at the top of the rail, above Approvals, on every page. N focuses it; idea and group add controls retain their context. One text area and Send route complete UI actions through their existing owners, original task text to Firstmate, and judgment/search requests to a visible small native agent job. Canvas changes have Undo and Show on map; started processes and delivered messages cannot be undone.
  - Explicit standalone, own-session, deep-work launch and session/task-without-Firstmate requests skip the routing judge. They launch a normal user-owned repo session through `launch_session`, with the original request and current repo/group context. An explicit own group creates one; an existing named or current group receives the native session. Missing or ambiguous repo/group information asks for a bounded repo and group choice. It never becomes a Firstmate task or a small job.
  - Settings owns `new_models.routing`, `new_models.small_job` and `new_models.standalone`. Routing inherits the configured Jev model unless overridden, or uses a configured native Claude/Codex judgment call. Small jobs and standalone sessions default to native Codex `gpt-6-luna`. Explicit role models/accounts persist. Account catalogs validate Codex models and reasoning effort; provider/account mismatches produce actionable errors. Firstmate's worker models and other LLM roles retain their defaults.
  - Codex supplies its own native session id. When Herdr cannot discover an account-specific store, Joyride matches a unique launch marker in that account's read-only native state, then binds it to the same terminal, agent, cwd and foreground process. It never identifies a session from cwd alone. The sessions projection also reads configured account homes. A personal launch records the user at the helm; its receipt opens the interactive worker or saved transcript and reveals the canvas group.
- **Start a session here** (`launch_session`): an action on idea cards and pages, group menus and Agents page idea headings. It starts a normal Claude Code session in the idea's repo, the group's repo, or the project's checkout when no repo is linked, using `workers.permission_mode`. Its first prompt carries the goal, `joyride notes --idea <slug>`, and public artifact links, and asks it to write any report to a file and register it with `joyride map link`. The session is filed under its idea or group and appears on the map and Agents page. The normal captain-helm rule applies. Existing transcripts stay ordinary sessions.
- **Board items** (`src/shared/board.ts`): one freeform item for notes, todo lists, links and anything mixed. Each line is text, a checkbox, or a link (a PDF, a Joyride or Claude artifact, a web page, a local file) shown with a type sign and a readable title made from its label, file name, forge PR or page. All checkboxes make a list, all links a link card, otherwise a note or a mixed card. An item is a note (`kind: note`) on a place: a group (`group:<lens>`), an idea, or Unfiled (`global`, the hub's board).
  - **From New:** a leading cue decides it for certain ("note:", "add a note", "list:", "make a list", a block of `- [ ]` lines, addresses alone, "link:", "save this link", `src/shared/compose.ts`); text that only mentions notes or lists adds Jev's `compose_kind` question. It goes to the place the words name ("add a note in Launch: …", "… in unfiled: …"), else the idea or board New was opened on, else the current group, else Unfiled; the preview's Goes to picks another. The current group is the one the captain rests the pointer on, clicks in or focuses a card of (`src/ui/views/map/current.ts`); crossing a group on the way to the rail doesn't count. On a group's "+", plain words are a note for that group. Items never reach Firstmate; Change on a task's card turns it into a note or a list.
  - **On the canvas:** each authored group carries its board under its name, above its ideas; each idea above its tasks; Unfiled on the hub. Far zoom shows one-line chips (a click zooms to the card), mid compact cards (ticks and links work), near full cards edited in place, with a quick composer under them (each line a bullet, a `[ ] todo` or a link). A board draws its newest four (three at mid), counting an item just moved or asked for as new, and links the rest to the Board page filtered to that place.
  - **Editing:** text edits in place (Enter saves); list items tick, rename, add and remove; a mixed card ticks in place and edits all its lines; links open (a Joyride artifact in Joyride, the rest in a new tab; a local path copies). Delete is an archive with Undo.
  - **Moving:** a card's grip drags it onto a group, an idea or the hub (Unfiled), through the map's own carry and drop; its Move to button and the grip's click open Move to. Undo puts it back, and the chart brings the moved card into view. Items whose group is deleted show in Unfiled until the group comes back.
  - **The Board page** (`#/board`, nav "Board"): every item off the canvas, by place: search every line and link title, filter by type, place and open todos, tick, edit, move and delete in place with Undo, and Show on map glides to the card. Search finds items as notes and opens them on the Board.
  - **Agents:** `joyride map note|list|link` with `--group`, `--idea` or nothing (Unfiled), `move-note`, and `board` to read them.
- **Agent intent:** per session, `{goal, now, next, waiting_on}` from the heavy LLM (task `session_intent`) over a condensed transcript; cached per transcript signature, refreshed after turns (at most once a minute per session, four at a time). It replaces raw titles on the map at mid and near zoom, and adds a goal line to Needs-you items.
- **Always present:**
  - An attention rail.
  - A cmd-K palette.
  - Keyboard-first navigation.

## 14. Out of scope (for now)

- Jira and Confluence write-back
- Phone access
- Native Pi and Cursor transcript readers. Firstmate's Cursor primary and live panes remain visible through the live worker projection.
- Hindsight
- Generated layout changes. Task placement applies its own grouping changes, each with undo (§13).
- Pushes to remotes
- Joyride on `devvm`: planned. It needs a user-space Herdr there and a :3000 check before and after.

## 15. Build checkpoints

Each checkpoint is verified by vitest, Playwright e2e, screenshots, `evidence.json` and a Jev verdict. Results are recorded in `docs/CHECKPOINTS.md`.

| # | Checkpoint |
|---|---|
| C0 | scaffold, install/uninstall, hook + guard (verify PreToolUse fires in bypass mode) |
| C1 | readers (Claude Code, Codex), backfill, mission proposals |
| C2 | live world (Herdr events, hooks), attention, map and panes |
| C3 | intents, reply in place, guard approvals tray |
| C4 | evidence and Jev verdict |
| C5 | guidance, repo decisions, notes and source search |
| C6 | nudges and artifact link cards |
| C7 | Firstmate, tasks, shared skills and fleet visibility |
| C8 | read-only map settings and task placement |
| C9 | attention rules, acknowledgement and evidence judging |
| C10 | dogfood handoff: the "Build Joyride" mission, AGENTS.md, decisions |
| C11 | no terminal app needed: daemon-managed Herdr server, chat view, browser terminal, agent intent |
| C12 | map control plane, Board and contextual session launch |
