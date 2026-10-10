# Attention is classified by Jev with a deterministic floor

Date: 2026-10-04T05:32:59.000Z
Supersedes: None

## Decision

L0-L4 ladder. Jev classifies on state transitions only (choice level, noul needs-human, choice kind). Permission pending, crash or Herdr blocked means at least L3; a pending guard request is L4. Jev may only raise. Done goes to the L2 review queue, not an interrupt. Ack, dismiss, snooze and override are logged as labels from day one.

## Why

User chose Jev for classification; the floor prevents one bad classification hiding a stuck agent.
