# Build checkpoints

**How each checkpoint is verified:**
- Its unit tests (vitest; every test file runs in its own sandbox).
- Its Playwright specs, each against a fresh sandbox daemon with fake models and a fake Herdr. Screenshots go to `docs/checkpoints/<C#>/`.
- Every run goes through `bin/joyride-evidence`, which records an attested evidence record on the `build-joyride` mission: exit code, log, screenshots.
- Jev then judges each done-when criterion of that mission.

Use `skills/joyride-verify/SKILL.md` for current verification. Run the full unit suite once under `nice -n 10` after the final rebase, plus typecheck and build. Run only affected e2e specs with one worker on an isolated daemon and private port. The historical `scripts/verify-checkpoints.sh` runner targets older code and is not the current check list.

Historical evidence records and screenshots under `docs/checkpoints/` retain what actually ran at each landing. The list below describes current coverage; an old verdict does not attest a new implementation.

## C0: scaffold, installer, guard
- **What:**
  - The daemon (Node 20 with tsx, SQLite index, event log tailer).
  - A single bun hook for Claude Code and Codex.
  - The installer, with backups and `GLOBAL_CHANGES.md`.
  - The blast-radius guard.
- **Real checks:**
  - With this build session running in `bypassPermissions` mode, PreToolUse events arrive tagged with that mode, and a gated `git push` was **denied** by the hook. So deny works even in bypass mode.
  - The guard briefly false-positived on a heredoc that only *mentioned* `git push`. That led to the command-position matcher and data-heredoc stripping (`{{CMD}}` in `guard.yaml`, with tests for both cases).
  - The hooks auto-start the daemon. Under launchd it can't start, because macOS privacy protection blocks reading `~/Documents`.
- **Screenshots:** `C0/shell-palette.png`

## C1: session readers, backfill, mission proposals
- **Real checks:**
  - 337 sessions indexed from Claude Code (93 transcripts, 598 MB) and Codex (244 threads), in 1.8 s cold and about 10 ms warm.
  - Backfill produced 61 named mission proposals (about 7 Haiku naming calls) and 14 per-repo archive missions.
  - `~/Documents` is itself a git repo, so sessions there are clustered two folders deep.
- **Screenshots:** `C1/proposals.png`, `C1/map.png`, `real/proposals.png`

## C2: live world, attention, map and panes
- **Real checks:**
  - 20 live Claude Code processes were projected as workers; ones idle for more than 20 minutes are not shown as working.
  - Jev classified this session's own turns (L1 progress).
  - A real tier-2 worker that hit a permission prompt raised an **L3 "needs permission"** item within seconds.
- **Screenshots:** `C2/map-far|mid|near.png`, `C2/rail-attention.png`, the mission and session panes, `real/map-*.png`

## C3: intents, reply in place, approvals, remote unblock
- **Real checks:**
  - Joyride read the screen of a real Claude Code worker in Herdr and answered Claude's folder-trust dialog remotely (down, Enter).
  - Later it answered a Bash permission menu ("Yes"). The L3 item resolved itself as "human answered the prompt", and the blocked-to-unblocked time was recorded.
  - The first real launch surfaced three Herdr bugs, all now fixed:
    - agent name rules;
    - a race while the pane's shell starts;
    - an inherited `CLAUDE_CODE_CHILD_SESSION` from a Herdr server started inside Claude Code, which turned off transcript saving.
- **Screenshots:** `C3/approvals-tray.png`, `C3/reply.png`, `C3/answer-prompt*.png`, `C3/worker-blocked.png`

## C4: evidence and Jev verdicts
- **Real checks:**
  - `joyride-evidence` recorded this build's own test runs, auto-linked to this session (through the parent-process chain) and to `build-joyride`.
  - The evidence judge's baseline is 94% on its 16 seed cases.
- **Screenshots:** `C4/evidence-panel.png`, `C4/verdict*.png`, `C4/lightbox.png`, `real/mission-evidence.png`

## C5: guidance, decisions, notes and search

- Repo instructions and `docs/decisions/` provide repo guidance.
- `guidance/captain.md` installs through the reversible installer; Firstmate guidance stays canonical and read-only in Settings.
- Authored notes live in `notes/`; Board, map, CLI and task-only hook context use the same files.
- Search finds ideas, notes, artifact cards, sessions and tasks.
- Current checks: `notes`, `notes-ui`, `knowledge`, `knowledge-ui`, `guidance` and `system-setup` unit coverage.

## C6: nudges and artifact link cards

