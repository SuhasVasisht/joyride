// System: installed components, configuration (LLM backends, Jev, notifications),
// model usage stats, a notification test, and the setup checklist. Config edits are commits.
//   routes: GET /api/system/status, GET|PUT /api/system/config, POST /api/system/notify-test,
//           GET /api/system/setup[?fresh=1], POST /api/system/setup/{ack,seen},
//           POST /api/system/install {component} -> job, GET /api/system/install/:id,
//           GET|POST /api/system/setup/gh-login, POST /api/system/setup/gh-login/{answer,focus}
//   bus entity: setup (after installs, acks, logins)
import fs from "node:fs";
import { SleepPrevention } from "../../core/sleep-prevention.ts";
import path from "node:path";
import YAML from "yaml";
import { execFile, spawn } from "node:child_process";
import { defineModule, type Ctx } from "../../core/context.ts";
import { Config } from "../../shared/schema.ts";
import { DEFAULT_ACCOUNTS, resolveAccounts } from "../../core/accounts.ts";
import { badNewModels } from "../../core/new-models.ts";
import { paths } from "../../shared/paths.ts";
import { loadConfig } from "../../core/config.ts";
import { editConfigYaml } from "../../core/config-yaml.ts";
import { unknownLlmTasks } from "../../shared/llm-tasks.ts";
import { commitPaths } from "../../core/gitstore.ts";
import { kvGet, kvSet } from "../../core/db.ts";
import { readFirstmateFiles } from "./firstmate-files.ts";
import { fakeModels } from "../../core/fakes.ts";
import { jevAvailable, jevStats } from "../../core/jev.ts";
import { llmStats } from "../../core/llm.ts";
import { writeFileAtomic } from "../../core/util.ts";
import { computeSetup, type RunResult, type SetupDeps, type SetupReport } from "./setup.ts";
import { INSTALLABLE_TOOLS, findTool, installCommand, toolSpec, type Found } from "./tools.ts";
import { GH_LOGIN_ARGS, answerGhLogin, pollGhLogin, startGhLogin, type GhLoginState } from "./gh-login.ts";

/** Components the setup page may install. Everything else stays CLI-only (`./bin/joyride install`). */
export const SETUP_COMPONENTS = ["hooks", "mcp", "skills", "pstack", "evals", "agents", ...INSTALLABLE_TOOLS];

export type InstallJob = { id: string; component: string; status: "running" | "ok" | "failed"; output: string; started: string; finished: string | null; exit: number | null };
/** Runs one install and streams its output; resolves to the exit code. */
export type InstallRunner = (component: string, onOutput: (chunk: string) => void) => Promise<number>;
let runnerOverride: InstallRunner | null = null;
/** Unit tests swap the runner so nothing is ever installed. */
export function setInstallRunner(fn: InstallRunner | null) { runnerOverride = fn; }

/** Probe results under JOYRIDE_TEST (set with POST /api/system/setup/test-fakes). Nothing external runs in tests. */
type TestFakes = { tools: Record<string, string | null>; commands: Record<string, RunResult>; components: Record<string, string>; screens: string[] | null };
const testFakes: TestFakes = { tools: {}, commands: {}, components: {}, screens: null };
const isTest = () => process.env.JOYRIDE_TEST === "1";

function runCmd(cmd: string, args: string[], timeout = 8000): Promise<RunResult> {
  if (isTest()) {
    const key = `${path.basename(cmd)} ${args.join(" ")}`;
    return Promise.resolve(testFakes.commands[key] ?? Object.entries(testFakes.commands).find(([k]) => key.startsWith(k))?.[1] ?? { code: 127, out: "not run in tests" });
  }
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" }, maxBuffer: 1 << 20 }, (err: any, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: `${stdout ?? ""}${stderr ?? ""}` });
    });
  });
}
const findToolFor = (name: string): Found | null => {
  if (isTest()) { const p = testFakes.tools[name]; return p ? { path: p, on_path: true } : null; }
  return findTool(name);
};

