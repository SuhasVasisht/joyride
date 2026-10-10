# One fleet: Firstmate supervises every session; owner tiers crew and watched

Date: 2026-10-05T09:00:00.000Z
Supersedes: None

## Decision

Joyride keeps one fleet roster of every live session, and Firstmate supervises all of it (option B). There is no Firstmate core patch: Firstmate learns the fleet through supported seams only:
- a fleet preference rendered into its `captain.md`;
- captain inbox notes (`fm-inbox.sh note`);
- the `joyride-fleet-feed` process-event-adapter/1 extension;
- the `joyride fleet` and `joyride steer` CLI.

The roster sorts sessions into owner tiers:
- **crew**: Firstmate launched it and keeps the whole lifecycle.
- **watched**: the captain started it. Firstmate guides it but never owns its process, checkout or end of life.
- **control**: Firstmate's own pane.
- **excluded**: the captain keeps it to themself. Fleet policy lives in `fleet.yaml`.

Every live session joins automatically, and the captain can opt one out.

Firstmate may steer watched sessions with text and answer their permission prompts. Both go through one guarded, attributed path that refuses to type over a captain's draft. From phase 3, Firstmate may also close idle watched panes without asking, but only after it saves the session's learnings, its work, what is needed to resume with context, and its artifacts. Blast-radius approvals stay the captain's.

After a direct steer the captain holds the helm until the turn ends plus 15 quiet minutes, or until they hand it back. While the captain holds the helm, Firstmate steers nothing there.

Pruning thresholds:
- an idle pane is a candidate after 72 h;
- mission proposals expire at 14 d;
- the archive horizon stays 30 d.

This extends:
- `dec-intents-not-orchestration`: a watched tier sits beside "a Crew is Firstmate-owned".
- `dec-authored-vs-projected`: fleet policy is authored, while tier and helm are projected.

## Why

Hand-started sessions were visible and steerable, but nobody supervised them. Adopting them as Firstmate tasks would fire a stale wake on every screen change. It would also ring the doorbell into the captain's composer and give teardown a destructive path into shared checkouts. A Joyride-held roster gives Firstmate the inputs a supervisor needs without patching five core scripts that change weekly.
