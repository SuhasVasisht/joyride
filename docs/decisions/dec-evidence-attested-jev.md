# Evidence must prove the intended behavior and survive the worker

Date: 2026-10-04T05:32:59.000Z
Supersedes: dec-all-four-pains, dec-dogfood-handoff, dec-full-build-verified-checkpoints, lrn-persist-verification-beyond-the-worktree-eb29d6, dec-validate-the-data-pass-through-the-live-c2784c, lrn-use-verification-suited-to-the-change-19545c

## Decision

Joyride targets blocked latency, unnecessary terminal checking, context loss and unreliable completion claims. Workers record checks with joyride-evidence, retaining exit status, logs and screenshots; publish disposable-worktree evidence through POST /api/evidence. Inferred transcript evidence stays labelled inferred.

Assertions decide behavior. The configured screenshot-caption model may downgrade an apparent pass; a caption cannot manufacture a pass. Jev judges done_when as pass/fail/insufficient; mission closure requires satisfied criteria or a written override. Feature checkpoints require unit tests and Playwright evidence. A data-only curation pass is checked against the live API for decisions, retained identities, links and protected content; it does not establish application-code behavior.

## Why

A completed command or attractive screenshot is insufficient proof, and teardown must not erase the record of what was actually checked.