const fakeRunner: InstallRunner = async (component, onOutput) => {
  const t = toolSpec(component);
  const cmd = t ? installCommand(t) : `./bin/joyride install ${component}`;
  onOutput(`(test) would run: ${cmd}\n`);
  await new Promise((r) => setTimeout(r, 250));
  const { logChange } = await import("../../cli/install.ts");
  logChange(component, "install", [`(test) would run \`${cmd}\`; nothing was installed`]);
  if (t) testFakes.tools[component] = `/opt/fake/bin/${component}`;
  else testFakes.components[component] = component === "hooks" ? "claude hooks: 8/8, codex hooks: 6/6" : component === "mcp" ? "claude: present" : "installed";
  onOutput(`(test) ${component} marked installed\n`);
  return 0;
};
const realRunner: InstallRunner = (component, onOutput) => new Promise((resolve) => {
  const child = spawn(path.join(paths.code, "bin", "joyride"), ["install", component], { cwd: paths.code, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (b) => onOutput(String(b)));
  child.stderr.on("data", (b) => onOutput(String(b)));
  child.on("error", (e) => { onOutput(`${e.message}\n`); resolve(127); });
  child.on("close", (code) => resolve(code ?? 1));
});

/** An llm task whose `account` names no login of its backend in `usage.accounts`, as an error to show; null when every one resolves. */
function badLlmAccount(cfg: Config): string | null {
  const accounts = resolveAccounts(cfg.usage.accounts?.length ? cfg.usage.accounts : DEFAULT_ACCOUNTS);
  for (const [task, t] of Object.entries(cfg.llm.tasks)) {
    if (!t.account) continue;
    const a = accounts.find((x) => x.id === t.account);
    if (!a) return `llm.tasks.${task} names the account "${t.account}", which is not in usage.accounts. Use one of: ${accounts.filter((x) => x.provider === t.backend).map((x) => x.id).join(", ") || "none"}.`;
    if (a.provider !== t.backend) return `llm.tasks.${task} runs on ${t.backend} but names the ${a.provider} account "${a.id}". Pick a ${t.backend} account.`;
  }
  return null;
}

let sleep: SleepPrevention | null = null;
export default defineModule({
  name: "system",
  order: 90,
  register(ctx: Ctx) {
    const { app, db } = ctx;
    const awake = new SleepPrevention({ changed: () => ctx.bus.change({ entity: "system" }) });
    sleep = awake;
    ctx.services.set("sleep-prevention", awake);
    let cache: { at: number; value: any } | null = null;
    async function components() {
      if (cache && Date.now() - cache.at < 30000) return cache.value;
      const { components } = await import("../../cli/install.ts");
      const value = Object.entries(components).map(([name, c]: [string, any]) => {
        let status = "";
        try { status = c.status(); } catch (e: any) { status = `error: ${e.message}`; }
        return { name, describe: c.describe, status };
      });
      cache = { at: Date.now(), value };
      return value;
    }

    // ---------- setup checklist ----------
    const svc = <T,>(name: string): T | null => (ctx.services.get(name) as T | undefined) ?? null;
    let setupCache: { at: number; value: SetupReport } | null = null;
    let inflight: Promise<SetupReport> | null = null;
    const invalidate = () => { setupCache = null; cache = null; ctx.bus.change({ entity: "setup" }); };
    async function buildDeps(): Promise<SetupDeps> {
      const { components: table } = await import("../../cli/install.ts");
      // Only cheap, file-based statuses run in-process; the MCP check shells out (claude mcp get), so it runs async.
      const herdr = svc<any>("herdr");
      return {
        daemon: { pid: process.pid, port: ctx.config.port },
        componentStatus: (name) => {
          if (isTest()) return testFakes.components[name] ?? (name === "hooks" ? "claude hooks: 0/8, codex hooks: 0/6" : name === "mcp" ? "claude: absent" : name === "evals" ? "claude 0/9, codex 0/9" : "absent");
          try { return (table as any)[name]?.status() ?? null; } catch (e: any) { return `error: ${e.message}`; }
        },
        findTool: findToolFor,
        run: runCmd,
        herdr: () => {
          if (!herdr) return null;
          try {
            const st = herdr.status();
            const m = st.machines.find((x: any) => x.label === herdr.defaultMachine()) ?? st.machines[0];
            return { connected: Boolean(st.connected), version: m?.version ?? null, error: m?.error ?? null, panes: m?.panes ?? null };
          } catch { return { connected: false, error: "status unavailable" }; }
        },
        herdrStartRoute: Boolean((app as any).routes?.some((r: any) => r.method === "POST" && r.path === "/api/herdr/start")),
        firstmate: () => { try { return svc<any>("firstmate")?.status() ?? null; } catch { return null; } },
        worker: (id) => { try { return svc<any>("workers")?.get(id) ?? null; } catch { return null; } },
        claudeScreens: async () => {
          if (isTest() && testFakes.screens) return testFakes.screens;
          if (!herdr) return [];
          const { readScreen } = await import("../live/screen.ts");
          let panes: any[] = [];
          try { panes = herdr.snapshot().panes.filter((p: any) => p.agent === "claude").slice(0, 40); } catch { return []; }
          return Promise.all(panes.map((p) => readScreen(herdr, p.pane_id, p.machine)));
        },
        jev: { available: jevAvailable(), key: Boolean(process.env.JEV_API_KEY), fake: fakeModels() },
        notifications: { enabled: ctx.config.notifications?.macos !== false, lastTest: kvGet(db, "setup:notify-test", null) },
        acks: kvGet<Record<string, string>>(db, "setup:acks", {}),
        seen: kvGet(db, "setup:seen", false),
        test: isTest(),
      };
    }
    async function setup(fresh = false): Promise<SetupReport> {
      if (!fresh && setupCache && Date.now() - setupCache.at < 20000) return setupCache.value;
      if (inflight) return inflight;
      inflight = (async () => {
        try { const value = await computeSetup(await buildDeps()); setupCache = { at: Date.now(), value }; return value; }
        finally { inflight = null; }
      })();
      return inflight;
    }
    app.get("/api/system/setup", async (c) => c.json(await setup(c.req.query("fresh") === "1")));
    app.post("/api/system/setup/seen", (c) => { kvSet(db, "setup:seen", true); if (setupCache) setupCache.value.land = false; return c.json({ seen: true }); });
    app.post("/api/system/setup/ack", async (c) => {
      let b: any = {};
      try { b = await c.req.json(); } catch {}
      const id = String(b.id ?? "");
      if (!/^[a-z0-9:-]{1,64}$/.test(id)) return c.json({ error: "Send {id} of the setup item to mark done." }, 400);
      const acks = kvGet<Record<string, string>>(db, "setup:acks", {});
      if (b.done === false) delete acks[id]; else acks[id] = new Date().toISOString();
      kvSet(db, "setup:acks", acks);
      invalidate();
      return c.json(await setup(true));
    });
    app.post("/api/system/setup/test-fakes", async (c) => {
      if (!isTest()) return c.json({ error: "Test fakes only exist when JOYRIDE_TEST=1." }, 404);
      const b: Partial<TestFakes> & { reset?: boolean } = await c.req.json().catch(() => ({}));
      if (b.reset) Object.assign(testFakes, { tools: {}, commands: {}, components: {}, screens: null });
      Object.assign(testFakes.tools, b.tools ?? {});
      Object.assign(testFakes.commands, b.commands ?? {});
      Object.assign(testFakes.components, b.components ?? {});
      if (b.screens !== undefined) testFakes.screens = b.screens;
      invalidate();
      return c.json({ ok: true });
    });

    // ---------- installs (one at a time, output streamed into the job) ----------
    const jobs = new Map<string, InstallJob>();
    let running: InstallJob | null = null;
    app.post("/api/system/install", async (c) => {
      let b: any = {};
      try { b = await c.req.json(); } catch {}
      const component = String(b.component ?? "");
      if (!SETUP_COMPONENTS.includes(component)) return c.json({ error: `"${component}" can't be installed from the setup page. Known: ${SETUP_COMPONENTS.join(", ")}.` }, 400);
      if (running) return c.json({ error: `${running.component} is still installing. Wait for it to finish, then try again.`, job: running }, 409);
      const job: InstallJob = { id: `inst-${Date.now().toString(36)}`, component, status: "running", output: "", started: new Date().toISOString(), finished: null, exit: null };
      jobs.set(job.id, job);
      running = job;
      const runner = runnerOverride ?? (isTest() ? fakeRunner : realRunner);
      runner(component, (chunk) => { job.output = (job.output + chunk).slice(-64_000); })
        .catch((e) => { job.output += `\n${e?.message ?? e}\n`; return 1; })
        .then((code) => {
          const t = toolSpec(component);
          const present = !t || Boolean(findToolFor(component));
          job.exit = code; job.finished = new Date().toISOString();
          job.status = code === 0 && present ? "ok" : "failed";
          if (code === 0 && !present) job.output += `\n${component} is still not found after the install.\n`;
          running = null;
          try { ctx.emit({ source: "daemon", type: "system.install", cwd: paths.code, data: { component, status: job.status, exit: code } }); } catch {}
          invalidate();
        });
      return c.json(job, 202);
    });
    app.get("/api/system/install/:id", (c) => {
      const j = jobs.get(c.req.param("id"));
      return j ? c.json(j) : c.json({ error: `No install job ${c.req.param("id")}. Jobs are kept until the daemon restarts.` }, 404);
    });

    // ---------- GitHub login in a Herdr pane ----------
    const ghCommand = `gh ${GH_LOGIN_ARGS.join(" ")}`;
    const ghState = () => kvGet<GhLoginState | null>(db, "setup:gh-login", null);
    async function ghView() {
      const s = ghState();
      const herdr = svc<any>("herdr");
      if (!s || !herdr) return { active: false, command: ghCommand };
      const r = await pollGhLogin(herdr, s);
      if (JSON.stringify(r.state) !== JSON.stringify(s)) kvSet(db, "setup:gh-login", r.state);
      if (r.state.done && !s.done) invalidate();
      return { ...r.view, command: ghCommand };
    }
    app.get("/api/system/setup/gh-login", async (c) => c.json(await ghView()));
    app.post("/api/system/setup/gh-login", async (c) => {
      const gh = findToolFor("gh");
      if (!gh) return c.json({ error: "The GitHub command line (gh) is not installed. Install it first.", command: ghCommand }, 400);
      const herdr = svc<any>("herdr");
      if (!herdr) return c.json({ error: "The live module is not running, so Joyride can't open a Herdr pane. Run the command in any terminal.", command: ghCommand }, 503);
      try { kvSet(db, "setup:gh-login", await startGhLogin(herdr, gh.path)); }
      catch (e: any) { return c.json({ error: `Joyride could not open a login pane: ${e.message}`, command: ghCommand }, e.status ?? 502); }
      return c.json(await ghView());
    });
    app.post("/api/system/setup/gh-login/answer", async (c) => {
      const b: any = await c.req.json().catch(() => ({}));
      const s = ghState(); const herdr = svc<any>("herdr");
      if (!s || !herdr) return c.json({ error: "No GitHub login is running. Start it again." }, 404);
      if (b.answer !== "y" && b.answer !== "n") return c.json({ error: "Answer with y or n." }, 400);
      try { await answerGhLogin(herdr, s, b.answer); } catch (e: any) { return c.json({ error: e.message }, 502); }
      return c.json(await ghView());
    });
    app.post("/api/system/setup/gh-login/focus", async (c) => {
      const s = ghState(); const herdr = svc<any>("herdr");
      if (!s || !herdr) return c.json({ error: "No GitHub login is running." }, 404);
      try { await herdr.call("pane.focus", { pane_id: s.pane_id }, { machine: s.machine }); } catch (e: any) { return c.json({ error: `Herdr could not bring the login pane forward: ${e.message}` }, 502); }
      return c.json({ focused: true });
    });
    app.get("/api/system/firstmate-files", (c) => c.json(readFirstmateFiles(paths.firstmateHome)));
    app.post("/api/system/firstmate-files/:file/open", async (c) => {
      const file = readFirstmateFiles(paths.firstmateHome).find((f) => f.file === c.req.param("file"));
      if (!file) return c.json({ error: "Choose one of Firstmate's four preference files." }, 400);
      if (file.state !== "ready") return c.json({ error: file.state === "absent" ? `${file.file} does not exist yet. Firstmate creates it when needed.` : file.error }, file.state === "absent" ? 404 : 500);
      try {
        if (!fakeModels()) await new Promise<void>((resolve, reject) => execFile("open", [file.path], (error) => error ? reject(error) : resolve()));
        return c.json({ opened: file.path });
      } catch {
        return c.json({ error: `Could not open ${file.file}. Open ${file.path} in your editor.` }, 500);
      }
    });
    app.get("/api/system/guidance", (c) => {
      const file = path.join(paths.root, "guidance", "captain.md");
      try { return c.json({ path: file, state: "ready", text: fs.readFileSync(file, "utf8") }); }
      catch (e) {
        if (e instanceof Error && "code" in e && e.code === "ENOENT") return c.json({ path: file, state: "absent", text: "" });
        return c.json({ error: "Captain guidance could not be read. Check guidance/captain.md permissions." }, 500);
      }
    });
    app.get("/api/system/status", async (c) => c.json({
      daemon: { pid: process.pid, uptime_s: Math.round(process.uptime()), root: paths.root, port: ctx.config.port, node: process.version, preview: process.env.JOYRIDE_PREVIEW === "1", sleep_prevention: await awake.status() },
      models: { jev: { available: jevAvailable(), ...jevStats() }, llm: llmStats() },
      components: await components(),
      global_changes: fs.existsSync(`${paths.root}/GLOBAL_CHANGES.md`) ? fs.readFileSync(`${paths.root}/GLOBAL_CHANGES.md`, "utf8").split("\n").filter((l) => l.startsWith("## ")).slice(-20).map((l) => l.slice(3)) : [],
    }));
    app.get("/api/system/config", (c) => {
      const config = loadConfig(true);
      return c.json({ config, yaml: fs.existsSync(paths.config) ? fs.readFileSync(paths.config, "utf8") : "", unknown_llm_tasks: unknownLlmTasks(config.llm.tasks) });
    });
    app.put("/api/system/config", async (c) => {
      const b = await c.req.json();
      let next: any;
      if (typeof b.yaml === "string") {
        try { next = Config.parse(YAML.parse(b.yaml) ?? {}); } catch (e: any) { return c.json({ error: `The configuration is not valid: ${e.message}` }, 400); }
        const bad = badLlmAccount(next) ?? badNewModels(next);
        if (bad) return c.json({ error: bad }, 400);
        writeFileAtomic(paths.config, b.yaml);
      } else {
        const cur = YAML.parse(fs.existsSync(paths.config) ? fs.readFileSync(paths.config, "utf8") : "{}") ?? {};
        const merged = { ...cur, ...b, ...(b.daemon ? { daemon: { ...(cur.daemon ?? {}), ...b.daemon } } : {}), ...(b.llm ? { llm: { ...(cur.llm ?? {}), ...b.llm } } : {}), ...(b.new_models ? { new_models: { ...(cur.new_models ?? {}), ...b.new_models } } : {}) };
        try { next = Config.parse(merged); } catch (e: any) { return c.json({ error: `The configuration is not valid: ${e.message}` }, 400); }
        const bad = badLlmAccount(next) ?? badNewModels(next);
        if (bad) return c.json({ error: bad }, 400);
        let yaml: string;
        try {
          yaml = editConfigYaml(fs.existsSync(paths.config) ? fs.readFileSync(paths.config, "utf8") : "", merged);
          Config.parse(YAML.parse(yaml) ?? {});
        } catch (e: any) { return c.json({ error: `The configuration could not be updated: ${e.message}` }, 400); }
        writeFileAtomic(paths.config, yaml);
      }
      const sha = commitPaths([paths.config], "settings: update joyride.config.yaml");
      Object.assign(ctx.config, loadConfig(true));
      await awake.setEnabled(ctx.config.daemon.prevent_sleep);
      ctx.bus.change({ entity: "system" });
      return c.json({ config: next, commit: sha });
    });
    app.post("/api/system/notify-test", async (c) => {
      const record = (r: { sent: boolean; reason?: string }) => { kvSet(db, "setup:notify-test", { ...r, at: new Date().toISOString() }); invalidate(); return c.json(r); };
      if (process.env.JOYRIDE_TEST === "1" || process.env.JOYRIDE_NO_NOTIFY === "1") return record({ sent: false, reason: "notifications are disabled in this environment" });
      const script = `display notification "Approvals and blocked agents will show up like this." with title "Joyride notifications work" sound name "Ping"`;
      const err = await new Promise<Error | null>((resolve) => execFile("osascript", ["-e", script], (e) => resolve(e)));
      return record(err ? { sent: false, reason: err.message } : { sent: true });
    });
  },
  async start(ctx) { await ctx.service<SleepPrevention>("sleep-prevention").setEnabled(ctx.config.daemon.prevent_sleep); },
  async stop() { await sleep?.stop(); },
});
