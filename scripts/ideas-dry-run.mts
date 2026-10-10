// Idea housekeeping against a COPY of a Joyride data root, with the real models: a check that the
// prompts, the account and the guardrails work on real data before the daemon runs them for good.
// It never starts a server, Herdr or background loops, and refuses to run against the live store.
//   JOYRIDE_HOME=<copy> JOYRIDE_RUNTIME=<copy>/.joyride FM_HOME=<copy of FM_HOME> \
//     npx tsx scripts/ideas-dry-run.mts naming [task-id] | place | tidy
//   naming  one idea_naming call for a task (the first one without an idea, unless named)
//   place   a dry-run placement of every task without an idea (the backfill), Jev then idea_naming
//   tidy    a dry-run tidy pass (idea_tidy)
// Prints JSON: the model and account each task ran on, and every proposed or rejected change.
import fs from "node:fs";
import path from "node:path";

process.env.JOYRIDE_HOUSEKEEPING = "0";
const { paths, CODE_ROOT } = await import("../src/shared/paths.ts");
const live = path.resolve(CODE_ROOT);
if (!process.env.JOYRIDE_HOME || path.resolve(paths.root) === live || !process.env.FM_HOME || !process.env.JOYRIDE_RUNTIME) {
  console.error("Run this against a copy: set JOYRIDE_HOME, JOYRIDE_RUNTIME and FM_HOME to copied folders (never the live data root).");
  process.exit(2);
}
if (process.env.JOYRIDE_FAKE_MODELS === "1") console.error("note: JOYRIDE_FAKE_MODELS=1, so the models are fakes");

const [mode = "tidy", arg] = process.argv.slice(2);
const { createDaemon } = await import("../src/server/app.ts");
const { llm } = await import("../src/core/llm.ts");
const { loadConfig } = await import("../src/core/config.ts");
const { NAMING_SCHEMA, namingPrompt } = await import("../src/modules/ideas/prompts.ts");
const { briefExcerpt } = await import("../src/modules/ideas/plan.ts");

const d = await createDaemon({ only: ["sessions", "missions", "memory", "notes", "firstmate", "ideas"], quiet: true });
const svc = (n: string) => d.ctx.service<any>(n);
await svc("missions").settled();
const cfg = loadConfig();
const used = (task: string) => cfg.llm.tasks[task] ?? cfg.llm.default;
const out: Record<string, unknown> = { mode, data_root: paths.root, fm_home: paths.firstmateHome };

if (mode === "naming") {
  const tasks = svc("firstmate").tasks();
  const t = arg ? tasks.find((x: any) => x.id === arg) : tasks.find((x: any) => !x.mission) ?? tasks[0];
  if (!t) { console.error("No Firstmate tasks in this copy."); process.exit(1); }
  const ideas = svc("missions").list({}).filter((m: any) => !m.archive && m.state === "open").slice(0, 12)
    .map((m: any) => ({ id: m.id, title: m.title, goal: String(m.goal).replace(/\s+/g, " ").slice(0, 240), tasks: [] }));
  const groups = svc("lenses").list().map((l: any) => ({ id: l.id, title: l.title }));
  const brief = t.brief && fs.existsSync(t.brief) ? briefExcerpt(fs.readFileSync(t.brief, "utf8")) : "";
  const t0 = Date.now();
  const r = await llm(namingPrompt({ task: { id: t.id, title: t.title, kind: t.kind, repo: t.repo, brief, last_event: String(t.last_event).slice(0, 200) }, ideas, groups }), { task: "idea_naming", schema: NAMING_SCHEMA, timeoutMs: 240000 });
  Object.assign(out, { llm: used("idea_naming"), task: { id: t.id, title: t.title }, candidates: ideas.map((i: any) => i.id), result: r, ms: Date.now() - t0 });
} else if (mode === "place") {
  Object.assign(out, { llm: used("idea_naming"), run: await svc("ideas").place({ dryRun: true, trigger: "backfill" }) });
} else if (mode === "tidy") {
  Object.assign(out, { llm: used("idea_tidy"), run: await svc("ideas").tidy({ dryRun: true, trigger: "manual" }) });
} else {
  console.error(`Unknown mode ${mode}. Use naming, place or tidy.`);
  process.exit(2);
}
console.log(JSON.stringify(out, null, 2));
process.exit(0);
