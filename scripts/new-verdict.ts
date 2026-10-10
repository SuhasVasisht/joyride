// Judge the actual final evidence through an isolated daemon's owner API.
import fs from "node:fs";
import path from "node:path";
import { buildSandbox } from "../tests/sandbox.ts";

const required = ["New final unit suite", "New final typecheck", "New final build", "New final affected browser suite", "New final review artifact proof", "New final feedback rendering proof", "New final real Jev phrase evaluation", "New real Haiku folder-scoped result"];
const evidence = new Map<string, Record<string, unknown>>();
const sources = new Map<string, string>();
const eventDirs = [...new Set([path.resolve(".joyride/events"), process.env.NEW_EVIDENCE_DIR].filter((p): p is string => Boolean(p)))];
for (const dir of eventDirs) for (const name of fs.readdirSync(dir).sort()) {
  if (!name.endsWith(".jsonl")) continue;
  for (const line of fs.readFileSync(path.join(dir, name), "utf8").split("\n")) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    const item = event.data?.item;
    if (event.type === "evidence.added" && item?.mode === "attested" && item.cwd === process.cwd() && item.mission === "build-joyride" && required.includes(item.name)
      && String(item.created) > String(evidence.get(item.name)?.created ?? "")) {
      evidence.set(item.name, item); sources.set(item.name, path.dirname(dir));
    }
  }
}
for (const name of required) if (evidence.get(name)?.exit_code !== 0) throw new Error(`Missing successful attested check: ${name}`);
const envFile = process.env.NEW_JEV_ENV_FILE;
if (envFile && !process.env.JEV_API_KEY) {
  const m = /^\s*JEV_API_KEY\s*=\s*(.*)\s*$/m.exec(fs.readFileSync(envFile, "utf8"));
  if (m) process.env.JEV_API_KEY = m[1].replace(/^['"]|['"]$/g, "");
}
if (!process.env.JEV_API_KEY) throw new Error("A real Jev key is required.");
const sb = buildSandbox(path.resolve(".joyride/new-verdict-sandbox"), { port: 4326 });
const blobs = path.join(sb.env.JOYRIDE_RUNTIME, "blobs");
fs.mkdirSync(blobs, { recursive: true });
for (const [name, item] of evidence) {
  const shots = Array.isArray(item.screenshots) ? item.screenshots : [];
  const hashes = [item.log_blob, ...shots.map((s) => s.blob)].filter((h): h is string => typeof h === "string" && /^[a-f0-9]{64}$/.test(h));
  for (const hash of hashes) fs.copyFileSync(path.join(sources.get(name)!, "blobs", hash), path.join(blobs, hash));
}
Object.assign(process.env, sb.env, { JOYRIDE_FAKE_MODELS: "0" });
const { createDaemon } = await import("../src/server/app.ts");
const d = await createDaemon({ only: ["evidence"], quiet: true });
try {
  for (const item of evidence.values()) {
    const r = await d.app.request("/api/evidence", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(item) });
    if (!r.ok) throw new Error(await r.text());
  }
  const criteria = [
    { id: "new-unit", kind: "test", text: "New final unit suite, typecheck and build pass after integrating ExpandedArtifact and rebasing onto local main. The labelled New corpus asserts routes and parsed parameters for at least 150 phrases." },
    { id: "new-browser", kind: "e2e", text: "New final affected browser suite passes with no placement or type picker, deterministic owner routes, visible agent outcomes, Undo, distinct animation feedback, reduced motion and a registerable report." },
    { id: "new-routing", kind: "other", text: "New final real Jev phrase evaluation reports per-route precision and recall for the current labelled corpus without unavailable calls." },
    { id: "new-real", kind: "e2e", text: "New real Haiku folder-scoped result runs an actual agent in a named private Herdr lab; the agent finds an artifact, records its link on the canvas, completes its callback and the browser verifies Undo." },
  ];
  const r = await d.app.request("/api/evidence/verdict/build-joyride", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ done_when: criteria, evidence: [...evidence.values()].map((e) => e.id) }) });
  const verdict = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(verdict));
  fs.writeFileSync("docs/reports/new-freeform-verdict.json", JSON.stringify(verdict, null, 2) + "\n");
  console.log(JSON.stringify(verdict, null, 2));
  if (verdict.verdict !== "pass") process.exitCode = 1;
} finally { await d.stop(); d.ctx.db.close(); }
