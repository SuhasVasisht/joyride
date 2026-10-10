// The control plane against real software (scripts/lab-control-plane.sh): an isolated Herdr lab session with
// one real Claude Code crewmate and a throwaway Firstmate lab home. The test plays Firstmate with its real
// scripts (tasks-axi, fm-captain-hold.sh) and the captain on the map. Proves:
//   1. a captain call answered on the map closes a real held task through fm-captain-hold.sh and tasks-axi;
//   2. a keyed decision answered on the map reaches the real crewmate pane's inbox through fm-send.sh, whose
//      doorbell goes through Firstmate's lab helper, and the worker acks it (moves it to handled/).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test, expect, type Page } from "@playwright/test";
import { shot } from "./shot";
import { call, PORT, waitUntil } from "./map-seed";

const LAB = process.env.E2E_LAB_HERDR_SOCKET;
const FMH = process.env.E2E_LAB_FM_HOME ?? "";
const SESSION = process.env.E2E_LAB_HERDR_SESSION ?? "";
const HELPER = process.env.E2E_LAB_HERDR_HELPER ?? "";
const FM_DIR = process.env.JOYRIDE_FIRSTMATE_DIR ?? "";
const MODEL_LOG = process.env.E2E_LAB_MODEL_LOG ?? "";
const [PANE, CREW_DIR] = (process.env.E2E_LAB_CREW ?? "=").split("=");
const WORKSPACE = process.env.E2E_LAB_CREW_WORKSPACE ?? "";
const TASK = process.env.E2E_LAB_CREW_TASK ?? "lab-scout";
const CALL = "lab-export-calls", IDEA = "cp8-lab-export", KEY = "flake-cause";
const REASON = "Two calls for the export. 1) Where the totals row goes: (A, recommended) the last row; (B) the first row. 2) Which file format: (A) CSV only; (B, recommended) CSV and XLSX.";
const CALL_WORDS = "Keep the server's rounding.";
const DECISION_WORDS = "Fix the download race first, then the timezone default.";
const CP = "C12";

test.skip(!LAB || !fs.existsSync(path.join(FMH, ".fm-lab-home")) || !SESSION.startsWith("fm-lab-"), "Herdr lab only: run scripts/lab-control-plane.sh");
test.describe.configure({ mode: "serial" });

const sandbox = `/tmp/joyride-e2e-${PORT}`;
const env = (): Record<string, string> => JSON.parse(fs.readFileSync(`${sandbox}/env.json`, "utf8"));
const backlog = () => fs.readFileSync(path.join(FMH, "data", "backlog.md"), "utf8");
const statusLog = () => fs.readFileSync(path.join(FMH, "state", `${TASK}.status`), "utf8");
const inbox = path.join(FMH, "state", `${TASK}.inbox`);
const msgs = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(".msg")) : []);
const modelSaw = (text: string) => fs.existsSync(MODEL_LOG) && fs.readFileSync(MODEL_LOG, "utf8").includes(text);
const epoch = (msAgo = 0) => Math.floor((Date.now() - msAgo) / 1000);

