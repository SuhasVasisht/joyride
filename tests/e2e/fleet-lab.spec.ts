// One fleet against real software (scripts/lab-fleet.sh): two real Claude Code panes the captain
// started, in an isolated Herdr lab session, and a throwaway Firstmate home. Firstmate's side is the real
// CLI it uses (`joyride steer`, `joyride fleet`) and Firstmate's own process-event commands. Proves:
//   1. a steer is refused onto the captain's draft, and the draft survives;
//   2. the captain's steer takes the helm, which refuses Firstmate's steer and prompt answer, and the
//      captain hands it back from the Agents page;
//   3. a real permission prompt is answered through the guarded path (the command then runs);
//   4. the fleet feed reaches the test home's process-event inbox, and the fleet's notes its captain inbox.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { test, expect } from "@playwright/test";
import { shot } from "./shot";
import { call, PORT, waitUntil } from "./map-seed";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const LAB = process.env.E2E_LAB_HERDR_SOCKET;
const FMH = process.env.E2E_LAB_FM_HOME ?? "";
const CLAIMS = process.env.E2E_LAB_CLAIMS ?? "";
const FM_DIR = process.env.JOYRIDE_FIRSTMATE_DIR ?? "";
const MODEL_LOG = process.env.E2E_LAB_MODEL_LOG ?? "";
const [APANE, APROJ] = (process.env.E2E_LAB_ALPHA ?? "=").split("=");
const [BPANE] = (process.env.E2E_LAB_BETA ?? "=").split("=");
const A = `local:${APANE}`, B = `local:${BPANE}`;
const BASE = `http://127.0.0.1:${PORT}`;
const sandbox = `/tmp/joyride-e2e-${PORT}`;
const DRAFT = "lab: bash touch alpha-approved.txt";

test.skip(!LAB || !fs.existsSync(path.join(FMH, ".fm-lab-home")), "Herdr lab only: run scripts/lab-fleet.sh");
test.describe.configure({ mode: "serial" });

/** Firstmate's CLI, as Firstmate runs it. */
function jr(args: string[], extra: Record<string, string> = {}) {
  const r = spawnSync(path.join(ROOT, "bin", "joyride"), args, { encoding: "utf8", timeout: 60_000, env: { ...process.env, JOYRIDE_URL: BASE, ...extra } });
  const out = `${r.stdout}${r.stderr}`;
  console.log(`$ joyride ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}  (exit ${r.status})\n${out.trim()}`);
  return { code: r.status, out };
}
const fmEnv = () => ({ ...process.env, FM_HOME: FMH, FM_PROCEVENT_CLAIM_ROOT: CLAIMS, FM_PROCEVENT_OWNER_CHECK_SECONDS: "1", JOYRIDE_GUARD: "off" });
/** One of Firstmate's own commands in the lab home. */
function fm(script: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const c = spawn(path.join(FM_DIR, "bin", script), args, { env: fmEnv() });
    let out = "";
    c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
    c.on("close", (code) => { console.log(`$ FM_HOME=<lab> ${script} ${args.join(" ")}  (exit ${code})\n${out.trim()}`); resolve({ code: code ?? 1, out }); });
  });
}
const workerNow = async (id: string) => (await call<any[]>("GET", "/api/workers")).body.find((w) => w.id === id);
const screen = async (id: string) => String((await call<any>("GET", `/api/workers/${encodeURIComponent(id)}/screen`)).body.screen ?? "");
const modelSaw = (text: string) => fs.existsSync(MODEL_LOG) && fs.readFileSync(MODEL_LOG, "utf8").includes(text);
const input = (id: string, body: unknown) => call("POST", `/api/workers/${encodeURIComponent(id)}/input`, body);
const results = () => { const d = path.join(FMH, "state", "procevent-inbox"); return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith(".result")).sort() : []; };

