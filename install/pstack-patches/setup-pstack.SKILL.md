---
name: setup-pstack
description: Configure which model pstack uses per role. Edits the Joyride-managed pstack models note that every pstack skill reads in place of its defaults. Use for /setup-pstack, "configure pstack models", or changing pstack's model choices.
---

# Setup pstack

Edit `{{MODELS_NOTE}}`, the note every pstack skill reads for its per-role model.

## Steps

### 1. Know the valid values

Claude Code's subagent tool (the Agent tool) takes `opus`, `sonnet` or `haiku` as `model`. The aliases `inherit-parent` and `auto` are always valid: the role runs on the parent model, so omit `model`. Codex has no subagent tool; there every role runs sequentially in the session model and these values are ignored.

### 2. Load current state

Read the note. Treat its role values as the current choices. A line whose role is not listed in step 4 is from a retired role; drop it.

### 3. Show the roles and confirm

Show every role with its model, plus any line step 2 dropped. Ask whether to keep them or change specific roles (prefer AskUserQuestion over free text). The user's standing preference is `opus` for every role. Panel roles (arena runners, architect runners, interrogate reviewers) take a list; one subagent runs per entry, so the list length sets the count. `arena cross-judge pool` is also a list, and Arena picks one value from it.

### 4. Write the note

Overwrite the whole note so re-runs stay idempotent. Keep the comment header. Shape:

```
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
```

### 5. Confirm

Tell the user the note was written and that it applies to new sessions. `joyride install pstack` keeps an edited note.

### 6. Offer a verification skill (optional)

Check whether the project has a way to drive the real app for proof (a `verify-*` skill, or an existing harness). If not, offer once: "want a project-local verification skill, so agents can drive the app the way a user does and prove changes work? I can generate one with /create-verification-skill." On yes, invoke `/create-verification-skill`. On no, move on without pushing.