- Cards register, detect, snapshot, preview and link outputs to ideas and sessions, preserving summaries and privacy.
- Nudges retain task-done, quiet-idea, prune and Firstmate-blocked behavior. Placement Undo uses its toast.
- Current specs: `artifacts`, `artifacts-firstmate`, `nudges`.
- Artifact reader: ten focused browser checks pass for content-first HTML/Markdown, matching details, preserved origin/focus/draft, narrow and tall documents, truthful fallbacks and safe HTML isolation. A fictional Firstmate report and the Freeform document are included. Proof and source coverage: `docs/reports/artifact-reader.html` and `docs/checkpoints/C6/artifact-reader/`. After the authorized rebase: 1,513 unit tests passed (8 skipped), typecheck/build passed, and two session/agent integration checks passed. Evidence: `evd_70c20c477d9e`, `evd_a99a5784ece9`, `evd_206116f38ec3`. The isolated fake-model verdict smoke `vd_2qas9w3h` passed without a caption downgrade; it is workflow smoke, not a live Jev judgment. No primary daemon refresh is claimed.

## C7: Firstmate, shared skills and fleet visibility
- **Real checks:**
  - Primary continuity: a named Herdr lab with a stub Claude primary and live worker switched to real Codex `gpt-6.1-sol`, then a second Codex account, then Claude. The session lock moved, the worker and pending decision survived, each successor read the durable handoff, and Codex handled a new inbox wake. `scripts/lab-firstmate-failover.sh` reproduces the isolated check and verifies the live default fleet after cleanup. The hub and rail controls have Playwright coverage and screenshots `C7/firstmate-codex-handoff.png` and `C7/firstmate-return-to-claude.png`. No live daemon verdict was requested under this task's isolation contract.
  - Installed for real: 45 adapted P-Stack skills (with no Cursor references left) for both agents, 2 agents, 9 evals skills, the evidence and verify skills.
  - Firstmate is pinned with Herdr as its backend and local-only mode.
  - **Firstmate's first real start needs `gh auth login`.** See `C7/README.md`.
- **Screenshots:** `C7/*.png`, `real/crew.png`

## C8: read-only map settings and task placement

- `workspace.yaml` holds title, home and theme; `/api/workspace/spec` reads the map settings.
- Housekeeping files unplaced Firstmate tasks into ideas. Captain moves stay pinned, each run has a ledger and Undo, and naming, merging and archiving remain captain actions.
- Current unit coverage: `workspace-layout`, `ideas`, `ideas-plan`. Map and control-plane specs exercise placement.

## C9: attention and evidence judging

- The deterministic attention floor, Jev classification and acknowledgement keep needs-you actionable.
- Evidence judging checks criteria against recorded tests and screenshots.
- Current coverage: `attention`, `attention-metrics`, `evidence` and `evidence-intents`, with `needs-you`, `rail` and `evidence` browser specs.

## C10: dogfood handoff
- **What:**
  - `AGENTS.md`, `CLAUDE.md`, `README.md`, `HANDOFF.md`, `docs/DESIGN.md`, `docs/DECISIONS.md` (repo decisions), `docs/CONTRACTS.md` and `docs/API.md` (generated).
  - The `build-joyride` mission, with C0–C10 as done-when criteria.
  - The settings page.
- **Screenshots:** `C10/settings*.png`, `C10/new-mission.png`, `C10/nav-1280.png`, `real/settings*.png`

