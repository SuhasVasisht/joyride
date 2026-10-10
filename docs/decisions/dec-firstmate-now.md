# Firstmate and capability integrations use supported seams

Date: 2026-10-04T05:32:59.000Z
Supersedes: dec-evals-skills, dec-pstack-canonical, lrn-supported-seams-reduce-vendor-maintenanc-7acaaf, lrn-supported-seams-can-avoid-vendor-patches-3081da, dec-preserve-future-firstmate-updates-c41ec3, lrn-durable-delivery-can-outlive-a-running-p-a43b96, lrn-use-durable-receipts-for-delivery-state-12fe46, dec-use-existing-firstmate-channels-a09af3

## Decision

Firstmate is pinned under vendor/firstmate, uses .joyride/firstmate as its home and Herdr as runtime, and lands local changes without remote publishing. Joyride routes task requests through durable inbox notes and task steering through supported interfaces. Firstmate guidance files are canonical and shown read-only in Settings.

Prefer existing preferences, inboxes and process-event adapters to patches across lifecycle scripts. The canonical P-Stack source and installed eval skills are capability inputs; consult vendor/PINS.md and installer state for exact versions rather than a historical hash. Firstmate owns delegation and sees the watched fleet through the fleet CLI and process-event feed. Repo instructions, skills, notes and artifact links supply agent context. validate-evaluator supports judge evaluation, error-discovery produces candidates, and eval-this maps to evals-start.

## Why

Supported integration contracts reduce maintenance while allowing upstream Firstmate updates.

Durable inbox notes can queue until Firstmate starts. Reuse the intent/request ID on retries and consult receipts to distinguish queued, acknowledged and converted-to-task state.
