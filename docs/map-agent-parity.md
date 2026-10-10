# Agent map edits

`joyride map` calls the map's HTTP endpoints. They do not write authored files themselves. `src/shared/map-actions.ts` exports `MAP_ACTIONS` with names, descriptions, Zod argument schemas, CLI fields and request builders. It imports no Node APIs, so the UI can import it too. Add an action there to expose it through the CLI used by agent clients.

## Inventory

| Map edit on this branch | HTTP endpoint | Agent operation |
| --- | --- | --- |
| Move an idea to a group or back to its repo | `POST /api/missions/move` | `move-idea <idea> --to-group <group or none>` |
| Move a task between ideas | Same | `move-task <task> --to-idea <idea>` |
| File a session into an idea or Unfiled | Same | `file-session <session key> --to-idea <idea or none>` |
| Create an empty group or create while moving an idea/session | `POST /api/lenses/create`, move with `to.new_lens` | `new-group <title> [--idea <idea>]`, `new-empty-group`, `new-session-group <title> --session <key>` |
| Rename authored, repo or Unfiled groups | `POST /api/lenses/rename` | `rename-group`, `rename-repo-group`, `rename-unfiled-group` |
| Delete or merge groups, retaining members | `POST /api/lenses/{delete,merge}` | `delete-group <group>`, `merge-group <group> --into <group>` |
| Move sessions directly into a group | `POST /api/missions/move`, `to.lens` | `move-session <key> --to-group <group>` |
| Set a session/worker aside and Undo | `POST /api/missions/{hide,unhide}`, `GET /api/missions/hidden` | `hide <key>`, `unhide <key>`, `hidden` |
| Undo a drag, menu move or agent move | `POST /api/missions/move/undo` | `undo <commit>` |
| Undo housekeeping | `POST /api/ideas/undo` | `undo <commit> --housekeeping` |
| Create canvas note/list cards and edit checklist items | `/api/notes`, `/api/notes/:id` | `note <text>`, `list <item>...`, `edit-list <id> <item>...` |
| Add/edit/archive/restore anchored note bullets | `/api/notes`, `/api/notes/:id`, `/api/notes/:id/{archive,restore}` | `add-note`, `edit-note`, `archive-note`, `restore-note` |
| Move a group on the canvas, or back to its usual spot | `POST /api/missions/map/layout` | `move-group <group> --x <x> --y <y>`, `move-group <group> --reset` |
| Read authored groups and ideas | `GET /api/missions/map` | `show` |
| Read map edit history | `GET /api/missions/move/history` | `history` |

Regrouping by pointer and the Move to menu both use the same move endpoint. `show` returns lens records and ideas, including authored task/session links and the primary lens computed by the shared lens matcher, and `layout`, where groups have been placed. An idea's `group: null` means it falls back to derived chart grouping, such as its repo. Group positions are authored data in `map/layout.yaml`, keyed by the map's group ids (`lens:<id>`, `repo:<path>`, `unfiled:<project>`; a bare group id means `lens:<id>`), in near units (1 unit is 1px at Near zoom). A move commits as a map move with the same Undo; a group placed on another lands on the nearest free spot when the map lays it out. Display preferences, zoom and the focused group are local UI state (focus is in the URL).

The existing anchored note drawer calls `/api/notes` to add/edit/archive/restore bullets on an idea, task, session or globally. Those operations retain the `joyride notes` CLI and table-driven map commands. Agents read them with `joyride notes`; Search finds them through `/api/knowledge/search`. Canvas note/list cards use the same notes endpoints. A list stores every bullet as a checkbox, using the shared helpers the UI uses. The list and edit-list operations accept item strings, including `[x]` on completed items; replacing the collection covers ticking, renaming, adding and removing items. Deleting a card archives its note, and restore-note uses the same route as the map's delete Undo. Answering asks, steering workers, starting Firstmate and filing new work use owner intents rather than map grouping edits; the existing fleet/steer CLI covers the agent operations those owners authorize.

## Commands

