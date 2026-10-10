// Setup checklist: tool specs and install commands (mirroring fm-bootstrap.sh), Node selection
// for npm tools, item computation with stubbed probes, the GitHub login screen parser, and the
// routes (install jobs through the test runner, gh login in a fake Herdr pane). Nothing is installed.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sandboxDaemon } from "../sandbox.ts";
import { startFakeHerdr, waitFor, assertSandboxed, type FakeHerdr } from "../fixtures/fake-herdr.ts";
import { FM_TOOL_SPECS, INSTALLABLE_TOOLS, findTool, installCommand, minNode, pickNode, toolSpec } from "../../src/modules/system/tools.ts";
import { claudeLoginNotice, computeSetup, isWaiting, type SetupDeps } from "../../src/modules/system/setup.ts";
import { parseGhLogin } from "../../src/modules/system/gh-login.ts";

import { paths } from "../../src/shared/paths.ts";

const hasFirstmate = fs.existsSync(paths.firstmateDir);

process.env.JOYRIDE_HERDR_POLL_MS = "300";

describe("Firstmate tools", () => {
  it.skipIf(!hasFirstmate)(`installs each tool the way fm-bootstrap.sh's install_cmd does${hasFirstmate ? "" : " (skipped: needs vendor/firstmate)"}`, () => {
    const boot = fs.readFileSync(path.join(paths.firstmateDir, "bin", "fm-bootstrap.sh"), "utf8");
    expect(installCommand(toolSpec("gh")!)).toBe("brew install gh");
    expect(installCommand(toolSpec("treehouse")!)).toBe("curl -fsSL https://kunchenguid.github.io/treehouse/install.sh | sh");
    expect(installCommand(toolSpec("no-mistakes")!)).toBe("curl -fsSL https://raw.githubusercontent.com/kunchenguid/no-mistakes/main/docs/install.sh | sh");
    expect(installCommand(toolSpec("tasks-axi")!)).toBe("npm install -g tasks-axi");
    expect(installCommand(toolSpec("gh-axi")!)).toBe("npm install -g gh-axi && gh-axi setup hooks");
    for (const t of FM_TOOL_SPECS.filter((x) => x.method === "curl")) expect(boot).toContain(installCommand(t));
    for (const t of ["gh-axi", "chrome-devtools-axi", "lavish-axi"]) expect(toolSpec(t)!.hooks).toBe(true);
    // Every tool the bootstrap requires for the herdr backend is covered.
    for (const t of ["herdr", "jq", "treehouse", "node", "git", "gh", "no-mistakes", "gh-axi", "chrome-devtools-axi", "tasks-axi", "quota-axi"]) expect(toolSpec(t)).toBeTruthy();
    expect(INSTALLABLE_TOOLS.sort()).toEqual(["chrome-devtools-axi", "gh", "gh-axi", "lavish-axi", "no-mistakes", "quota-axi", "tasks-axi", "treehouse"]);
  });

  it("splits required from optional for local-only projects on the herdr backend", () => {
    const req = FM_TOOL_SPECS.filter((t) => t.tier === "required").map((t) => t.name);
    expect(req).toEqual(["git", "node", "jq", "herdr", "treehouse", "tasks-axi", "quota-axi"]);
    expect(FM_TOOL_SPECS.filter((t) => t.tier === "optional").map((t) => t.name)).toEqual(expect.arrayContaining(["gh", "gh-axi", "no-mistakes", "chrome-devtools-axi", "lavish-axi"]));
  });

  it("registers one installer component per tool", async () => {
    const { components } = await import("../../src/cli/install.ts");
    for (const t of INSTALLABLE_TOOLS) {
      expect(components[t], t).toBeTruthy();
      expect(components[t].describe).toContain(installCommand(toolSpec(t)!));
    }
  });

  it("finds tools on PATH and off it", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "joyride-tools-"));
    const a = path.join(tmp, "a"), b = path.join(tmp, "b");
    fs.mkdirSync(a); fs.mkdirSync(b);
    fs.writeFileSync(path.join(a, "treehouse"), "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(path.join(b, "quota-axi"), "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(path.join(b, "not-exec"), "x", { mode: 0o644 });
    expect(findTool("treehouse", [a, b], [a])).toEqual({ path: path.join(a, "treehouse"), on_path: true });
    expect(findTool("quota-axi", [a, b], [a])).toEqual({ path: path.join(b, "quota-axi"), on_path: false });
    expect(findTool("not-exec", [a, b], [a, b])).toBeNull();
    expect(findTool("gh", [a, b], [a, b])).toBeNull();
  });

  it("picks a Node new enough for an npm tool, preferring the one on PATH", () => {
    expect(minNode(">=22.19")).toEqual([22, 19, 0]);
    expect(minNode(">=20")).toEqual([20, 0, 0]);
    expect(minNode("^20 || >=22")).toEqual([20, 0, 0]);
    expect(minNode("")).toBeNull();
    const cands = [{ dir: "/nvm/v20/bin", version: [20, 20, 0] as [number, number, number] }, { dir: "/nvm/v22/bin", version: [22, 23, 2] as [number, number, number] }];
    expect(pickNode([20, 0, 0], cands)?.dir).toBe("/nvm/v20/bin");
    expect(pickNode([22, 19, 0], cands)?.dir).toBe("/nvm/v22/bin");
    expect(pickNode([24, 0, 0], cands)).toBeNull();
  });
});

