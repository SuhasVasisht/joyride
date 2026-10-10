// Evaluate the current Jev judges on their seed sets with the REAL Jev API.
//   npx tsx scripts/judge-baseline.mts [attention|evidence]
import { attentionTarget, evidenceTarget, evaluate } from "../src/modules/hillclimb/targets.ts";
const which = process.argv[2] ?? "attention";
const t = which === "evidence" ? evidenceTarget : attentionTarget;
const ds = t.dataset({ service() { throw new Error("no daemon"); } });
const t0 = Date.now();
const ev = await evaluate(t, t.current(), ds);
console.log(JSON.stringify({ target: t.id, n: ds.length, ms: Date.now() - t0, scores: ev.scores }, null, 1));
for (const p of ev.predictions.filter((p) => !p.ok)) console.log("MISS", p.id, JSON.stringify(p.expected), "->", JSON.stringify(p.predicted));
