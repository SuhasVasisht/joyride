# Decisions

Captain decisions live in repo files with their reasons. Superseded decisions retain their original text and link to their replacement. Current design is in `DESIGN.md`.

| id | kind | decision |
|---|---|---|
| [con-the-heavy-llm-backend-is-configurable-de-355b9c](decisions/con-the-heavy-llm-backend-is-configurable-de-355b9c.md) | constraint | Joyride internal models are configured per task and effort |
| [dec-attention-jev](decisions/dec-attention-jev.md) | decision | Attention is classified by Jev with a deterministic floor |
| [dec-authored-vs-projected](decisions/dec-authored-vs-projected.md) | decision | Joyride owns knowledge; Firstmate owns delegation; Herdr owns runtime |
| [dec-cold-start-backfill](decisions/dec-cold-start-backfill.md) | decision | File sessions by demonstrated work using reversible mission moves |
| [dec-evidence-attested-jev](decisions/dec-evidence-attested-jev.md) | decision | Evidence must prove the intended behavior and survive the worker |
| [dec-firstmate-now](decisions/dec-firstmate-now.md) | decision | Firstmate and capability integrations use supported seams |
| [dec-global-changes-logged](decisions/dec-global-changes-logged.md) | constraint | Global changes go through the installer and are logged |
| [dec-guard-blast-radius](decisions/dec-guard-blast-radius.md) | constraint | Global blast-radius guard: only actions with real-world reach are held |
| [dec-no-jira-yet](decisions/dec-no-jira-yet.md) | constraint | No Jira or Confluence linking or write-back for now |
| [dec-one-fleet](decisions/dec-one-fleet.md) | decision | One fleet: Firstmate supervises every session; owner tiers crew and watched |
| [dec-opus-subagents](decisions/dec-opus-subagents.md) | convention | Build with Opus subagents only |
| [dec-ui-local-daemon](decisions/dec-ui-local-daemon.md) | decision | Joyride serves one user through a local daemon and web UI |
| [dec-visual-light-editorial](decisions/dec-visual-light-editorial.md) | decision | Light editorial visual direction |

## Accepted first-principles decisions

| id | state | decision |
|---|---|---|
| [dec-knowledge-as-sources](decisions/dec-knowledge-as-sources.md) | accepted | Knowledge stays in its sources |
| [dec-storage-data-home](decisions/dec-storage-data-home.md) | accepted | Authored data can live in a separate data home |
| [dec-six-nouns-three-places](decisions/dec-six-nouns-three-places.md) | accepted | Six nouns and three places for guidance; placement only |

## Superseded decisions

These documents preserve the captain's historical choices. Read their replacement links for current behavior.

| id | state | historical decision |
|---|---|---|
| [dec-firstmate-memory-single-store](decisions/dec-firstmate-memory-single-store.md) | superseded | Memory has one file-backed store, scoped delivery and reversible lifecycle |
| [dec-hillclimb-backpass-jev](decisions/dec-hillclimb-backpass-jev.md) | superseded | Hill-climbing uses one generic engine: backpass evidence for instructions, labels for Jev judges |
| [dec-ideas-auto-tidy](decisions/dec-ideas-auto-tidy.md) | superseded | Ideas are missions, groups are lenses, and housekeeping tidies them without asking |
| [dec-storage-git-in-repo](decisions/dec-storage-git-in-repo.md) | superseded | Authored data is a git repo of markdown and YAML inside the Joyride folder |
| [dec-learnings-on-demand-nudged](decisions/dec-learnings-on-demand-nudged.md) | superseded | Learning extraction runs on demand, with nudges |
| [dec-workspace-as-code](decisions/dec-workspace-as-code.md) | superseded | Workspace and map evolve through reviewable changes |
