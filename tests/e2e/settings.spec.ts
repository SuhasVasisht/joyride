// Settings (C10): daemon, models with per-task heavy-LLM overrides, notifications
// with a test, the guard policy and remembered allows, installed components and
// metrics. Also: the topbar fits at 1280px with every page, secondary ones under "More".
import { test, expect } from "@playwright/test";
import { shot } from "./shot";
import { call, guardRequest } from "./map-seed";

test("the topbar fits at 1280px; Settings stays under More after removing evolution", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/#/map");
  const nav = page.getByRole("navigation", { name: "Main" });
  for (const name of ["Map", "Agents", "Search", "Usage"]) await expect(nav.getByRole("link", { name: new RegExp(`^${name}`) })).toBeVisible();
  const fits = await page.evaluate(() => {
    const bar = document.querySelector(".topbar") as HTMLElement;
    const kids = [...bar.children].map((c) => c.getBoundingClientRect());
    return bar.scrollWidth <= bar.clientWidth && kids.every((r) => r.right <= window.innerWidth) && document.documentElement.scrollWidth <= window.innerWidth;
  });
  expect(fits).toBe(true);
  const more = nav.getByRole("button", { name: "More" });
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await more.click();
  const menu = page.getByRole("menu", { name: "More pages" });
  await expect(menu.getByRole("menuitem", { name: "Settings" })).toBeVisible();
  for (const name of ["Hill-climb", "Evolve", "Capabilities"]) await expect(menu.getByRole("menuitem", { name })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(more).toBeFocused();
  // Keyboard: ArrowDown opens the menu and moves into it.
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await expect(menu.getByRole("menuitem", { name: "Settings" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/settings/);
  await expect(nav.getByRole("button", { name: "Settings" })).toHaveClass(/active/);
  await shot(page, "C10", "nav-1280");
});

test("settings: models, notifications, guard, components and metrics", async ({ page }) => {
  const g = await guardRequest("Publish the package", "npm publish --access public", { rule: "publish" });
  await call("POST", `/api/guard/requests/${g.id}/decide`, { decision: "allow", reason: "approved in Joyride", remember: { scope: "session", hours: 24 } });

  await page.goto("/#/settings");
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  const toc = page.getByRole("navigation", { name: "Settings sections" });
  for (const name of ["Daemon", "Models", "Notifications", "Guard", "Installed components", "Metrics"]) await expect(toc.getByRole("link", { name })).toBeVisible();

  const daemon = page.locator('[data-settings="daemon"]');
  await expect(daemon).toContainText("Main daemon");
  await expect(daemon).toContainText(/127\.0\.0\.1:\d+/);

  const originalYaml = (await call<{ yaml: string }>("GET", "/api/system/config")).body.yaml;
  const originalComments = originalYaml.split("\n").filter((line) => line.trimStart().startsWith("#"));

  // Models: Jev runs on fakes here; override one task's heavy model and save (a commit).
  const models = page.locator('[data-settings="models"]');
  await expect(models.locator(".st-avail")).toHaveText("Available");
  await expect(models.getByLabel("Default backend")).toHaveValue("codex");
  await expect(models.getByLabel("Default effort")).toHaveValue("medium");
  await expect(models.getByLabel("Effort for session_intent")).toHaveValue("low");
  await expect(models.getByLabel("Model for hillclimb_proposer")).toHaveCount(0);
  await models.getByLabel("Backend for screenshot_caption").selectOption("claude");
  await models.getByLabel("Model for screenshot_caption").fill("sonnet");
  await models.getByLabel("Effort for screenshot_caption").selectOption("max");
  await models.getByRole("button", { name: "Save model settings" }).click();
  await expect(models.getByRole("status")).toContainText("Saved");
  const cfg = (await call<any>("GET", "/api/system/config")).body;
  expect(cfg.yaml.split("\n").filter((line: string) => line.trimStart().startsWith("#"))).toEqual(originalComments);
  expect(cfg.yaml).toContain("session_intent:       { backend: codex, model: gpt-6-luna,  effort: low }");
  expect(cfg.config.llm.tasks.screenshot_caption).toEqual({ backend: "claude", model: "sonnet", effort: "max" });
  await expect(models.getByTestId("unknown-llm-tasks")).toHaveCount(0);
  await shot(page, "C10", "settings-models-effort");

  // An override whose key no task uses is flagged, since it would silently never apply.
  await call("PUT", "/api/system/config", { llm: { tasks: { ...cfg.config.llm.tasks, memory_merge: { backend: "codex", model: "gpt-6-luna" } } } });
  await page.reload();
  await expect(models.getByTestId("unknown-llm-tasks")).toContainText("memory_merge");
  await expect(models.locator('tr[data-task="memory_merge"]')).toContainText("No task uses this key");
  await models.getByTestId("unknown-llm-tasks").scrollIntoViewIfNeeded();
  await shot(page, "C10", "settings-unknown-task");
  await call("PUT", "/api/system/config", { llm: { tasks: cfg.config.llm.tasks } });
  await page.reload();
  await expect(models.getByTestId("unknown-llm-tasks")).toHaveCount(0);
  await models.getByText("Show joyride.config.yaml").click();
  await expect(models.getByLabel("joyride.config.yaml")).toContainText("sonnet");
  await expect(models.getByLabel("joyride.config.yaml")).toContainText("# Joyride configuration.");
  await models.getByLabel("joyride.config.yaml").scrollIntoViewIfNeeded();
  await shot(page, "C10", "settings-config-comments");

  // Notifications: level and macOS toggle save; the test reports why nothing is sent in a sandbox.
  const notify = page.locator('[data-settings="notifications"]');
  await notify.getByRole("radio", { name: /L4/ }).check();
  await notify.getByLabel("Show macOS notifications").uncheck();
  await notify.getByRole("button", { name: "Save notification settings" }).click();
  await expect.poll(async () => (await call<any>("GET", "/api/system/config")).body.config.notifications).toEqual({ macos: false, min_level: "L4" });
  const notificationYaml = (await call<{ yaml: string }>("GET", "/api/system/config")).body.yaml;
  expect(notificationYaml.split("\n").filter((line) => line.trimStart().startsWith("#"))).toEqual(originalComments);
  await notify.getByRole("button", { name: "Send a test notification" }).click();
  await expect(notify.locator("[data-notify-test]")).toContainText("Not sent: notifications are disabled in this environment");

  // Guard: the policy's rules, the remembered allow (with Forget) and recent decisions.
  const guard = page.locator('[data-settings="guard"]');
  await expect(guard.locator('[data-guard-rule="git-push"]')).toContainText("Git push to a remote");
  await expect(guard).toContainText("wait up to 5 minutes for you");
  const allow = guard.locator("[data-allow-rule]", { hasText: "Package publish" });
  await expect(allow).toHaveCount(1);
  await expect(allow).toContainText("Claude Code session");
  await expect(guard.locator(`[data-guard-request="${g.id}"]`)).toContainText("Allowed");
  await guard.scrollIntoViewIfNeeded();
  await shot(page, "C10", "settings-guard");
  await allow.getByRole("button", { name: /Forget the allow/ }).click();
  await expect(allow).toHaveCount(0);
  expect((await call<any[]>("GET", "/api/guard/rules")).body.some((r) => r.rule === "publish")).toBe(false);

  const comps = page.locator('[data-settings="components"]');
  await expect(comps.locator('[data-component="hooks"]')).toBeVisible();
  const metrics = page.locator('[data-settings="metrics"]');
  await expect(metrics.locator('[data-metric="unblock-1d"]')).toBeVisible();
  await expect(metrics.locator('[data-metric="checking"] svg')).toBeVisible();

  await page.evaluate(() => document.querySelector(".main")?.scrollTo(0, 0));
  await toc.getByRole("link", { name: "Models" }).click();
  await expect(toc.getByRole("link", { name: "Models" })).toHaveClass(/on/);
  await page.evaluate(() => document.querySelector(".main")?.scrollTo(0, 0));
  await shot(page, "C10", "settings");
});

test("captain guidance is read-only and explains installation when absent", async ({ page }) => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = (await call<{ daemon: { root: string } }>("GET", "/api/system/status")).body.daemon.root;
  expect(root).toMatch(/^\/tmp\/joyride-e2e-/);
  const file = path.join(root, "guidance/captain.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "# Captain guidance\n\nNever push. Record proof with joyride-evidence.\n");
  try {
    await page.goto("/#/settings");
    const section = page.locator('[data-settings="guidance"]');
    await section.scrollIntoViewIfNeeded();
    await expect(section.getByLabel("Captain guidance")).toContainText("Never push.");
    await expect(section.locator("textarea, input, button")).toHaveCount(0);
    await expect(section).toContainText(file);
    await shot(page, "C10", "settings-captain-guidance");
    fs.unlinkSync(file);
    await page.reload();
    await section.scrollIntoViewIfNeeded();
    await expect(section).toContainText("Guidance is not installed");
    await expect(section).toContainText("./bin/joyride install guidance");
    await shot(page, "C10", "settings-guidance-absent");
  } finally { fs.rmSync(file, { force: true }); }
});

test("daemon sleep toggle saves, reloads and releases its assertion", async ({ page }) => {
  await call("PUT", "/api/system/config", { daemon: { prevent_sleep: false } });
  await page.goto("/#/settings");
  const daemon = page.locator('[data-settings="daemon"]');
  const toggle = daemon.getByRole("switch", { name: "Prevent automatic system sleep while the daemon runs" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  if (process.platform !== "darwin") {
    await expect(toggle).toBeDisabled();
    await expect(daemon).toContainText("only supported on macOS");
    return;
  }
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(daemon.getByRole("status")).toContainText("Active: macOS");
  expect((await call<any>("GET", "/api/system/config")).body.config.daemon.prevent_sleep).toBe(true);
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(daemon.getByRole("status")).toContainText("Active: macOS");
  await shot(page, "C10", "settings-sleep-on");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(daemon.getByRole("status")).toHaveText("Sleep prevention is off.");
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(daemon.getByRole("status")).toHaveText("Sleep prevention is off.");
  await shot(page, "C10", "settings-sleep-off");
});

test("sleep pill waits for the daemon to apply, blocks repeats and restores on failure", async ({ page }) => {
  test.skip(process.platform !== "darwin", "needs the macOS sleep assertion");
  await call("PUT", "/api/system/config", { daemon: { prevent_sleep: false } });
  let release: () => void = () => {};
  let puts = 0;
  let fail = false;
  await page.route("**/api/system/config", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    puts++;
    if (fail) return route.fulfill({ status: 500, json: { error: "joyride.config.yaml is read-only" } });
    await new Promise<void>((resolve) => { release = resolve; });
    await route.fallback();
  });
  await page.goto("/#/settings");
  const daemon = page.locator('[data-settings="daemon"]');
  const pill = daemon.getByRole("switch", { name: "Prevent automatic system sleep while the daemon runs" });
  await expect(pill).toHaveAttribute("aria-checked", "false");
  await expect(pill).toHaveText("Off");

  // Keyboard on: the pill stays Off and focused while the request is held.
  await pill.focus();
  await page.keyboard.press("Space");
  await expect(pill).toHaveText("Turning on…");
  await expect(pill).toHaveAttribute("aria-busy", "true");
  await expect(pill).toHaveAttribute("aria-checked", "false");
  await expect(pill).toHaveAttribute("data-on", "false");
  await expect(daemon.getByRole("status")).toContainText("asking macOS to prevent sleep");
  await page.keyboard.press("Space");
  await page.keyboard.press("Enter");
  await pill.click({ force: true });
  await shot(page, "jr-sleep-pill", "pending-on");
  expect(puts).toBe(1);
  release();
  await expect(pill).toHaveAttribute("aria-checked", "true");
  await expect(pill).toHaveText("On");
  await expect(pill).not.toHaveAttribute("aria-busy", "true");
  await expect(pill).toBeFocused();
  await expect(daemon.getByRole("status")).toContainText("Active: macOS");
  await shot(page, "jr-sleep-pill", "confirmed-on");

  // Reload reconciles from the daemon.
  await page.reload();
  await expect(pill).toHaveAttribute("aria-checked", "true");

  // Off: same pending hold, then confirmed release.
  await pill.focus();
  await page.keyboard.press("Enter");
  await expect(pill).toHaveText("Turning off…");
  await expect(pill).toHaveAttribute("aria-checked", "true");
  await shot(page, "jr-sleep-pill", "pending-off");
  release();
  await expect(pill).toHaveAttribute("aria-checked", "false");
  await expect(pill).toHaveText("Off");
  await expect(daemon.getByRole("status")).toHaveText("Sleep prevention is off.");
  await shot(page, "jr-sleep-pill", "confirmed-off");

  // Failure keeps the confirmed value and says why.
  fail = true;
  await pill.click();
  await expect(daemon.getByRole("alert")).toContainText("Could not turn sleep prevention on: joyride.config.yaml is read-only. It is still off.");
  await expect(pill).toHaveAttribute("aria-checked", "false");
  await expect(pill).toHaveText("Off");
  expect((await call<any>("GET", "/api/system/config")).body.config.daemon.prevent_sleep).toBe(false);
  await shot(page, "jr-sleep-pill", "failure-restored");
});

test("sleep pill honours reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await call("PUT", "/api/system/config", { daemon: { prevent_sleep: false } });
  await page.route("**/api/system/config", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    await new Promise((r) => setTimeout(r, 400));
    await route.fulfill({ status: 500, json: { error: "held for the test" } });
  });
  await page.goto("/#/settings");
  const pill = page.locator('[data-settings="daemon"]').getByRole("switch");
  await expect(pill).toHaveText("Off");
  await pill.click();
  await expect(pill).toHaveText("Turning on…");
  const motion = await pill.evaluate((el) => {
    const knob = getComputedStyle(el.querySelector(".st-pill-knob")!);
    return { animation: knob.animationName, transition: knob.transitionDuration };
  });
  expect(motion.animation).toBe("none");
  expect(motion.transition).toBe("0s");
  await shot(page, "jr-sleep-pill", "reduced-motion-pending");
  await expect(pill).toHaveText("Off");
});

test("daemon sleep status reports startup errors and unsupported systems", async ({ page }) => {
  await call("PUT", "/api/system/config", { daemon: { prevent_sleep: false } });
  let state: object = { state: "error", error: "Could not prevent sleep: native assertion failed. Turn the setting off and on to retry." };
  await page.route("**/api/system/status", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.daemon.sleep_prevention = state;
    await route.fulfill({ response, json: body });
  });
  await page.goto("/#/settings");
  const daemon = page.locator('[data-settings="daemon"]');
  await expect(daemon.getByRole("status")).toContainText("native assertion failed");
  await expect(daemon.getByRole("status")).not.toContainText("Active:");
  await shot(page, "C10", "settings-sleep-error");
  state = { state: "unsupported" };
  await page.reload();
  await expect(daemon.getByRole("switch")).toBeDisabled();
  await expect(daemon.getByRole("status")).toHaveText("Sleep prevention is only supported on macOS.");
  await shot(page, "C10", "settings-sleep-unsupported");
});
