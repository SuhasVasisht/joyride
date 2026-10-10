# Authored data is a git repo of markdown and YAML inside the Joyride folder

Date: 2026-10-04T05:32:59.000Z
Supersedes: None

## Decision

missions/, lenses/, notes/, artifacts/, map/layout.yaml, guidance/ and workspace.yaml are committed on every change (history, diff and revert for free). Runtime state in .joyride/ (events, sqlite index, blobs, task-notes and mission proposals) is gitignored; the event log is durable.

## Why

User: keep it in the current folder for now; the Obsidian-compatible format allows mounting into the vault later.
