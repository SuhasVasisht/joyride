import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test, expect } from "@playwright/test";
import { call, PORT, waitUntil } from "./map-seed";
import { shot } from "./shot";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const LAB = process.env.E2E_LAB_HERDR_SOCKET;
const [PANE, CWD] = (process.env.E2E_LAB_ALPHA ?? "=").split("=");
const [BETA] = (process.env.E2E_LAB_BETA ?? "=").split("=");
const A = `local:${PANE}`, B = `local:${BETA}`;
const MODEL_LOG = process.env.E2E_LAB_MODEL_LOG ?? "";
const WORK = process.env.E2E_LAB_WORK ?? "";
const BASE = `http://127.0.0.1:${PORT}`;
const sandbox = `/tmp/joyride-e2e-${PORT}`;
const jr = (args: string[]) => {
  const r = spawnSync(path.join(ROOT, "bin/joyride"), args, { encoding: "utf8", timeout: 120_000, env: { ...process.env, JOYRIDE_URL: BASE } });
  console.log(`joyride ${args.join(" ")}: exit ${r.status}\n${r.stdout}${r.stderr}`);
  return { code: r.status, out: r.stdout + r.stderr, stdout: r.stdout };
};
const worker = async (id: string) => (await call<any[]>("GET", "/api/workers")).body.find((w) => w.id === id);
test.skip(!LAB, "Run scripts/lab-fleet-pruning.sh with an isolated named Herdr session.");

