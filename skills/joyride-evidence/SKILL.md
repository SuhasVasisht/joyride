---
name: joyride-evidence
description: Record proof for verification work. Use whenever you run tests, builds, e2e suites or take screenshots to show a change works, and before you say a task is done. Wrap the check with joyride-evidence so Joyride has an attested record.
---

# Record evidence with joyride-evidence

Joyride decides whether work is done by judging recorded evidence against the mission's `done_when` criteria. Test results and exit codes decide. A claim with no recorded run behind it counts as nothing.

The tool is `bin/joyride-evidence` in your Joyride checkout, written `<joyride>/bin/joyride-evidence` below; your global guidance names the exact path. It works with the Joyride daemon down and never uses the network.

## Wrap every verification command

```sh
<joyride>/bin/joyride-evidence run --name "unit tests" -- npm test
<joyride>/bin/joyride-evidence run --name e2e --claim "login flow works end to end" -- npx playwright test
<joyride>/bin/joyride-evidence run --name build -- "npm run build && npm run typecheck"
```

- Output streams to your terminal as usual, and the exit code is passed through unchanged.
- The tool records:
  - the exit code
  - the last 4 KB of output and the full log
  - test counts (Playwright JSON, vitest, jest, pytest, go, cargo and mocha summaries)
  - any screenshots the run created or changed
- Pass a single quoted string when you need shell features (`&&`, pipes, redirects). Several arguments run directly, without a shell.
- Use short, stable names per check: `unit tests`, `e2e`, `typecheck`, `lint`, `build`. A newer run with the same name replaces the older one when Joyride judges.
- `--claim "..."` says in one sentence what this run proves.
- `--mission <id>` links the record to a Joyride mission. Without it, Joyride links the record through your session.
- Your session is found automatically: for Claude Code through the parent process, and for Codex through the working directory. To override, pass `--session claude:<id>` or `--session codex:<id>`.

## Screenshots

New or changed images are attached automatically if they are under `test-results/`, `playwright-report/`, `screenshots/` or `docs/checkpoints/` in the current directory or the repo root. For other locations, pass `--screenshots <dir|glob>` (repeatable), for example `--screenshots "out/**/*.png"`.

Screenshots are captioned when evidence is judged. A caption that contradicts the criterion turns a pass into "insufficient", so make sure screenshots show the thing the criterion describes.

## Evidence produced elsewhere

Use `add` for checks that really ran somewhere else, such as CI or manual QA you actually did:

```sh
<joyride>/bin/joyride-evidence add --name "manual QA" --claim "checkout works on Safari" \
  --screenshot safari-checkout.png [--exit-code 0] [--log ci.log] [--results playwright.json] [--command "..."]
```

## Rules

- Never say a task is done, fixed or passing without a joyride-evidence record of the check that shows it.
- Run the final check through joyride-evidence, and record failing runs too. Do not run checks unrecorded until they pass and then record only the green run.
- Never fabricate evidence. `add` is only for real runs, and should include their log or screenshots.
- In your final message, quote the summary line the tool prints, for example `joyride-evidence: recorded "unit tests" (exit 0, 42 passed, 0 failed, …) as evd_…`.
- If the tool is missing on this machine, run the check normally and say that evidence could not be recorded.
