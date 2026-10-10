# Joyride owns knowledge; Firstmate owns delegation; Herdr owns runtime

Date: 2026-10-04T05:32:59.000Z
Supersedes: dec-intents-not-orchestration, dec-conflict-rules, dec-herdr-default-runtime, lrn-shared-checkout-changes-are-not-session-08721c, lrn-use-authoritative-session-identity-bd555b, lrn-shared-directories-make-teardown-dangero-474977, lrn-projection-gaps-already-obscure-the-flee-2b8056, lrn-separate-observed-status-from-worker-rep-2e0698, lrn-use-authoritative-identifiers-for-crew-i-5d8ade, lrn-shared-checkouts-make-teardown-hazardous-4c280b, lrn-ownership-requires-lifecycle-guarantees-084be2, dec-external-session-stores-stay-read-only-b0c16c, dec-joyride-routes-commands-to-owners-6029f0, lrn-preserve-the-captain-s-actual-answer-e62944, dec-route-actions-through-their-owners-2ebfd3, lrn-record-the-captain-s-actual-answer-4381b8, lrn-keep-authored-and-projected-state-separa-454355, lrn-separate-authored-data-from-projected-st-0095dc, lrn-keep-intents-pending-until-acknowledgmen-e1016e, lrn-fold-decisions-by-key-f062bd

## Decision

Joyride authors missions, lenses, notes, artifacts and workspace configuration. Firstmate owns tasks, crews and delegation; Herdr owns panes and processes. Commands become intents executed by the responsible owner. External Claude/Codex transcripts are read-only projections.

Crew identity uses the recorded task pane, then a valid FM_TASK_ID, never cwd. Worker placement follows the session mission, then the crew task mission; Firstmate's control pane remains separate. A watched session is not an isolated crew worktree. Do not attribute shared dirty changes to one session or treat closing a pane as permission to clean its directory or kill every process below cwd. Observed idle/disconnected state is not verified completion.

Human edits to projected tasks become pending intents. Repo choices and their reasons live in docs/decisions; authored notes and artifact links preserve context.

## Why

One owner per responsibility prevents a second orchestrator and avoids loss of shared work. The old claim that crew is always null is obsolete: resolveOwner and worker mission fallback are implemented.

Preserve the captain’s exact words and selected labels; keep a decision pending until its owner acknowledges it. Completing a question differs from releasing held work. A later working status cannot resolve an earlier keyed decision; use the authoritative decision fold.