// ---------------------------------------------------------------- computeSetup
function deps(over: Partial<SetupDeps> = {}, tools: Record<string, { path: string; on_path: boolean } | null> = {}): SetupDeps {
  return {
    daemon: { pid: 42, port: 4317 },
    componentStatus: (n) => ({ hooks: "claude hooks: 8/8, codex hooks: 6/6", mcp: "claude: present", skills: "installed", pstack: "45 skills linked", evals: "claude 9/9, codex 9/9" } as Record<string, string>)[n] ?? null,
    findTool: (n) => (n in tools ? tools[n] : { path: `/opt/homebrew/bin/${n}`, on_path: true }),
    run: async (cmd, args) => (cmd.endsWith("gh") ? { code: 0, out: "github.com\n  ✓ Logged in to github.com account octocat (keyring)\n" } : { code: 0, out: "Logged in using ChatGPT\n" }),
    herdr: () => ({ connected: true, version: "0.9.3", panes: 7 }),
    herdrStartRoute: true,
    firstmate: () => ({ running: true, pane: { worker: "local:wH:p1", status: "idle" }, herdr_connected: true, vendor: { present: true } }),
    worker: () => ({ id: "local:wH:p1", status: "idle", last_message: "Done. Workers are ready." }),
    claudeScreens: async () => ["❯ "],
    jev: { available: true, key: true, fake: false },
    notifications: { enabled: true, lastTest: { sent: true, at: "2026-10-04T10:00:00Z" } },
    acks: {},
    seen: false,
    test: false,
    ...over,
  };
}
const byId = (r: Awaited<ReturnType<typeof computeSetup>>) => Object.fromEntries(r.items.map((i) => [i.id, i]));

