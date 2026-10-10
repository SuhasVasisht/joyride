// Firstmate reports as artifacts: the read-only report reader (titles,
// projects, held captain decisions, follow-ups), registration with mission
// links, re-registration that updates instead of duplicating, automatic
// snapshot updates and the watcher. FM_HOME is never written.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { sandboxDaemon } from "../sandbox.ts";
import { buildReportsHome, CACHE_REPORT, REPORT_MISSION, REPORT_TASKS as T } from "../e2e/reports-fixture.ts";
import type { ArtifactsService } from "../../src/modules/artifacts/index.ts";
import { decodeHold, readFirstmateReports, reportStatus, readBacklogRows } from "../../src/modules/artifacts/firstmate.ts";

process.env.JOYRIDE_FIRSTMATE_POLL_MS = "50";
process.env.JOYRIDE_FIRSTMATE_DEBOUNCE_MS = "300";

let d: Awaited<ReturnType<typeof sandboxDaemon>>;
let svc: ArtifactsService;
let home: string;
let paths: typeof import("../../src/shared/paths.ts").paths;

/** Every file under the home with its content hash and mtime: proof that nothing wrote into it. */
function fingerprint(dir: string): string {
  const out: string[] = [];
  const walk = (p: string) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const f = path.join(p, e.name);
      if (e.isDirectory()) walk(f);
      else out.push(`${path.relative(dir, f)}:${fs.statSync(f).mtimeMs}:${crypto.createHash("sha1").update(fs.readFileSync(f)).digest("hex")}`);
    }
  };
  walk(dir);
  return out.sort().join("\n");
}
const byTask = (task: string) => svc.list().find((a) => a.firstmate?.task === task)!;
const waitFor = async (fn: () => boolean | Promise<boolean>, ms = 4000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error("timed out");
};

beforeAll(async () => {
  home = path.join(process.env.JOYRIDE_RUNTIME!, "firstmate");
  buildReportsHome(home);
  d = await sandboxDaemon("artifacts-firstmate", ["sessions", "missions", "artifacts", "firstmate"]);
  paths = (await import("../../src/shared/paths.ts")).paths;
  if (!paths.firstmateHome.startsWith(d.sb.dir)) throw new Error(`refusing to run: FM_HOME ${paths.firstmateHome} is outside the sandbox`);
  svc = d.ctx.service<ArtifactsService>("artifacts");
  const ms = d.ctx.service<any>("missions");
  ms.create({ id: REPORT_MISSION, title: "Alpha cache", repos: [path.join(d.sb.dir, "repos", "alpha")] });
  ms.create({ id: "beta-sync", title: "Beta sync reliability", repos: [path.join(d.sb.dir, "repos", "beta")] });
});
afterAll(async () => { await d.modules.find((m) => m.name === "artifacts")?.stop?.(); });

describe("report reader", () => {
  it("decodes Firstmate holds", () => {
    expect(decodeHold(`fm-hold-v1:${Buffer.from("Pick one of (a) or (b).").toString("base64")}`)).toBe("Pick one of (a) or (b).");
    expect(decodeHold("waiting on keys")).toBe("waiting on keys");
    expect(decodeHold(null)).toBeNull();
  });

  it("reads every report with its heading, project and backlog state, including archived tasks", () => {
    const reps = readFirstmateReports(home);
    expect(reps.map((r) => [r.task, r.heading, r.repo, r.status])).toEqual([
      [T.cache, "Alpha API cache backend: Redis or in-process LRU", "alpha", "decision-open"],
      [T.retry, "Beta sync client retries: what happens on a 429", "beta", "applying"],
      [T.logs, "Gamma service logging audit", "gamma", "reported"],
    ]);
    const cache = reps[0];
    expect(cache.mission).toBe(REPORT_MISSION);
    expect(cache.decisions).toEqual([expect.objectContaining({ task: "alpha-cache-pick", open: true, question: expect.stringContaining(`data/${T.cache}/report.md`) })]);
    const retry = reps[1];
    expect(retry.decisions).toEqual([expect.objectContaining({ task: "beta-retry-pick", open: false, answer: "go with exponential backoff capped at 30 seconds", mode: "answered" })]);
    expect(retry.followups).toEqual([{ task: "beta-retry-tune", title: expect.stringContaining("Beta: apply the retry policy"), done: false }]);
  });

  it("derives applied, decided and in-progress from the backlog", () => {
    const rows = readBacklogRows(home);
    const done = rows.map((r) => (r.id === "beta-retry-tune" ? { ...r, section: "done" as const, checked: true } : r));
    expect(reportStatus(T.retry, done).status).toBe("applied");
    expect(reportStatus(T.retry, rows.filter((r) => r.id !== "beta-retry-tune")).status).toBe("decided");
    expect(reportStatus("new-scout", [{ ...rows[0], id: "new-scout", section: "in_flight", hold: null, kind: "scout", notes: [], checked: false }]).status).toBe("in-progress");
    expect(readFirstmateReports(path.join(d.sb.dir, "no-such-home"))).toEqual([]);
  });
});

