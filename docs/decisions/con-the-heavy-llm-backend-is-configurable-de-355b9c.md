# Joyride internal models are configured per task and effort

Date: 2026-10-05T05:06:44.929Z
Supersedes: dec-llm-backend-configurable, cnv-joyride-llm-codex-luna-f1b0bb, dec-jev-vs-llm-split, lrn-apply-configuration-through-the-authored-3b6447, lrn-keep-estimates-separate-from-measurement-e5115e, lrn-review-downstream-effects-before-choosin-fd8a11, lrn-call-frequency-can-dominate-small-prompt-3178de, lrn-inventory-every-model-execution-path-6160f1, lrn-silent-configuration-acceptance-hides-mi-9e171c, lrn-model-selection-does-not-isolate-runtime-68bcb3, dec-pin-backpass-models-and-resolve-gateway-d5049e, dec-add-effort-control-and-task-name-warning-63d8a5, dec-keep-frequent-or-low-stakes-tasks-on-lun-ccf24b, dec-use-astra-for-judge-improvement-1df1f7, dec-upgrade-consequential-low-volume-tasks-4f7242

## Decision

Read GET /api/system/config or joyride.config.yaml for current selections. Current task keys are `session_preserve`, `session_intent`, `mission_naming`, `proposal_brief`, `screenshot_caption`, `ask_options`, `idea_naming` and `idea_brief`. Consult `src/shared/llm-tasks.ts` for the current inventory. Launched workers and Jev are separate execution paths; these are not worker-dispatch settings.

Use src/core/llm.ts and src/core/jev.ts: internal calls set JOYRIDE_INTERNAL=1 and run isolated from the world view. Codex calls are ephemeral with hooks disabled; explicit task effort avoids inheriting user defaults. Supported heavy backends are codex and claude, not gateway. Task keys live in src/shared/llm-tasks.ts; unknown overrides warn. Change configuration through Settings or PUT /api/system/config so it is committed.

Jev handles typed judgments; the heavy model handles generation and reasoning. Model stakes include downstream quarantine and completion verdicts, not merely prompt size. Historical token/cost probes are not current quota or performance measurements.

## Why

Keep frequent, reviewed outputs inexpensive and use stronger reasoning for durable knowledge and judge improvement; recheck the configuration instead of reviving obsolete all-Luna or Haiku defaults.
