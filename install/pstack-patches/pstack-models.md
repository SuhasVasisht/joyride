# pstack models (managed by Joyride; edit freely, `joyride install pstack` keeps your edits)
# One line per role: `<role>: <model>`. Values are Claude Code subagent models: opus, sonnet or haiku.
# `inherit-parent` or `auto`: the role runs on the parent model (omit the subagent `model`). Panel roles list one entry per seat.
# Codex has no subagent tool: run each role sequentially in the session model and ignore these values.
# The user's preference: every role runs on opus.
# budget: unlimited
feature, refactoring: opus
bug-fix: opus
perf-issue: opus
hillclimb: opus
judgment and prose: opus
hardest tasks: opus
how explorer: opus
how explainer: opus
why investigators: opus
why synthesizer: opus
arena runners: opus, opus, opus
arena cross-judge pool: opus
swarm workers: opus
architect runners: opus, opus, opus
interrogate reviewers: opus, opus, opus
