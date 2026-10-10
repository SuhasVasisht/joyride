import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { shot } from "./shot";

const port = Number(process.env.E2E_PORT ?? 4399);
if (port === 4317 || port === 3000) throw new Error("evidence autolink requires a sandbox port");
const sandbox = `/tmp/joyride-e2e-${port}`;
const thread = "01a11272-fdda-7150-8077-8a1da374de9a";
const mission = "evidence-autolink";

test("Codex evidence without hooks links the active conversation in Joyride", async ({ page, request }) => {
  const env = z.record(z.string(), z.string()).parse(JSON.parse(fs.readFileSync(path.join(sandbox, "env.json"), "utf8")));
  if (!env.JOYRIDE_RUNTIME?.startsWith(sandbox)) throw new Error("evidence runtime must be isolated");
  const created = await request.post("/api/missions", { data: { id: mission, title: "Codex evidence conversation linking" } });
  expect(created.ok()).toBe(true);
  // A new cwd has no hook event; the CLI inherits only the current Codex identity.
  const cwd = path.join(sandbox, "evidence-work");
  fs.mkdirSync(cwd, { recursive: true });
  const output = execFileSync(path.resolve("bin/joyride-evidence"), ["run", "--name", "automatic Codex evidence", "--mission", mission, "--", "true"], {
    cwd, encoding: "utf8", env: { ...process.env, ...env, PWD: cwd, CODEX_THREAD_ID: thread, CODEX_SESSION_ID: "" }, stdio: "pipe",
  });
  expect(output).toBe("");
  await expect.poll(async () => {
    const response = await request.get(`/api/evidence?mission=${mission}`);
    const records = z.array(z.object({ session: z.string().nullable() })).parse(await response.json());
    return records[0]?.session;
  }).toBe(`codex:${thread}`);
  await page.goto(`/#/evidence/${mission}`);
  const item = page.getByTestId("evidence-item").filter({ hasText: "automatic Codex evidence" });
  await expect(item).toBeVisible();
  await expect(item.getByRole("link").first()).toHaveAttribute("href", `#/session/${encodeURIComponent(`codex:${thread}`)}`);
  await shot(page, "C4", "codex-evidence-autolink");
});