describe("setup items", () => {
  it("everything in place: only the Codex trust check can't be seen, and acking it completes the list", async () => {
    let r = await computeSetup(deps());
    const items = byId(r);
    expect(r.summary.blocking).toBe(0);
    expect(r.land).toBe(false);
    expect(items["codex-hooks-trust"]).toMatchObject({ status: "unknown", fix: { kind: "command", command: "/hooks", ack: true } });
    expect(r.items.filter((i) => i.status !== "ok").map((i) => i.id)).toEqual(["codex-hooks-trust"]);
    expect(items["gh-login"].detail).toContain("as octocat");
    expect(items["codex-login"].detail).toBe("Logged in using ChatGPT.");
    expect(items.firstmate).toMatchObject({ status: "ok", fix: { kind: "link", href: "#/worker/local:wH:p1" } });
    r = await computeSetup(deps({ acks: { "codex-hooks-trust": "2026-10-04T12:00:00Z" } }));
    expect(byId(r)["codex-hooks-trust"].status).toBe("ok");
    expect(r.summary.required.done).toBe(r.summary.required.total);
    // Every item has a title, a plain detail and a group; copy has no ALL-CAPS labels or arrows.
    for (const i of r.items) { expect(i.title).toMatch(/^[A-Za-z]/); expect(i.detail.length).toBeGreaterThan(10); expect(`${i.title} ${i.fix?.label ?? ""}`).not.toMatch(/→|\b[A-Z]{4,}\b(?<!JEV_API_KEY)/); }
  });

  it("a fresh Mac: one fix per missing piece, required ones block and send a new user to setup", async () => {
    const tools = Object.fromEntries(["treehouse", "tasks-axi", "quota-axi", "gh", "gh-axi", "no-mistakes", "chrome-devtools-axi", "lavish-axi", "codex"].map((t) => [t, null]));
    const r = await computeSetup(deps({
      componentStatus: (n) => ({ hooks: "claude hooks: 0/8, codex hooks: 0/6", mcp: "claude: absent", skills: "absent", pstack: "absent", evals: "claude 0/9, codex 0/9" } as Record<string, string>)[n] ?? null,
      herdr: () => ({ connected: false, error: "connect ENOENT" }),
      herdrStartRoute: false,
      firstmate: () => ({ running: false, pane: null, herdr_connected: false, vendor: { present: true } }),
      jev: { available: false, key: false, fake: false },
      notifications: { enabled: true, lastTest: null },
    }, tools));
    const i = byId(r);
    expect(i.hooks.fix).toEqual({ kind: "button", label: "Install hooks", action: "install:hooks", command: "./bin/joyride install hooks" });
    expect(i.hooks.detail).toContain("Claude 0 of 8");
    expect(i["memory-mcp"]).toBeUndefined();
    expect(i["evidence-skills"].fix?.action).toBe("install:skills");
    expect(i.herdr).toMatchObject({ status: "missing", fix: { kind: "command", command: "herdr" } });
    expect(i["tool:treehouse"]).toMatchObject({ group: "required", status: "missing", fix: { kind: "button", action: "install:treehouse", command: "curl -fsSL https://kunchenguid.github.io/treehouse/install.sh | sh" } });
    expect(i["tool:quota-axi"].fix?.action).toBe("install:quota-axi");
    expect(i.firstmate).toMatchObject({ status: "missing", fix: { action: "firstmate-start", disabled: "Start Herdr first." } });
    expect(i["tool:gh"]).toMatchObject({ group: "optional", fix: { action: "install:gh", command: "brew install gh" } });
    expect(i["gh-login"]).toMatchObject({ group: "optional", status: "missing", fix: { action: "gh-login", disabled: expect.stringMatching(/Install the GitHub command line/) } });
    expect(i["codex-login"].fix?.kind).toBe("link");
    expect(i.jev.fix?.command).toContain("JEV_API_KEY");
    expect(i.notifications).toMatchObject({ status: "unknown", fix: { action: "notify-test" } });
    expect(r.summary.blocking).toBe(7); // hooks, herdr, memory, evidence, treehouse, tasks-axi, quota-axi, firstmate
    expect(r.land).toBe(true);
    expect((await computeSetup(deps({ seen: true }, tools))).land).toBe(false);
    expect((await computeSetup(deps({ test: true }, tools))).land).toBe(false);
    // With the Herdr start route registered, the fix is a button.
    expect(byId(await computeSetup(deps({ herdr: () => ({ connected: false }), herdrStartRoute: true }))).herdr.fix).toEqual({ kind: "button", label: "Start Herdr", action: "herdr-start" });
  });

  it("gh present but logged out offers the browser login; a tool off PATH says how to add it", async () => {
    const r = await computeSetup(deps({ run: async (cmd) => (cmd.endsWith("gh") ? { code: 1, out: "You are not logged into any GitHub hosts. To log in, run: gh auth login" } : { code: 1, out: "Not logged in" }) }, { treehouse: { path: "/Users/x/.local/bin/treehouse", on_path: false } }));
    const i = byId(r);
    expect(i["gh-login"]).toMatchObject({ status: "missing", fix: { kind: "button", label: "Log in to GitHub", action: "gh-login", command: "gh auth login --web --hostname github.com --git-protocol https" } });
    expect(i["codex-login"].fix).toEqual({ kind: "command", label: "Run in a terminal", command: "codex login" });
    expect(i["tool:treehouse"]).toMatchObject({ status: "warn", fix: { kind: "command", command: `echo 'export PATH="/Users/x/.local/bin:$PATH"' >> ~/.zshrc` } });
    expect(r.summary.blocking).toBe(0);
  });

  it("surfaces Firstmate waiting on the captain with a link to its pane", async () => {
    const ask = "Already in place: hooks.\n\nReply \"approve all\" (or name which tools to install), plus your project list, and I'll get the fleet ready.";
    const r = await computeSetup(deps({ worker: () => ({ id: "local:wH:p1", status: "idle", last_message: ask }) }));
    expect(byId(r).firstmate).toMatchObject({ title: "Firstmate is waiting for you", status: "warn", needs_you: true, fix: { kind: "link", label: "Answer Firstmate", href: "#/worker/local:wH:p1" } });
    expect(byId(r).firstmate.detail).toMatch(/^It asked: Reply "approve all"/);
    expect(isWaiting({ id: "x", status: "blocked" })).toBe(true);
    expect(isWaiting({ id: "x", status: "working", last_message: "Which one?" })).toBe(false);
    expect(isWaiting({ id: "x", status: "idle", last_message: "Should I start with alpha?" })).toBe(true);
    expect(isWaiting({ id: "x", status: "idle", last_message: "All three workers finished." })).toBe(false);
  });

  it("warns when a Claude Code screen says the login expires", async () => {
    expect(claudeLoginNotice(["  ⚠ Your login expires in 1 day · run /login to renew"])).toEqual({ level: "warn", text: "Claude Code says your login expires in 1 day." });
    expect(claudeLoginNotice(["API Error: OAuth token has expired. Please run /login"])?.level).toBe("missing");
    expect(claudeLoginNotice(["❯ "])).toBeNull();
    const r = await computeSetup(deps({ claudeScreens: async () => ["hello", "⚠ Your login expires in 1 day · run /login to renew"] }));
    expect(byId(r)["claude-login"]).toMatchObject({ status: "warn", fix: { kind: "command", command: "/login" } });
  });
});