```sh
joyride map show
joyride map move-idea exports --to-group reporting
joyride map move-task jr-export --to-idea exports
joyride map file-session claude:session-id --to-idea exports
joyride map new-group "Writing"
joyride map rename-group writing "Drafts"
joyride map move-session claude:session-id --to-group writing
joyride map merge-group writing --into reporting
joyride map rename-repo-group /path/to/repo "Repo work"
joyride map rename-unfiled-group alpha "Alpha scratch"
joyride map hide claude:session-id
joyride map unhide claude:session-id
joyride map note "Keep the login flow accessible" --scope mission:login
joyride map list "Tag build" "Write notes" --title Release --scope mission:login
joyride map edit-list <note id> "[x] Tag build" "Tell support"
joyride map archive-note <note id>
joyride map restore-note <note id>
joyride map move-group reporting --x 1200 --y 0
joyride map move-group reporting --reset
joyride map history
joyride map undo <commit>
```

Output is JSON. The default scope is global, which places a card on the hub; `mission:<idea>` places it on an idea. The same shared action table defines CLI arguments and HTTP request shapes. Agents use the CLI.

An omitted `from-group` uses the idea's primary lens, matching the normal map move. Explicit `--from-group` remains available. A session can return to Unfiled; a task always belongs to an idea. Rule-based groups keep the same server-side restrictions. New group naming, collisions, no-ops and conflict checks remain the endpoint's responsibility.

Agent identity defaults to `FM_TASK_ID`, then the session environment, then the client name. Override it with `--agent <id>`. A `Map-actor` git trailer stores the agent id and CLI source without changing the commit subject that housekeeping uses for pins. Map moves emit the same missions/lenses changes as UI moves. Agent edits use the existing map/rail notifications with Undo; there is no new UI component. Grouping history survives daemon restarts because it comes from git. Set-aside is the UI's view choice in the SQLite index, with a bounded attribution history there; its history rows have `commit: null` and a `key` for unhide. An unhide or new activity marks the earlier hide undone. Undo refuses to overwrite files changed by a later edit.

## Parity and remaining scope

Custom groups and canvas notes/lists have landed and are wired; the table has no pending endpoint stubs. `new-empty-group` remains an alias for explicit empty-group creation. Repo and Unfiled renaming become authored groups with the same contents as in the UI. Session-in-group moves leave earlier ideas and groups. Group creation, rename, delete, merge and session filing all return commits accepted by the existing map Undo; setting work aside uses unhide, as the UI does. Notes use the existing archive/restore Undo. Group placement (`move-group`) returns a commit the same Undo takes back. Display preferences and zoom remain local browser state; accepting suggested work and sending notes to Firstmate remain owner intents outside grouping edits.

## Verification

Unit tests validate the shared action table, CLI arguments, real HTTP moves, agent attribution, change events, existing notification Undo, session filing, group creation/rename/delete/merge, session-in-group moves, derived-group renames, hide/unhide attribution and notification Undo, and later-edit conflicts. `tests/e2e/map-agent.spec.ts` runs on sandbox port 4417 and uses the executable CLI while the map is open, checks the live group and attributed toast, then clicks Undo on the map. A second scenario creates note/list cards via CLI, edits checkbox items via CLI, and deletes/restores the checklist from the map. Further scenarios create and rename a group via CLI with map Undo, move a session directly into a group, and set its worker aside via CLI with map Undo. Its screenshots are under `docs/checkpoints/C2/map-agent-*.png`. Verification is recorded with `joyride-evidence --mission build-joyride`; the live daemon is untouched.

Earlier map verification on the branch rebased onto `7f0739d`, with custom groups and the needs-you fix:

| Check | Result | Evidence |
| --- | --- | --- |
| Full unit suite | 1,075 passed, 8 skipped | `evd_8bf41d59ee51` |
| Typecheck | Passed | `evd_42452323b0d6` |
| Build | Passed | `evd_fb0fd71529e5` |
| Map e2e on 4417, one worker | 4 passed, 11 screenshots | `evd_3fccbf5026e2` |
