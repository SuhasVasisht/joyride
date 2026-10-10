# Hill-climbing uses one generic engine: backpass evidence for instructions, labels for Jev judges

Date: 2026-10-04T05:32:59.000Z
Supersedes: None

State: superseded on 2026-10-05
Replaced by: [dec-knowledge-as-sources](dec-knowledge-as-sources.md)

The original decision and its reason below are historical, not current implementation guidance.

## Decision

Targets now: agent instructions (backpass transcript evidence becomes memory entries by default, promotable to repo files) and Jev judges (accepted only if better on held-out labels via validate-evaluator TPR/TNR and the human approves). Memory digest selection comes later.

## Why

User wants something like Kun's hill-climbing (backpass) plus the evals skills.
