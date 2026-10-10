import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { sandboxDaemon } from "../sandbox.ts";

const DELTA = "/tmp/joyride-fixture-repos/delta";
const ago = (min: number) => new Date(Date.now() - min * 60e3).toISOString();
const uuid = (n: number) => `d${String(n).padStart(7, "0")}-dddd-4ddd-8ddd-dddddddddddd`;

/** Claude Code transcript lines for a session. */
function claude(id: string, branch: string, cwd = DELTA) {
  const lines: string[] = [];
  let n = 0;
  const base = (o: object) => JSON.stringify({ sessionId: id, cwd, gitBranch: branch, isSidechain: false, uuid: `${id}-${n++}`, ...o });
  const api = {
    user: (text: string, min: number, extra: object = {}) => { lines.push(base({ type: "user", timestamp: ago(min), origin: { kind: "human" }, message: { role: "user", content: text }, ...extra })); return api; },
    say: (text: string, min: number) => { lines.push(base({ type: "assistant", timestamp: ago(min), message: { id: `m${n}`, role: "assistant", model: "claude-x", content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 10 } } })); return api; },
    tool: (tid: string, name: string, input: object, min: number) => { lines.push(base({ type: "assistant", timestamp: ago(min), message: { id: `m${n}`, role: "assistant", model: "claude-x", content: [{ type: "tool_use", id: tid, name, input }], usage: { input_tokens: 10, output_tokens: 10 } } })); return api; },
    result: (tid: string, text: string, min: number) => { lines.push(base({ type: "user", timestamp: ago(min), message: { role: "user", content: [{ type: "tool_result", tool_use_id: tid, content: text }] }, toolUseResult: { stdout: text } })); return api; },
    raw: (o: object) => { lines.push(base(o)); return api; },
    text: () => lines.join("\n") + "\n",
  };
  return api;
}

