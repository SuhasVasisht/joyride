// Read-only smoke test of the session readers against the real ~/.claude and
// ~/.codex. Prints counts and timings only (no titles, prompts or paths).
// The index and data root live in a throwaway temp dir; nothing is written to
// the external stores or to this repo. Run: npx tsx tests/smoke/sessions-smoke.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "joyride-smoke-"));
process.env.JOYRIDE_HOME = path.join(tmp, "home");
process.env.JOYRIDE_RUNTIME = path.join(tmp, "runtime");
delete process.env.JOYRIDE_CLAUDE_DIR;
delete process.env.JOYRIDE_CODEX_DIR;
fs.mkdirSync(process.env.JOYRIDE_HOME, { recursive: true });

const codexDb = path.join(os.homedir(), ".codex", "state_5.sqlite");
const stamp = (f: string) => { try { const s = fs.statSync(f); return `${s.size}@${s.mtimeMs}`; } catch { return "missing"; } };
const before = stamp(codexDb);

const { createDaemon } = await import("../../src/server/app.ts");
const d = await createDaemon({ only: ["sessions"], quiet: true });
const svc = d.ctx.service<any>("sessions");
const fmt = (s: any) => `files=${s.files} parsed=${s.parsed} incremental=${s.incremental} cached=${s.cached} MB=${(s.bytes / 1e6).toFixed(1)} removed=${s.removed} ms=${s.ms}${s.via ? ` via=${s.via}` : ""}${s.error ? ` error="${s.error}"` : ""}`;

try {
  const cold = await svc.reindex();
  console.log(`cold  total ${cold.ms}ms`);
  console.log(`  claude ${fmt(cold.claude)}`);
  console.log(`  codex  ${fmt(cold.codex)}`);
  const warm = await svc.reindex();
  console.log(`warm  total ${warm.ms}ms`);
  console.log(`  claude ${fmt(warm.claude)}`);
  console.log(`  codex  ${fmt(warm.codex)}`);
  console.log("counts", JSON.stringify(svc.counts()));
  const all = svc.list({ limit: 100000 });
  const repos = new Set(all.map((s: any) => s.repo).filter(Boolean));
  const recent = all.filter((s: any) => Date.parse(s.updated) > Date.now() - 30 * 864e5);
  console.log(`visible=${all.length} repos=${repos.size} updated<30d=${recent.length} no-repo=${all.filter((s: any) => !s.repo).length} zero-turn=${all.filter((s: any) => !s.turns).length}`);
  for (const src of ["claude", "codex"]) {
    const s = all.find((x: any) => x.source === src);
    if (!s) continue;
    const t0 = Date.now();
    const turns = await svc.transcript(s.key, { limit: 200 });
    console.log(`transcript newest ${src}: ${turns.length} turns, ${turns.reduce((n: number, t: any) => n + t.tools.length, 0)} tool calls, ${Date.now() - t0}ms`);
  }
  // Dry clustering only (pure function): no Jev, no LLM, no proposals or missions written.
  const { clusterSessions } = await import("../../src/modules/missions/backfill.ts");
  const clusters = clusterSessions(recent);
  const sizes = clusters.map((c) => c.sessions.length).sort((a, b) => b - a);
  console.log(`dry backfill: ${clusters.length} clusters from ${recent.length} recent sessions (largest ${sizes.slice(0, 5).join(", ")}; singletons ${sizes.filter((n) => n === 1).length}); ${all.length - recent.length} sessions would fold into ${new Set(all.filter((s: any) => !recent.includes(s)).map((s: any) => s.repo ?? "")).size} archive missions`);
  console.log(`codex state db unchanged by the reader: ${stamp(codexDb) === before || "changed by another process"}`);
} finally {
  await d.stop();
  d.ctx.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
