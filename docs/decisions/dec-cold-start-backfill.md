# File sessions by demonstrated work using reversible mission moves

Date: 2026-10-04T05:32:59.000Z
Supersedes: lrn-respect-grouping-boundaries-745e48, lrn-verify-assignments-and-retention-indepen-8443d1, lrn-session-attribution-is-required-for-fili-d959f9, lrn-undo-through-the-move-api-fd3ae3, lrn-review-the-full-session-census-a09c60, dec-use-reversible-map-moves-0aa8c6, lrn-worker-filing-depends-on-session-attribu-162a3d, lrn-undo-moves-through-the-mission-api-88ba75, lrn-distinguish-task-evidence-from-incidenta-baf18d, lrn-review-the-full-session-inventory-bc593c, dec-leave-unattributed-workers-untouched-11db99, dec-preserve-separate-sessions-and-control-n-9719b0, dec-leave-unmatched-sessions-unfiled-94a773, dec-file-sessions-by-demonstrated-mission-wo-89ffd4, lrn-an-open-mission-tracks-a-goal-510c98, dec-consolidate-related-proposals-into-durab-e0ec8e, lrn-undo-commits-have-preconditions-2497c1, lrn-check-route-capabilities-before-grouping-ba8178, lrn-recurring-work-needs-bounded-completion-8d26b4, lrn-session-moves-have-two-undo-paths-f75762, dec-make-live-changes-through-the-daemon-api-730e8f, dec-use-three-missions-as-session-homes-09c9b7, lrn-require-indexed-sessions-for-worker-fili-4fb733, lrn-account-for-concurrent-indexing-2c62a2, lrn-verify-membership-and-preservation-toget-9f543b, lrn-choose-undo-methods-based-on-current-sta-838463, lrn-classify-by-demonstrated-task-context-eec793, dec-preserve-session-copies-and-use-reversib-f140bc, lrn-missing-attribution-prevents-reliable-fi-f6be99, lrn-verify-baseline-assignments-4daa32, dec-retain-unrelated-history-unfiled-bfb282, lrn-missing-attribution-blocks-evidence-back-e316bc, lrn-verify-identity-and-membership-21469c, lrn-reverse-moves-survive-later-edits-9103d2, lrn-classify-by-task-evidence-1a2232, dec-preserve-unmatched-history-and-session-c-57b4bd, dec-use-reversible-api-changes-268b5b, dec-create-three-goal-focused-missions-16cfe9

## Decision

Cold start reads session metadata; recent history produces reviewable mission proposals and older history is grouped into repo archives. For ideas (missions), housekeeping now files and tidies without asking (dec-ideas-auto-tidy); session backfill still proposes. Pi and Cursor are outside v1. Mission naming uses the configured heavy model.

For curation, review the full session census and transcript context. The map's Unfiled view is only a recent 24-hour/40-session slice. File by substantive work, not incidental setup, cwd or similar titles. Leave unmatched or unattributed workers unfiled; preserve separate transcript identities and Firstmate's control history. A session belongs to a mission, not directly to a lens.

POST /api/missions/move with {session, to:{mission}} returns a commit. Undo via /api/missions/move/undo in reverse order per affected file; later edits can block exact undo, so inspect them before moving back. Verify exclusive destination membership, projected assignment, untouched assignments and retention of all original session keys. An open mission tracks a goal; it neither dispatches work nor proves completion.

## Why

A map should describe the work without changing runtime ownership or losing history. Grouping references alone does not back up transcripts.

For recurring work, define completion for a retained batch or reporting cycle rather than declaring the ongoing activity permanently finished.