let d: Awaited<ReturnType<typeof sandboxDaemon>>;
let missions: any, sessions: any;
const projDir = (cwd = DELTA) => path.join(d.sb.env.JOYRIDE_CLAUDE_DIR, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
const write = (id: string, text: string, cwd = DELTA) => { fs.mkdirSync(projDir(cwd), { recursive: true }); fs.writeFileSync(path.join(projDir(cwd), `${id}.jsonl`), text); };
const keysOf = (p: any) => p.sessions.map((r: any) => `${r.source}:${r.id}`).sort();
const proposalWith = (id: string) => missions.proposals().find((p: any) => keysOf(p).includes(`claude:${id}`));
const S = { export1: uuid(1), export2: uuid(2), smoke: uuid(3), quick: uuid(4), solo: uuid(5) };
const BATCH = [6, 7, 8, 9, 10].map(uuid);

beforeAll(async () => {
  fs.mkdirSync(DELTA, { recursive: true });
  if (!fs.existsSync(path.join(DELTA, ".git"))) execFileSync("git", ["init", "-q", DELTA]);
  d = await sandboxDaemon("missions-context", ["sessions", "missions"]);
  missions = d.ctx.service("missions");
  sessions = d.ctx.service("sessions");
  await d.start();
  await missions.settled();
  await missions.briefsIdle();

  // Two sessions of real work on main: edits, a verified commit, an interrupted heredoc commit, a subagent that commits.
  write(S.export1, claude(S.export1, "main")
    .user("Add a CSV export to the report page", 300)
    .say("Looking at the report page.", 299)
    .tool("tu_e1", "Edit", { file_path: `${DELTA}/src/export.ts`, old_string: "a", new_string: "b" }, 298)
    .tool("tu_w1", "Write", { file_path: `${DELTA}/src/export.test.ts`, content: "test" }, 297)
    .tool("tu_c1", "Bash", { command: 'git add -A && git commit -m "feat: csv export"' }, 296)
    .result("tu_c1", "[main 1a2b3c4] feat: csv export\n 2 files changed, 40 insertions(+)", 296)
    .user("Also add a totals row", 290)
    .raw({ type: "user", timestamp: ago(289), isCompactSummary: true, message: { role: "user", content: "This session is being continued from a previous conversation that ran out of context." } })
    .tool("tu_m1", "MultiEdit", { file_path: `${DELTA}/src/export.ts`, edits: [] }, 288)
    .tool("tu_c2", "Bash", { command: "git commit -m \"$(cat <<'EOF'\nfeat: totals row\n\nAdds a totals row.\nEOF\n)\"" }, 287)
    .tool("tu_q1", "Bash", { command: 'npm test && git commit -qm "chore: quiet one"' }, 285)
    .result("tu_q1", "14 passing", 285)
    .tool("tu_f1", "Bash", { command: 'git commit -m "wip: nothing"' }, 284)
    .result("tu_f1", "On branch main\nnothing to commit, working tree clean", 284)
    .tool("tu_x1", "Write", { file_path: "/private/tmp/claude-1/proj/session/scratchpad/notes.md", content: "x" }, 283)
    .tool("tu_t1", "Bash", { command: "T=/tmp/jr-$$; mkdir -p $T && cd $T && git init -q && git commit -qm scratch --allow-empty" }, 282)
    .result("tu_t1", "", 282)
    .tool("tu_t2", "Bash", { command: "git -C $HOME/other commit -qm elsewhere" }, 281)
    .result("tu_t2", "", 281)
    .say("Done: the export has a totals row and its tests pass.", 286)
    .text());
  const sub = path.join(projDir(), S.export1, "subagents");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, "agent-1.jsonl"), claude(S.export1, "main")
    .raw({ type: "user", isSidechain: true, timestamp: ago(295), message: { role: "user", content: "Write the export guide" } })
    .raw({ type: "assistant", isSidechain: true, timestamp: ago(294), message: { id: "s1", role: "assistant", content: [{ type: "tool_use", id: "tu_s1", name: "Write", input: { file_path: `${DELTA}/docs/EXPORT.md`, content: "x" } }] } })
    .raw({ type: "assistant", isSidechain: true, timestamp: ago(293), message: { id: "s2", role: "assistant", content: [{ type: "tool_use", id: "tu_s2", name: "Bash", input: { command: "git -C /tmp/joyride-fixture-repos/delta commit -am 'docs: export guide'" } }] } })
    .raw({ type: "user", isSidechain: true, timestamp: ago(293), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_s2", content: "[main 9f8e7d6] docs: export guide\n 1 file changed" }] }, toolUseResult: { stdout: "" } })
    .text());
  write(S.export2, claude(S.export2, "main").user("Wire the export button into the toolbar", 200).tool("tu_t1", "Edit", { file_path: `${DELTA}/src/toolbar.tsx` }, 199).say("The button is in the toolbar.", 180).text());
  // Noise: a smoke test, and one quick question with no edits.
  write(S.smoke, claude(S.smoke, "smoke").user("reply with the word ok", 100).say("ok", 100).text());
  write(S.quick, claude(S.quick, "question").user("is this the right branch?", 90).say("Yes, you're on question.", 89).text());
  // Not noise: one prompt, but two hours of work with edits.
  write(S.solo, claude(S.solo, "solo").user("Port the importer to the new API and keep the tests green", 400).tool("tu_p1", "Edit", { file_path: `${DELTA}/src/importer.ts` }, 350).say("Ported; 14 tests pass.", 280).text());
  BATCH.forEach((id, i) => write(id, claude(id, `feature/b${i}`).user(`Feature ${i}: build the thing`, 60 - i).user("Next step", 50 - i).user("Finish it", 40 - i).say(`Feature ${i} works.`, 30 - i).text()));
  await sessions.reindex();
  await missions.runBackfill();
});
afterAll(async () => { await d?.stop(); });

describe("session digests", () => {
  it("reads prompts, final message, edits and commits from a Claude transcript and its subagents", async () => {
    const { digestTranscript, subagentFilesOf } = await import("../../src/modules/missions/context.ts");
    const file = path.join(projDir(), `${S.export1}.jsonl`);
    const dg = await digestTranscript("claude", file, subagentFilesOf(file, S.export1), DELTA);
    expect(dg.prompt_count).toBe(2); // the compact summary is not a prompt
    expect(dg.first_prompt).toBe("Add a CSV export to the report page");
    expect(dg.last_prompts).toEqual(["Add a CSV export to the report page", "Also add a totals row"]);
    expect(dg.final_message).toBe("Done: the export has a totals row and its tests pass.");
    expect(dg.files).toEqual({ [`${DELTA}/src/export.ts`]: 2, [`${DELTA}/src/export.test.ts`]: 1, [`${DELTA}/docs/EXPORT.md`]: 1 });
    expect(dg.commits).toEqual([
      { sha: "1a2b3c4", branch: "main", subject: "feat: csv export" },
      { sha: null, branch: null, subject: "chore: quiet one" }, // -q prints no hash; the command succeeded
      { sha: null, branch: null, subject: "feat: totals row" }, // no result arrived: message only
      { sha: "9f8e7d6", branch: "main", subject: "docs: export guide" },
    ]); // "wip: nothing" failed (nothing to commit); the scratchpad file is not counted
  });

  it("reads a Codex rollout: one record family for prompts, patches and FileChange merged, commits from outputs", async () => {
    const { digestTranscript } = await import("../../src/modules/missions/context.ts");
    const ev = (payload: object) => JSON.stringify({ timestamp: ago(10), type: "event_msg", payload });
    const ri = (payload: object) => JSON.stringify({ timestamp: ago(10), type: "response_item", payload });
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jr-codex-")), "rollout.jsonl");
    fs.writeFileSync(file, [
      ri({ type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>x</environment_context>" }] }),
      ri({ type: "message", role: "user", content: [{ type: "input_text", text: "Make the sync job idempotent" }] }),
      ev({ type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: "Make the sync job idempotent" }] } }),
      ri({ type: "custom_tool_call", name: "apply_patch", call_id: "c1", input: "*** Begin Patch\n*** Update File: /r/beta/sync.py\n@@\n-a\n+b\n*** End Patch" }),
      ev({ type: "item_completed", item: { type: "FileChange", changes: { "/r/beta/sync.py": { type: "update" } } } }),
      ri({ type: "custom_tool_call", name: "exec", call_id: "c2", input: 'const patch = "*** Begin Patch\\n*** Add File: /r/beta/tests/test_sync.py\\n+x\\n*** End Patch"; await tools.apply_patch(patch);' }),
      ev({ type: "item_completed", item: { type: "CommandExecution", command: ["/bin/zsh", "-lc", 'git commit -m "fix: idempotent sync"'], aggregated_output: "[master 0a1b2c3] fix: idempotent sync\n 1 file changed" } }),
      ri({ type: "custom_tool_call", name: "exec", call_id: "c3", input: 'const r = await tools.exec_command({"cmd":"git commit -m \\"test: retry\\""});' }),
      ri({ type: "custom_tool_call_output", call_id: "c3", output: [{ type: "input_text", text: "Output:\n[master 4d5e6f7] test: retry\n" }] }),
      ri({ type: "function_call", name: "exec_command", call_id: "c4", arguments: JSON.stringify({ cmd: "git commit -m 'chore: tidy'" }) }),
      ev({ type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: "Now add a retry test" }] } }),
      ev({ type: "item_completed", item: { type: "AgentMessage", content: [{ type: "text", text: "The sync is idempotent and retried batches are safe." }] } }),
    ].join("\n") + "\n");
    const dg = await digestTranscript("codex", file);
    expect(dg.prompt_count).toBe(2);
    expect(dg.first_prompt).toBe("Make the sync job idempotent");
    expect(dg.final_message).toBe("The sync is idempotent and retried batches are safe.");
    expect(dg.files).toEqual({ "/r/beta/sync.py": 1, "/r/beta/tests/test_sync.py": 1 });
    expect(dg.commits.map((c: any) => [c.sha, c.subject])).toEqual([["0a1b2c3", "fix: idempotent sync"], ["4d5e6f7", "test: retry"], [null, "chore: tidy"]]);
  });

  it("parses commit messages and hook events", async () => {
    const { commitMessageOf, mergeHookEvents, emptyDigest } = await import("../../src/modules/missions/context.ts");
    expect(commitMessageOf('git commit -m "feat: a \\"quoted\\" thing"')).toBe('feat: a "quoted" thing');
    expect(commitMessageOf("git commit -am 'fix: b'")).toBe("fix: b");
    expect(commitMessageOf("git commit --message=wip")).toBe("wip");
    expect(commitMessageOf("git commit -m \"$(cat <<'EOF'\nfeat: c\n\nbody\nEOF\n)\"")).toBe("feat: c");
    expect(commitMessageOf("git commit")).toBeNull();
    // only a git commit the shell would run counts, and -m belongs to it
    const { commitCommandAt } = await import("../../src/modules/missions/context.ts");
    expect(commitCommandAt(`cat >> t.test.ts <<'EOF'\n  it.each(["git status", "git commit -m 'push the button'"])\nEOF`)).toBeNull();
    expect(commitCommandAt('echo "remember to git commit"')).toBeNull();
    expect(commitCommandAt(`python3 - <<'EOF'\nrun('npm test && git commit -qm "chore: in a script"')\nEOF\necho done`)).toBeNull();
    expect(commitMessageOf(`cat > a.txt <<EOF\ngit commit -m "not this"\nEOF\ngit commit -m "this one"`)).toBe("this one");
    expect(commitMessageOf('python -m pytest -q && git add -A && git commit -qm "feat: after tests"')).toBe("feat: after tests");
    expect(commitMessageOf('cd repo; GIT_AUTHOR_NAME=x git -C /r commit -m "fix: env prefix"')).toBe("fix: env prefix");
    const { commitElsewhere } = await import("../../src/modules/missions/context.ts");
    expect(commitElsewhere("cd /r/app && git commit -m a", "/r/app")).toBe(false);
    expect(commitElsewhere("git -C /r/app/sub commit -m a", "/r/app")).toBe(false);
    expect(commitElsewhere("git add -A && git commit -qm a", "/r/app")).toBe(false);
    expect(commitElsewhere("cd /tmp/x && git commit -m a", "/r/app")).toBe(true);
    expect(commitElsewhere("(cd $T/home && git commit -qm x --allow-empty)", "/r/app")).toBe(true);
    expect(commitElsewhere("mkdir gt && cd gt && git init -q && git commit -qm one", "/r/app")).toBe(true);
    expect(commitElsewhere("git -C /r/other commit -m a", "/r/app")).toBe(true);
    const dg = mergeHookEvents(emptyDigest(), [
      { tool: "Edit", input: JSON.stringify({ file_path: "/r/a.ts", old_string: "x".repeat(500) }).slice(0, 400) + "…" },
      { tool: "Write", input: '{"file_path":"/r/b.ts","content":"' },
      { tool: "Bash", input: JSON.stringify({ command: 'git commit -m "feat: from hooks"' }) },
      { tool: "Bash", input: JSON.stringify({ command: `git add -A && git commit -qm "chore: a long message that the hook clipped\n\n${"x".repeat(400)}"` }).slice(0, 120) + "…" },
      { tool: "Write", input: JSON.stringify({ file_path: `${os.homedir()}/.claude/projects/x/memory/MEMORY.md` }) },
      { tool: "Bash", input: JSON.stringify({ command: "git status" }) },
    ]);
    expect(dg.files).toEqual({ "/r/a.ts": 1, "/r/b.ts": 1 });
    expect(dg.commits).toEqual([{ sha: null, branch: null, subject: "feat: from hooks" }, { sha: null, branch: null, subject: "chore: a long message that the hook clipped" }]);
  });
});

