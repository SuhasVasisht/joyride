import { test, expect, type APIRequestContext } from "@playwright/test";
import { shot } from "./shot";
import { stopFixtureFirstmate } from "./fixture-cleanup";

// A half-set-up Mac, through the daemon's test fakes (JOYRIDE_TEST): nothing external runs and
// every install goes through the test runner, which only logs what it would have run.
async function halfSetUp(request: APIRequestContext) {
  const r = await request.post("/api/system/setup/test-fakes", {
    data: {
      reset: true,
      tools: { git: "/usr/bin/git", node: "/opt/homebrew/bin/node", jq: "/usr/bin/jq", herdr: "/opt/homebrew/bin/herdr", codex: "/opt/homebrew/bin/codex", "chrome-devtools-axi": "/Users/you/.nvm/versions/node/v20.20.0/bin/chrome-devtools-axi" },
      components: { hooks: "claude hooks: 8/8, codex hooks: 6/6", skills: "installed", pstack: "45 skills linked", evals: "claude 9/9, codex 9/9" },
      commands: { "codex login status": { code: 0, out: "Logged in using ChatGPT\n" } },
      screens: ["❯ ", "  ⚠ Your login expires in 1 day · run /login to renew"],
    },
  });
  expect(r.ok()).toBeTruthy();
}

test.beforeEach(async ({ request }) => { await stopFixtureFirstmate(); await halfSetUp(request); });

test("setup: the checklist groups what is required, shows progress, and a fix button installs through the API", async ({ page }) => {
  await page.goto("/#/setup");
  await expect(page.getByRole("heading", { name: "Set up Joyride", level: 1 })).toBeVisible();
  await expect(page.getByTestId("setup-page").getByText(/of \d+ required steps done/)).toBeVisible();
  const required = page.locator('[data-group="required"]');
  const optional = page.locator('[data-group="optional"]');
  await expect(required.getByRole("heading", { name: "Required" })).toBeVisible();
  await expect(optional.getByRole("heading", { name: "Optional" })).toBeVisible();
  await expect(required.locator('[data-item="herdr"]')).toHaveAttribute("data-status", "ok");
  await expect(required.locator('[data-item="claude-login"]')).toContainText("expires in 1 day");
  await expect(required.locator('[data-item="codex-hooks-trust"]')).toContainText("/hooks");
  await expect(required.locator('[data-item="firstmate"]').getByRole("button", { name: "Start Firstmate" })).toBeVisible();
  await expect(optional.locator('[data-item="gh-login"]').getByRole("button", { name: "Log in to GitHub" })).toBeDisabled();
  await expect(optional.locator('[data-item="tool:gh"]')).toContainText("brew install gh");
  const tree = required.locator('[data-item="tool:treehouse"]');
  await expect(tree).toHaveAttribute("data-status", "missing");
  await expect(tree).toContainText("curl -fsSL https://kunchenguid.github.io/treehouse/install.sh | sh");
  await page.mouse.move(0, 0);
  // The page scrolls inside .main, so a tall viewport captures the whole checklist.
  const h = await page.evaluate(() => (document.querySelector(".main")?.scrollHeight ?? 900) + 60);
  await page.setViewportSize({ width: 1440, height: Math.min(4000, Math.max(900, h)) });
  await shot(page, "C11", "setup");
  await page.setViewportSize({ width: 1440, height: 900 });

  // The install button calls the API, shows the streamed output, and the item rechecks to done.
  const call = page.waitForRequest((r) => r.url().endsWith("/api/system/install") && r.method() === "POST");
  await tree.getByRole("button", { name: "Install treehouse" }).click();
  expect((await call).postDataJSON()).toEqual({ component: "treehouse" });
  await expect(tree.locator(".su-out")).toContainText("(test) would run: curl -fsSL https://kunchenguid.github.io/treehouse/install.sh | sh");
  await expect(tree).toContainText("Logged in GLOBAL_CHANGES.md");
  await expect(tree).toHaveAttribute("data-status", "ok");
  await tree.scrollIntoViewIfNeeded();
  await shot(page, "C11", "setup-installed");

  // Codex hook trust can't be detected: "Mark as done" records it.
  const trust = required.locator('[data-item="codex-hooks-trust"]');
  await trust.getByRole("button", { name: "Mark as done" }).click();
  await expect(trust).toHaveAttribute("data-status", "ok");
});

test("setup: the GitHub login opens a Herdr pane once gh is installed", async ({ page, request }) => {
  await request.post("/api/system/setup/test-fakes", { data: { tools: { gh: "/opt/homebrew/bin/gh" }, commands: { "gh auth status --hostname github.com": { code: 1, out: "You are not logged into any GitHub hosts." } } } });
  await page.goto("/#/setup");
  const item = page.locator('[data-item="gh-login"]');
  await expect(item).toHaveAttribute("data-status", "missing");
  const call = page.waitForRequest((r) => r.url().endsWith("/api/system/setup/gh-login") && r.method() === "POST");
  await item.getByRole("button", { name: "Log in to GitHub" }).click();
  await call;
  await expect(item.getByText(/Waiting for gh to show a one-time code|Opening a login pane/)).toBeVisible({ timeout: 10000 });
  await expect(item.getByRole("button", { name: "Show the pane in Herdr" })).toBeVisible({ timeout: 10000 });
});

test("setup is reachable from the guide's first step, the rail card, Settings and the palette", async ({ page }) => {
  await page.goto("/#/start");
  const step = page.locator(".guide-setup");
  await expect(step.getByRole("heading", { name: "Set up Joyride" })).toBeVisible();
  await step.getByRole("button", { name: "Finish setting up" }).click();
  await expect(page).toHaveURL(/#\/setup$/);

  await page.goto("/#/map");
  const card = page.getByRole("region", { name: "Getting started" });
  await expect(card.getByRole("heading", { name: "New here? Start with setup" })).toBeVisible();
  await expect(card.getByRole("meter")).toBeVisible();
  await card.getByRole("button", { name: "Set up Joyride" }).click();
  await expect(page.getByRole("heading", { name: "Set up Joyride", level: 1 })).toBeVisible();

  await page.goto("/#/settings");
  await page.getByRole("link", { name: "Set up Joyride" }).click();
  await expect(page).toHaveURL(/#\/setup$/);

  await page.goto("/#/map");
  await page.getByRole("button", { name: "Open command palette" }).click();
  await page.keyboard.type("Set up Joyride");
  await page.getByRole("option", { name: "Set up Joyride", exact: true }).click();
  await expect(page).toHaveURL(/#\/setup$/);
});
