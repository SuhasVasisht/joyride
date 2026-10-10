// A fixture FM_HOME holding three Firstmate investigation reports, shaped like
// the real home: a scout report with a captain decision still held, one whose
// decision was answered and is being applied, and an archived one with neither.
// Shared by tests/unit/artifacts-firstmate.test.ts and tests/e2e/artifacts-firstmate.spec.ts.
import fs from "node:fs";
import path from "node:path";

export const REPORT_TASKS = { cache: "alpha-cache-study", retry: "beta-retry-review", logs: "gamma-log-audit" } as const;
export const REPORT_MISSION = "alpha-cache"; // carried by the cache study's brief marker

const hold = (text: string) => `fm-hold-v1:${Buffer.from(text, "utf8").toString("base64")}`;
const write = (f: string, text: string) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };

export const CACHE_REPORT = `# Alpha API cache backend: Redis or in-process LRU

Scout task \`alpha-cache-study\`, 2026-10-03. Read-only.

## Findings

The alpha API spends 62 percent of request time re-reading tenant settings that change at most once a day.
A shared cache removes that cost for every replica; an in-process LRU only helps the replica that warmed it.

| Option | p95 after | Ops cost |
| --- | --- | --- |
| Redis | 110 ms | one more service |
| In-process LRU | 240 ms | none |

Decision: cache tenant settings for 15 minutes. Settings change at most daily and the cache removes most of the read cost.

Learning: tenant settings reads dominate alpha latency. Profile the settings path before tuning queries.

## Open questions

- Open question: should the cache be Redis or the in-process LRU?
`;

export const RETRY_REPORT = `# Beta sync client retries: what happens on a 429

Scout task \`beta-retry-review\`, 2026-10-02. Read-only.

The beta sync client retries a 429 immediately and forever, so one throttled tenant can hold a worker for hours.

Decision: retry with exponential backoff capped at 30 seconds. The provider's limits reset within a minute.

Learning: immediate retries on 429 amplify throttling. Always honour Retry-After before falling back to backoff.
`;

export const LOGS_REPORT = `# Gamma service logging audit

Scout task \`gamma-log-audit\`, 2026-10-01.

The gamma service logs full request bodies at info level, which puts customer addresses in the log store.

Learning: request bodies in info logs leak personal data. Log body sizes and hashes instead of bodies.
`;

/** Write the fixture into `home` (an FM_HOME). Overwrites the backlog files. */
export function buildReportsHome(home: string) {
  const t = REPORT_TASKS;
  const data = path.join(home, "data");
  write(path.join(data, "backlog.md"), [
    "## In flight",
    `- [ ] alpha-cache-pick - Pick a cache backend for the alpha API (repo: alpha) (kind: captain) (hold: ${hold(`Pick a cache backend from data/${t.cache}/report.md. Options: (a) Redis; (b) in-process LRU.`)}) (hold-kind: captain)`,
    `  Captain hold origin: ${t.cache}`,
    `- [ ] beta-retry-tune - Beta: apply the retry policy from data/${t.retry}/report.md (repo: beta) (kind: ship) (since 2026-10-04)`,
    "  Mode local-only.",
    "## Queued",
    "## Done",
    `- [x] ${t.cache} - Scout: which cache backend the alpha API should use data/${t.cache}/report.md (repo: alpha) (kind: scout) (reported 2026-10-03)`,
    `- [x] ${t.retry} - Scout: how the beta sync client retries data/${t.retry}/report.md (repo: beta) (kind: scout) (reported 2026-10-02)`,
    `- [x] beta-retry-pick - Pick a retry policy for the beta sync client (repo: beta) (kind: captain) (done 2026-10-03) (hold: ${hold(`Pick a retry policy from data/${t.retry}/report.md.`)}) (hold-kind: captain)`,
    "  Resolution mode: answered",
    "",
    "  Captain decision:",
    "  go with exponential backoff capped at 30 seconds",
    "",
    `  Origin: ${t.retry}`,
    "",
  ].join("\n"));
  write(path.join(data, "done-archive.md"), [
    "## Archived 2026-10-01",
    `- [x] ${t.logs} - Scout: what the gamma service logs data/${t.logs}/report.md (repo: gamma) (kind: scout) (reported 2026-10-01)`,
    "",
  ].join("\n"));
  write(path.join(data, t.cache, "brief.md"), `# Cache study\n\njoyride-mission: ${REPORT_MISSION}\n\nCompare cache backends for the alpha API.\n`);
  write(path.join(data, t.cache, "report.md"), CACHE_REPORT);
  write(path.join(data, t.retry, "report.md"), RETRY_REPORT);
  write(path.join(data, t.logs, "report.md"), LOGS_REPORT);
  fs.mkdirSync(path.join(home, "state"), { recursive: true });
}