describe("gh login screen", () => {
  it("reads the code, the URL, a yes/no question, success and errors", () => {
    const q = parseGhLogin("$ gh auth login --web --hostname github.com --git-protocol https\n? Authenticate Git with your GitHub credentials? (Y/n)\n");
    expect(q.question).toBe("Authenticate Git with your GitHub credentials?");
    expect(q.code).toBeNull();
    const c = parseGhLogin("? Authenticate Git with your GitHub credentials? Yes\n\n! First copy your one-time code: 4F2A-9C1B\nPress Enter to open https://github.com/login/device in your browser... ");
    expect(c).toMatchObject({ code: "4F2A-9C1B", url: "https://github.com/login/device", pressEnter: true, question: null, done: false });
    const d = parseGhLogin("✓ Authentication complete.\n- gh config set -h github.com git_protocol https\n✓ Configured git protocol\n✓ Logged in as octocat-2\n$ ");
    expect(d).toMatchObject({ done: true, account: "octocat-2" });
    expect(parseGhLogin("X error connecting to github.com\n").error).toBe("error connecting to github.com");
  });
});

// ---------------------------------------------------------------- routes
let d: Awaited<ReturnType<typeof sandboxDaemon>>;
let fake: FakeHerdr;
beforeAll(async () => {
  d = await sandboxDaemon("system-setup", ["live", "firstmate", "system"]);
  fake = await startFakeHerdr(d.sb.env.JOYRIDE_HERDR_SOCKET, { scenario: "default" });
  await assertSandboxed(d.sb.env);
  await d.start();
  await waitFor(async () => (await d.req("GET", "/api/herdr/status")).body.connected, 5000);
});
afterAll(async () => {
  await d?.stop();
  await fake?.stop();
});