describe("registration", () => {
  let before: string;
  it("registers each report once as a report artifact, linked to its mission, with a snapshot", async () => {
    before = fingerprint(home);
    const r = await svc.syncFirstmate();
    expect(r).toMatchObject({ reports: 3, created: 3, updated: 0 });
    const cache = byTask(T.cache);
    expect(cache).toMatchObject({ kind: "report", title: "Alpha API cache backend: Redis or in-process LRU", project: "alpha", mission: REPORT_MISSION, source: "firstmate", detected_from: "firstmate", embeddable: true });
    expect(cache.local_source).toBeNull();
    expect(cache.snapshot_blob).toMatch(/^[a-f0-9]{64}$/);
    expect(cache.firstmate).toMatchObject({ task: T.cache, status: "decision-open" });
    // The one open mission on the same repo is the match when the brief carries no marker.
    expect(byTask(T.retry).mission).toBe("beta-sync");
    expect(byTask(T.logs).mission).toBeNull();
    expect(byTask(T.logs).project).toBe("gamma");
    const log = execFileSync("git", ["log", "--format=%s", "--", "artifacts"], { cwd: paths.root, encoding: "utf8" });
    expect(log).toContain("artifacts: Firstmate reports (3 new, 0 updated)");
  });

  it("derives a summary without writing memory or distillation fields", () => {
    const cache = byTask(T.cache);
    expect(cache.summary).toBe(cache.title);
    expect(cache).not.toHaveProperty("distilled");
    expect(cache).not.toHaveProperty("candidates");
    expect(d.ctx.services.has("memory")).toBe(false);
  });

  it("serves the report as text and filters by project", async () => {
    const cache = byTask(T.cache);
    const t = await d.req("GET", `/api/artifacts/${cache.id}/text`);
    expect(t.status).toBe(200);
    expect(t.body.text).toBe(CACHE_REPORT);
    expect(t.body.content_type).toMatch(/^text\/markdown/);
    const list = await d.req("GET", "/api/artifacts?project=beta");
    expect(list.body.map((a: any) => a.firstmate?.task)).toEqual([T.retry]);
  });

  it("re-registering an updated report updates the same artifact instead of duplicating it", async () => {
    const cache = byTask(T.cache);
    const again = await svc.syncFirstmate();
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 3, commit: null });

    fs.writeFileSync(path.join(home, "data", T.cache, "report.md"), CACHE_REPORT.replace("# Alpha API cache backend: Redis or in-process LRU", "# Alpha API cache backend: Redis wins") + "\nAddendum: Redis also serves the session store.\n");
    const r = await svc.syncFirstmate();
    expect(r).toMatchObject({ created: 0, updated: 1 });
    const after = byTask(T.cache);
    expect(svc.list().filter((a) => a.firstmate?.task === T.cache)).toHaveLength(1);
    expect(after.id).toBe(cache.id);
    expect(after.title).toBe("Alpha API cache backend: Redis wins");
    expect(after.snapshot_blob).not.toBe(cache.snapshot_blob);
    expect(svc.list().length).toBe(3);
  });

  it("keeps a title someone set by hand and a mission someone picked", async () => {
    const logs = byTask(T.logs);
    svc.update(logs.id, { title: "Gamma logs leak addresses", mission: "beta-sync" });
    fs.appendFileSync(path.join(home, "data", T.logs, "report.md"), "\nFollow-up: the fix shipped in gamma 2.4.\n");
    await svc.syncFirstmate();
    expect(byTask(T.logs)).toMatchObject({ title: "Gamma logs leak addresses", mission: "beta-sync" });
  });

  it("follows the backlog: an answered decision clears decision-open", async () => {
    const bl = path.join(home, "data", "backlog.md");
    const text = fs.readFileSync(bl, "utf8");
    const held = text.split("\n").filter((l, i, all) => l.startsWith("- [ ] alpha-cache-pick") || (i > 0 && all[i - 1].startsWith("- [ ] alpha-cache-pick")));
    const moved = text.replace(held.join("\n") + "\n", "").replace("## Done\n", `## Done\n${held[0].replace("- [ ]", "- [x]")}\n  Resolution mode: answered\n\n  Captain decision:\n  b) the in-process LRU for now\n\n  Origin: ${T.cache}\n`);
    fs.writeFileSync(bl, moved);
    await svc.syncFirstmate();
    expect(byTask(T.cache).firstmate).toMatchObject({ status: "decided", decisions: [expect.objectContaining({ open: false, answer: "b) the in-process LRU for now" })] });
  });

  it("never writes into the Firstmate home", () => {
    // Only the test itself edited the home above; compare everything else to the first snapshot.
    const now = fingerprint(home).split("\n").filter((l) => !/^data\/(backlog\.md|alpha-cache-study\/report\.md|gamma-log-audit\/report\.md):/.test(l));
    const was = before.split("\n").filter((l) => !/^data\/(backlog\.md|alpha-cache-study\/report\.md|gamma-log-audit\/report\.md):/.test(l));
    expect(now).toEqual(was);
    expect(fs.readdirSync(home).sort()).toEqual(["data", "state"]);
  });
});

