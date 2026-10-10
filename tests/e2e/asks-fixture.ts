// Asks on top of the crew fixture home (crew-fixture.ts): captain holds in the shapes
// bin/fm-captain-hold.sh writes (an encoded reason, hold-kind captain, the hold-set stamp and
// origin body lines), the scout's keyed decision followed by a later working line, and the
// ship task's model, effort, account and joyride-request marker.
import fs from "node:fs";
import path from "node:path";
import { FIXTURE_TASKS as T } from "./crew-fixture";

export const ASK_TASKS = { calls: "jr-csv-calls", later: "jr-csv-later" } as const;
export const CALLS_REASON = "Two calls for the export. 1) Where the totals row goes: (A, recommended) the last row; (B) the first row. 2) Which file format: (A) CSV only; (B, recommended) CSV and XLSX.";
export const DOCS_REASON = "Start the docs (after I look at the button) - hold until then";
export const REQUEST_ID = "int_map0001";

const enc = (s: string) => `fm-hold-v1:${Buffer.from(s, "utf8").toString("base64")}`;
const day = (d: number) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);

export function addAskFixtures(home: string) {
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const backlog = path.join(home, "data", "backlog.md");
  let text = fs.readFileSync(backlog, "utf8");
  // The queued docs task: a held work item, but blocked by the ship task, so not actionable yet.
  text = text.replace(`- [ ] ${T.queued} - Document the CSV export (repo: alpha) (kind: ship)`, `- [ ] ${T.queued} - Document the CSV export (repo: alpha) (kind: ship) (hold: ${enc(DOCS_REASON)}) (hold-kind: captain)`);
  text = text.replace(new RegExp(`(^- \\[ \\] ${T.queued} .*)$`, "m"), `$1\n  Captain hold set: ${stamp}`);
  text = text.replace("## Done", [
    `- [ ] ${ASK_TASKS.calls} - Export: where the totals go and which format (repo: alpha) (kind: captain) (hold: ${enc(CALLS_REASON)}) (hold-kind: captain)`,
    `  Captain hold set: ${stamp}`,
    `  Captain hold origin: ${T.scout}`,
    `- [ ] ${ASK_TASKS.later} - Revisit the export colours (repo: alpha) (kind: captain) (hold: ${enc("Pick the colours when the design lands")}) (hold-kind: captain) (hold-until: ${day(10)})`,
    "",
    "## Done",
  ].join("\n"));
  fs.writeFileSync(backlog, text);
  fs.appendFileSync(path.join(home, "state", `${T.ship}.meta`), "model=claude-opus-5-5\neffort=high\naccount=claude-2\n");
  fs.appendFileSync(path.join(home, "data", T.ship, "brief.md"), `\njoyride-request: ${REQUEST_ID}\n`);
  // A later working line must not read as an answer: only resolved [key=flake-cause] closes it.
  fs.appendFileSync(path.join(home, "state", `${T.scout}.status`), `working [at=${Math.floor(Date.now() / 1000) - 300}]: reading CI logs while Firstmate decides\n`);
}
