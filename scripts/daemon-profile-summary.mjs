import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2];
if (!dir) throw new Error("Pass the profiles directory printed by bench-daemon.ts.");
for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".cpuprofile"))) {
  const profile = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
  const totals = new Map();
  for (const [i, id] of profile.samples.entries()) totals.set(id, (totals.get(id) ?? 0) + profile.timeDeltas[i]);
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  const rows = [...totals].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([id, us]) => ({ ms: Math.round(us / 100) / 10, ...nodes.get(id).callFrame }));
  console.log(JSON.stringify({ file, samples: profile.samples.length, top_self_time: rows }, null, 2));
}
