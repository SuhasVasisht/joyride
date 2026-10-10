// A small, realistic Firstmate home (FM_HOME) for tests: four backlog tasks in
// every section, per-task meta/status/turn-ended files, briefs carrying the
// joyride-mission marker, a scout report, a secondmate and Firstmate's own
// home summary. Formats follow vendor/firstmate (tasks-axi backlog, key=value
// meta, append-only status log).
import fs from "node:fs";
import path from "node:path";

export const FIXTURE_WORKTREE_ROOT = "/tmp/joyride-fixture-repos/alpha-worktrees";

export type FixtureIds = { ship: string; scout: string; queued: string; done: string };
export const FIXTURE_TASKS: FixtureIds = { ship: "jr-csv-export", scout: "scout-flaky-export", queued: "jr-csv-docs", done: "sync-idempotent" };
/**
 * Herdr panes the herdr-backend tasks record in their meta (`herdr_pane_id`, workspace "w90"): a pane with
 * this id is that task's crewmate. The scout task stays on a tmux window, so only FM_TASK_ID names its crew.
 */
export const FIXTURE_CREW_PANES = { ship: "w90:p1", done: "w90:p2" } as const;

const epoch = (msAgo: number) => Math.floor((Date.now() - msAgo) / 1000);
const write = (f: string, text: string) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };

/** Write the fixture into `home` (wiped first). Tasks ship, scout and queued carry `joyride-mission: <mission>`. */
export function buildFirstmateHome(home: string, mission: string) {
  fs.rmSync(home, { recursive: true, force: true });
  const t = FIXTURE_TASKS;
  const day = (d: number) => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
  write(path.join(home, "config", "backend"), "herdr\n");
  write(path.join(home, "data", "projects.md"), `- alpha [local-only] - Fixture app for the CSV export (added ${day(5)})\n- beta [local-only +yolo] - Sync service (added ${day(9)})\n`);
  write(path.join(home, "data", "secondmates.md"), `- sm-infra - Infrastructure domain (home: /tmp/sm-infra; scope: infra; projects: beta; added ${day(7)})\n`);
  write(path.join(home, "data", "backlog.md"), [
    "## In flight", "",
    `- [ ] ${t.ship} - Add a CSV export button with totals (repo: alpha) (kind: ship) (since ${day(1)})`,
    `- [ ] ${t.scout} - SCOUT why the export test flakes on CI (repo: alpha) (since ${day(0)})`,
    "", "## Queued", "",
    `- [ ] ${t.queued} - Document the CSV export (repo: alpha) (kind: ship) blocked-by: ${t.ship} - needs the button first`,
    "", "## Done", "",
    `- [x] ${t.done} - Make the sync job idempotent local main (repo: beta) (kind: ship) (done ${day(2)})`,
    "",
  ].join("\n"));

  const wt = (id: string) => path.join(FIXTURE_WORKTREE_ROOT, id);
  // tests run fm-send.sh against stubbed tmux/herdr, never a real terminal.
  const meta = (id: string, kind: string, extra: string[] = [], window = `fixture:fm-${id}`) =>
    write(path.join(home, "state", `${id}.meta`), [`window=${window}`, `endpoint_task_id=${id}`, `worktree=${wt(id)}`, `project=${path.join(home, "projects", "alpha")}`, "harness=claude", `kind=${kind}`, `branch=fm/${id}`, ...extra, ""].join("\n"));
  const herdrPane = (pane: string) => ["backend=herdr", "herdr_session=default", `herdr_workspace_id=${pane.split(":")[0]}`, `herdr_pane_id=${pane}`];
  meta(t.ship, "ship", ["mode=local-only", "yolo=off", ...herdrPane(FIXTURE_CREW_PANES.ship)], `default:${FIXTURE_CREW_PANES.ship}`);
  meta(t.scout, "scout");
  // Reported done, not torn down yet: its crewmate is still live, outside any mission in most tests.
  meta(t.done, "ship", ["mode=local-only", ...herdrPane(FIXTURE_CREW_PANES.done)], `default:${FIXTURE_CREW_PANES.done}`);
  for (const id of [t.ship, t.scout]) fs.mkdirSync(wt(id), { recursive: true });

  write(path.join(home, "state", `${t.ship}.status`), [
    `working [key=impl] [at=${epoch(2 * 36e5)}]: wiring the export button into the toolbar`,
    `working [at=${epoch(6e5)}]: running the e2e suite against the totals row`,
    "",
  ].join("\n"));
  write(path.join(home, "state", `${t.scout}.status`), `needs-decision [key=flake-cause] [at=${epoch(15 * 6e4)}]: two causes found, a timezone default and a race in the download handler; pick which to fix first\n`);
  write(path.join(home, "state", `${t.ship}.turn-ended`), "");

  const brief = (id: string, title: string, body: string, marker = true) => write(path.join(home, "data", id, "brief.md"),
    `# ${title}\n\n## Captain's intent\n\n${marker ? `joyride-mission: ${mission}\n\n` : ""}${body}\n`);
  brief(t.ship, "Add a CSV export button with totals", "Add an Export CSV button to the report page; the file includes a totals row.");
  brief(t.scout, "Why the export test flakes", "Find out why the CSV export e2e test fails one run in five on CI.");
  brief(t.queued, "Document the CSV export", "Document the export button and the totals row in the user guide.");
  brief(t.done, "Make the sync job idempotent", "Running the sync twice must not duplicate rows.", false);
  write(path.join(home, "data", t.scout, "report.md"), "# Flaky export test\n\nTwo causes:\n\n1. The test builds dates in local time, so it fails after 5 pm Pacific.\n2. The download handler resolves before the file is flushed.\n\nRecommendation: fix the race first; it also explains the empty-file reports.\n");

  write(path.join(home, "state", "home-summary.json"), JSON.stringify({
    schema: "fm-secondmate-home-summary.v1", generated: new Date().toISOString(), generated_epoch: epoch(0), home, valid: true, state: "captain_decision",
    active_children: [{ id: t.ship, kind: "ship", state: "working", repo: "alpha" }, { id: t.scout, kind: "scout", state: "needs-decision", repo: "alpha" }],
    decisions_open: [{ id: t.scout, key: "flake-cause", verb: "needs-decision", summary: "pick which flake cause to fix first" }],
    holds: [], queued: [{ id: t.queued, title: "Document the CSV export", blocked_by: t.ship, repo: "alpha", kind: "ship" }],
    landed: [{ id: t.done, title: "Make the sync job idempotent", kind: "ship", local_note: "local main" }],
    endpoints: [], counts: {}, omitted: [],
  }, null, 2));
  return { home, worktree: wt, tasks: t };
}
