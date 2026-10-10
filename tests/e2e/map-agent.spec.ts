import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test, expect } from "@playwright/test";
import { call, PORT, seedWorld, W, FAKE_SESSIONS } from "./map-seed";
import { shot } from "./shot";

const exec = promisify(execFile);

test("a CLI idea move appears live on the map and the map undoes it", async ({ page }) => {
  await seedWorld();
  expect((await call("POST", "/api/lenses", { id: "agent-filing", title: "Agent filing" })).status).toBe(200);
  const env = JSON.parse(fs.readFileSync(`/tmp/joyride-e2e-${PORT}/env.json`, "utf8"));
  const initialNudges = page.waitForResponse((r) => r.url().endsWith("/api/nudges") && r.ok());
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await expect(page.locator('[data-mission="oauth-login"]')).toBeVisible();
  await page.getByRole("radio", { name: "Mid" }).click();
  await expect(page.locator(".map-viewport")).toHaveAttribute("data-zoom", "mid");
  await page.keyboard.press("0");
  await expect(page.locator('.region-label[data-region="lens:agent-filing"]')).toBeVisible();
  await expect(page.locator('.empty-group[data-region="lens:agent-filing"]')).toContainText("No ideas or sessions here yet");
  // Wait for the notification host to read its initial set before issuing the external edit.
  await expect(page.locator('[data-rail="nudges"]')).toBeVisible();
  await initialNudges;
  await shot(page, "C2", "map-agent-before");
  const moved = await exec(path.resolve("bin/joyride"), ["map", "move-idea", "oauth-login", "--to-group", "agent-filing"], {
    env: { ...process.env, ...env, JOYRIDE_URL: `http://127.0.0.1:${PORT}`, FM_TASK_ID: "jr-agent-parity-e2e" },
  });
  const result = JSON.parse(moved.stdout);
  expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
  await page.locator('[data-mission="oauth-login"] .mn-title').focus();
  await page.getByRole("radio", { name: "Mid" }).click();
  await expect(page.locator(".map-viewport")).toHaveAttribute("data-zoom", "mid");
  const label = page.locator('.region-label[data-region="lens:agent-filing"]');
  await expect(label).toBeVisible();
  await expect(label).toContainText("Agent filing");
  await expect(label.locator(".rl-sub")).toContainText("1 idea");
  const toast = page.locator(`[data-toast="tidied:${result.commit}"]`);
  await expect(toast).toContainText("Map edit by jr-agent-parity-e2e");
  await toast.hover();
  const history = (await call("GET", "/api/missions/move/history")).body;
  expect(history[0]).toMatchObject({ commit: result.commit, actor: { id: "jr-agent-parity-e2e", via: "cli" }, undone: false });
  await shot(page, "C2", "map-agent-moved");
  await toast.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(toast).toContainText("Move undone.");
  await page.keyboard.press("0");
  await expect(label).toBeVisible();
  await expect(page.locator('.empty-group[data-region="lens:agent-filing"]')).toContainText("No ideas or sessions here yet");
  expect((await call("GET", "/api/missions/oauth-login")).body.lenses).toEqual([]);
  expect((await call("GET", "/api/missions/move/history")).body[0].undone).toBe(true);
  await shot(page, "C2", "map-agent-undone");
});

test("CLI note and checklist cards appear live, reflect agent edits and support map delete Undo", async ({ page }) => {
  await seedWorld();
  const sandboxEnv = JSON.parse(fs.readFileSync(`/tmp/joyride-e2e-${PORT}/env.json`, "utf8"));
  const env = { ...process.env, ...sandboxEnv, JOYRIDE_URL: `http://127.0.0.1:${PORT}`, FM_TASK_ID: "jr-agent-parity-e2e" };
  const cli = async (args: string[]) => JSON.parse((await exec(path.resolve("bin/joyride"), ["map", ...args], { env })).stdout);
  await page.goto("/");
  const idea = page.locator('[data-mission="oauth-login"]');
  await expect(idea).toBeVisible();
  await idea.locator(".mn-title").focus();
  await page.getByRole("radio", { name: "Near" }).click();
  const board = idea.locator('[data-note-board="mission:oauth-login"]');
  const note = await cli(["note", "Keep the login flow accessible", "--scope", "mission:oauth-login"]);
  await expect(board).toBeVisible();
  const noteCard = board.locator(`[data-note-card="${note.id}"]`);
  await expect(noteCard).toContainText("Keep the login flow accessible");
  expect(note.provenance).toMatchObject({ type: "agent", ref: "cli:jr-agent-parity-e2e" });
  const list = await cli(["list", "Tag the build", "Write notes", "--title", "Agent release", "--scope", "mission:oauth-login"]);
  const listCard = board.locator(`[data-note-card="${list.id}"]`);
  await expect(listCard).toHaveAttribute("data-kind", "list");
  await expect(listCard.getByRole("checkbox", { name: "Tag the build" })).not.toBeChecked();
  await listCard.scrollIntoViewIfNeeded();
  await shot(page, "C2", "map-agent-note-list-live");
  await cli(["edit-list", list.id, "[x] Tag the build", "Tell support"]);
  await expect(listCard.getByRole("checkbox", { name: "Tag the build" })).toBeChecked();
  await expect(listCard).toContainText("Tell support");
  await expect(listCard).not.toContainText("Write notes");
  await shot(page, "C2", "map-agent-list-edited");
  await listCard.getByRole("button", { name: "Delete this list" }).click();
  await expect(listCard).toHaveCount(0);
  const deleted = board.locator(`[data-note-deleted="${list.id}"]`);
  await deleted.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(listCard).toBeVisible();
  await expect(listCard.getByRole("checkbox", { name: "Tag the build" })).toBeChecked();
  expect((await call("GET", `/api/notes/${list.id}`)).body.status).toBe("active");
  await shot(page, "C2", "map-agent-list-delete-undone");
});


