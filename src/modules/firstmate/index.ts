// Firstmate (checkpoint C7): a read-only projection of Firstmate's FM_HOME into
// tasks and crews, plus the intents that reach Firstmate. Joyride never edits
// Firstmate's state: it files a captain inbox note with bin/fm-inbox.sh
// (create_task) or runs bin/fm-send.sh (steer_task). Firstmate only starts when
// the human asks (POST /api/firstmate/start), or to recover a saved primary handoff.
//   service `firstmate`: status(), tasks({mission?}), task(id), report(id), send(taskId, text), ensureRunning(), reload(), home(),
//                        crewKeys(), controlWorker() (what the workers projection needs to tell crew from watched),
//                        note(requestId, body) (a captain inbox note; the fleet module relays through it)
//   routes: /api/firstmate, /api/firstmate/status, /api/firstmate/tasks[?mission=], /api/firstmate/tasks/:id[/report],
//           POST /api/firstmate/send {task, text}, POST /api/firstmate/start,
//           POST /api/firstmate/place {text, idea?, kinds?} (where a request goes, and with kinds whether it is a task, note or list; request.ts),
//           GET /api/firstmate/requests/:id (how far it got, from fm-inbox.sh receipts), POST /api/firstmate/requests/:id/nudge
//           GET /api/firstmate/replies (Firstmate's answers to map requests, for the cards they became),
//           POST /api/firstmate/requests/:id/dismiss (the captain is done with that reply)
//   create_task targets a mission id, `auto` (Jev placement; a task in flight becomes a steer) or `new` (names and commits an idea).
//   tell_firstmate {text, idea?} (the New box's update or question) files a captain inbox note; its reply shows on the map too.
//   bus entities: tasks, requests (Firstmate's inbox moved: a note read or a reply written)
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { defineModule, type Ctx } from "../../core/context.ts";
import { kvGet, kvSet } from "../../core/db.ts";
import { ensureDir, now, truncate } from "../../core/util.ts";
import { paths } from "../../shared/paths.ts";
import type { Mission, WorkerView } from "../../shared/schema.ts";
import type { CrewKey } from "../live/owner.ts";
import type { MachinePane } from "../live/herdr.ts";
import { homeSignature, readHome, type HomeState, type TaskDetail } from "./state.ts";
import { FIRSTMATE_PIN, seedHome } from "./seed.ts";
import { checkFirstmateVendorAsync, type VendorCheck } from "./vendor.ts";
import { buildTaskRequest, imagesNote } from "./prompt.ts";
import { attachedImages } from "../live/intents.ts";
import { canSendImages, noImagesReason } from "../../shared/images.ts";
import { FM_TOOL_SPECS, findTool } from "../system/tools.ts";
import { jev, jevAvailable, pick, probs, q } from "../../core/jev.ts";
import { llm } from "../../core/llm.ts";
import { createPrimaryManager } from "./primary.ts";
import { fileInboxNote, HANDOFF_FILING_TIMEOUT_MS } from "./inbox.ts";
import { isPrimaryIdle, type PrimaryStatus } from "../../shared/firstmate-primary.ts";
import { NAMING_SCHEMA, namingPrompt, type Naming } from "../ideas/prompts.ts";
import {
  KIND_CRITERIA, REPLY_KINDS, captainMessage, findRequestNote, fixedPlacement, kindFrom, mapReplies, openIdeas, parseReceipts, placeCriteria, placementFrom, requestProgress, steerableTasks,
  type MapReply, type Placement, type Receipts, type RequestProgress,
} from "./request.ts";

export type CrewWorker = { id: string; agent: string; status: string; title: string; cwd: string; controllable: boolean };
export type CrewTask = TaskDetail & { workers: CrewWorker[] };
export type FirstmateStatus = {
  home: string; home_exists: boolean; configured: boolean; backend: string | null;
  running: boolean; pane: { machine: string; pane_id: string; worker: string; status: string } | null;
  herdr_connected: boolean;
  primary: PrimaryStatus;
  /** pinned: the upstream pin plus every patch in install/firstmate-patches (patches lists the applied ones). */
  vendor: { path: string; present: boolean; head: string | null; pin: string; pinned: boolean; patches: string[]; missing_patches: string[] };
  tasks: { total: number; in_flight: number; queued: number; done: number; for_missions: number };
  summary: HomeState["summary"]; projects: HomeState["projects"]; secondmates: number;
  /** missing_tools: what a local-only project on the herdr backend needs; optional_missing: what it can skip. */
  setup: { missing_tools: string[]; optional_missing: string[]; not_on_path: string[]; notes: string[] };
  errors: string[];
};
export type FirstmateApi = {
  status(): FirstmateStatus;
  tasks(opts?: { mission?: string }): CrewTask[];
  task(id: string): CrewTask | null;
  report(id: string): { path: string; text: string } | null;
  send(taskId: string, text: string, images?: string[]): Promise<{ task: string; recorded: boolean; output: string; images?: string[] }>;
  ensureRunning(): Promise<FirstmateStatus & { started: boolean }>;
  switchPrimary(account: string): Promise<FirstmateStatus>;
  reload(): boolean;
  /** Each task's recorded Herdr pane (mapped to a Joyride machine) and mission: the authoritative crew identity. */
  crewKeys(): CrewKey[];
  /** Firstmate's own pane as a worker id, or null when it is not running. */
  controlWorker(): string | null;
  isControlWorker(w: Pick<WorkerView, "id" | "cwd">): boolean;
  /** The whole projected home: tasks, Firstmate's own summary and open decisions (a cross-check), its wake queue, secondmates. */
  home(): HomeState;
  /** File a captain inbox note (bin/fm-inbox.sh note): durable, idempotent per request id, never typed into a pane. */
  note(requestId: string, body: string): Promise<{ note: string; outcome: string; announced: boolean | null; path: string }>;
  answerHold(task: string, answer: string, label: string, mode: "done" | "release"): Promise<{ output: string }>;
  answerDecision(task: string, answer: string, key?: string): Promise<{ output: string }>;
};