## C11: no terminal app needed (managed Herdr, chat, browser terminal, agent intent)
- **What:**
  - The daemon starts and keeps the local `herdr server` running (detached, scrubbed environment, `.joyride/herdr-server.log`); `POST /api/herdr/start`; `managed` in `/api/herdr/status`.
  - Worker pane tabs: Chat (live markdown conversation, tool chips, reply pinned, prompt answered inline), Terminal (xterm.js over SSE frames of the pane's ANSI screen; typing mapped to Herdr keys) and Details. The session pane uses the same chat renderer.
  - The `intentions` module: goal, now, next and waiting on per session (Codex Luna, task `session_intent`), on the worker header, the map at mid and near zoom, and Needs-you items.
  - The `usage` module and panel: one card per account in `usage.accounts` (Claude Code, each Codex login, Cursor) with its windows, percent used, reset time (local and relative) and plan, read from `quota-axi --json` (a `--profile-only` run per credential folder) and cached for a minute. A rail section on the map and a full page (`#/usage`). Needing Keychain approval, a folder not signed in yet, a missing CLI, unreadable output and a timeout each have their own state. Start a session can pick the account, passed to the agent as CODEX_HOME or CLAUDE_CONFIG_DIR.
- **Real checks:**
  - Against the real Herdr 0.9.3 binary on an isolated socket (`XDG_CONFIG_HOME=/tmp/jrhz`, never the user's server): a sandbox daemon found nothing listening and started `herdr server` in its own process group with no `CLAUDE*`/`JOYRIDE*` variables, connected within a second, left it running across a daemon restart without starting another, waited out 10 s after the server was killed and then restarted it, and answered the start button with "already running".
  - The browser terminal on a real Herdr pane: typing, Backspace, Enter, Up (shell history), Left (mid-line edit), Ctrl+C on `sleep 30`, and ANSI colour from zsh all round-tripped; the frame size came from `pane.layout` (120 by 40).
  - The chat view rendered real transcripts from `~/.claude` (read only, sandbox daemon, fake models): 142 tool chips in 18 folded runs, markdown lists, bold and code intact.
- **Screenshots:** `C11/chat.png`, `C11/terminal.png`, `C11/intent-map.png`, `C11/terminal-real-herdr.png`, `C11/usage-*.png`

## Images in messages

- **Built:**
  - The reply box (rail, mission and worker chat) and Firstmate's create-task and steer boxes take images by paste, drag-and-drop and the file picker. Thumbnails show before sending and with the sent message: in the intent status, the mission timeline and the chat history.
  - The `uploads` module stores each image at `.joyride/uploads/<day>/<id>.<ext>` (gitignored runtime data). It accepts PNG, JPEG, GIF and WebP by content, up to 10 MB.
  - The relay empties the agent's input box, pastes each image path on its own, and waits for Claude Code's or Codex's `[Image #N]` attachment before it pastes the text. If an image doesn't attach, it clears the box and sends nothing. Agents other than Claude Code and Codex are refused, and the UI says so.
  - Firstmate gets attached images with a new task. A crewmate gets the absolute paths in its steer inbox message, with a note that Read or view_image opens them.
- **Real checks:** `scripts/lab-images.sh` runs an isolated Herdr lab session with a real Claude Code (2.1.289) and a real Codex (0.160) pane, and sends images from Joyride's worker reply box. Claude Code's transcript holds both images as image blocks. Its model request to the lab's fake Messages API carried the same bytes (sha256 checked), and the answer that names them shows in its terminal. Codex's rollout holds the image as `input_image` with the same bytes.
- **Screenshots:** `chat-images/attach-*.png`, `chat-images/chat-history.png`, `chat-images/agent-without-images*.png`, `chat-images/firstmate-*.png`, `chat-images/lab-*.png`

## C12: the map as the control plane

- **What:** CP0 to CP7b and their integration: asks and the answer channel, ideas and housekeeping with undo, the map as the control plane, the task sheet, notes, new tasks from anywhere, nudges, one knowledge home, the map slots and the "This looks moot" button. Done means the captain runs a working day from the home page without opening Firstmate's chat.
- **Acceptance journeys:** each starts at `#/` on the e2e sandbox (fixture FM_HOME with the real vendored intake, fm-send and tasks-axi, stubbed doorbells, fake Herdr, fake models). `tests/e2e/c12-journeys.spec.ts` walks J1 to J10 as one day with Firstmate's pane running, then checks J12 over the whole run. The CP specs hold each journey's detail.

  | # | Journey | Proven by |
  |---|---|---|
  | J1 | See the plane | `c12-journeys` J1 (groups, far, mid and near, nothing unfiled, agent, model, account and helm); `control-plane-map`; `control-plane-integrate` (one region per name) |
  | J2 | Answer a crew decision | `c12-journeys` J2 (navy, orange after 20 min on a stopped Firstmate, an option answers it); `answer-ask`; `task-sheet`; `control-plane-integrate` (moot) |
  | J3 | Answer a captain call | `c12-journeys` J3 (all recommendations plus words, wake note, the decision in Knowledge); `answer-ask`; `control-plane-map` |
  | J4 | Approve a held work item (release) | `c12-journeys` J4; `answer-ask` |
  | J5 | Answer a worker prompt | `c12-journeys` J5 (Allow on the card holding the worker line); `answer-ask`; `worker` |
  | J6 | Side sheet | `c12-journeys` J6 (worker sheet beside the map, steer through fm-send, Esc back to the card); `task-sheet`; `control-plane-integrate` |
  | J7 | Notes | `c12-journeys` J7 (idea, task and agent notes, `joyride notes --task`, the task-only notes context and source search); `notes`; `notes-ui` |
  | J8 | New task from the map | `c12-journeys` J8 (direct task delivery in the current idea, an unscoped task creating an idea, and explicit steering without a picker); `compose`; `control-plane-integrate` |
  | J9 | Housekeeping | `c12-journeys` J9 (four tasks in one commit, placement respects pinned moves, Undo restores the files, the captain's move stands); `nudges`; `control-plane-integrate` |
  | J10 | Live updates and nudges | `c12-journeys` J10 (status line and a report's call without a reload, Pause and feedback to an authored note); `nudges`; `asks` (SSE) |
  | J11 | Knowledge home | `knowledge-ui`; `knowledge`; `c12-journeys` J11 (legacy navigation and artifact links, one search over the day's decision and note) |
  | J12 | No chat needed | `c12-journeys` J12: no visit to Firstmate's worker route, no `reply` intent, no intent to Firstmate, and no key or text into its pane |

- **Herdr lab proof:** `scripts/lab-control-plane.sh` (set `FM_HERDR_LAB_HELPER` to Firstmate's `bin/fm-herdr-lab.sh`) with `tests/e2e/control-plane-lab.spec.ts`. It runs an isolated Herdr lab session, a marked Firstmate lab home, and one real Claude Code crewmate on the fake Messages API.
  - A map answer closes a real held task: the real `fm-captain-hold.sh` and `tasks-axi`.
  - A keyed decision answered on the map reaches the crewmate's inbox. fm-send's doorbell goes through the lab helper. The crewmate reads the message and moves it to `handled/`.
- **Unit tests:** the fold with parity against `fm-classify-lib.sh` (`asks-fold`); hold decoding and options (`asks`); answer routing (`answer-ask`, `answer-owner`, `recheck-ask`); placement thresholds, pins, undo and the llm account (`ideas-plan`, `ideas`); note scopes and digests (`notes`, `notes-tell`); request markers and receipts (`compose-request`, `compose-ghost`); rank fusion (`knowledge`); redirects (`knowledge-ui`, `task-sheet`). Placement Undo remains available through its toast.
- **Live smoke:** Firstmate runs it on the live daemon after the merge.
- **Screenshots:** `C12/j*.png`, `C12/lab-*.png`, and the CP specs' `C12/cp*.png`, `C12/knowledge-*.png`

## Verdicts

Latest verdict on `build-joyride` (2026-10-04T08:27:53.478Z), judged by Jev over 106 attested evidence records:

| criterion | verdict |
|---|---|
| C0 | pass |
| C1 | pass |
| C2 | pass |
| C3 | pass |
| C4 | pass |
| C5 | pass |
| C6 | pass |
| C7 | pass |
| C8 | pass |
| C9 | pass |
| C10 | pass |

Overall: **pass**.

The first verdict run passed C4–C8 and rated the rest insufficient. That exposed a bug: every criterion was judged against only the newest 12 records. Each criterion is now judged on its own most relevant evidence (`relevantFor` in `src/modules/evidence/verdict.ts`), and targeted evidence was added for the C0 prose filter, the C0 global-change log and the C10 mission seeding.

## Freeform New (2026-10-06)

The right rail has one freeform textbox, with Jev choosing existing owner actions,
direct Firstmate delivery or a visible contextual Haiku job. The review artifact is
[Freeform New](reports/new-freeform.html): 69 inventory rows, 362 labelled phrases,
169 browser submissions, twelve animation kinds and real-agent canvas proof.

The branch includes ExpandedArtifact and native report-return navigation from
local main. New receipts keep their text opaque during each animation; screenshots
wait for the resting state and center canvas results. Agent status notes use plain
text, and map note cards render Markdown headings. The report's replay labels use
explicit ink color. Its browser proof opens the full-screen ExpandedArtifact view
and verifies return to the artifact detail.

Post-rebase checks: 1,472 unit tests passed (8 skipped), typecheck and build
passed, and all 74 affected browser tests passed with one worker, including
report-back. Five focused feedback checks also passed, covering opaque view
feedback and headings/link labels at far, mid and near zoom. The real Haiku job
found and linked an artifact, finished its turn, and supported Undo in a named
guarded Herdr lab. The full capture frames both Firstmate and the result, with
readable receipt and artifact-card closeups. The private lab teardown verified
that the live default Herdr fleet was unchanged. The live Joyride daemon and
live Firstmate home were not used.

The latest isolated real Jev verdict is **pass**, `vd_9olpohfa`
(2026-10-06T10:26:11.172Z). All four criteria passed, with no screenshot-caption
downgrade. Historical failing runs remain in the evidence trail.

Evidence: `evd_dbd6c9d42366` (units), `evd_4c4997dbf808` (typecheck),
`evd_e2df05b94a68` (build), `evd_7d3918486291` (74 affected browser tests),
`evd_d621900ba77e` (five feedback checks), `evd_f9d038320b62` (report artifact),
`evd_bbe6d3f85877` (real Haiku), `evd_a219489cdaaf` (real Jev corpus),
`evd_567743371a8d` (final verdict).

Real Jev precision/recall: deterministic 100% / 92.7%, Firstmate 100% / 100%,
agent 56.6% / 100%. All 23 deterministic misses became agent jobs. These are
synthetic corpus measurements with calibration overlap, not a production accuracy
claim. The report states the Undo, account metadata and external-work test limits.