describe("noise rules", () => {
  it("recognizes smoke-test prompts and nothing more", async () => {
    const { isSmokePrompt } = await import("../../src/modules/missions/context.ts");
    for (const t of ["reply with the word ok", "Reply with just OK.", "say hi", "Say hello to me", "respond with \"pong\"", "ping", "hello", "smoke test", "This is a smoke test of the hook", "are you there?"]) expect(isSmokePrompt(t), t).toBe(true);
    for (const t of ["ok so now add the totals row", "Say what the sync job does", "is this the right branch?", "test the export with 10k rows and fix what breaks", "", "hello, can you set this repo up locally and run the tests for me please"]) expect(isSmokePrompt(t), t).toBe(false);
  });

  it("flags smoke tests and one quick exchange, keeps long single-prompt work", async () => {
    const { noiseOf, emptyDigest } = await import("../../src/modules/missions/context.ts");
    const item = (o: object) => ({ key: "claude:x", source: "claude", id: "x", title: "t", cwd: "/r", repo: "/r", branch: "main", first_prompt: "", started: ago(10), updated: ago(8), turns: 1, tokens: 0, model: null, transcript: "", mission: null, archived: false, subagents: 0, ...o }) as any;
    const dg = (o: object = {}) => ({ ...emptyDigest(), ...o });
    expect(noiseOf([{ item: item({ first_prompt: "reply with the word ok" }), digest: dg({ first_prompt: "reply with the word ok", last_prompts: ["reply with the word ok"], prompt_count: 1 }) }]))
      .toEqual({ noise: true, reason: "Smoke test: “reply with the word ok”" });
    expect(noiseOf([{ item: item({ first_prompt: "what branch is this?" }), digest: dg({ first_prompt: "what branch is this?", prompt_count: 1 }) }]))
      .toEqual({ noise: true, reason: "One quick exchange: 1 prompt over 2 minutes, no files changed" });
    // the same exchange with an edit, a commit, or a long run is real work
    expect(noiseOf([{ item: item({ first_prompt: "fix it" }), digest: dg({ first_prompt: "fix it", files: { "/r/a.ts": 1 } }) }]).noise).toBe(false);
    expect(noiseOf([{ item: item({ first_prompt: "fix it" }), digest: dg({ first_prompt: "fix it", commits: [{ sha: "abc1234", subject: "fix", branch: "main" }] }) }]).noise).toBe(false);
    expect(noiseOf([{ item: item({ first_prompt: "do the ops review", started: ago(120) }), digest: dg({ first_prompt: "do the ops review" }) }]).noise).toBe(false);
    expect(noiseOf([{ item: item({ first_prompt: "a", turns: 5 }), digest: dg({ first_prompt: "a", prompt_count: 5 }) }]).noise).toBe(false);
    // several sessions are never "one quick exchange"
    expect(noiseOf([{ item: item({ first_prompt: "q1" }), digest: dg({ first_prompt: "q1" }) }, { item: item({ first_prompt: "q2" }), digest: dg({ first_prompt: "q2" }) }]).noise).toBe(false);
  });
});

