// FM_HOME skeleton for running Firstmate under Joyride: Herdr backend, Claude
// crewmates, local-only delivery (no pushes, no PRs, no GitHub calls), and
// standing worker instructions that require joyride-evidence. Idempotent:
// files the human (or Firstmate) already edited are kept.
import fs from "node:fs";
import path from "node:path";

export const FIRSTMATE_PIN = "fede6197556c188dd2f451809d17851760d1ef46";

export const CAPTAIN_MD = `# Captain preferences (seeded by Joyride)

- Every project is **local-only**: workers stop with a clean ready branch, and landing is a local fast-forward after my approval. Never push, never open a PR, never call GitHub (\`gh\`) for this fleet.
- Register a new project as \`local-only\`: clone it from its local path into \`projects/<name>\` and make no remote changes.
- Joyride (the workspace above you) sends task requests that carry a \`joyride-mission: <id>\` line. Keep that line verbatim in the task brief's Captain's intent.
- Work is done only when its proof is recorded with \`joyride-evidence\` (tests, e2e, screenshots).
`;

export function briefInclude(evidenceBin: string) {
  return `Joyride standing instructions:
- Record every verification run with joyride-evidence so Joyride can judge the work, for example \`${evidenceBin} run --name "unit tests" -- npm test\`. Add \`--mission <id>\` when the brief carries a joyride-mission line. A claim without a recorded run counts as nothing.
- For UI changes, verify on the real surface (Playwright) and keep the screenshots under test-results/ or docs/checkpoints/ so joyride-evidence attaches them.
- Never push and never open a pull request. Finish with a clean local branch and report it ready.
`;
}

export type SeedResult = { home: string; created: string[]; kept: string[] };

/** Create or complete the FM_HOME skeleton. Never overwrites an existing file. */
export function seedHome(home: string, opts: { evidenceBin: string }): SeedResult {
  const created: string[] = [], kept: string[] = [];
  for (const d of ["config", "data", "state", "projects"]) fs.mkdirSync(path.join(home, d), { recursive: true });
  const files: Record<string, string> = {
    "config/backend": "herdr\n",
    "config/crew-harness": "claude\n",
    "config/brief-include.md": briefInclude(opts.evidenceBin),
    "data/backlog.md": "## In flight\n\n## Queued\n\n## Done\n",
    "data/projects.md": "",
    "data/captain.md": CAPTAIN_MD,
  };
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(home, rel);
    if (fs.existsSync(f)) { kept.push(rel); continue; }
    fs.writeFileSync(f, content);
    created.push(rel);
  }
  return { home, created, kept };
}
