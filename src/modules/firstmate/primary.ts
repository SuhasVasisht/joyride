import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Ctx } from "../../core/context.ts";
import { readAccounts } from "../../core/accounts.ts";
import { paths } from "../../shared/paths.ts";
import { slugify } from "../../core/util.ts";
import type { WorkerView } from "../../shared/schema.ts";
import type { UsageSnapshot } from "../../shared/usage.ts";
import { PrimaryStateSchema, type PrimaryState, type PrimaryStatus } from "../../shared/firstmate-primary.ts";
import type { HerdrApi } from "../live/herdr.ts";
import { screenText } from "../live/screen.ts";
import type { HomeState } from "./state.ts";
import { MAX_HANDOFF_ATTEMPTS, PrimaryFailover, composeHandoff, hasCapacity, primaries, primaryArgs, type Primary, type PrimaryPane } from "./failover.ts";
import { cursorHandoff } from "./cursor.ts";

const emptyUsage = (): UsageSnapshot => ({ fetchedAt: null, generatedAt: null, maxAgeSeconds: 60, providers: [], ageSeconds: null, refreshing: false });
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const exec = promisify(execFile);
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (e) { return !(e instanceof Error && "code" in e && e.code === "ESRCH"); } }
function lockPid(home: string): number | null {
  try {
    const text = fs.readFileSync(path.join(home, "state", ".lock"), "utf8").trim();
    if (!/^\d+$/.test(text) || Number(text) < 2) throw new Error("Firstmate's session lock is unreadable. Inspect state/.lock before retrying.");
    return Number(text);
  } catch (e) { if (e instanceof Error && "code" in e && e.code === "ENOENT") return null; throw e; }
}

