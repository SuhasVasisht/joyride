# Review servers

Joyride's **Servers** page and map cards share one local registry. A group names the terminals for a particular change, such as a frontend and backend. Review groups stay available after the creating agent exits. Private test groups have a separate purpose and are hidden from the review canvas.

From home, open **Servers**, choose **New server group**, add each foreground command and its working directory/ports, save, and choose **Start group**. **Add to canvas** or **Show on canvas** opens the group's map card. Drag its region title or use Alt + arrow keys to place it. Group controls, review links, and each member's **Terminal & logs** are available on that card. The detail page has individual member controls and both actual Herdr terminals.

## Agent interface

Discover the supported commands with:

```sh
joyride --help
joyride servers --help
joyride servers list
joyride servers list --purpose review
joyride servers show dossier-review
```

All server commands return JSON. `list` and `show` reconcile live ownership; stored records alone do not count as running. Read `instances[].state`, `reason`, `run.change`, `run.branch`, `pending`, and the declared ports before choosing a group. Use the matching project's review instance when appropriate. Use another id when a second change must stay available alongside it.

Create a definition file in your worktree. This runnable example uses Joyride's safe fixture and port 4325 and an OS-assigned backend port; it does not start any dossier application:

```sh
node --input-type=module - <<'JS'
import fs from 'node:fs';
import path from 'node:path';
const cwd = process.cwd();
const fixture = path.join(cwd, 'tests/fixtures/review-server.mjs');
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
fs.writeFileSync('review-group.json', JSON.stringify({
  id: 'dossier-review', name: 'Dossier review', purpose: 'review',
  project: 'Safe fixture', change: 'First change', branch: 'fm/my-change',
  creator: process.env.CODEX_THREAD_ID || process.env.FM_TASK_ID || 'local agent',
  canvas: true, url: 'http://127.0.0.1:4325',
  members: [
    { id: 'backend', name: 'Backend', cwd, ports: [],
      command: `${quote(process.execPath)} ${quote(fixture)} 0 Backend` },
    { id: 'frontend', name: 'Frontend', cwd, ports: [4325],
      command: `${quote(process.execPath)} ${quote(fixture)} 4325 Frontend` }
  ]
}, null, 2));
JS
joyride servers create review-group.json
joyride servers start dossier-review
joyride servers show dossier-review
```

Members start in definition order. Use foreground commands; do not append `&`, daemonize, disown, or use a command that manages an unrelated global service. The member's shell runs `/bin/sh`; wrap a command with the required interpreter when it needs another shell. Use existing dependencies. Commands and definitions are stored in git, so keep credentials out of them. Refer to existing local configuration or credential files instead.

To apply another change, edit `change`, `branch`, `cwd` or the command in your JSON file, then:

```sh
joyride servers save review-group.json
joyride servers update dossier-review --request review-new-change-1
joyride servers show dossier-review
joyride servers logs dossier-review frontend
```

Saving preserves the current processes and marks changed members pending. **Update group** restarts only members whose launch contract changed; a group change/branch update refreshes all members so every displayed instance names the requested change. `start` reuses a verified running instance without applying pending changes. After updating, verify the visible `run.change` and review URL before reporting which instance shows the change. Joyride does not switch branches, pull code, install dependencies, or rebuild unless that work is explicitly part of the saved command.

The canvas and Servers page enable **Open review** only when the whole group is running with one launched review URL. A member's Open control uses its running launch's URL. Stopped, starting, failed and unknown URLs remain visible as selectable text with disabled Open controls. Saving a different URL does not make the pending URL live: until Update applies it, Open uses the current launch's URL.

```sh
joyride servers stop dossier-review --member frontend
joyride servers start dossier-review --member frontend
joyride servers restart dossier-review --request review-restart-1
joyride servers stop dossier-review
```

`start` and `stop` are idempotent. A new `restart` request deliberately replaces the selected instances. Reuse the same `--request` id when retrying after a lost response; its durable action journal avoids restarting completed members again. Different actions cannot share a request id. Lifecycle commands require a matching purpose: review is the CLI default. There is no bulk cleanup command that can accidentally stop review groups.

For temporary checks, use a distinct definition with `purpose: "test"`, `canvas: false`, its own id and ports:

```sh
joyride servers create my-private-test.json
joyride servers start my-private-test --purpose test
joyride servers stop my-private-test --purpose test
```

Stop only your private test group's id when cleaning up. A test-purpose lifecycle request against a review group is refused. Keep a requested review instance running and report its group id, shown change, URL, and canvas card.

An isolated daemon is addressed with `JOYRIDE_URL=http://127.0.0.1:<port> joyride servers …`. This only selects an already-running daemon; it does not create one.

## Storage and restart behavior

All paths are relative to the daemon's data root (`JOYRIDE_HOME`, normally the Joyride checkout), except runtime paths, which use `JOYRIDE_RUNTIME` when overridden:

