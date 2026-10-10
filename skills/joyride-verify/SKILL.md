---
name: joyride-verify
description: Verify a Joyride build checkpoint (C0–C12) or feature when working on the Joyride repo itself. Use before reporting Joyride work as done. Covers typecheck, unit tests, build, e2e with screenshots, joyride-evidence records, and a Jev verdict from the daemon.
---

# Verify a Joyride checkpoint

Work in the assigned Joyride checkout or isolated worktree. Read `AGENTS.md` first. Below, `<mission>` is the Joyride mission id, which is the slug of `missions/<slug>.md`. `C#` is the checkpoint from `docs/DESIGN.md` §15.

Run every step through `bin/joyride-evidence` so it is recorded (see the joyride-evidence skill).

1. **Typecheck**

   ```sh
   bin/joyride-evidence run --name typecheck --mission <mission> -- npm run typecheck
   ```

2. **Unit tests** (vitest, `tests/unit/**`)

   ```sh
   bin/joyride-evidence run --name "unit tests" --mission <mission> -- nice -n 10 npx vitest run tests/unit
   ```

   - Unit tests use `sandboxDaemon(name, modules)` from `tests/sandbox.ts`, with fake models.
   - Keep the sandbox isolated. `src/shared/paths.ts` reads `JOYRIDE_HOME` and `JOYRIDE_RUNTIME` when it is imported.
     - At the top of a test file, use only `import type` from `src/`. Load values with `await import(...)` *after* `sandboxDaemon()`.
     - Otherwise the test binds to the real `.joyride` runtime and writes into the live event log and index.
     - Check `paths.runtime.startsWith(sb.dir)` before emitting anything.

3. **Build the UI**

   ```sh
   bin/joyride-evidence run --name build --mission <mission> -- npm run build
   ```

4. **End-to-end tests with screenshots**

   - Write specs in `tests/e2e/`.
   - Save checkpoint screenshots with `await shot(page, "C#", "what-it-shows")` from `tests/e2e/shot.ts`. It writes `docs/checkpoints/C#/<name>.png`.
   - Use a private preview port in 4320–4329 and an isolated sandbox, with fake models. Run only the affected specs, with one worker. Never use port 3000 or touch the live daemon on 4317. Set `JOYRIDE_FIRSTMATE_DIR` to the stable vendored Firstmate directory for checks that exercise its scripts.

   ```sh
   bin/joyride-evidence run --name e2e --mission <mission> --claim "C#: <what the screenshots show>" -- scripts/e2e.sh <private-port> tests/e2e/<area>.spec.ts --workers=1
   ```

   Playwright's JSON report (`test-results/e2e.json`) supplies the pass and fail counts. New screenshots under `docs/checkpoints/` are attached.

5. **Ask Jev for a verdict.** Use an already authorized isolated daemon and its private port/data directory. Do not start or restart the live daemon.

   ```sh
   curl -s -X POST http://127.0.0.1:<private-port>/api/evidence/verdict/<mission> -H 'content-type: application/json' -d '{}'
   ```

   - If the mission file does not exist yet, pass the criteria inline: `-d '{"done_when":[{"text":"…","kind":"test"},{"text":"…","kind":"screenshot"}]}'`. Kinds are test, e2e, screenshot, review and other.
   - Read these fields of the response:
     - `verdict`: pass, fail or insufficient.
     - `per_criterion[].reason`.
     - `downgraded_by_caption`: true when a screenshot caption contradicted a criterion.
   - The latest verdict is at `GET /api/evidence/verdict/<mission>`.

6. **Act on the verdict**
   - **pass:** report the verdict id and the evidence summary lines, and record the result for `C#` in `docs/CHECKPOINTS.md`.
   - **fail:** fix the cause, then re-run the failing step through joyride-evidence and ask for a new verdict.
   - **insufficient:** add the missing evidence, such as a screenshot that shows the criterion or a test that covers it. Do not argue with the judge, and do not lower the criterion.

Never report a checkpoint as done on a fail or insufficient verdict. Closing a mission without a pass needs a written override from the human.

## Current checkpoint coverage

- C0: scaffold, installer, hooks and guard.
- C1: session readers, backfill, idea proposals and auto-link.
- C2: live workers, attention, map and panes.
- C3: intents, replies and approvals.
- C4: evidence records and Jev verdicts.
- C5: guidance, repo decisions, notes and source search.
- C6: artifact link cards and nudges.
- C7: Firstmate tasks, shared skills, watched fleet, fleet/steer CLI and process-event feed.
- C8: read-only map settings and reversible task placement.
- C9: attention floor, acknowledgement and evidence judging.
- C10: agent contract and local delivery.
- C11: chat, terminal and agent intent.
- C12: map interactions, Board and contextual session launch.