test("preserve then close in Herdr, refuse captain helm, expose prune ask and run saved resume command", async ({ page }) => {
  test.setTimeout(240_000);
  const env = JSON.parse(fs.readFileSync(`${sandbox}/env.json`, "utf8"));
  // This lab compresses only the idle clock. Production defaults and the 72h boundary are unit tested.
  fs.writeFileSync(path.join(env.JOYRIDE_HOME, "fleet.yaml"), "pruning:\n  idle_hours: 0.0003\n  proposal_days: 14\n  archive_days: 30\n");
  await waitUntil(async () => (await worker(A))?.owner?.tier === "watched" && (await worker(B))?.owner?.tier === "watched", 60_000);
  await waitUntil(async () => /❯/.test(String((await call<any>("GET", `/api/workers/${encodeURIComponent(A)}/screen`)).body.screen)), 30_000);
  expect(jr(["steer", B, "lab: beta waiting for captain"]).code).toBe(0);
  const prompt = jr(["steer", A, "lab: save the work summary and Learning: keep the context when closing"]);
  expect(prompt.code).toBe(0);
  await waitUntil(async () => fs.readFileSync(MODEL_LOG, "utf8").includes("save the work summary") && (await worker(A))?.status === "idle", 60_000);
  await call("POST", "/api/sessions/reindex?full=1");
  const w = await worker(A);
  expect(w.owner.tier).toBe("watched");
  // Register a real local output. Preservation must snapshot its bytes and retain the checkout.
  const output = path.join(CWD, "generated-report.md");
  fs.writeFileSync(output, "Lab output: retained after pane closure.\n");
  const registered = await call<any>("POST", "/api/artifacts", { local_source: output, session: w.session, kind: "report", title: "Generated lab report" });
  expect(registered.status).toBe(201);
  const attention = (await call<any[]>("GET", "/api/attention?open=1")).body;
  for (const a of attention) if (a.worker === A || a.session === w.session) await call("POST", `/api/attention/${a.id}/resolve`, { resolution: "Lab captain reviewed the completed work." });
  await waitUntil(async () => (await call<any>("GET", "/api/fleet/prune")).body.candidates.some((c: any) => c.worker === A && c.eligible), 30_000);
  const dry = jr(["fleet", "prune", "--dry-run"]);
  expect(dry.code).toBe(0);
  expect(dry.out).toContain(`Would preserve and close ${A}`);
  expect(await worker(A)).toBeTruthy();
  fs.writeFileSync(path.join(ROOT, "test-results", "fleet-pruning-dry-run.txt"), dry.out);
  const proposal = jr(["fleet", "propose-prune", A, "The lab pane has finished; preserve its context first."]);
  expect(proposal.code).toBe(0);
  const asks = (await call<any>("GET", `/api/asks?worker=${encodeURIComponent(A)}&kind=approval`)).body.asks;
  expect(asks).toEqual([expect.objectContaining({ kind: "approval", source: "fleet", answer: { via: "prune", target: expect.any(String) } })]);
  await page.goto("/#/agents");
  await expect(page.locator(`[data-agent="w:${A}"]`)).toBeVisible();
  await shot(page, "fleet-p3", "lab-idle-watched-before-close");
  const retired = jr(["fleet", "retire", A, "--json"]);
  expect(retired.code, retired.out).toBe(0);
  const record = JSON.parse(retired.stdout);
  expect(record).toMatchObject({ origin: "firstmate", status: "sent", result: { closed: true, artifact: expect.any(String), resume: { session: w.session, cwd: CWD } } });
  await waitUntil(async () => !(await worker(A)), 15_000);
  const saved = JSON.parse(fs.readFileSync(record.result.file, "utf8"));
  expect(saved.artifacts.some((a: any) => a.path === output && a.snapshot)).toBe(true);
  expect(fs.readFileSync(output, "utf8")).toBe("Lab output: retained after pane closure.\n");
  expect(fs.existsSync(saved.transcript)).toBe(true);
  expect(saved.learnings.length).toBeGreaterThan(0);
  const artifact = (await call<any>("GET", `/api/artifacts/${record.result.artifact}`)).body;
  expect(artifact.kind).toBe("session");
  await page.goto(`/#/artifacts/${record.result.artifact}`);
  await expect(page.locator("body")).toContainText("Saved session");
  await shot(page, "fleet-p3", "lab-saved-session-artifact");
  fs.writeFileSync(path.join(ROOT, "test-results", "fleet-pruning-preserved.json"), JSON.stringify({ record, saved, asks }, null, 2));

  // Execute the exact saved command in print mode against the lab's fake model. No real account is used.
  const modelPort = fs.readFileSync(path.join(WORK, "model.port"), "utf8").trim();
  const resume = spawnSync("/bin/sh", ["-c", `${record.result.resume.command} --print 'lab: resumed saved session'`], { encoding: "utf8", timeout: 90_000, env: { ...process.env, ...env, CLAUDECODE: "", JOYRIDE_INTERNAL: "1", ANTHROPIC_API_KEY: "sk-ant-lab-resume", ANTHROPIC_BASE_URL: `http://127.0.0.1:${modelPort}`, DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } });
  console.log(`saved resume command: exit ${resume.status}\n${resume.stdout}${resume.stderr}`);
  expect(resume.status, resume.stderr).toBe(0);
  expect(fs.readFileSync(MODEL_LOG, "utf8")).toContain("resumed saved session");

  // A captain steer takes beta's helm and blocks retirement regardless of the shortened idle clock.
  const steer = await call<any>("POST", "/api/intents", { kind: "reply", target: B, payload: { text: "lab: captain has the helm" }, origin: "captain" });
  expect(steer.body.status).toBe("sent");
  await waitUntil(async () => (await worker(B))?.helm?.by === "captain", 30_000);
  const blocked = jr(["fleet", "retire", B]);
  expect(blocked.code).toBe(2);
  expect(blocked.out).toContain("the captain holds the helm");
  expect(await worker(B)).toBeTruthy();
  expect((await call<any>("GET", `/api/asks?worker=${encodeURIComponent(B)}&kind=approval`)).body.asks.some((a: any) => a.source === "fleet")).toBe(true);
  await page.goto("/#/agents");
  await expect(page.locator(`[data-agent="w:${B}"] [data-helm="captain"]`)).toBeVisible();
  await shot(page, "fleet-p3", "lab-captain-helm-refusal");
});
