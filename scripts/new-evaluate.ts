import fs from "node:fs";
import path from "node:path";
// Read only Jev configuration from an explicitly supplied credentials file. Never print credentials.
const envFile = process.env.NEW_JEV_ENV_FILE;
if (envFile && !process.env.JEV_API_KEY) {
  const m = /^\s*JEV_API_KEY\s*=\s*(.*)\s*$/m.exec(fs.readFileSync(envFile, "utf8"));
  if (m) process.env.JEV_API_KEY = m[1].replace(/^['"]|['"]$/g, "");
}
if (!process.env.JEV_API_KEY) throw new Error("Real Jev evaluation requires JEV_API_KEY or NEW_JEV_ENV_FILE.");
process.env.JOYRIDE_FAKE_MODELS = "0";
const { classifyNew } = await import("../src/modules/new/classify.ts");
const { jev } = await import("../src/core/jev.ts");
const { newWorld, newContext } = await import("../tests/fixtures/new-world.ts");
const { ScreenContext } = await import("../src/shared/freeform.ts");
const corpus = JSON.parse(fs.readFileSync(new URL("../tests/fixtures/new-corpus.json", import.meta.url), "utf8")).slice(0, Number(process.env.NEW_JEV_LIMIT ?? 10000));
const rows: { id: string; text: string; expected: string; predicted: string; confidence: number | null; model: string; ms: number; rawRoute?: string; probabilities?: Record<string, number> }[] = [];
let next = 0;
async function worker() {
  while (next < corpus.length) {
    const row = corpus[next++], t = Date.now();
    let rawRoute: string | undefined, probabilities: Record<string, number> | undefined;
    const r = await classifyNew(row.text, ScreenContext.parse({ ...newContext, ...row.context }), newWorld, async (...args) => { const judgment = await jev(...args); rawRoute = judgment.answers.new_route?.choice; probabilities = judgment.answers.new_route?.probabilities; return judgment; });
    rows.push({ id: row.id, text: row.text, expected: row.expected.route, predicted: r.candidate.route, confidence: r.confidence, model: r.classifier, ms: Date.now() - t, rawRoute, probabilities });
    if (rows.length % 25 === 0) console.log(`Jev evaluated ${rows.length}/${corpus.length}`);
  }
}
await Promise.all([worker(), worker()]);
const routes = ["deterministic", "firstmate", "agent"];
const metrics = Object.fromEntries(routes.map((route) => {
  const tp = rows.filter((r) => r.expected === route && r.predicted === route).length;
  const fp = rows.filter((r) => r.expected !== route && r.predicted === route).length;
  const fn = rows.filter((r) => r.expected === route && r.predicted !== route).length;
  return [route, { tp, fp, fn, precision: tp + fp ? tp / (tp + fp) : null, recall: tp + fn ? tp / (tp + fn) : null }];
}));
const report = { at: new Date().toISOString(), dataset: "tests/fixtures/new-corpus.json", samples: rows.length, fake: false, metrics, rows: rows.sort((a,b) => a.id.localeCompare(b.id)) };
fs.mkdirSync("docs/reports", { recursive: true });
fs.writeFileSync(process.env.NEW_JEV_OUT ?? "docs/reports/new-freeform-jev.json", JSON.stringify(report, null, 2)+"\n");
console.log(JSON.stringify({ samples: rows.length, metrics, unavailable: rows.filter((r) => r.model === "unavailable").length }));
if (rows.some((r) => r.model === "unavailable")) process.exitCode = 1;