let lifecycle: { start(): void; stop(): void } | null = null;

class FirstmateError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

// Tools Firstmate's bootstrap checks for (bin/fm-bootstrap.sh), split into what local-only projects on
// the herdr backend need and what they can skip (gh and its pipeline only matter for GitHub projects).
// The setup page (#/setup) installs each one.

export const firstmateDir = () => paths.firstmateDir;
export const evidenceBin = () => path.join(paths.code, "bin", "joyride-evidence");
const skillsDir = () => path.join(paths.claudeDir, "skills");


/**
 * Under tests (JOYRIDE_TEST) fm-send.sh runs with stub tmux/herdr/sleep first on PATH, so a
 * fixture task can never ring a doorbell into a real terminal.
 */
function fmSendEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, FM_HOME: paths.firstmateHome, HERDR_SOCKET_PATH: paths.herdrSocket, JOYRIDE_GUARD: "off" };
  // A worker's inherited home overrides must never redirect the daemon's intake.
  for (const key of ["FM_STATE_OVERRIDE", "FM_DATA_OVERRIDE", "FM_CONFIG_OVERRIDE", "FM_ROOT_OVERRIDE", "FM_WAKE_QUEUE", "FM_WAKE_QUEUE_LOCK"]) delete env[key];
  if (process.env.JOYRIDE_TEST) {
    const stub = ensureDir(path.join(paths.runtime, "firstmate-stubs"));
    const log = path.join(stub, "calls.log");
    for (const b of ["tmux", "herdr"]) {
      const f = path.join(stub, b);
      if (!fs.existsSync(f)) fs.writeFileSync(f, `#!/usr/bin/env bash\nprintf '%s %s\\n' "$(basename "$0")" "$*" >> '${log}'\nexit 1\n`, { mode: 0o755 });
    }
    const sl = path.join(stub, "sleep");
    if (!fs.existsSync(sl)) fs.writeFileSync(sl, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    env.PATH = `${stub}:${env.PATH ?? ""}`;
    env.FM_SEND_SETTLE = "0";
    env.TASKS_AXI_BACKEND = "markdown";
  }
  return env;
}

