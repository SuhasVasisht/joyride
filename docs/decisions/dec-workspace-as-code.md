# Workspace and map evolve through reviewable changes

Date: 2026-10-04T05:32:59.000Z
Supersedes: dec-ui-hybrid-flexible

State: superseded on 2026-10-05
Replaced by: [dec-six-nouns-three-places](dec-six-nouns-three-places.md)

The original decision and its reason below are historical, not current implementation guidance.

## Decision

The spatial map shows missions with drill-in evidence, diffs and transcripts, plus a command palette. The renderer is replaceable and reads workspace.yaml.

Tier 1 produces a spec diff, preview and explicit accept/commit or revert. Tier 2 runs code changes as a mission with a worktree, preview port, evidence and a local acceptance merge. Suggestions from interaction logs do not apply automatically.

## Why

The workspace can evolve from intent while the stable surface remains intact until its change is accepted.