describe("proposal context", () => {
  it("briefs every pending non-noise proposal in batches of four", async () => {
    const before = (await missions.proposalSummary()).stats;
    const fresh = [proposalWith(S.export1), proposalWith(S.solo), ...BATCH.map(proposalWith)];
    expect(new Set(fresh.map((p) => p.id)).size).toBe(7);
    const batch = await missions.runBriefs();
    expect(batch).toMatchObject({ running: false, total: 7, done: 7, calls: 2, failed: 0 });
    const after = (await missions.proposalSummary()).stats;
    expect(after.calls - before.calls).toBe(2);
    expect(after.proposals - before.proposals).toBe(7);
    // nothing left to do: a second run makes no calls
    await missions.runBriefs();
    expect((await missions.proposalSummary()).stats.calls).toBe(after.calls);
  });

  it("assembles sessions, files, commits, artifacts, live state, why grouped and the brief", async () => {
    const p = proposalWith(S.export1);
    expect(keysOf(p)).toEqual([`claude:${S.export1}`, `claude:${S.export2}`]);
    d.ctx.services.set("workers", { forSession: (k: string) => (k === `claude:${S.export2}` ? { status: "working" } : null) });
    d.ctx.services.set("artifacts", { list: ({ session }: any) => (session === `claude:${S.export1}` ? [{ id: "a1", title: "Export design", url: "https://claude.ai/artifact/x", kind: "claude-artifact", session }] : []) });
    try {
      const r = await d.req("GET", `/api/missions/proposals/${p.id}/context`);
      expect(r.status).toBe(200);
      const c = r.body;
      expect(c.sessions.map((s: any) => s.key)).toEqual([`claude:${S.export1}`, `claude:${S.export2}`]);
      expect(c.sessions[0]).toMatchObject({ title: "Add a CSV export to the report page", first_prompt: "Add a CSV export to the report page", last_prompts: ["Also add a totals row"], final_message: "Done: the export has a totals row and its tests pass.", turns: 2, branch: "main", live: null, files: 3, commits: 4, missing: false });
      expect(c.sessions[1]).toMatchObject({ live: "working", files: 1, commits: 0 });
      expect(c.running).toBe(true);
      expect(c.files[0]).toEqual({ path: `${DELTA}/src/export.ts`, display: "src/export.ts", edits: 2, sessions: 1 });
      expect(c.files.map((f: any) => f.display).sort()).toEqual(["docs/EXPORT.md", "src/export.test.ts", "src/export.ts", "src/toolbar.tsx"]);
      expect(c.files_total).toBe(4);
      expect(c.commits.map((x: any) => x.subject)).toEqual(["docs: export guide", "feat: totals row", "chore: quiet one", "feat: csv export"]); // newest first
      expect(c.commits_total).toBe(4);
      expect(c.artifacts).toEqual([{ id: "a1", title: "Export design", url: "https://claude.ai/artifact/x", kind: "claude-artifact", session: `claude:${S.export1}` }]);
      expect(c.why[0]).toBe("Both sessions ran in delta, on branch main.");
      expect(c.why[1]).toMatch(/^Each one started within \d+ minutes of the one before it; backfill starts a new group after a 72-hour gap\.$/);
      expect(c).toMatchObject({ noise: false, noise_reason: "", brief_status: "ready" });
      expect(c.brief.outcome).toBe("shipped");
      expect(c.brief.worth_tracking).toBe(true);
      expect(c.brief.summary.split(" ").length).toBeLessThanOrEqual(61);
      expect((await d.req("GET", "/api/missions/proposals/mp-nope/context")).status).toBe(404);
    } finally { d.ctx.services.delete("workers"); d.ctx.services.delete("artifacts"); }
  });

  it("marks noise without a model and lists it in the summary", async () => {
    const calls = (await missions.proposalSummary()).stats.calls;
    const smoke = (await d.req("GET", `/api/missions/proposals/${proposalWith(S.smoke).id}/context`)).body;
    expect(smoke).toMatchObject({ noise: true, noise_reason: "Smoke test: “reply with the word ok”", brief: null, brief_status: "skipped" });
    expect(smoke.why[0]).toBe("One session in delta, on branch smoke.");
    const quick = (await d.req("GET", `/api/missions/proposals/${proposalWith(S.quick).id}/context`)).body;
    expect(quick.noise_reason).toMatch(/^One quick exchange: 1 prompt over \d+ (seconds|minutes), no files changed$/);
    const solo = (await d.req("GET", `/api/missions/proposals/${proposalWith(S.solo).id}/context`)).body;
    expect(solo.noise).toBe(false);
    const sum = (await d.req("GET", "/api/missions/proposals/summary")).body;
    expect(sum.stats.calls).toBe(calls);
    const byId = new Map(sum.items.map((i: any) => [i.id, i]));
    expect(sum.items.length).toBe(missions.proposals({ status: "pending" }).length);
    expect(byId.get(proposalWith(S.smoke).id)).toMatchObject({ noise: true, recommended: null, brief_status: "skipped" });
    expect(byId.get(proposalWith(S.export1).id)).toMatchObject({ noise: false, recommended: true, brief_status: "ready", files: 4, commits: 4 });
    expect(byId.get(proposalWith(BATCH[0]).id)).toMatchObject({ recommended: false, brief_status: "ready" });
  });

  it("caches the brief by session set and updated times, and refreshes a stale one when opened", async () => {
    const p = proposalWith(S.export1);
    const calls = () => missions.proposalSummary().then((s: any) => s.stats.calls);
    const c0 = await calls();
    await missions.proposalContext(p.id);
    await missions.proposalContext(p.id, { wait: true });
    expect(await calls()).toBe(c0); // cached
    const file = path.join(d.sb.env.JOYRIDE_RUNTIME, "proposals", "briefs", `${p.id}.json`);
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(stored).toMatchObject({ id: p.id, batch: expect.any(Number) });

    // The second session gets a new prompt: the cached brief is now stale.
    fs.appendFileSync(path.join(projDir(), `${S.export2}.jsonl`), claude(S.export2, "main").user("Make the button blue", 1).text());
    await sessions.reindex();
    const sum = (await missions.proposalSummary()).items.find((i: any) => i.id === p.id);
    expect(sum).toMatchObject({ brief_status: "stale", recommended: true });
    // The background batch leaves a recent stale brief alone; opening the proposal refreshes it.
    await missions.runBriefs();
    expect(await calls()).toBe(c0);
    const r = await missions.proposalContext(p.id, { wait: true });
    expect(r.brief_status).toBe("ready");
    expect(r.sessions[1].last_prompts).toEqual(["Make the button blue"]);
    expect(await calls()).toBe(c0 + 1);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).sig).not.toBe(stored.sig);
  });

  it("records a failed brief and does not retry it on every open", async () => {
    const { registerLlmFake } = await import("../../src/core/fakes.ts");
    const p = proposalWith(S.solo);
    fs.rmSync(path.join(d.sb.env.JOYRIDE_RUNTIME, "proposals", "briefs", `${p.id}.json`), { force: true });
    registerLlmFake("proposal_brief", () => { throw new Error("model unavailable"); });
    try {
      const r = await missions.proposalContext(p.id, { wait: true });
      expect(r.brief_status).toBe("failed");
      expect(r.brief_error).toMatch(/model unavailable/);
      const calls = (await missions.proposalSummary()).stats.calls;
      expect((await missions.proposalContext(p.id, { wait: true })).brief_status).toBe("failed");
      expect((await missions.proposalSummary()).stats.calls).toBe(calls);
    } finally {
      const { fakeProposalBrief } = await import("../../src/modules/missions/context.ts");
      registerLlmFake("proposal_brief", fakeProposalBrief);
    }
  });
});