describe("setup routes", () => {
  it("GET /api/system/setup returns grouped items and never lands a test run on setup", async () => {
    await d.req("POST", "/api/system/setup/test-fakes", { reset: true, tools: { git: "/usr/bin/git", node: "/usr/bin/node", jq: "/usr/bin/jq", herdr: "/opt/homebrew/bin/herdr" } });
    const r = await d.req("GET", "/api/system/setup?fresh=1");
    expect(r.status).toBe(200);
    const ids = r.body.items.map((i: any) => i.id);
    expect(ids.slice(0, 4)).toEqual(["daemon", "hooks", "codex-hooks-trust", "herdr"]);
    expect(ids).toEqual(expect.arrayContaining(["tool:treehouse", "tool:tasks-axi", "tool:quota-axi", "firstmate", "claude-login", "gh-login", "codex-login", "jev", "notifications"]));
    const herdr = r.body.items.find((i: any) => i.id === "herdr");
    expect(herdr.status).toBe("ok");
    expect(r.body.summary.blocking).toBeGreaterThan(0);
    expect(r.body.land).toBe(false);
  });

  it("installs a tool through a job (test runner), logs it to GLOBAL_CHANGES.md and rechecks", async () => {
    const changes = path.join(process.env.JOYRIDE_HOME!, "GLOBAL_CHANGES.md");
    const before = fs.existsSync(changes) ? fs.readFileSync(changes, "utf8") : "";
    const bad = await d.req("POST", "/api/system/install", { component: "service" });
    expect(bad.status).toBe(400);
    const r = await d.req("POST", "/api/system/install", { component: "treehouse" });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ component: "treehouse", status: "running" });
    const busy = await d.req("POST", "/api/system/install", { component: "tasks-axi" });
    expect(busy.status).toBe(409);
    await waitFor(async () => (await d.req("GET", `/api/system/install/${r.body.id}`)).body.status !== "running", 5000);
    const job = (await d.req("GET", `/api/system/install/${r.body.id}`)).body;
    expect(job).toMatchObject({ status: "ok", exit: 0 });
    expect(job.output).toContain("(test) would run: curl -fsSL https://kunchenguid.github.io/treehouse/install.sh | sh");
    const after = fs.readFileSync(changes, "utf8");
    expect(after.slice(before.length)).toMatch(/install `treehouse`[\s\S]*nothing was installed/);
    const s = (await d.req("GET", "/api/system/setup")).body;
    expect(s.items.find((i: any) => i.id === "tool:treehouse").status).toBe("ok");
  });

  it("a failing install is reported as failed with its output", async () => {
    const { setInstallRunner } = await import("../../src/modules/system/index.ts");
    setInstallRunner(async (_c, out) => { out("npm ERR! network\n"); return 1; });
    try {
      const r = await d.req("POST", "/api/system/install", { component: "quota-axi" });
      await waitFor(async () => (await d.req("GET", `/api/system/install/${r.body.id}`)).body.status !== "running", 5000);
      expect((await d.req("GET", `/api/system/install/${r.body.id}`)).body).toMatchObject({ status: "failed", exit: 1, output: expect.stringContaining("npm ERR! network") });
    } finally { setInstallRunner(null); }
  });

  it("acks the Codex trust check and records notification tests", async () => {
    const a = await d.req("POST", "/api/system/setup/ack", { id: "codex-hooks-trust" });
    expect(a.body.items.find((i: any) => i.id === "codex-hooks-trust").status).toBe("ok");
    await d.req("POST", "/api/system/notify-test");
    const s = (await d.req("GET", "/api/system/setup?fresh=1")).body;
    expect(s.items.find((i: any) => i.id === "notifications")).toMatchObject({ status: "warn", detail: expect.stringContaining("disabled in this environment") });
  });

  it("logs in to GitHub in a new Herdr pane: types the command, presses Enter for the code, closes on success", async () => {
    const none = await d.req("POST", "/api/system/setup/gh-login");
    expect(none.status).toBe(400);
    expect(none.body.command).toBe("gh auth login --web --hostname github.com --git-protocol https");
    await d.req("POST", "/api/system/setup/test-fakes", { tools: { gh: "/opt/homebrew/bin/gh" } });
    const r = await d.req("POST", "/api/system/setup/gh-login");
    expect(r.status).toBe(200);
    expect(r.body.active).toBe(true);
    const pane = r.body.worker.split(":").slice(1).join(":");
    expect(fake.inputs.some((x) => x.target === pane && x.text === "/opt/homebrew/bin/gh auth login --web --hostname github.com --git-protocol https")).toBe(true);
    expect(fake.calls.some((c) => c.method === "workspace.create" && c.params.label === "GitHub login")).toBe(true);
    const p = fake.panes.get(pane)!;
    p.screen = ["? Authenticate Git with your GitHub credentials? (Y/n)"]; p.input = ""; p.revision++;
    let v = (await d.req("GET", "/api/system/setup/gh-login")).body;
    expect(v.question).toBe("Authenticate Git with your GitHub credentials?");
    await d.req("POST", "/api/system/setup/gh-login/answer", { answer: "y" });
    expect(fake.inputs.some((x) => x.target === pane && x.text === "y")).toBe(true);
    p.screen = ["? Authenticate Git with your GitHub credentials? Yes", "", "! First copy your one-time code: 4F2A-9C1B", "Press Enter to open https://github.com/login/device in your browser... "]; p.input = ""; p.revision++;
    const enters = () => fake.inputs.filter((x) => x.target === pane && x.keys?.includes("enter")).length;
    const n = enters();
    v = (await d.req("GET", "/api/system/setup/gh-login")).body;
    expect(v).toMatchObject({ code: "4F2A-9C1B", url: "https://github.com/login/device", active: true });
    expect(enters()).toBe(n + 1);
    await d.req("GET", "/api/system/setup/gh-login");
    expect(enters()).toBe(n + 1); // only once
    p.screen = ["✓ Authentication complete.", "✓ Logged in as octocat-2", "$ "]; p.revision++;
    v = (await d.req("GET", "/api/system/setup/gh-login")).body;
    expect(v).toMatchObject({ done: true, account: "octocat-2", active: false });
    expect(fake.calls.some((c) => c.method === "workspace.close")).toBe(true);
  });
});
