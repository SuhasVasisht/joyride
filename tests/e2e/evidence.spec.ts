// C4: the evidence panel: attested records (via the joyride-evidence CLI, with
// screenshots blobbed) next to inferred ones, a Jev verdict with per-criterion
// results and the caption downgrade note, the screenshot lightbox, re-verify.
// Runs only against the sandbox daemon (E2E_PORT).
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { shot } from "./shot";

const PORT = Number(process.env.E2E_PORT ?? 4399);
if (PORT === 4317 || PORT === 3000) throw new Error("evidence e2e refuses to run against the real daemon port");
const BASE = `http://127.0.0.1:${PORT}`;
const SANDBOX = `/tmp/joyride-e2e-${PORT}`;
const FILES = path.join(SANDBOX, "files");

async function call<T = any>(method: string, p: string, body?: unknown): Promise<T> {
  const r = await fetch(BASE + p, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok && r.status !== 409) throw new Error(`${method} ${p} -> ${r.status}: ${t}`);
  return t ? JSON.parse(t) : (null as T);
}

/** joyride-evidence with the sandbox env: records land in the sandbox event log only. */
function evidenceCli(args: string[]) {
  const env = JSON.parse(fs.readFileSync(path.join(SANDBOX, "env.json"), "utf8"));
  if (!String(env.JOYRIDE_RUNTIME).startsWith(SANDBOX)) throw new Error("refusing: evidence CLI env is not the sandbox");
  execFileSync("node_modules/.bin/tsx", ["src/cli/evidence.ts", "add", ...args], { env: { ...process.env, ...env }, stdio: "pipe" });
}

test.describe.configure({ mode: "serial" });

test.afterAll(async () => {
  for (const id of ["memory-pages", "digest-budget"]) await call("PUT", `/api/missions/${id}`, { archive: true });
});

