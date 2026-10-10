# Global changes go through the installer and are logged

Date: 2026-10-04T05:32:59.000Z
Supersedes: None

## Decision

Every change outside the repo is applied by bin/joyride install, backed up to .joyride/backups, logged in GLOBAL_CHANGES.md, and reversible with uninstall. No need to show the user the diff first.

## Why

User: go ahead with global changes, just document them here.
