// Writes config/judges/*.yaml from the built-in defaults (only if missing).
import YAML from "yaml";
import fs from "node:fs";
import { DEFAULT_ATTENTION_JUDGE } from "../src/modules/attention/classify.ts";
import { DEFAULT_EVIDENCE_JUDGE } from "../src/modules/evidence/verdict.ts";
const out: [string, string, unknown][] = [
  ["config/judges/attention.yaml", "# Jev attention judge. Tuned by the hill-climb engine (target judge:attention); every accepted change is a commit.\n", DEFAULT_ATTENTION_JUDGE],
  ["config/judges/evidence.yaml", "# Jev evidence judge. Tuned by the hill-climb engine (target judge:evidence); every accepted change is a commit.\n", DEFAULT_EVIDENCE_JUDGE],
];
for (const [f, header, v] of out) if (!fs.existsSync(f) || process.argv.includes("--force")) { fs.writeFileSync(f, header + YAML.stringify(v, { lineWidth: 0 })); console.log("wrote", f); }