test("evidence: attested and inferred records, a Jev verdict, screenshots in a lightbox", async ({ page }) => {
  fs.mkdirSync(FILES, { recursive: true });
  const ms = await call<any[]>("GET", "/api/missions");
  if (!ms.some((m) => m.id === "memory-pages")) {
    await call("POST", "/api/missions", {
      id: "memory-pages", title: "Memory pages in the workspace", repos: ["/tmp/joyride-fixture-repos/alpha"],
      goal: "Browse, triage and verify memory from the UI.",
      done_when: [
        { id: "c1", text: "End-to-end tests cover the whole memory flow and pass", kind: "e2e" },
        { id: "c2", text: "Screenshot checks of the memory page have no error banner", kind: "screenshot" },
        { id: "c3", text: "Unit tests for memory and learnings pass", kind: "test" },
      ],
    });
    await call("POST", "/api/missions", { id: "digest-budget", title: "Digest stays inside its budget", done_when: [{ id: "c1", text: "End-to-end tests cover the whole digest flow and pass", kind: "e2e" }] });
  }

  await test.step("record evidence", async () => {
    // These are deliberate evidence fixtures in the fake-model sandbox.
    for (const text of ["Save task notes as files", "Register the original source", "Review session handoffs"]) await call("POST", "/api/notes", { bullets: [text], global: true });
    await page.goto("/#/knowledge?types=notes");
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(FILES, "memory-entries.png") });
    await page.goto("/#/knowledge/artifacts");
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(FILES, "memory-digest.png") });
    const log = path.join(FILES, "vitest.log");
    fs.writeFileSync(log, " ✓ tests/unit/knowledge.test.ts (38 tests) 912ms\n ✓ tests/unit/learnings.test.ts (11 tests) 901ms\n\n Test Files  2 passed (2)\n      Tests  49 passed (49)\n");
    evidenceCli(["--name", "unit tests", "--mission", "memory-pages", "--exit-code", "0", "--command", "npx vitest run tests/unit/knowledge.test.ts tests/unit/learnings.test.ts", "--log", log, "--claim", "Memory and learnings unit suites pass."]);
    evidenceCli(["--name", "memory e2e", "--mission", "memory-pages", "--exit-code", "0", "--command", "npx playwright test tests/e2e/knowledge.spec.ts",
      "--claim", "Playwright browsed entries, triaged candidates with the keyboard and accepted a merge.", "--screenshot", path.join(FILES, "memory-entries.png"), path.join(FILES, "memory-digest.png")]);
    await call("POST", "/api/evidence", {
      mode: "inferred", name: "npm test", command: "npm test -- --run tests/unit/cart.test.ts", exit_code: 1, assertions: { passed: 41, failed: 1, skipped: 0 },
      log_tail: "FAIL tests/unit/cart.test.ts > totals > rounds half up\nAssertionError: expected 10.01 to be 10.02\n Tests  1 failed | 41 passed (42)", mission: "memory-pages", cwd: "/tmp/joyride-fixture-repos/alpha", session: null,
    });
    evidenceCli(["--name", "digest e2e", "--mission", "digest-budget", "--exit-code", "0", "--command", "npx playwright test tests/e2e/knowledge.spec.ts -g digest", "--claim", "The digest preview shows 6 of 40 lines.", "--screenshot", path.join(FILES, "memory-digest.png")]);
    await expect.poll(async () => (await call<any[]>("GET", "/api/evidence?mission=memory-pages")).length, { timeout: 15000 }).toBe(3);
  });

  await test.step("evidence panel and verdict", async () => {
    await page.goto("/#/evidence/memory-pages");
    const panel = page.getByTestId("evidence-panel");
    await expect(panel.getByTestId("evidence-item")).toHaveCount(3);
    await expect(panel.getByText("Attested", { exact: true })).toHaveCount(2);
    await expect(panel.getByText("Inferred", { exact: true })).toHaveCount(1);
    await expect(panel.getByText("exit 1")).toBeVisible();
    await expect(panel.getByText("1 failed", { exact: true })).toBeVisible();
    await expect(panel.locator(".k-asserts").getByText(/49 passed/)).toBeVisible();
    await expect(panel.locator(".k-thumb")).toHaveCount(2);
    await expect(panel.getByTestId("verdict")).toContainText("No verdict yet");
    await panel.getByRole("button", { name: "Ask Jev for a verdict" }).click();
    const verdict = panel.getByTestId("verdict");
    await expect(verdict.locator(".k-crit li")).toHaveCount(3);
    await expect(verdict.getByTestId("downgrade-note")).toBeVisible();
    await expect(verdict.locator(".word")).toHaveText(/Pass|Fail|Insufficient evidence/);
    await page.waitForTimeout(300);
    await shot(page, "C4", "verdict");
    // The whole panel: a taller window so the evidence list fits under the verdict.
    await page.setViewportSize({ width: 1440, height: 1700 });
    await page.waitForTimeout(300);
    await shot(page, "C4", "evidence-panel");
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  await test.step("screenshot lightbox", async () => {
    const panel = page.getByTestId("evidence-panel");
    await panel.locator(".k-thumb").first().click();
    const box = page.getByTestId("lightbox");
    await expect(box).toBeVisible();
    await expect(box).toContainText("memory-entries.png, from memory e2e");
    await page.waitForTimeout(250);
    await shot(page, "C4", "lightbox");
    await page.keyboard.press("ArrowRight");
    await expect(box).toContainText("memory-digest.png");
    await page.keyboard.press("Escape");
    await expect(box).toHaveCount(0);
  });

  await test.step("a passing verdict and re-verify", async () => {
    await page.goto("/#/evidence/digest-budget");
    const panel = page.getByTestId("evidence-panel");
    await expect(panel.getByTestId("evidence-item")).toHaveCount(1);
    await panel.getByRole("button", { name: "Ask Jev for a verdict" }).click();
    await expect(panel.getByTestId("verdict").locator(".word")).toHaveText("Pass");
    await panel.getByRole("button", { name: "Re-verify" }).click();
    await expect(panel.getByText(/Re-verify sent as intent int_/)).toBeVisible();
    const intents = await call<any[]>("GET", "/api/intents?kind=reverify");
    expect(intents[0]).toMatchObject({ kind: "reverify", target: "digest-budget", status: "sent" });
    await shot(page, "C4", "verdict-pass");
  });

  await test.step("panel inside the mission page", async () => {
    await page.goto("/#/mission/memory-pages");
    const panel = page.getByTestId("evidence-panel");
    await panel.first().waitFor({ timeout: 8000 }).catch(() => {}); // the mission page shell belongs to another view
    if (await panel.count()) {
      await expect(panel.getByTestId("verdict").locator(".k-crit li")).toHaveCount(3);
      await panel.scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      await shot(page, "C4", "mission-evidence");
    }
  });
});
