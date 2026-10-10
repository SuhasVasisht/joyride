# Authored data can live in a separate data home

Date: 2026-10-10
State: accepted
Supersedes: [dec-storage-git-in-repo](dec-storage-git-in-repo.md)

## Decision

Authored data (missions/, lenses/, notes/, artifacts/, map/, servers/, guidance/, skills/, workspace.yaml, fleet.yaml, guard.yaml, joyride.config.yaml) lives in a data home: its own git repo, committed on every change as before. `JOYRIDE_HOME` names it, or a gitignored `.joyride.env` beside the code. Without either, the data home is the code checkout itself. Runtime state stays in `.joyride/` (`JOYRIDE_RUNTIME`), gitignored. The code checkout ships defaults (guard.yaml, config/judges, config/mcp-manifest.json, joyride.config.example.yaml) and Joyride's own worker skills; the data home's copies win.

## Why

The code is published as a public repository. Personal and work data must never reach it, and the daemon's automatic commits made that impossible while both shared one repo.