export function createPrimaryManager(ctx: Ctx, deps: {
  home: string; dir: string;
  pane(): (PrimaryPane & { agent?: string }) | null;
  homeState(): HomeState;
  note(id: string, body: string): Promise<{ note: string }>;
  launched(pane: { machine: string; pane_id: string }): void;
}) {
  const journal = path.join(paths.runtime, "state", "firstmate-primary.json");
  let state: PrimaryState = { current: null, phase: "ready", lastSwitch: null, error: null };
  try { const parsed = PrimaryStateSchema.safeParse(JSON.parse(fs.readFileSync(journal, "utf8"))); if (parsed.success) state = parsed.data; } catch {}
  let lastScreen = { pane: "", text: "", changed: Date.now() };
  let startJob: Promise<void> | null = null;
  let stopped = false;
  const h = () => ctx.service<HerdrApi>("herdr");
  let configuredAccounts: ReturnType<typeof readAccounts> = ctx.services.get("usage")?.accounts?.() ?? readAccounts();
  const refreshAccounts = () => { configuredAccounts = ctx.services.get("usage")?.accounts?.() ?? readAccounts(); };
  const choices = () => primaries(configuredAccounts, ctx.config.firstmate.primaries, { claude: paths.claudeDir, codex: paths.codexDir });
  const usage = (): UsageSnapshot => ctx.services.get("usage")?.report?.() ?? emptyUsage();
  function save(s: PrimaryState) {
    state = PrimaryStateSchema.parse(s);
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    fs.writeFileSync(`${journal}.tmp`, JSON.stringify(state));
    fs.renameSync(`${journal}.tmp`, journal);
    ctx.bus.change({ entity: "firstmate" });
  }
  function current(): Primary | null {
    const pane = deps.pane();
    const list = choices();
    if (!pane) return list.find((p) => p.account === state.current?.account) ?? null;
    const worker: WorkerView | undefined = ctx.services.get("workers")?.list?.().find((w: WorkerView) => w.id === `${pane.machine}:${pane.pane_id}`);
    const transcript: string | undefined = worker?.session ? ctx.services.get("sessions")?.get?.(worker.session)?.transcript : undefined;
    if (transcript) {
      const bound = list.find((p) => {
        const home = p.env.CODEX_HOME ?? p.env.CLAUDE_CONFIG_DIR;
        if (!home || p.harness !== pane.agent) return false;
        const relative = path.relative(home, transcript);
        return relative.startsWith(p.harness === "codex" ? `sessions${path.sep}` : `projects${path.sep}`);
      });
      if (bound) return bound;
    }
    const saved = list.find((p) => p.account === state.current?.account);
    return saved && (!pane.agent || saved.harness === pane.agent) ? saved : list.find((p) => p.harness === (pane.agent ?? "claude")) ?? null;
  }
  async function observe() {
    const pane = deps.pane(), primary = current();
    if (!pane || !primary || stopped) return null;
    const screen = screenText(await h().call("pane.read", { pane_id: pane.pane_id, source: "visible", lines: 150, strip_ansi: true }, { machine: pane.machine, timeoutMs: 3000 }));
    if (lastScreen.pane !== pane.pane_id || lastScreen.text !== screen) lastScreen = { pane: pane.pane_id, text: screen, changed: Date.now() };
    return { primary, pane, screen, unchangedMs: Date.now() - lastScreen.changed, usage: usage() };
  }
  const simulated = () => process.env.JOYRIDE_TEST === "1" && process.env.JOYRIDE_FIRSTMATE_REAL !== "1";
  async function awaitStartup(oldPid: number | null) {
    if (simulated()) return;
    const until = Date.now() + 90_000;
    while (Date.now() < until && !stopped) {
      const pid = lockPid(deps.home);
      // The completion marker is refreshed by fm-session-start, not by this manager.
      const complete = path.join(deps.home, "state", ".session-start-complete");
      if (pid && pid !== oldPid && alive(pid) && fs.existsSync(complete) && fs.readFileSync(complete, "utf8").trim() === String(pid) && fs.statSync(complete).mtimeMs >= lastLaunch) return;
      await pause(500);
    }
    throw new Error("The successor has not acquired the session lock and finished fm-session-start within 90 seconds. Open its pane and retry startup there.");
  }
  let lastLaunch = 0;
  async function validate(to: Primary) {
    if (simulated() || to.harness !== "codex") return;
    try {
      await exec("codex", ["--no-daemon", "login", "status"], { env: { ...process.env, ...to.env }, timeout: 15_000, maxBuffer: 128 * 1024 });
    } catch {
      throw new Error(`${to.label}'s login could not be confirmed. Sign in to its configured Codex account or fix its CLI configuration, refresh usage, then retry. The source was preserved.`);
    }
  }
  let attemptedPane: PrimaryPane | null = null;
  async function closeAttempted() {
    await h().refresh();
    const primary = deps.pane();
    if (primary && (!attemptedPane || primary.machine !== attemptedPane.machine || primary.pane_id !== attemptedPane.pane_id))
      throw new Error("The primary changed during recovery. Its pane was preserved.");
    const target = attemptedPane;
    if (!target || !h().snapshot().panes.some(p => p.machine === target.machine && p.pane_id === target.pane_id)) return;
    const workers: WorkerView[] = ctx.services.get("workers")?.list?.() ?? [];
    if (workers.some(w => w.id === `${target.machine}:${target.pane_id}` && w.owner.task))
      throw new Error("The failed launch pane is now owned by a worker. It was preserved; inspect Firstmate before retrying.");
    const pid = lockPid(deps.home);
    await h().sendKeys(target.pane_id, ["ctrl+c"], { machine: target.machine });
    await h().call("pane.close", { pane_id: target.pane_id }, { machine: target.machine });
    const until = Date.now() + 15_000;
    while (pid && alive(pid) && Date.now() < until) await pause(250);
    if (pid && alive(pid)) throw new Error("The failed target still holds the primary lock. Retry after closing its pane.");
    await h().refresh();
  }
  async function launch(to: Primary, note: string) {
    attemptedPane = null;
    if (stopped) throw new Error("Joyride is stopping. The saved handoff will resume at its next start.");
    const oldPid = lockPid(deps.home);
    if (oldPid && alive(oldPid)) throw new Error(`Firstmate's outgoing session still holds lock pid ${oldPid}. Close that session before retrying.`);
    await h().refresh();
    const existing = deps.pane();
    if (existing) throw new Error("A Firstmate primary is still running. Close it through the handoff before starting another.");
    lastLaunch = Date.now();
    const prompt = [
      "You are Firstmate, continuing supervision in the existing FM_HOME. Run bin/fm-session-start.sh now and follow its emitted supervision instructions.",
      `Your primary account is ${to.account} (${to.label}); harness ${to.harness}${to.model ? `, model ${to.model}` : ""}.`,
      `Use docs/supervision-protocols/${to.harness}.md. Preserve every live worker. Reconcile open decisions and drain the durable wake queue.`,
      note ? `Find primary handoff note ${note} with bin/fm-inbox.sh receipts --all-pending --all-handled, read its saved path before taking your next action, and continue the captain's requests and pending promises from it.` : "Read the captain inbox and continue the existing backlog.",
      "After handling wakes, use the exact --ack-through command printed by bin/fm-wake-drain.sh. Continue supervision with this harness's protocol.",
    ].join("\n");
    const machine = h().defaultMachine();
    const result = await h().launch({ cwd: deps.dir, agent: to.harness, label: ctx.config.firstmate.pane_label, machine,
      agentName: `firstmate-${slugify(ctx.config.firstmate.pane_label, 20)}`.slice(0, 32),
      env: { FM_HOME: deps.home, FM_BACKEND: "herdr", FM_PRIMARY_HARNESS: to.harness, FM_PRIMARY_ACCOUNT: to.account,
        FM_TASK_ID: "", FM_SUPERVISION_ACTOR: "", FM_STATE_OVERRIDE: "", FM_DATA_OVERRIDE: "", FM_CONFIG_OVERRIDE: "", FM_ROOT_OVERRIDE: "", FM_WAKE_QUEUE: "", FM_WAKE_QUEUE_LOCK: "", ...to.env },
      args: [...primaryArgs(to, ctx.config.workers.permission_mode), ...(to.harness === "codex" && ctx.config.workers.permission_mode !== "bypassPermissions" ? ["--add-dir", deps.home] : [])],
      autoTrust: to.harness === "claude" || (to.harness === "codex" && ctx.config.workers.permission_mode !== "bypassPermissions"), prompt });
    deps.launched({ machine, pane_id: result.pane_id });
    attemptedPane = { machine, pane_id: result.pane_id, status: "unknown" };
    try {
      if (!result.prompt_sent) throw new Error("The successor could not receive its startup prompt. Retry from the Firstmate controls.");
      await h().refresh(machine);
      await awaitStartup(oldPid);
    } catch (error) {
      try { await closeAttempted(); }
      catch (cleanup) { throw new Error(`${error instanceof Error ? error.message : String(error)} Failed launch cleanup also failed: ${cleanup instanceof Error ? cleanup.message : String(cleanup)}`); }
      throw error;
    }
  }
  const controller = new PrimaryFailover({
    state: () => state, save, observe, choices,
    handoff: async (o, to, id, reason) => {
      const contextPath = path.join(paths.runtime, "state", `primary-handoff-${id}.json`);
      const bodyPath = path.join(paths.runtime, "state", `primary-handoff-${id}.md`);
      // Retries replay the identical payload, even if the pane or inbox changed.
      if (fs.existsSync(bodyPath)) return fs.readFileSync(bodyPath, "utf8");
      const outgoingPath = path.join(deps.home, "state", `primary-handoff-${id}.md`);
      const workers: WorkerView[] = ctx.services.get("workers")?.list?.() ?? [];
      const worker = workers.find((w) => w.id === `${o.pane.machine}:${o.pane.pane_id}`);
      let transcript = null;
      let transcriptPath = worker?.session ? ctx.services.get("sessions")?.get?.(worker.session)?.transcript ?? null : null;
      try {
        if (o.primary.harness === "cursor" && !simulated()) {
          const captured = await cursorHandoff(worker?.session, deps.dir);
          transcript = captured.transcript; transcriptPath = captured.path;
        } else if (worker?.session) transcript = await ctx.services.get("sessions")?.transcriptState(worker.session, { limit: 80, fullText: true }) ?? null;
      } catch {
        throw new Error("The source conversation could not be read. The source was preserved. Restore its transcript or reopen the conversation, then retry the handoff.");
      }
      const context = { from: o.primary, to, reason, transcript, screen: o.screen, home: deps.homeState(), contextPath, outgoingPath,
        transcriptPath,
        live: workers.filter((w) => w.id !== worker?.id).map((w) => ({ id: w.id, task: w.owner.task, status: w.status, action: w.current_action || w.last_message })) };
      fs.mkdirSync(path.dirname(contextPath), { recursive: true });
      fs.writeFileSync(`${contextPath}.tmp`, JSON.stringify(context), { mode: 0o600 });
      fs.renameSync(`${contextPath}.tmp`, contextPath);
      const body = composeHandoff(context);
      fs.writeFileSync(`${bodyPath}.tmp`, body, { mode: 0o600 });
      fs.renameSync(`${bodyPath}.tmp`, bodyPath);
      // Exhausted panes cannot answer. A responsive outgoing primary gets a bounded chance
      // to add its own next actions; the transcript-based note is always filed as well.
      if (!/hit.*limit|usage limit|rate limit|out of.*usage|429/i.test(o.screen) && !simulated()) {
        try {
          await h().prompt(o.pane.pane_id, `Joyride is switching Firstmate to ${to.label}. Write a handoff note to ${outgoingPath}, including recent captain asks verbatim, open promises and decisions, live workers and your next action. Preserve FM_HOME and stop supervising after writing it.`, { machine: o.pane.machine, keepDraft: true });
          const until = Date.now() + 10_000;
          while (Date.now() < until && !fs.existsSync(outgoingPath)) await pause(250);
        } catch { /* A pane that stopped responding still gets its transcript preserved. */ }
      }
      return body;
    },
    note: async (id, body) => (await deps.note(`primary-handoff-${id}`, body)).note,
    stop: async (pane) => {
      const oldPid = lockPid(deps.home);
      try { await h().sendKeys(pane.pane_id, ["ctrl+c"], { machine: pane.machine }); } catch {}
      // Closing only the outgoing primary's pane terminates its process group, while
      // the home and every worker pane survive. Never remove or force-rewrite .lock.
      let closeError: unknown = null;
      try { await h().call("pane.close", { pane_id: pane.pane_id }, { machine: pane.machine }); }
      catch (e) { closeError = e; }
      const until = Date.now() + 15_000;
      while (oldPid && alive(oldPid) && Date.now() < until) await pause(250);
      await h().refresh(pane.machine);
      if (oldPid && alive(oldPid)) throw new Error(`Outgoing Firstmate pid ${oldPid} is still alive. The successor was not started.`);
      if (deps.pane()?.pane_id === pane.pane_id) throw closeError ?? new Error("The outgoing Firstmate pane is still present. The successor was not started.");
    },
    launch,
    validate,
    recover: async (source, note) => {
      if (!hasCapacity(usage(), source.primary.account)) throw new Error("The source no longer has capacity. Refresh usage and start an available primary.");
      await closeAttempted();
      await launch(source.primary, note);
    },
  }, { confirmationMs: ctx.config.firstmate.confirmation_seconds * 1000, nearZeroSeconds: ctx.config.firstmate.near_zero_runway_seconds });

  function status(): PrimaryStatus {
    const active = current(), report: UsageSnapshot = ctx.services.get("usage")?.snapshot?.() ?? emptyUsage(), list = choices();
    const claude = list.find((p) => p.harness === "claude" && p.account !== active?.account && hasCapacity(report, p.account));
    return { ...state, current: active ? { account: active.account, label: active.label, harness: active.harness, model: active.model } : null,
      choices: list.map(({ env, ...p }) => ({ ...p, available: hasCapacity(report, p.account) })), returnToClaude: claude?.account ?? null };
  }
  async function start(automatic = false) {
    if (startJob || controller.busy()) throw new Error("Firstmate is already starting or switching. Wait for it to finish.");
    refreshAccounts();
    startJob = (async () => {
      const pending = state.phase !== "ready" && state.lastSwitch?.note;
      const list = choices();
      const to = (pending ? list.find((p) => p.account === state.lastSwitch?.to) : null) ?? list.find((p) => hasCapacity(usage(), p.account)) ?? list[0];
      if (!to) throw new Error("No Firstmate primary matches usage.accounts. Check firstmate.primaries.");
      const attempts = state.lastSwitch?.attempts ?? 0;
      const lastSwitch = pending && state.lastSwitch ? { ...state.lastSwitch, attempts: (!automatic && attempts >= MAX_HANDOFF_ATTEMPTS ? 0 : attempts) + 1, retryAt: null } : state.lastSwitch;
      save({ ...state, lastSwitch, current: to, phase: "starting", error: null });
      try {
        if (pending && !hasCapacity(usage(), to.account)) throw new Error(`${to.label} has no fresh usage reading with capacity. Refresh usage limits, then retry.`);
        await launch(to, pending ? state.lastSwitch?.note ?? "" : ""); save({ ...state, phase: "ready", error: null });
      }
      catch (e) {
        const attempts = state.lastSwitch?.attempts ?? 1;
        save({ ...state, lastSwitch: state.lastSwitch ? { ...state.lastSwitch, retryAt: Date.now() + 60_000 * attempts } : null, phase: "failed",
          error: `${e instanceof Error ? e.message : String(e)}${attempts >= MAX_HANDOFF_ATTEMPTS ? " Automatic handoff paused after 3 attempts. Fix startup, then retry from the Firstmate controls." : " Retry from the Firstmate controls or wait for the saved handoff to retry."}` });
        throw e;
      }
    })().finally(() => { startJob = null; });
    return startJob;
  }
  return {
    status, start, refreshAccounts,
    switch: (account: string, reason?: string) => startJob ? Promise.reject(new Error("Firstmate is starting. Wait for it to finish.")) : controller.switch(account, reason),
    check: async () => {
      if (stopped || startJob || controller.busy()) return;
      if (state.phase !== "ready" && state.lastSwitch?.note) {
        if (!deps.pane() && (state.lastSwitch?.attempts ?? 0) < MAX_HANDOFF_ATTEMPTS && Date.now() >= (state.lastSwitch?.retryAt ?? 0)) { await start(true); return; }
        const pid = lockPid(deps.home);
        const marker = path.join(deps.home, "state", ".session-start-complete");
        const pane = deps.pane();
        const target = choices().find((p) => p.account === state.lastSwitch?.to);
        const startedAt = Date.parse(state.lastSwitch.at);
        if (pane && target && pane.agent === target.harness && current()?.account === target.account && state.current?.account === target.account
          && pid && alive(pid) && fs.existsSync(marker) && fs.readFileSync(marker, "utf8").trim() === String(pid)
          && Number.isFinite(startedAt) && fs.statSync(marker).mtimeMs >= startedAt)
          save({ ...state, phase: "ready", error: null });
      }
      await controller.check();
    },
    stop: () => { stopped = true; },
  };
}