export default defineModule({
  name: "firstmate",
  order: 60,
  register(ctx: Ctx) {
    const { app, db } = ctx;
    const home = () => paths.firstmateHome;
    let state: HomeState = { home: home(), present: false, tasks: [], secondmates: [], projects: [], summary: null, summary_decisions: [], wake: { pending: 0, oldest: null }, backend: null, errors: [] };
    let sig = "";
    let receiptsCache: { at: number; all: boolean; r: Receipts } | null = null;
    let vendor: FirstmateStatus["vendor"] = { path: firstmateDir(), present: false, head: null, pin: FIRSTMATE_PIN, pinned: false, patches: [], missing_patches: [] };
    let vendorRefreshing: Promise<void> | null = null;
    let vendorCheck: VendorCheck | undefined;
    const diagnostics = ctx.service<import("../../core/diagnostics.ts").Diagnostics>("diagnostics");
    function refreshVendor() {
      if (vendorRefreshing) return vendorRefreshing;
      vendorRefreshing = diagnostics.refresh("firstmate vendor", async () => {
        const dir = firstmateDir();
        const present = await fs.promises.access(path.join(dir, "bin", "fm-send.sh")).then(() => true, () => false);
        const check = present ? await checkFirstmateVendorAsync(dir, {}, vendorCheck) : null;
        vendorCheck = check ?? undefined;
        vendor = { path: dir, present, head: check?.head ?? null, pin: FIRSTMATE_PIN, pinned: check?.state === "pinned", patches: check?.applied ?? [], missing_patches: check?.missing ?? [] };
      }).catch((e) => ctx.log(`firstmate: vendor refresh failed: ${e}`)).finally(() => { vendorRefreshing = null; });
      return vendorRefreshing;
    }
    let tools: { at: number; required: string[]; optional: string[]; offPath: string[] } = { at: 0, required: [], optional: [], offPath: [] };
    const optional = <T,>(name: string): T | null => (ctx.services.get(name) as T | undefined) ?? null;
    const missionsSvc = () => optional<any>("missions");
    const herdr = () => optional<any>("herdr");
    const workers = () => optional<any>("workers");
    const intents = () => optional<any>("intents");

    function crewsMap(): Record<string, string[]> {
      const svc = missionsSvc();
      if (!svc) return {};
      try { return Object.fromEntries((svc.list({}) as Mission[]).filter((m) => m.crews?.length).map((m) => [m.id, m.crews])); } catch { return {}; }
    }

    /** Re-read FM_HOME; returns true (and announces "tasks") when anything changed. */
    function reload(force = false): boolean {
      const s = homeSignature(home());
      if (!force && s === sig) return false;
      sig = s;
      // The inbox may have moved (a note read, a reply written): the next receipts read is fresh.
      receiptsCache = null;
      ctx.bus.change({ entity: "requests" });
      const before = JSON.stringify(state.tasks);
      try { state = readHome(home(), crewsMap(), kvGet<Record<string, string>>(db, "firstmate:linked", {})); }
      catch (e: any) { state = { ...state, errors: [`Could not read ${home()}: ${e.message}`] }; }
      linkMarkedTasks();
      const changed = JSON.stringify(state.tasks) !== before;
      if (changed || force) ctx.bus.change({ entity: "tasks" });
      return changed;
    }

    /**
     * A task whose brief carries our marker is linked into the mission's authored `crews` once. When the
     * marker now names another mission, Joyride's own earlier auto-link is moved with it (one commit).
     */
    function linkMarkedTasks() {
      const svc = missionsSvc();
      if (!svc) return;
      const seen = kvGet<Record<string, string>>(db, "firstmate:linked", {});
      let dirty = false;
      for (const t of state.tasks) {
        if (t.mission_source !== "marker" || !t.mission || seen[t.id] === t.mission) continue;
        try {
          const m: Mission | null = svc.get(t.mission);
          if (!m) continue; // the mission may be created later; try again on the next reload
          const prev: Mission | null = seen[t.id] ? svc.get(seen[t.id]) : null;
          const changed: Mission[] = [];
          if (prev && prev.id !== m.id && prev.crews.includes(t.id)) changed.push({ ...prev, crews: prev.crews.filter((x) => x !== t.id) });
          if (!m.crews.includes(t.id)) changed.push({ ...m, crews: [...m.crews, t.id] });
          if (changed.length) svc.applyGrouping({ missions: changed, lenses: [] }, `mission ${m.id}: link Firstmate task ${t.id}${changed.length > 1 ? ` (its brief moved it from ${prev!.id})` : ""}`);
          seen[t.id] = t.mission;
          dirty = true;
        } catch (e: any) { ctx.log(`firstmate: could not link task ${t.id} to mission ${t.mission}: ${e.message}`); }
      }
      if (dirty) kvSet(db, "firstmate:linked", seen);
    }

    /** The live workers the projection identified as this task's crew (by recorded pane or FM_TASK_ID, never by cwd). */
    function crewWorkers(t: TaskDetail): CrewWorker[] {
      const w = workers();
      if (!w) return [];
      let list: WorkerView[] = [];
      try { list = w.list(); } catch { return []; }
      return list
        .filter((x) => x.owner?.tier === "crew" && x.owner.task === t.id)
        .map((x) => ({ id: x.id, agent: x.agent, status: x.status, title: x.title, cwd: x.cwd, controllable: x.controllable }));
    }

    function crewKeys(): CrewKey[] {
      const h = herdr();
      return state.tasks.map((t) => {
        let machine: string | null = null;
        if (t.pane) { try { machine = h?.machineForHerdrSession?.(t.herdr_session) ?? null; } catch {} }
        return { task: t.id, mission: t.mission, machine: machine ?? (t.pid ? h?.defaultMachine?.() ?? "local" : null), pane: t.pane, pid: t.pid };
      });
    }
    const withCrew = (t: TaskDetail): CrewTask => ({ ...t, workers: crewWorkers(t) });

    function findPane(): { machine: string; pane_id: string; status: string; agent: string } | null {
      const h = herdr();
      if (!h) return null;
      let panes: MachinePane[] = [];
      try { panes = h.snapshot().panes; } catch { return null; }
      const label = ctx.config.firstmate?.pane_label ?? "firstmate";
      const saved = kvGet<{ machine: string; pane_id: string; terminal_id?: string } | null>(db, "firstmate:pane", null);
      const dir = vendor.path;
      const crew = crewKeys();
      const candidates = panes.filter((p) => p.agent && !crew.some((k) => k.machine === p.machine && k.pane === p.pane_id));
      const hit = candidates.find((p) => saved && p.machine === saved.machine && p.pane_id === saved.pane_id && (!saved.terminal_id || p.terminal_id === saved.terminal_id))
        ?? candidates.find((p) => p.name === label || p.label === label)
        ?? candidates.find((p) => (p.foreground_cwd ?? p.cwd) === dir);
      return hit?.agent ? { machine: hit.machine, pane_id: hit.pane_id, status: hit.agent_status ?? "unknown", agent: hit.agent } : null;
    }

    const primary = createPrimaryManager(ctx, {
      home: home(), dir: firstmateDir(), pane: findPane,
      homeState: () => { reload(true); return state; }, note: (id, body) => fileNote(id, body, HANDOFF_FILING_TIMEOUT_MS),
      launched: (pane) => kvSet(db, "firstmate:pane", { ...pane, started: now() }),
    });


    function refreshTools() {
      if (Date.now() - tools.at > 60_000) {
        const found = new Map(FM_TOOL_SPECS.map((t) => [t.name, findTool(t.name)]));
        tools = {
          at: Date.now(),
          required: FM_TOOL_SPECS.filter((t) => t.tier === "required" && !found.get(t.name)).map((t) => t.name),
          optional: FM_TOOL_SPECS.filter((t) => t.tier === "optional" && !found.get(t.name)).map((t) => t.name),
          offPath: FM_TOOL_SPECS.filter((t) => { const f = found.get(t.name); return f && !f.on_path; }).map((t) => t.name),
        };
      }
    }

    function status(): FirstmateStatus {
      const pane = findPane();
      const h = herdr();
      const notes: string[] = ["Firstmate uses the configured permission mode and account priority. Joyride answers Claude Code's folder-trust prompt for vendor/firstmate."];
      if (tools.required.length) notes.push(`Firstmate needs ${tools.required.join(", ")} before it can start a worker. Install them from Set up Joyride (#/setup), or approve them when Firstmate asks on its first start.`);
      if (tools.offPath.length) notes.push(`${tools.offPath.join(", ")} ${tools.offPath.length > 1 ? "are" : "is"} installed outside your PATH, so Firstmate can't see ${tools.offPath.length > 1 ? "them" : "it"}. Set up Joyride shows where.`);
      if (tools.optional.length) notes.push(`Optional and missing: ${tools.optional.join(", ")}. Firstmate's start-up check lists the GitHub tools (gh, gh-axi, no-mistakes) as missing; Joyride projects are local-only, so that is expected.`);
      const backend = state.backend;
      return {
        home: home(), home_exists: state.present, configured: backend === "herdr",
        backend, running: Boolean(pane),
        pane: pane ? { ...pane, worker: `${pane.machine}:${pane.pane_id}` } : null,
        herdr_connected: Boolean(h?.connected?.()),
        primary: primary.status(),
        vendor,
        tasks: {
          total: state.tasks.length,
          in_flight: state.tasks.filter((t) => t.section === "in_flight" || (!t.section && t.status !== "done")).length,
          queued: state.tasks.filter((t) => t.section === "queued").length,
          done: state.tasks.filter((t) => t.section === "done").length,
          for_missions: state.tasks.filter((t) => t.mission).length,
        },
        summary: state.summary, projects: state.projects, secondmates: state.secondmates.length,
        setup: { missing_tools: tools.required, optional_missing: tools.optional, not_on_path: tools.offPath, notes },
        errors: state.errors,
      };
    }

    function send(taskId: string, text: string, images: string[] = []): Promise<{ task: string; recorded: boolean; output: string; images?: string[] }> {
      const typed = String(text ?? "").trim();
      if (!typed && !images.length) return Promise.reject(new FirstmateError("The message is empty. Type what the crew should change and send it again."));
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(taskId)) return Promise.reject(new FirstmateError(`"${taskId}" is not a Firstmate task id.`));
      if (images.length) {
        // The crewmate reads the steer from its inbox file, then opens each path with its own image reader.
        const crew = api.task(taskId)?.workers ?? [];
        const blind = crew.find((w) => !canSendImages(w.agent));
        if (blind && !crew.some((w) => canSendImages(w.agent))) return Promise.reject(new FirstmateError(noImagesReason(blind.agent, `The crewmate on ${taskId}`)));
      }
      const body = images.length ? `${typed}${typed ? "\n\n" : ""}${imagesNote(images, "Open each one before you act on this message")}` : typed;
      if (!fs.existsSync(path.join(home(), "state", `${taskId}.meta`))) {
        return Promise.reject(new FirstmateError(`Firstmate has no running task ${taskId} (no state/${taskId}.meta in ${home()}). Steer only works for tasks Firstmate has spawned; queued tasks take their brief when they start.`, 404));
      }
      const script = path.join(firstmateDir(), "bin", "fm-send.sh");
      if (!fs.existsSync(script)) return Promise.reject(new FirstmateError(`Firstmate is not vendored at ${firstmateDir()}. Run \`./bin/joyride vendor firstmate\` to clone it at the pin with Joyride's patches.`, 500));
      return new Promise((resolve, reject) => {
        execFile(script, [taskId, body], { env: fmSendEnv(), cwd: firstmateDir(), timeout: 30_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
          const output = `${stdout ?? ""}${stderr ?? ""}`.split("\n").filter((l) => l.trim() && !l.startsWith("●")).join("\n").slice(-1200);
          if (err) return reject(new FirstmateError(`fm-send.sh could not deliver the steer to ${taskId} (exit ${(err as any).code ?? "?"}): ${output || err.message}`, 502));
          reload(true);
          resolve({ task: taskId, recorded: true, output, ...(images.length ? { images } : {}) });
        });
      });
    }

    function answerScript(name: string, args: string[], stdin?: string): Promise<{ output: string }> {
      const script = path.join(firstmateDir(), "bin", name);
      if (!fs.existsSync(script)) return Promise.reject(new FirstmateError(`Firstmate's ${name} is missing at ${firstmateDir()}. Run \`./bin/joyride vendor firstmate\`, then retry the answer.`, 503));
      return new Promise((resolve, reject) => {
        let inputError: Error | null = null;
        const child = execFile(script, args, { env: fmSendEnv(), cwd: firstmateDir(), timeout: 30_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
          const output = `${stdout ?? ""}${stderr ?? ""}`.trim();
          reload(true);
          // The intake can confirm a close even if a later bookkeeping step fails.
          const closed = name === "fm-captain-hold.sh" && output.split("\n").some((l) => l.startsWith("closed:"));
          if ((err || inputError || (name === "fm-captain-hold.sh" && output.includes("skipped:"))) && !closed) return reject(new FirstmateError(output.includes("skipped:")
            ? `Firstmate skipped this answer. It may have already closed the call; refresh the ask. ${output.slice(-1200)}`
            : `${name} could not record the answer: ${output.slice(-1200) || err?.message || inputError?.message}. Check Firstmate's task and retry.`, 502));
          resolve({ output: output.slice(-1200) });
        });
        child.stdin?.on("error", (error) => { inputError = error; });
        child.stdin?.end(stdin);
      });
    }

    /**
     * File a captain inbox note with bin/fm-inbox.sh: a durable record plus one `check` wake, safe while
     * Firstmate is mid-turn, and never typed into its pane (so a draft in its composer survives).
     * `--request-id` makes a retry of the same intent replay the original note instead of adding one.
     */
    async function fileNote(requestId: string, body: string, timeoutMs = 300_000): Promise<{ note: string; outcome: string; announced: boolean | null; path: string }> {
      const script = path.join(firstmateDir(), "bin", "fm-inbox.sh");
      if (!fs.existsSync(script)) return Promise.reject(new FirstmateError(`Firstmate is not vendored at ${firstmateDir()}. Run \`./bin/joyride vendor firstmate\` to clone it at the pin with Joyride's patches.`, 500));
      try {
        const note = await fileInboxNote({ script, cwd: firstmateDir(), env: fmSendEnv(), requestId, body, timeoutMs });
        receiptsCache = null;
        return note;
      } catch (e) { throw new FirstmateError(e instanceof Error ? e.message : String(e), 502); }
    }

    async function ensureRunning(): Promise<FirstmateStatus & { started: boolean }> {
      const existing = findPane();
      if (existing) return { ...status(), started: false };
      const h = herdr();
      if (!h) throw new FirstmateError("The live module is not running, so Joyride can't reach Herdr to start Firstmate.", 503);
      const machine = h.defaultMachine();
      if (!h.connected(machine)) throw new FirstmateError(`Herdr on ${machine} is not connected. Start Herdr (\`herdr\`), then start Firstmate again.`, 503);
      const dir = firstmateDir();
      if (!fs.existsSync(path.join(dir, "AGENTS.md"))) throw new FirstmateError(`Firstmate is not vendored at ${dir}. Run \`./bin/joyride vendor firstmate\`, then try again.`, 500);
      // Seed only missing files; Firstmate owns its existing preferences.
      const seeded = seedHome(home(), { evidenceBin: evidenceBin() });
      try { await primary.start(); }
      catch (e: unknown) { throw new FirstmateError(`Herdr could not start Firstmate: ${e instanceof Error ? e.message : String(e)}`, 502); }
      const root = findPane();
      try { ctx.emit({ source: "daemon", type: "firstmate.started", cwd: dir, pane: root?.pane_id, data: { machine, home: home(), seeded: seeded.created, primary: primary.status().current } }); } catch {}
      try { await h.refresh(machine); } catch {}
      reload(true);
      return { ...status(), started: true };
    }

    async function switchPrimary(account: string): Promise<FirstmateStatus> {
      primary.refreshAccounts();
      const info = primary.status();
      const target = info.choices.find((p) => p.account === account);
      if (target && target.account !== info.current?.account && !target.available)
        throw new FirstmateError(`${target.label} has no fresh usage reading with capacity. Refresh usage limits, then retry.`, 409);
      if (target?.harness === "claude" && info.current?.harness !== "claude" && !isPrimaryIdle(findPane()?.status))
        throw new FirstmateError("Firstmate is working. Wait until it is idle, then switch to Claude Code.", 409);
      try { await primary.switch(account); }
      catch (e) { throw new FirstmateError(primary.status().error ?? (e instanceof Error ? e.message : String(e)), 409); }
      reload(true);
      return status();
    }

    // ---------- new task from anywhere (request.ts) ----------
    const ideasNow = (): Mission[] => { try { return openIdeas(missionsSvc()?.list({}) ?? []); } catch { return []; } };

    /**
     * Jev's idea_place over the tasks in flight, the open ideas and "new". A fixed idea is certain.
     * `kinds` (text that only mentions notes or lists) also asks, in the same call, whether it is a task at all.
     */
    async function place(text: string, idea?: string, kinds = false): Promise<Placement & { error?: string }> {
      const ideas = ideasNow();
      const askKind = kinds && jevAvailable();
      const kindQ = { compose_kind: q.choice("The captain typed this into the box that sends work to their agents. Is it work for an agent, a note to keep, or a checklist to tick off?", KIND_CRITERIA) };
      if (idea) {
        const m: Mission | null = missionsSvc()?.get(idea) ?? null;
        if (!m) throw new FirstmateError(`There is no idea ${idea}. Pick another target.`, 404);
        if (!askKind) return fixedPlacement(m);
        try {
          const r = await jev({ request: truncate(text, 2000) }, kindQ, { timeoutMs: 15000, retries: 1 });
          return { ...fixedPlacement(m), kind: kindFrom(pick(r, "compose_kind"), probs(r, "compose_kind")) };
        } catch { return fixedPlacement(m); }
      }
      const tasks = steerableTasks(state.tasks);
      if (!tasks.length && !ideas.length && !askKind) return { choice: { kind: "new", title: null, p: 1 }, auto: true, options: [{ kind: "new", title: null, p: 1 }], via: "fixed" };
      if (!jevAvailable()) return { ...placementFrom(null, {}, tasks, ideas), error: "Jev is not configured, so pick where this goes." };
      try {
        const r = await jev({ request: truncate(text, 2000) }, {
          idea_place: q.choice("The captain typed a request for their agents. Where does it belong: more work for one task already in flight, a new task inside one of the ideas (streams of the captain's intent), or a new idea? Choose new when none clearly fits.", placeCriteria(tasks, ideas)),
          ...(askKind ? kindQ : {}),
        }, { timeoutMs: 15000, retries: 1 });
        const pl = placementFrom(pick(r, "idea_place"), probs(r, "idea_place"), tasks, ideas);
        return askKind ? { ...pl, kind: kindFrom(pick(r, "compose_kind"), probs(r, "compose_kind")) } : pl;
      } catch (e: any) {
        return { ...placementFrom(null, {}, tasks, ideas), error: `Jev could not place this (${e.message}), so pick where it goes.` };
      }
    }

    /** Name a new idea for a request (idea_naming) and commit it as a mission. */
    async function newIdea(text: string, title?: string): Promise<Mission> {
      const svc = missionsSvc();
      let named = { title: String(title ?? "").trim(), goal: "" };
      if (!named.title) {
        try {
          const n = await llm<Naming>(namingPrompt({ task: { id: "request", title: truncate(text.replace(/\s+/g, " "), 120), kind: "request", repo: null, brief: truncate(text, 900), last_event: "" }, ideas: [], groups: [] }), { task: "idea_naming", schema: NAMING_SCHEMA, timeoutMs: 240000 });
          named = { title: String(n?.title ?? "").trim(), goal: String(n?.goal ?? "").trim() };
        } catch (e: any) { ctx.log(`firstmate: idea_naming for a map request failed: ${e.message}`); }
      }
      if (!named.title) named.title = text.replace(/\s+/g, " ").trim().split(" ").slice(0, 6).join(" ").replace(/^[a-z]/, (c) => c.toUpperCase());
      return svc.create({ title: truncate(named.title, 100), goal: named.goal || text.trim().slice(0, 600), state: "open" }, `mission: new idea "${truncate(named.title, 60)}" from a map request`);
    }

    function receipts(all: boolean, fresh = false): Promise<Receipts> {
      if (!fresh && receiptsCache && Date.now() - receiptsCache.at < 1500 && (receiptsCache.all || !all)) return Promise.resolve(receiptsCache.r);
      const script = path.join(firstmateDir(), "bin", "fm-inbox.sh");
      if (!fs.existsSync(script)) return Promise.reject(new FirstmateError(`Firstmate is not vendored at ${firstmateDir()}. Run \`./bin/joyride vendor firstmate\`.`, 503));
      return new Promise((resolve, reject) => {
        execFile(script, ["receipts", ...(all ? ["--all-pending", "--all-handled"] : [])], { env: fmSendEnv(), cwd: firstmateDir(), timeout: 15_000, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
          if (err) return reject(new FirstmateError(`fm-inbox.sh receipts failed (exit ${(err as any).code ?? "?"}): ${String(stderr || err.message).slice(-600)}`, 502));
          try { const r = parseReceipts(String(stdout)); receiptsCache = { at: Date.now(), all, r }; resolve(r); }
          catch (e: any) { reject(new FirstmateError(e.message, 502)); }
        });
      });
    }

    async function requestState(id: string): Promise<RequestProgress & { firstmate_running: boolean }> {
      let note = findRequestNote(await receipts(false), id);
      // A miss may be a note filed after the cached read: look again, uncached and unbounded.
      if (!note) note = findRequestNote(await receipts(true, true), id);
      return { ...requestProgress(id, note, state.tasks), firstmate_running: Boolean(findPane()) };
    }

    /** Replies to map requests the captain has not dismissed (request.ts mapReplies). */
    async function replies(): Promise<MapReply[]> {
      const list: any[] = REPLY_KINDS.flatMap((kind) => intents()?.list({ kind, limit: 300 }) ?? []);
      if (!list.length) return [];
      return mapReplies(list, await receipts(true), state.tasks, kvGet<Record<string, string>>(db, "firstmate:replies-dismissed", {}));
    }

    function announce(noteId: string): Promise<{ output: string }> {
      const script = path.join(firstmateDir(), "bin", "fm-inbox.sh");
      return new Promise((resolve, reject) => {
        execFile(script, ["announce", "--json", noteId], { env: fmSendEnv(), cwd: firstmateDir(), timeout: 15_000 }, (err, stdout, stderr) => {
          const output = `${stdout ?? ""}${stderr ?? ""}`.trim().slice(-600);
          if (err) return reject(new FirstmateError(`fm-inbox.sh could not ring Firstmate again (exit ${(err as any).code ?? "?"}): ${output || err.message}`, 502));
          resolve({ output });
        });
      });
    }

    const api: FirstmateApi = {
      status,
      tasks: (o = {}) => state.tasks.filter((t) => !o.mission || t.mission === o.mission).map(withCrew),
      task: (id) => { const t = state.tasks.find((x) => x.id === id); return t ? withCrew(t) : null; },
      report: (id) => {
        const t = state.tasks.find((x) => x.id === id);
        if (!t?.report) return null;
        try { return { path: t.report, text: fs.readFileSync(t.report, "utf8") }; } catch { return null; }
      },
      send, ensureRunning, switchPrimary, reload: () => reload(true),
      crewKeys,
      home: () => state,
      isControlWorker: (w) => w.cwd === firstmateDir() || w.cwd === paths.firstmateHome,
      controlWorker: () => { const p = findPane(); return p ? `${p.machine}:${p.pane_id}` : null; },
      note: (requestId, body) => fileNote(requestId, body),
      answerHold: (task, answer, label, mode) => answerScript("fm-captain-hold.sh", ["answers", "--source", "joyride-map"], `${task}\t${answer}\t${label}\t${mode}\n`),
      answerDecision: (task, answer, key) => answerScript("fm-send.sh", [task, ...(key ? ["--resolve-key", key] : []), answer]),
    };
    ctx.services.set("firstmate", api);
    reload(true);

    // ---------- intents ----------
    const reg = intents();
    if (reg) {
      reg.registerHandler("switch_firstmate", (it: { payload: { account?: string } }) => switchPrimary(String(it.payload.account ?? "")));
      reg.registerHandler("create_task", async (it: any) => {
        const svc = missionsSvc();
        if (!svc) throw new FirstmateError("The missions module is not running, so the task can't be tied to a mission.");
        const brief = String(it.payload?.brief ?? "").trim();
        if (!brief) throw new FirstmateError("Say what the crew should do, then create the task again.");
        // `auto`: Jev places it. More work for a task in flight is a steer into that task's inbox.
        let target = String(it.target ?? "");
        let placed: Placement["choice"] = null;
        if (target === "auto") {
          const pl = await place(brief);
          if (!pl.auto || !pl.choice) {
            const best = pl.choice ? ` (best guess: ${pl.choice.kind === "new" ? "a new idea" : `${pl.choice.kind} ${pl.choice.title}`}, ${Math.round(pl.choice.p * 100)}%)` : "";
            throw new FirstmateError(`Joyride isn't sure where this goes${best}. Pick an idea, a task or a new idea, then send it again.`);
          }
          placed = pl.choice;
          if (placed.kind === "task") {
            try { const r = await send(placed.id, brief, attachedImages(ctx, it.payload?.images)); return { via: "steer", task: placed.id, placed, request: it.id, output: r.output }; }
            catch (e: any) { throw new FirstmateError(e.message); }
          }
          target = placed.kind === "new" ? "new" : placed.id;
        }
        const mission: Mission | null = target === "new" ? await newIdea(brief, it.payload?.title) : svc.get(target);
        if (!mission) throw new FirstmateError(`There is no mission ${target}. Create the task from a mission page.`);
        // The inbox note is durable: a stopped Firstmate drains it on its next start, so no pane is needed.
        const running = Boolean(findPane());
        // Images travel as their stored paths in the note (Firstmate opens them with Read), the same way a
        // steer carries them to a crewmate's inbox, so nothing needs the pane.
        const images = attachedImages(ctx, it.payload?.images);
        let notes: { id: string; bullets: string[] }[] = [];
        try { notes = ctx.services.get("notes")?.forMission(mission.id) ?? []; } catch { /* notes module absent */ }
        const text = buildTaskRequest({ mission, brief, evidenceBin: evidenceBin(), skillsDir: skillsDir(), images, notes: notes.map((n) => n.bullets), request: it.id });
        let note: Awaited<ReturnType<typeof fileNote>>;
        try { note = await fileNote(it.id, text); }
        catch (e: any) { throw new FirstmateError(e.message); }
        return { mission: mission.id, mission_title: mission.title, created_idea: target === "new", placed, request: it.id, via: "inbox", note: note.note, outcome: note.outcome, announced: note.announced, firstmate_running: running, marker: `joyride-mission: ${mission.id}`, chars: text.length, notes: notes.map((n) => n.id), ...(images.length ? { images } : {}) };
      });
      reg.registerHandler("steer_task", async (it: any) => {
        const images = attachedImages(ctx, it.payload?.images);
        try { return await send(it.target, String(it.payload?.text ?? it.payload?.message ?? ""), images); }
        catch (e: any) { throw new FirstmateError(e.message); }
      });
      // A captain message from the New box: an update or a question, filed like a task request so it is durable,
      // drained by a stopped Firstmate on its next start, and answered on the map.
      reg.registerHandler("tell_firstmate", async (it: any) => {
        const text = String(it.payload?.text ?? "").trim();
        if (!text) throw new FirstmateError("Type the message for Firstmate, then send it again.", 400);
        const ideaId = it.payload?.idea ? String(it.payload.idea) : null;
        const m: Mission | null = ideaId ? missionsSvc()?.get(ideaId) ?? null : null;
        let note: Awaited<ReturnType<typeof fileNote>>;
        try { note = await fileNote(it.id, captainMessage({ requestId: it.id, text, idea: m ? { id: m.id, title: m.title } : null })); }
        catch (e: any) { throw new FirstmateError(e.message); }
        return { request: it.id, note: note.note, outcome: note.outcome, announced: note.announced, firstmate_running: Boolean(findPane()), ...(m ? { mission: m.id } : {}) };
      });
      reg.registerHandler("start_firstmate", async () => {
        const s = await ensureRunning();
        return { started: s.started, running: s.running, pane: s.pane, home: s.home };
      });
    }

    // ---------- routes ----------
    const fail = (c: any, e: any) => c.json({ error: e.message }, e instanceof FirstmateError ? e.status : 500);
    const viaIntent = async (c: any, kind: string, target: string, payload: Record<string, unknown>, direct: () => Promise<unknown>) => {
      const r = intents();
      if (!r) { try { return c.json(await direct()); } catch (e) { return fail(c, e); } }
      const it = await r.create(kind, target, payload);
      return c.json(it, it.status === "failed" ? 400 : 200);
    };
    app.get("/api/firstmate", (c) => c.json(status()));
    app.get("/api/firstmate/status", (c) => c.json(status()));
    app.get("/api/firstmate/tasks", (c) => c.json(api.tasks({ mission: c.req.query("mission") || undefined })));
    app.get("/api/firstmate/tasks/:id", (c) => {
      const t = api.task(c.req.param("id"));
      return t ? c.json(t) : c.json({ error: `Firstmate has no task ${c.req.param("id")}.` }, 404);
    });
    app.get("/api/firstmate/tasks/:id/report", (c) => {
      const r = api.report(c.req.param("id"));
      return r ? c.json(r) : c.json({ error: `Task ${c.req.param("id")} has no report yet.` }, 404);
    });
    app.post("/api/firstmate/send", async (c) => {
      let b: any = {};
      try { b = await c.req.json(); } catch {}
      const task = String(b.task ?? b.id ?? "");
      if (!task) return c.json({ error: "Send {task, text}: the Firstmate task id and the message." }, 400);
      const images = Array.isArray(b.images) && b.images.length ? b.images.map(String) : undefined;
      return viaIntent(c, "steer_task", task, { text: b.text ?? "", ...(images ? { images } : {}) }, () => send(task, b.text ?? "", images ? attachedImages(ctx, images) : []));
    });
    app.post("/api/firstmate/start", (c) => viaIntent(c, "start_firstmate", "firstmate", {}, () => ensureRunning()));
    app.post("/api/firstmate/switch", async (c) => {
      const b = await c.req.json<{ account?: string }>().catch(() => ({}));
      if (!("account" in b) || typeof b.account !== "string") return c.json({ error: "Choose an account to switch Firstmate to." }, 400);
      const account = b.account;
      return viaIntent(c, "switch_firstmate", "firstmate", { account }, () => switchPrimary(account));
    });
    app.post("/api/firstmate/place", async (c) => {
      let b: any = {};
      try { b = await c.req.json(); } catch {}
      const text = String(b.text ?? "").trim();
      if (!text) return c.json({ error: "Type what you want done, then place it." }, 400);
      try { return c.json(await place(text, b.idea ? String(b.idea) : undefined, b.kinds === true)); } catch (e) { return fail(c, e); }
    });
    app.get("/api/firstmate/requests/:id", async (c) => {
      try { return c.json(await requestState(c.req.param("id"))); } catch (e) { return fail(c, e); }
    });
    app.get("/api/firstmate/replies", async (c) => {
      try { return c.json(await replies()); } catch (e) { return fail(c, e); }
    });
    app.post("/api/firstmate/requests/:id/dismiss", (c) => {
      const id = c.req.param("id");
      const seen = kvGet<Record<string, string>>(db, "firstmate:replies-dismissed", {});
      seen[id] = now();
      kvSet(db, "firstmate:replies-dismissed", seen);
      ctx.bus.change({ entity: "requests", id });
      return c.json({ request: id, dismissed: seen[id] });
    });
    app.post("/api/firstmate/requests/:id/nudge", async (c) => {
      try {
        const s = await requestState(c.req.param("id"));
        if (!s.note) return c.json({ error: "Firstmate has no inbox note for this request yet." }, 404);
        if (s.note.acknowledged) return c.json({ ...s, nudged: false, message: "Firstmate already read this." });
        await announce(s.note.id);
        return c.json({ ...s, nudged: true });
      } catch (e) { return fail(c, e); }
    });

    // ---------- watching ----------
    let watchers: fs.FSWatcher[] = [];
    let poll: NodeJS.Timeout | null = null;
    let debounce: NodeJS.Timeout | null = null;
    const refreshHome = () => diagnostics.refresh("firstmate", () => { primary.refreshAccounts(); return reload(); }).catch((e) => ctx.log(`firstmate: refresh failed: ${e}`));
    const kick = () => { if (debounce) clearTimeout(debounce); debounce = setTimeout(() => { debounce = null; void refreshHome(); }, 250); debounce.unref(); };
    const offChange = ctx.bus.onChange((ch) => { if (ch.entity === "missions") { sig = ""; kick(); } });
    function arm() {
      for (const w of watchers) { try { w.close(); } catch {} }
      watchers = [];
      for (const d of [path.join(home(), "data"), path.join(home(), "state"), path.join(home(), "config")]) {
        if (!fs.existsSync(d)) continue;
        try { const w = fs.watch(d, { recursive: true }, kick); w.on("error", () => {}); watchers.push(w); } catch {}
      }
    }
    lifecycle = {
      // fs.watch gives fast updates; the poll covers a home created later and missed events.
      start: () => {
        void refreshVendor();
        refreshTools();
        void refreshHome();
        arm();
        const ms = Number(process.env.JOYRIDE_FIRSTMATE_POLL_MS ?? 5000);
        poll = setInterval(() => {
          if (!watchers.length && fs.existsSync(home())) arm();
          void refreshHome(); void refreshVendor(); refreshTools();
          if (ctx.config.firstmate.enabled) void primary.check().catch((e: unknown) => ctx.log("firstmate: primary capacity check failed", String(e)));
        }, ms);
        poll.unref();
      },
      stop: () => {
        for (const w of watchers) { try { w.close(); } catch {} }
        watchers = [];
        if (poll) clearInterval(poll);
        if (debounce) clearTimeout(debounce);
        offChange();
        primary.stop();
      },
    };
  },
  start() { lifecycle?.start(); },
  stop() { lifecycle?.stop(); },
});