/** One of Firstmate's real commands, run in the lab home the way Firstmate runs it. */
function fm(cmd: string, args: string[]) {
  const e: Record<string, string> = { ...(process.env as Record<string, string>), FM_HOME: FMH, TASKS_AXI_BACKEND: "markdown", JOYRIDE_GUARD: "off" };
  for (const k of ["FM_TASK_ID", "FM_TASK_INBOX", "FM_STATE_OVERRIDE", "FM_DATA_OVERRIDE", "FM_CONFIG_OVERRIDE", "FM_ROOT_OVERRIDE"]) delete e[k];
  const r = spawnSync(cmd, args, { cwd: FMH, env: e, encoding: "utf8", timeout: 60_000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  console.log(`$ FM_HOME=<lab> ${path.basename(cmd)} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}  (exit ${r.status})\n${out.trim()}`);
  return { code: r.status, out };
}
const tasksAxi = (args: string[]) => fm("tasks-axi", [...args, "--file", path.join(FMH, "data", "backlog.md")]);

async function zoom(page: Page, level: "Far" | "Mid" | "Near") {
  await page.getByRole("radio", { name: level }).click();
  await expect(page.locator(".map-viewport")).toHaveAttribute("data-zoom", level.toLowerCase());
}
/** Bring an idea into view at near zoom: focus its title, which centres it. */
async function nearOn(page: Page, mission: string) {
  const node = page.locator(`.mission-node[data-mission="${mission}"]`);
  await expect(node).toBeVisible();
  await node.locator(".mn-title").focus();
  await zoom(page, "Near");
  await node.locator(".mn-title").focus();
  return node;
}

test.beforeAll(async () => {
  // fm-send rings the crewmate's doorbell with `herdr ... --session <s>`. Under JOYRIDE_TEST the daemon puts
  // this folder first on fm-send's PATH, so every one of those calls goes through Firstmate's lab helper,
  // scoped to the lab session (the helper refuses server and session operations, and any other session).
  const stubs = path.join(env().JOYRIDE_RUNTIME, "firstmate-stubs");
  fs.mkdirSync(stubs, { recursive: true });
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  fs.writeFileSync(path.join(stubs, "herdr"), [
    "#!/usr/bin/env bash",
    "# Lab doorbell shim (tests/e2e/control-plane-lab.spec.ts): Firstmate's herdr calls, through its lab helper.",
    `SESSION=${q(SESSION)}; HELPER=${q(HELPER)}; LOG=${q(path.join(stubs, "calls.log"))}`,
    'args=(); want=""',
    'for a in "$@"; do',
    '  if [ -n "$want" ]; then [ "$a" = "$SESSION" ] || { echo "lab shim: refusing herdr session $a" >&2; exit 1; }; want=""; continue; fi',
    '  case "$a" in',
    '    --session) want=1 ;;',
    '    --session=*) [ "${a#--session=}" = "$SESSION" ] || { echo "lab shim: refusing herdr session ${a#--session=}" >&2; exit 1; } ;;',
    '    *) args+=("$a") ;;',
    '  esac',
    "done",
    'printf "herdr(lab) %s\\n" "${args[*]}" >> "$LOG"',
    "unset HERDR_SESSION",
    "# The helper runs the real herdr from PATH: take this folder off it, or the helper would call this shim again.",
    `STUBS=${q(stubs)}; PATH=":$PATH:"; PATH="\${PATH//:$STUBS:/:}"; PATH="\${PATH#:}"; export PATH="\${PATH%:}"`,
    'exec "$HELPER" run "$SESSION" "${args[@]}"',
    "",
  ].join("\n"), { mode: 0o755 });

  if ((await call("GET", `/api/missions/${IDEA}`)).status === 404) {
    expect((await call("POST", "/api/missions", { id: IDEA, title: "Ship the CSV export (lab)", repos: [CREW_DIR] })).status).toBe(201);
  }
  // The crewmate's task, recorded the way bin/fm-spawn.sh records a Herdr launch.
  expect(tasksAxi(["add", TASK, "SCOUT why the export test flakes on CI", "--kind", "scout", "--start"]).code).toBe(0);
  fs.writeFileSync(path.join(FMH, "state", `${TASK}.meta`), [
    `window=${SESSION}:${PANE}`, `endpoint_task_id=${TASK}`, `worktree=${CREW_DIR}`, `project=${CREW_DIR}`, "harness=claude", "kind=scout",
    `branch=fm/${TASK}`, "backend=herdr", `herdr_session=${SESSION}`, `herdr_workspace_id=${WORKSPACE}`, `herdr_pane_id=${PANE}`, "",
  ].join("\n"));
  fs.mkdirSync(path.join(FMH, "data", TASK), { recursive: true });
  fs.writeFileSync(path.join(FMH, "data", TASK, "brief.md"), `# Why the export test flakes\n\n## Captain's intent\n\njoyride-mission: ${IDEA}\n\nFind out why the CSV export e2e test fails one run in five on CI.\n`);
  fs.writeFileSync(path.join(FMH, "state", `${TASK}.status`), `working [at=${epoch(10 * 6e4)}]: reading CI logs\n`);
  await waitUntil(async () => (await call("GET", `/api/firstmate/tasks/${TASK}`)).body?.mission === IDEA, 20_000);
});

test("a captain call answered on the map closes the real held task through fm-captain-hold.sh and tasks-axi", async ({ page }) => {
  test.setTimeout(120_000);
  // Firstmate holds the call for the captain with its real intake: the scout's report raised it.
  const held = fm(path.join(FM_DIR, "bin", "fm-captain-hold.sh"), ["hold", CALL, "--title", "Export: where the totals go and which format", "--repo", "alpha", "--origin", TASK, "--reason", REASON]);
  expect(held.code).toBe(0);
  expect(backlog()).toMatch(new RegExp(`- \\[ \\] ${CALL} .*\\(hold-kind: captain\\)`));
  await waitUntil(async () => (await call("GET", "/api/asks")).body.asks.some((a: { id: string }) => a.id === `hold:${CALL}`), 20_000);

  await page.setViewportSize({ width: 1600, height: 1600 });
  await page.goto("/#/");
  const idea = await nearOn(page, IDEA);
  const card = idea.locator(`.ask-card[data-ask="hold:${CALL}"]`);
  await expect(card).toContainText("Needs you");
  await expect(card.getByRole("radio", { name: /the last row/ })).toBeChecked();
  await card.getByRole("button", { name: "Add your own words" }).click();
  await card.getByRole("textbox", { name: "Your answer" }).fill(CALL_WORDS);
  await card.scrollIntoViewIfNeeded();
  await shot(page, CP, "lab-01-call-on-map");
  await card.getByRole("button", { name: "Use all recommendations" }).click();

  const words = `Go with your recommendations: 1 A, 2 B. ${CALL_WORDS}`;
  await waitUntil(async () => backlog().includes(`- [x] ${CALL}`), 30_000);
  const shown = tasksAxi(["show", CALL, "--full"]);
  expect(shown.code).toBe(0);
  expect(shown.out).toMatch(/state: done/);
  expect(shown.out).toContain("Resolution recorded by fm-captain-hold");
  expect(shown.out).toContain(words);
  expect(shown.out).toContain("joyride-map");
  await expect(card).toHaveCount(0, { timeout: 15_000 });
  await shot(page, CP, "lab-02-call-closed");
});

test("a keyed decision answered on the map reaches the real crewmate's inbox, and the crewmate acks it", async ({ page }) => {
  test.setTimeout(240_000);
  const target = `decision:${TASK}:${KEY}`;
  fs.appendFileSync(path.join(FMH, "state", `${TASK}.status`), `needs-decision [key=${KEY}] [at=${epoch(6e4)}]: two causes found, a timezone default and a race in the download handler; pick which to fix first\n`);
  // Wait for the suggested options too, so the card does not change shape while the captain types.
  await waitUntil(async () => (await call("GET", `/api/asks/${encodeURIComponent(target)}`)).body?.options_source === "suggested", 30_000);

  await page.setViewportSize({ width: 1600, height: 1600 });
  await page.goto("/#/");
  const idea = await nearOn(page, IDEA);
  const card = idea.locator(`.ask-card[data-ask="${target}"]`);
  await expect(card).toContainText("Firstmate is deciding");
  await card.getByRole("button", { name: "Add your own words" }).click();
  await card.getByRole("textbox", { name: "Your answer" }).fill(DECISION_WORDS);
  await card.scrollIntoViewIfNeeded();
  await shot(page, CP, "lab-03-decision-on-map");
  await card.getByRole("button", { name: "Send these choices" }).click();

  // fm-send closes the key at enqueue time and writes the durable inbox record.
  await waitUntil(async () => new RegExp(`resolved .*\\[key=${KEY}\\].*answered: ${DECISION_WORDS.replace(/[.,]/g, "\\$&")}`).test(statusLog()), 30_000);
  // The doorbell went through the lab helper into the real pane, and the crewmate read and acked the message.
  await waitUntil(async () => modelSaw("Firstmate instruction waiting"), 90_000);
  const handled = path.join(inbox, "handled");
  await waitUntil(async () => msgs(inbox).length === 0 && msgs(handled).some((n) => fs.readFileSync(path.join(handled, n), "utf8").includes(DECISION_WORDS)), 90_000);
  const shim = fs.readFileSync(path.join(env().JOYRIDE_RUNTIME, "firstmate-stubs", "calls.log"), "utf8");
  expect(shim).toMatch(/herdr\(lab\) pane /);
  expect(shim).not.toMatch(/^herdr .*server/m);
  const screen = String((await call<any>("GET", `/api/workers/${encodeURIComponent(`local:${PANE}`)}/screen`)).body?.screen ?? "");
  console.log(`crewmate screen after the ack:\n${screen.split("\n").slice(-25).join("\n")}`);
  await expect(card).toHaveCount(0, { timeout: 15_000 });
  await page.goto(`/#/worker/${encodeURIComponent(`local:${PANE}`)}?tab=terminal`);
  await expect(page.locator(".xterm-rows")).toContainText("handled", { timeout: 15_000 }); // the Bash call that moved it
  await shot(page, CP, "lab-04-crewmate-acked");
});