test("CLI group creation and rename appear live and the map undoes the rename", async ({ page }) => {
  await seedWorld();
  const sandboxEnv = JSON.parse(fs.readFileSync(`/tmp/joyride-e2e-${PORT}/env.json`, "utf8"));
  const env = { ...process.env, ...sandboxEnv, JOYRIDE_URL: `http://127.0.0.1:${PORT}`, FM_TASK_ID: "jr-agent-parity-e2e" };
  const cli = async (args: string[]) => JSON.parse((await exec(path.resolve("bin/joyride"), ["map", ...args], { env })).stdout);
  await page.goto("/");
  await page.getByRole("radio", { name: "Mid" }).click();
  await expect(page.locator('[data-rail="nudges"]')).toBeVisible();
  const created = await cli(["new-group", "Agent scratch"]);
  const group = page.locator(`.region-label[data-region="lens:${created.lens}"]`);
  await expect(group).toBeVisible();
  await expect(group.locator(".rl-title")).toHaveText("Agent scratch");
  const renamed = await cli(["rename-group", created.lens, "Agent drafts"]);
  await expect(group.locator(".rl-title")).toHaveText("Agent drafts");
  const toast = page.locator(`[data-toast="tidied:${renamed.commit}"]`);
  await expect(toast).toContainText("Map edit by jr-agent-parity-e2e");
  await toast.hover();
  await shot(page, "C2", "map-agent-group-renamed");
  await toast.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(group.locator(".rl-title")).toHaveText("Agent scratch");
  await shot(page, "C2", "map-agent-group-rename-undone");
  await cli(["delete-group", created.lens]);
  await expect(group).toHaveCount(0);
});


test("a CLI session move and set-aside appear live, and map Undo returns the worker", async ({ page }) => {
  await seedWorld();
  const key = `claude:${FAKE_SESSIONS.claudeWorking}`;
  expect((await call("POST", "/api/missions/move", { session: key, to: { mission: null } })).status).toBe(200);
  const sandboxEnv = JSON.parse(fs.readFileSync(`/tmp/joyride-e2e-${PORT}/env.json`, "utf8"));
  const env = { ...process.env, ...sandboxEnv, JOYRIDE_URL: `http://127.0.0.1:${PORT}`, FM_TASK_ID: "jr-agent-parity-e2e" };
  const cli = async (args: string[]) => JSON.parse((await exec(path.resolve("bin/joyride"), ["map", ...args], { env })).stdout);
  const prior = (await call("GET", "/api/nudges")).body;
  for (const nudge of [...prior.nudges, ...prior.overflow]) {
    expect((await call("POST", `/api/nudges/${nudge.id}/act`, { action: "dismiss" })).status).toBe(200);
  }
  await page.goto("/");
  await page.getByRole("radio", { name: "Mid" }).click();
  await expect(page.locator('[data-rail="nudges"]')).toBeVisible();
  const worker = page.locator(`[data-worker="${W.working}"]`);
  await expect(worker).toBeVisible();
  const group = await cli(["new-group", "Agent sessions"]);
  await cli(["move-session", key, "--to-group", group.lens]);
  await expect(worker).toHaveAttribute("data-region", `lens:${group.lens}`);
  await shot(page, "C2", "map-agent-session-in-group");
  await cli(["file-session", key, "--to-idea", "none"]);
  await expect(worker).toHaveAttribute("data-region", "unfiled:alpha");
  await cli(["hide", key]);
  await expect(worker).toHaveCount(0);
  const history = await cli(["history"]);
  const hidden = history.find((r: { key?: string; undone: boolean }) => r.key === key && !r.undone);
  expect(hidden).toMatchObject({ commit: null, actor: { id: "jr-agent-parity-e2e" } });
  const toast = page.locator(`[data-toast="tidied:${hidden.id}"]`);
  await expect(toast).toContainText("Map edit by jr-agent-parity-e2e");
  await toast.hover();
  await shot(page, "C2", "map-agent-hidden");
  await toast.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(worker).toBeVisible();
  await expect(worker).toHaveAttribute("data-region", "unfiled:alpha");
  await shot(page, "C2", "map-agent-hide-undone");
  await cli(["delete-group", group.lens]);
});
