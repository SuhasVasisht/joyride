# Fleet operator note for Firstmate

You supervise every live session Joyride sees, not only the crews you launch. This note says how to read the fleet, steer the captain's own sessions, answer their permission prompts, and act on the fleet feed. `joyride` below is `<Joyride checkout>/bin/joyride`; it talks to the daemon on `http://127.0.0.1:4317`.

## Who is in the fleet

| Tier | What it is | What you may do |
|---|---|---|
| `crew` | You launched it for a task | Everything your crew contract allows. Steer it with `fm-send.sh <task>`, never with `joyride steer` |
| `watched` | The captain started it | Read it; steer it with `joyride steer`; answer its own permission prompts with `joyride steer --answer`; preserve and close eligible idle panes with `joyride fleet retire`. Never `fm-send`, `fm-control`, teardown, keys, git or file changes in its checkout |
| `yours only` (`excluded`) | The captain keeps it to themself (`fleet.yaml`) | Nothing. Leave it alone |

Your own pane is not a member. Every live session joins as `watched` unless the captain excludes it; a batched captain inbox note tells you when sessions join.

## The helm

The helm says who is steering a session right now. You hold it by default. When the captain steers a session themself (in its pane, in Joyride's terminal, or with a reply from Joyride), they take the helm until that turn ends plus 15 quiet minutes, or until they hand it back.

Claude's background task completion notifications do not take the helm. Firstmate's operational input and steering inbox doorbells remain attributed to Firstmate, including the doorbells sent by `fm-send`.

While the captain holds the helm, do not steer that session, crew included: `joyride steer`, `--answer` and `joyride fleet retire` refuse it, and for crew hold off `fm-send.sh` too. When the captain hands it back, a captain inbox note gives you what they said meanwhile and the session's intent now. Reconcile it at your next supervision review.

## Read the fleet

- `joyride fleet --brief`: run it at bearings. It shows only the sessions that need attention and the ones at the captain's helm.
- `joyride fleet`: the full roster. Each row gives tier, worker id, inferred state, helm, project and goal. `--json` returns the same as data; `--all` adds the captain's own sessions.
- `joyride fleet show <worker>`: one session, with the prompt on its screen when it is waiting at one.
- `joyride fleet events`: the fleet events delivered to you so far.

States are inferred from Herdr, hooks and attention, because watched sessions write no status lines: `working`, `blocked` (at a prompt), `needs-decision`, `failed`, `done` (inferred), `paused` (idle).

## Steer a watched session

```sh
joyride steer <worker> "Run the export tests serially and report which one fails."
joyride steer <worker> -    # read the text from stdin
```

The steer types into the session's own input box, as the captain's replies do. It is recorded as yours (origin `firstmate`) and does not take the helm. Joyride refuses it, and sends nothing, when any of these hold:

- the session is crew, excluded, or your own pane;
- the captain holds its helm;
- its input box holds text, which is the captain's draft. Joyride never clears it for you;
- it runs outside Herdr;
- `fleet.yaml` takes away your `steer` authority.

A refusal exits with code 2 and says why. Do not retry in a loop; try again when the reason has cleared. While `fleet.yaml` can't be read, every steer and answer is refused until the captain fixes it.

## Answer a watched session's permission prompt

```sh
joyride fleet show <worker>                     # read the prompt and its options first
joyride steer <worker> --answer allow --why "Read-only test run inside the session's own repo."
```

The choices are `allow`, `allow_always` and `deny`. Joyride answers only with an option the prompt itself offers, after reading the prompt twice to be sure it is still there. It records the prompt, the option picked and your reason for the captain.

It refuses when the session is not waiting at a prompt, when the captain holds the helm, and when `fleet.yaml` takes away your `answer_prompt` authority.

Answer only what you would be willing to explain to the captain. Leave anything with real-world reach (pushes, publishing, remote writes, deleting outside the repo) to the captain. Joyride's guard holds those as approvals that only the captain decides.

## The fleet feed

The `joyride-fleet-feed` extension is bound into your home's `config/extensions.d` as a process-event source, `joyride-fleet`. Fleet events reach you as process-event results with a `check` wake.

Each result's first line is `joyride-fleet-feed/1 seq=<n> kinds=<...>`, then one line per event:

- a watched session moved into `blocked`, `needs-decision`, `failed` or `done`;
- the captain took or handed back a session's helm;
- a session was excluded from the fleet or included again.

Classify a result with `fm-procevent.sh classify <result-file>`; the result is `fleet-needs-attention`, `fleet-helm` or `fleet-update`. Act on it, then mark it handled with `fm-procevent.sh handled joyride-fleet <seq>`.

The feed only tells you what changed. `joyride fleet` is always the current truth.

The captain installs or retires the feed with `./bin/joyride install firstmate-feed` or `./bin/joyride uninstall firstmate-feed`.

## Preserve and close an idle watched session

The first live use is a read-only list:

```sh
joyride fleet prune --dry-run
```

It prints each pane that would close and why, including its branch, uncommitted status, unpushed count and how many sessions share the folder. It also explains each pane kept open. It saves and closes nothing.

```sh
joyride fleet propose-prune <worker> "This work is finished; save its context first."
joyride fleet retire <worker>
```

A proposal appears in `/api/asks` as an `approval`, placed on the worker, and expires after 14 days. The captain answers it through `answer_ask` with `approve` or `deny`, or `POST /api/fleet/prunes/<id>/decide` with `{approve: true|false}`. Approval still runs every retirement guard.

The captain grants standing `retire_worker` authority in `fleet.yaml`. You can retire an idle watched pane without asking only when that authority is present and preservation succeeds. The default thresholds are 72 idle hours, proposal expiry at 14 days, and archiving unlinked history at 30 days. `pruning.idle_hours`, `pruning.proposal_days` and `pruning.archive_days` change them.

Joyride never closes crew, excluded sessions, your own pane, a captain-held helm, a pane with a draft, a busy agent, a session with open attention or guard requests, or one the captain steered in the past 24 hours. It currently preserves only local Claude Code and Codex sessions in connected Herdr panes. Remote or unidentified sessions stay open.

Before closing, Joyride commits a `kind: session` artifact with its summary, work done, repo, branch, git status, exact session id, cwd and resume command. It snapshots the raw transcript and produced local files, records hosted artifact links, and saves extracted learnings inside the same session-context JSON. The context JSON lives under `artifacts/sessions/`; the registered artifact points to it and its blob snapshot. Run the saved resume command to continue the same conversation with the original agent config.

A missing, unreadable or oversized file over the 25 MiB snapshot limit stops preservation. Any failure leaves the pane open and raises a prune approval ask with the reason. Joyride rechecks the idle agent, empty composer, helm, transcript, checkout status and output contents after preservation. It verifies the current native session reference, or Claude's foreground PID against its live registry when Herdr omits that reference. Closing invokes only Herdr's `pane.close`; it never modifies the session's files, git history or transcripts.

Expired mission proposals retain their metadata and reason `expired`. Their unlinked, non-live sessions enter repo archive missions. Unlinked non-live sessions older than 30 days enter the same archive missions. No transcript is deleted.
