# Ideas are missions, groups are lenses, and housekeeping tidies them without asking

Date: 2026-10-05T12:00:00.000Z
Supersedes: None

State: superseded on 2026-10-05
Replaced by: [dec-six-nouns-three-places](dec-six-nouns-three-places.md)

The original decision and its reason below are historical, not current implementation guidance.

## Decision

An idea is today's mission, renamed in every screen; a group is today's lens. Files, routes and APIs keep the names mission and lens. A Firstmate task always lands in an idea through the authored link `Mission.crews`, which wins over a brief's `joyride-mission:` marker.

Housekeeping files new Firstmate tasks into ideas (Jev `idea_place`, then gpt-6.1-sol `idea_naming` below 0.75 or for a new idea) and runs a bounded tidy pass (`idea_tidy`, at most six changes: create, rename, merge, archive, group, move) without asking. Every run is one commit (`joyride: housekeeping: …`) with Undo and a ledger entry. The captain's own moves always win: map moves pin their task, session or group placement for good, captain edits pin an idea for seven days, and a change the captain undid is never repeated. Nothing is deleted (archive and merge only), an idea in use is never archived, and runs are rate-limited.

Housekeeping runs on Joyride's own Codex login (`account: codex` in `llm.tasks`, the default `~/.codex`), keeping Codex 2 free for workers.

This supersedes `dec-cold-start-backfill`'s "missions are proposed, not auto-created" for ideas, and DESIGN §14's exclusion of auto-applied grouping. Session backfill still proposes; it does not auto-create.

## Why

The captain asked to stop steering and filing work through Firstmate's chat, and to have "another one of your agents … handle that housekeeping of updating when new categories are created, deleting old categories". Proposals that waited for review sat unreviewed (61 of them until a scout pass decided them). Undo on every run and pins on the captain's moves keep the change safe.
