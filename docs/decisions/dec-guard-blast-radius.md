# Global blast-radius guard: only actions with real-world reach are held

Date: 2026-10-04T05:32:59.000Z
Supersedes: None

## Decision

A global PreToolUse hook for all Claude Code and Codex sessions. Gated: pushes to remotes, Jira, Confluence, Slack, email and Teams writes, cloud and infra changes, remote shells, recursive deletes outside the repo, publishing, PR and release changes, non-local HTTP writes. Fail closed (deny) on timeout (5 min) or daemon down; everything else allowed instantly. Rules match commands in command position only, and heredoc data bodies are ignored, so prose mentioning a command does not trigger it. Jev may only escalate ambiguous commands. Allow-pattern rules per session, mission or global. JOYRIDE_GUARD=off is the escape hatch. guard.yaml has an auto_approve extension point for a future Jev guard tier.

## Why

User: it can just go ahead; only guard remote pushes to Bitbucket or Jira or anything with a blast radius; and: I can't get caught up in approvals.
