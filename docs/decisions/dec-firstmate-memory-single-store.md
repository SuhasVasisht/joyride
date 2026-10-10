# Memory has one file-backed store, scoped delivery and reversible lifecycle

Date: 2026-10-04T21:00:00.000Z
Supersedes: dec-memory-file-first, dec-memory-inbox, lrn-rendered-files-preserve-offline-startup-efee27, lrn-a-shared-store-must-reconcile-curation-r-b6bf1a, lrn-anchor-checks-miss-unanchored-staleness-0a2e0c, lrn-fleet-facts-need-their-own-scope-66ba54, lrn-memory-delivery-needs-first-session-reso-17927d, lrn-mutable-text-makes-unstable-identities-cb05b8, dec-fix-duplicate-memory-entries-a829d1, dec-use-one-physical-memory-store-7354dc, dec-use-supported-api-supersession-ad1dea, dec-consolidate-without-deleting-sources-4e8e7f

State: superseded on 2026-10-05
Replaced by: [dec-knowledge-as-sources](dec-knowledge-as-sources.md)

The original decision and its reason below are historical, not current implementation guidance.

## Decision

Memory entries are markdown in memory/entries, with scope, provenance, anchors and explicit supersession. Claude auto-memory, traces, backpass and artifacts are candidate inboxes. Promotions, merges and retirement require review; authorized curation can use the API. Repo instruction files change only through an accepted promotion diff.

Firstmate captain.md, captain-shared.md, learnings.md and memory-archive.md are persisted views of this store. Bullet entries use fleet scope; layouts preserve surrounding text. Firstmate can start offline. Its edits are captured against the last render; matching strips stow markers and reconciles wording. Rendering is atomic and respects its startup budget. Firstmate-authored entries activate immediately under its own stow lifecycle. Fleet facts do not enter normal repo digests.

SessionStart injects at most 40 lines of eligible global/repo facts. Resolve worktrees via their common git directory before first injection. Anchored entries become stale after matching file changes and leave injection; unanchored active entries get a re-verification proposal after 30 days (up to five pending), while remaining injected. Preferences and fleet entries have their own exemptions. Use memory_search/get/discover for details beyond the digest.

## Why

A single canon preserves offline startup and upstream compatibility without importing one fact repeatedly or leaking local rules into unrelated repositories.
