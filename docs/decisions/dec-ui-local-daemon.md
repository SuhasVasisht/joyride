# Joyride serves one user through a local daemon and web UI

Date: 2026-10-04T05:32:59.000Z
Supersedes: dec-solo-user, dec-vm-later

## Decision

Joyride serves one human's local agents. The TypeScript daemon listens on 127.0.0.1:4317 and serves the React UI with SSE updates and a disposable SQLite index over durable local sources. Vite development uses 4318; tier-2 previews use 4320–4329. Never use port 3000 for Joyride.

Herdr provides the runtime beneath Joyride. Remote VM expansion is deferred; the existing devvm port-3000 demo is hands-off and any separately authorized VM work must verify it remains intact. No team authentication, sharing or merge product is implied.

## Why

The workspace needs local files and runtime access, with one user's workflow working before broader deployment.