describe("watcher", () => {
  it("registers a new report on its own once the module runs", async () => {
    await d.modules.find((m) => m.name === "artifacts")!.start!(d.ctx);
    fs.mkdirSync(path.join(home, "data", "delta-queue-scout"), { recursive: true });
    fs.writeFileSync(path.join(home, "data", "delta-queue-scout", "report.md"), "# Delta queue depth\n\nThe delta queue backs up when the consumer restarts during a deploy, because it drains in a single thread.\n");
    await waitFor(() => Boolean(svc.list().find((a) => a.firstmate?.task === "delta-queue-scout")));
    expect(byTask("delta-queue-scout")).toMatchObject({ title: "Delta queue depth", kind: "report", project: null });
  });
});


describe("report updates", () => {
  it("keeps unfinished reports visible and tracks final status without distillation", async () => {
    const task = "unfinished-study";
    const file = path.join(home, "data", task, "report.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "# An unfinished investigation\n\nA durable result.\n");
    const status = path.join(home, "state", `${task}.status`);
    fs.writeFileSync(status, "working [at=1791190000]: writing\n");
    await svc.syncFirstmate();
    expect(byTask(task).firstmate?.final).toBe(false);
    expect(byTask(task).summary).toBe("An unfinished investigation");
    const before = byTask(task).snapshot_blob;
    fs.appendFileSync(status, "done [at=1791190003]: final\n");
    fs.appendFileSync(file, "\nFinal addendum.\n");
    await svc.syncFirstmate();
    expect(byTask(task).firstmate?.final).toBe(true);
    expect(byTask(task).snapshot_blob).not.toBe(before);
    expect((await d.req("GET", `/api/artifacts/${byTask(task).id}/text`)).body.text).toContain("Final addendum.");
  });
  it("debounces a burst of report writes before taking the snapshot", async () => {
    const task = "burst-study";
    const file = path.join(home, "data", task, "report.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "# A burst investigation\n");
    for (let i = 0; i < 4; i++) {
      fs.appendFileSync(file, `\nUpdate ${i}.\n`);
      await new Promise(r => setTimeout(r, 100));
      expect(svc.list().find(a => a.firstmate?.task === task)).toBeUndefined();
    }
    await waitFor(() => Boolean(svc.list().find(a => a.firstmate?.task === task)));
    expect((await d.req("GET", `/api/artifacts/${byTask(task).id}/text`)).body.text).toContain("Update 3.");
  });
});