test("one fleet in a Herdr lab: draft kept, helm handed back, a real prompt answered, the feed in Firstmate's inbox", async ({ page }) => {
  test.setTimeout(420_000);
  // Both of the captain's sessions are watched fleet members, at their input boxes.
  await waitUntil(async () => (await workerNow(A))?.owner?.tier === "watched" && (await workerNow(B))?.owner?.tier === "watched", 60_000);
  await waitUntil(async () => /❯/.test(await screen(A)) && /❯/.test(await screen(B)), 60_000);

  // Bind the feed into the lab home the documented way, through Joyride's installer.
  const env = JSON.parse(fs.readFileSync(`${sandbox}/env.json`, "utf8")) as Record<string, string>;
  const inst = spawnSync(path.join(ROOT, "bin", "joyride"), ["install", "firstmate-feed"], { encoding: "utf8", timeout: 120_000,
    env: { ...process.env, JOYRIDE_HOME: env.JOYRIDE_HOME, JOYRIDE_RUNTIME: env.JOYRIDE_RUNTIME, JOYRIDE_URL: BASE, FM_HOME: FMH, FM_PROCEVENT_CLAIM_ROOT: CLAIMS } });
  console.log(`$ joyride install firstmate-feed (exit ${inst.status})\n${inst.stdout}${inst.stderr}`);
  expect(inst.status).toBe(0);
  expect(inst.stdout).toMatch(/handshake process-event-adapter\/1 \(joyride-fleet-feed\)/);
  expect(inst.stdout).toMatch(/registered source joyride-fleet polling http:\/\/127\.0\.0\.1:\d+\/api\/fleet\/feed/);
  expect(fs.existsSync(path.join(FMH, "config", "extensions.d", "dev.joyride.fleet-feed.json"))).toBe(true);

  // Roster as Firstmate reads it.
  const roster = jr(["fleet"]);
  expect(roster.code).toBe(0);
  expect(roster.out).toMatch(new RegExp(`watched\\s+${A}`));
  expect(roster.out).toMatch(new RegExp(`watched\\s+${B}`));

  // 1. The captain is typing in alpha (from Joyride's terminal tab). Firstmate's steer is refused, the draft stays.
  expect((await input(A, { data: DRAFT })).status).toBe(200);
  await waitUntil(async () => (await screen(A)).includes(DRAFT), 15_000);
  const ontoDraft = jr(["steer", A, "Firstmate here: run the tests."]);
  expect(ontoDraft.code).toBe(2);
  expect(ontoDraft.out).toMatch(/most likely the captain's draft/);
  await new Promise((r) => setTimeout(r, 1500));
  expect(await screen(A)).toContain(DRAFT);
  expect(modelSaw("Firstmate here: run the tests.")).toBe(false);
  await page.goto(`/#/worker/${encodeURIComponent(A)}?tab=terminal`);
  await expect(page.locator(".xterm-rows")).toContainText(DRAFT, { timeout: 15_000 });
  await shot(page, "fleet-p2", "lab-draft-kept");

  // 2. The captain sends the draft: they take the helm, and the agent stops at a real permission prompt.
  expect((await input(A, { keys: ["enter"] })).status).toBe(200);
  await waitUntil(async () => (await workerNow(A))?.helm?.by === "captain", 30_000);
  expect((await workerNow(A)).helm.via).toBe("joyride-terminal");
  await waitUntil(async () => (await call<any>("GET", `/api/fleet/members/${encodeURIComponent(A)}`)).body?.prompt?.options?.length > 0, 60_000);
  const shown = jr(["fleet", "show", A]);
  expect(shown.out).toMatch(/blocked \(inferred\)/);
  expect(shown.out).toMatch(/1\. Yes/);
  const atHelm = jr(["steer", A, "--answer", "allow", "--why", "It only touches a file in its own folder."]);
  expect(atHelm.code).toBe(2);
  expect(atHelm.out).toMatch(/The captain holds the helm/);
  expect(jr(["steer", A, "Firstmate here."]).code).toBe(2);
  expect(fs.existsSync(path.join(APROJ, "alpha-approved.txt"))).toBe(false);
  await page.goto("/#/agents");
  const rowA = page.locator(`[data-agent="w:${A}"]`);
  await expect(rowA.locator('[data-helm="captain"]')).toHaveText("Helm: you");
  await shot(page, "fleet-p2", "lab-fleet-captain-helm");

  // 4a. The feed: Firstmate's runner polls the daemon and captures what happened so far.
  const poll1 = await fm("fm-procevent.sh", ["start", "joyride-fleet"]);
  expect(poll1.code).toBe(0);
  await waitUntil(async () => results().length >= 1, 15_000);
  const first = fs.readFileSync(path.join(FMH, "state", "procevent-inbox", results()[0]), "utf8");
  expect(first.split("\n")[0]).toMatch(/^joyride-fleet-feed\/1 seq=/);
  expect(first).toContain(`${A} `);
  expect(first).toMatch(/the captain took the helm \(typing in Joyride's terminal/);
  expect(first).toMatch(/blocked: /);
  expect((await fm("fm-procevent.sh", ["classify", path.join(FMH, "state", "procevent-inbox", results()[0])])).out).toContain("fleet-needs-attention");
  expect(fs.readFileSync(path.join(FMH, "state", ".wake-queue"), "utf8")).toContain("procevent joyride-fleet-feed joyride-fleet 1");

  // 2b. The captain hands the helm back on the Agents page.
  await rowA.locator('[data-action="hand-back"]').click();
  await waitUntil(async () => (await workerNow(A))?.helm?.by === "firstmate", 15_000);
  await expect(rowA.locator('[data-helm="firstmate"]')).toHaveText("Helm: Firstmate");

  // 3. Firstmate answers the real prompt through the guarded path; the command runs.
  const answered = jr(["steer", A, "--answer", "allow", "--why", "The captain handed it back; the command only touches a file in the session's own folder."]);
  expect(answered.code).toBe(0);
  expect(answered.out).toMatch(/Answered .* prompt with "Yes"/);
  await waitUntil(async () => fs.existsSync(path.join(APROJ, "alpha-approved.txt")), 60_000);
  const rec = (await call<any[]>("GET", `/api/intents?target=${encodeURIComponent(A)}&kind=answer_prompt`)).body[0];
  expect(rec).toMatchObject({ origin: "firstmate", status: "sent", result: { picked: "Yes", choice: "allow", why: expect.stringContaining("handed it back") } });
  expect(rec.result.prompt.options.some((o: string) => /^1\. Yes/.test(o))).toBe(true);

  // Firstmate's text steer goes in once the turn is over, as Firstmate's (never taking the helm).
  await waitUntil(async () => (await workerNow(A))?.status !== "working" && (await workerNow(A))?.status !== "blocked", 60_000);
  const steerA = jr(["steer", A, "lab: Firstmate checking in on alpha"]);
  expect(steerA.code).toBe(0);
  await waitUntil(async () => modelSaw("lab: Firstmate checking in on alpha"), 60_000);
  await waitUntil(async () => (await call<any[]>("GET", "/api/events?type=steer.attributed&limit=50")).body.some((e: any) => e.data?.worker === A && e.data?.by === "firstmate" && e.data?.via === "joyride-reply"), 30_000);
  expect((await workerNow(A)).helm.by).toBe("firstmate");

  // Beta: steered by Firstmate, then kept by the captain (refused), then back in the fleet.
  expect(jr(["steer", B, "lab: hello beta from Firstmate"]).code).toBe(0);
  await waitUntil(async () => modelSaw("lab: hello beta from Firstmate"), 60_000);
  const rowB = page.locator(`[data-agent="w:${B}"]`);
  await rowB.locator('[data-action="exclude"]').click();
  await expect(rowB.locator('[data-owner="excluded"]')).toHaveText("Yours only");
  const kept = jr(["steer", B, "lab: are you there?"]);
  expect(kept.code).toBe(2);
  expect(kept.out).toMatch(/keeps .* to themself/);
  await rowB.locator('[data-action="include"]').click();
  await expect(rowB.locator('[data-owner="watched"]')).toHaveText("Watched");
  await shot(page, "fleet-p2", "lab-fleet-after");

  // 4b. The next poll carries only what is new: the helm back with Firstmate, beta out and in.
  await fm("fm-procevent.sh", ["start", "joyride-fleet"]);
  await waitUntil(async () => results().length >= 2, 15_000);
  const second = fs.readFileSync(path.join(FMH, "state", "procevent-inbox", results()[1]), "utf8");
  expect(second).toMatch(/the helm is back with you \(the captain handed it back\)/);
  expect(second).toContain("the captain keeps this session to themself now");
  expect(second).toContain("back in the fleet as a watched session");
  expect(second).not.toMatch(/the captain took the helm/);
  expect((await fm("fm-procevent.sh", ["classify", path.join(FMH, "state", "procevent-inbox", results()[1])])).out).toMatch(/fleet-(helm|update)/);

  // The fleet's captain inbox notes landed in the lab home: who joined, and the hand-back with what the captain said.
  const notes = () => { const d = path.join(FMH, "state", "inbox"); return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith(".note")).map((f) => fs.readFileSync(path.join(d, f), "utf8")) : []; };
  await waitUntil(async () => notes().some((n) => n.includes("joined the fleet")) && notes().some((n) => n.includes("handed back the helm")), 60_000);
  const joined = notes().find((n) => n.includes("joined the fleet"))!;
  expect(joined).toContain(A);
  expect(joined).toContain(B);
  const handBack = notes().find((n) => n.includes("handed back the helm"))!;
  expect(handBack).toContain(`handed back the helm of ${A}`);
  expect(handBack).toContain(DRAFT);
  for (const n of results()) await fm("fm-procevent.sh", ["handled", "joyride-fleet", n.split(".")[1]]);
});