| Path | Contents |
|---|---|
| `servers/<group-id>.yaml` | Group definition, project/change/branch, creator identity, purpose, member ids/commands/cwds/ports/URLs, review URL and whether it is on the canvas. Written through `commitPaths()`; recover previous definitions from git. |
| `map/layout.yaml` | Canvas placement under `server:<group-id>`, using the existing map layout and git-backed move/Undo interface. |
| `.joyride/state/review-servers.json` | Current instance ownership: machine and exact Herdr session socket, workspace/pane/terminal identity, launch nonce, launched definition/change/branch/URL, lifecycle phase and idempotency requests. Preserve this file during a daemon restart. |
| `.joyride/servers/<launch-nonce>/config.json` | Immutable command/cwd and nonce passed to the foreground runner. |
| `.joyride/servers/<launch-nonce>/status.json` | Runner PID, matching nonce, actual running/exited receipt and exit code. |
| `.joyride/servers/<launch-nonce>/output.log` | Saved output mirrored to the actual terminal. Old launch directories are retained; the UI/CLI shows the latest member log, capped to its last 64 KiB. |
| `docs/review-servers.md` | This agent-facing contract and exact examples. Linked from `joyride servers --help` and `docs/CONTRACTS.md`. |

The Herdr terminal owns the command. It survives the creating CLI/agent exiting, a browser reload, and a Joyride daemon restart **while that Herdr session remains running**. Joyride does not stop server groups during daemon shutdown and does not start groups automatically on boot. A Herdr session stop, terminal closure, or machine reboot ends its foreground processes. Definitions and logs remain, but the UI shows failed or unknown until reconciliation verifies a new instance. Use Start after an owned terminal has disappeared; nothing is blindly relaunched.

Running requires the exact saved terminal identity and a receipt PID verified against both Herdr's process info and the nonce in its live runner command line. Declared ports must also listen; otherwise the member is starting. A mixed running/stopped group is partial. An unreachable or changed runtime, ambiguous prepared launch, or process identity mismatch is unknown. Controls refuse unknown ownership rather than signalling an unverified process. Inspect its terminal in Herdr and restore the owning runtime/journal; do not kill by port or process name. Corrupt definitions or runtime journals produce an error while the rest of Joyride keeps serving.

A launch is journaled before creation. If Joyride exits between terminal creation and receipt storage, reconciliation uses its unique `jr-server:<launch-nonce>` workspace label to recover the terminal. An uncertain command submission is never replayed automatically. Each member has its own owned Herdr workspace/terminal; the registry and UI group them without changing any existing workspace or session. Removing a running member's definition is refused; stop it first.

Occupied ports are reported before creating a new terminal. This preflight cannot reserve a port against another program racing the command, so the command's own bind error remains authoritative and appears as failed with its saved output. Lifecycle actions close only a verified owned terminal; they never kill listeners by port. Partial start failures keep the other members visible and controllable.

Server lifecycle and ownership requests use Herdr's existing per-call deadline with a bounded 10-second timeout. A timeout names the exact method; it does not prove that the whole runtime is down. Creation may have completed even when its reply was lost. Reconciliation recovers only the unique `jr-server:<launch-nonce>` workspace and exact terminal; an uncertain prepared launch stays unknown, with the same nonce, and a lifecycle retry cannot create another workspace or replay command input. Preserve that journal and ask the runtime owner to inspect the exact terminal before taking further action.

## Local API

| Method and path | Body/result |
|---|---|
| `GET /api/servers[?purpose=review\|test]` | Reconciled groups and member views. |
| `GET /api/servers/:id` | One reconciled group, or 404. |
| `POST /api/servers` | Full definition JSON; creates and commits it. |
| `PUT /api/servers/:id` | Full definition JSON with the same id; saves and commits it. |
| `POST /api/servers/:id/action` | `{action: "start"\|"stop"\|"restart"\|"update", purpose: "review"\|"test", member?: "frontend", request?: "stable-id"}`. |
| `GET /api/servers/:id/members/:member/logs` | `{text}`: latest saved output. |
| `GET /api/servers/:id/members/:member/terminal` | Actual ANSI terminal frames over SSE. Read only; use lifecycle controls. |
| `GET /api/servers/:id/members/:member/terminal/frame` | One actual terminal frame. |
| `POST /api/missions/map/layout` | Existing placement API, e.g. `{group: "server:dossier-review", x: 280, y: 160}`. |

## Verification

`scripts/lab-review-servers.sh <assigned-4401–4409-port>` runs only this area's e2e, with one worker and safe local HTTP fixtures. It provisions and tears down a unique non-default Herdr session exclusively through Firstmate's guarded helper and verifies the default fleet tripwire. The preview for daemon-restart and reply-loss proof is on 4329; the review fixture uses 4325 and other fixtures use OS-assigned loopback ports. A private socket relay forwards only to that named lab and delays or drops completed replies to prove real-process recovery without replay. Set `FM_HERDR_LAB_HELPER` if the helper lives elsewhere. Screenshots live in `docs/checkpoints/review-servers/` and runs must be wrapped in `joyride-evidence`.
