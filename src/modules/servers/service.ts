import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import type { Ctx } from "../../core/context.ts";
import { paths } from "../../shared/paths.ts";
import { ServerDefinition, ServerReceipt, type ServerAction, type ServerGroupView, type ServerMemberView, type ServerRun } from "../../shared/servers.ts";
import type { HerdrApi } from "../live/herdr.ts";
import { atomicJson, definitions, journalFile, readJournal, runRoot, saveDefinition, type Journal } from "./store.ts";

const Pane = z.object({ pane_id: z.string(), terminal_id: z.string(), workspace_id: z.string() });
const PaneList = z.object({ panes: z.array(Pane) });
const WorkspaceList = z.object({ workspaces: z.array(z.object({ workspace_id: z.string(), label: z.string().nullable().optional() })) });
const ProcessInfo = z.object({ process_info: z.object({ shell_pid: z.number().nullable().optional(), foreground_processes: z.array(z.object({ pid: z.number() })).default([]) }) });
const SERVER_TIMEOUT_MS = 10_000;
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
export const runKey = (group: string, member: string) => `${group}/${member}`;

export async function assertFreePort(port: number) {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createServer();
    socket.once("error", () => reject(new Error(`Port ${port} is occupied. Choose a free port or stop its owner through its own controls.`)));
    socket.listen({ host: "127.0.0.1", port, exclusive: true }, () => socket.close(() => resolve()));
  });
}
async function listening(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (yes: boolean) => { socket.destroy(); resolve(yes); };
    socket.setTimeout(200); socket.once("connect", () => done(true)); socket.once("error", () => done(false)); socket.once("timeout", () => done(false));
  });
}

export class ServersService {
  private journal: Journal;
  private queue: Promise<unknown> = Promise.resolve();
  private journalError: string | null = null;
  constructor(private ctx: Ctx) {
    try { this.journal = readJournal(); }
    catch (e) { this.journal = { runs: {}, requests: {} }; this.journalError = `Cannot read ${journalFile()}: ${message(e)}. Restore the ownership journal before controlling servers.`; }
  }
  private herdr() { return this.ctx.service<HerdrApi>("herdr"); }
  private persist() { atomicJson(journalFile(), this.journal); this.ctx.bus.change({ entity: "servers" }); }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => {}).then(() => { if (this.journalError) throw new Error(this.journalError); return fn(); });
    this.queue = next;
    return next;
  }
  private folder(run: ServerRun) { return path.join(runRoot(), run.nonce); }
  private receipt(run: ServerRun) {
    try {
      const r = ServerReceipt.parse(JSON.parse(fs.readFileSync(path.join(this.folder(run), "status.json"), "utf8")));
      return r.nonce === run.nonce ? r : null;
    } catch { return null; }
  }
  private get(id: string) {
    const group = definitions().find((g) => g.id === id);
    if (!group) throw new Error(`Server group ${id} does not exist. Use joyride servers list.`);
    return group;
  }
  private async panes(run: ServerRun) {
    const h = this.herdr(), machine = h.machines().find((m) => m.label === run.machine);
    if (!machine?.connected || machine.socket !== run.socket) throw new Error("The owning Herdr runtime is unavailable or its socket changed. Restore it before using lifecycle controls.");
    return PaneList.parse(await h.call("pane.list", {}, { machine: run.machine, timeoutMs: SERVER_TIMEOUT_MS })).panes;
  }
  // Recover the response-to-journal crash window by its unique workspace label.
  private async recover(run: ServerRun) {
    const panes = await this.panes(run);
    if (!run.pane) {
      const workspaces = WorkspaceList.parse(await this.herdr().call("workspace.list", {}, { machine: run.machine, timeoutMs: SERVER_TIMEOUT_MS })).workspaces;
      const ws = workspaces.filter((w) => w.label === `jr-server:${run.nonce}`);
      if (ws.length > 1) throw new Error("Several terminals claim this launch. Resolve the duplicate before starting again.");
      const found = ws[0] && panes.filter((p) => p.workspace_id === ws[0].workspace_id);
      if (found && found.length !== 1) throw new Error("The prepared server workspace changed. Inspect it in Herdr before retrying.");
      if (found?.[0]) {
        const p = found[0]; run.pane = p.pane_id; run.terminal = p.terminal_id; run.workspace = p.workspace_id; this.persist();
      }
    }
    return panes.find((p) => p.pane_id === run.pane && p.terminal_id === run.terminal);
  }
  private async ownsProcess(run: ServerRun) {
    if (!run.pane) return false;
    const receipt = this.receipt(run);
    if (!receipt || receipt.state !== "running") return false;
    const info = ProcessInfo.parse(await this.herdr().call("pane.process_info", { pane_id: run.pane }, { machine: run.machine, timeoutMs: SERVER_TIMEOUT_MS })).process_info;
    if (info.shell_pid !== receipt.pid && !info.foreground_processes.some((p) => p.pid === receipt.pid)) return false;
    // A receipt's PID can be reused. Require the exact launch token in the live argv.
    try {
      const argv = execFileSync("ps", ["-p", String(receipt.pid), "-o", "command="], { encoding: "utf8" });
      return argv.includes(run.nonce) && argv.includes("/servers/runner.mjs");
    } catch { return false; }
  }
  private async terminalEmpty(run: ServerRun) {
    const info = ProcessInfo.parse(await this.herdr().call("pane.process_info", { pane_id: run.pane }, { machine: run.machine, timeoutMs: SERVER_TIMEOUT_MS })).process_info;
    const alive = (pid: number) => {
      try { process.kill(pid, 0); return true; }
      catch (e) { return !(e instanceof Error && "code" in e && e.code === "ESRCH"); }
    };
    return !(info.shell_pid && alive(info.shell_pid)) && !info.foreground_processes.some((p) => alive(p.pid));
  }
  private async viewMember(group: ServerDefinition, member: ServerDefinition["members"][number]): Promise<ServerMemberView> {
    const run = this.journal.runs[runKey(group.id, member.id)] ?? null;
    const base = { ...member, run, pending: Boolean(run && (run.change !== group.change || run.branch !== group.branch || run.url !== group.url || JSON.stringify(run.member) !== JSON.stringify(member))) };
    if (!run || run.phase === "stopped") return { ...base, state: "stopped", reason: run?.error ?? null };
    try {
      if (!await this.recover(run)) return { ...base, state: "failed", reason: "The owned terminal is gone. Start to create a new instance." };
      const receipt = this.receipt(run);
      if (receipt?.state === "exited") return await this.terminalEmpty(run)
        ? { ...base, state: "failed", reason: `Command exited with code ${receipt.exit}. Read the log, then restart.` }
        : { ...base, state: "unknown", reason: "The owned command exited, but another process is using its terminal. Inspect that terminal in Herdr before changing it." };
      if (await this.ownsProcess(run)) {
        const ready = (await Promise.all(run.member.ports.map(listening))).every(Boolean);
        return { ...base, state: ready ? "running" : "starting", reason: ready ? null : "Command is running; waiting for its ports to listen." };
      }
      return { ...base, state: "unknown", reason: run.error ?? "The terminal exists but its server process identity cannot be verified. Inspect its terminal; lifecycle controls will not signal another process." };
    } catch (e) { return { ...base, state: "unknown", reason: message(e) }; }
  }
  async list(purpose?: string): Promise<ServerGroupView[]> {
    if (this.journalError) throw new Error(this.journalError);
    return Promise.all(definitions().filter((g) => !purpose || g.purpose === purpose).map(async (g) => {
      const instances = await Promise.all(g.members.map((m) => this.viewMember(g, m)));
      const state = instances.some((m) => m.state === "unknown") ? "unknown" : instances.some((m) => m.state === "failed") ? "failed" : instances.every((m) => m.state === "running") ? "running" : instances.some((m) => m.state === "starting") ? "starting" : instances.some((m) => m.state === "running") ? "partial" : "stopped";
      return { ...g, instances, state, pending: instances.some((m) => m.pending) };
    }));
  }
  save(raw: unknown, creating: boolean) {
    return this.serial(async () => {
      const g = ServerDefinition.parse(raw), current = definitions().find((x) => x.id === g.id);
      if (creating && current) throw new Error(`Group ${g.id} already exists. Update it or choose a new id.`);
      if (!creating && !current) throw new Error(`Group ${g.id} does not exist.`);
      if (current?.purpose !== undefined && current.purpose !== g.purpose) throw new Error("A group's review/test purpose cannot change. Create a separate group.");
      for (const old of current?.members ?? []) if (!g.members.some((m) => m.id === old.id)) {
        const run = this.journal.runs[runKey(g.id, old.id)];
        if (run && run.phase !== "stopped") throw new Error(`Stop ${old.name} before removing its definition.`);
      }
      const commit = saveDefinition(g);
      this.ctx.bus.change({ entity: "servers" });
      return { group: g, commit };
    });
  }
  private async stopRun(run: ServerRun) {
    if (run.phase === "stopped") return;
    const pane = await this.recover(run);
    if (pane) {
      // Re-read immediately before closing; never close by port or process name.
      const fresh = await this.recover(run);
      if (fresh) {
        if (!await this.ownsProcess(run) && !(this.receipt(run)?.state === "exited" && await this.terminalEmpty(run))) throw new Error("Stop refused: this terminal no longer has a verified owned server. Inspect it in Herdr.");
        await this.herdr().call("pane.close", { pane_id: fresh.pane_id }, { machine: run.machine, timeoutMs: SERVER_TIMEOUT_MS });
      }
    }
    run.phase = "stopped"; this.persist();
  }
  private async startMember(group: ServerDefinition, member: ServerDefinition["members"][number], request?: string) {
    const key = runKey(group.id, member.id), old = this.journal.runs[key];
    if (old && old.phase !== "stopped") {
      const view = await this.viewMember(group, member);
      if (view.state === "running" || view.state === "starting") return;
      await this.stopRun(old);
    }
    if (!fs.existsSync(member.cwd) || !fs.statSync(member.cwd).isDirectory()) throw new Error(`Working directory ${member.cwd} is missing or is not a folder. Update its definition to an existing directory.`);
    for (const port of member.ports) await assertFreePort(port);
    const h = this.herdr(), machine = h.machines().find((m) => m.label === h.defaultMachine());
    if (!machine?.connected || !machine.socket) throw new Error("Local Herdr is not connected. Restore Herdr, then start this group.");
    const run: ServerRun = { nonce: randomUUID(), machine: machine.label, socket: machine.socket, phase: "prepared", pane: null, terminal: null, workspace: null, member, change: group.change, branch: group.branch, url: group.url, request: request ?? null, error: null };
    this.journal.runs[key] = run;
    atomicJson(path.join(this.folder(run), "config.json"), { nonce: run.nonce, command: member.command, cwd: member.cwd });
    this.persist();
    try {
      const result = z.object({ root_pane: Pane }).parse(await h.call("workspace.create", {
        cwd: member.cwd, label: `jr-server:${run.nonce}`, focus: false,
        env: { JOYRIDE_REVIEW_RUN: run.nonce, FM_TASK_ID: "", JOYRIDE_INTERNAL: "", CLAUDECODE: "" },
      }, { machine: run.machine, timeoutMs: SERVER_TIMEOUT_MS }));
      run.pane = result.root_pane.pane_id; run.terminal = result.root_pane.terminal_id; run.workspace = result.root_pane.workspace_id;
      // Journal before sending. A failed/uncertain send is never automatically replayed.
      run.phase = "launched"; this.persist();
      const command = `exec ${quote(process.execPath)} ${quote(path.join(paths.code, "src/modules/servers/runner.mjs"))} ${quote(path.join(this.folder(run), "config.json"))} ${quote(run.nonce)}`;
      await h.call("pane.send_input", { pane_id: run.pane, text: command, keys: ["enter"] }, { machine: run.machine, timeoutMs: SERVER_TIMEOUT_MS });
    } catch (e) { run.error = message(e); this.persist(); throw e; }
  }
  act(id: string, input: ServerAction) {
    return this.serial(async () => {
      const group = this.get(id);
      if (input.purpose !== group.purpose) throw new Error(`This is a ${group.purpose} group. Its lifecycle requires purpose=${group.purpose}.`);
      const signature = JSON.stringify({ id, ...input, request: undefined });
      const previous = input.request ? this.journal.requests[input.request] : undefined;
      if (previous) {
        if (previous.signature !== signature) throw new Error("This request id already belongs to another lifecycle action.");
        if (previous.done) return (await this.list()).find((g) => g.id === id);
      }
      const members = input.member ? group.members.filter((m) => m.id === input.member) : group.members;
      if (!members.length) throw new Error(`Member ${input.member} does not exist in ${id}.`);
      // Refuse uncertain ownership before mutating any member of a group.
      for (const m of members) {
        if (previous?.completed.includes(m.id)) continue;
        const v = await this.viewMember(group, m);
        if (v.state === "unknown") throw new Error(v.reason ?? "Server ownership is unknown.");
      }
      const receipt = previous ?? { signature, completed: [], done: false };
      if (input.request && !previous) { this.journal.requests[input.request] = receipt; this.persist(); }
      for (const member of members) {
        if (receipt.completed.includes(member.id)) continue;
        const run = this.journal.runs[runKey(id, member.id)];
        const alreadyLaunched = input.request && run?.request === input.request && run.phase === "launched";
        if (!alreadyLaunched) {
          const pending = run && (run.change !== group.change || run.branch !== group.branch || run.url !== group.url || JSON.stringify(run.member) !== JSON.stringify(member));
          if (run && (input.action === "stop" || input.action === "restart" || input.action === "update" && pending)) await this.stopRun(run);
          if (input.action !== "stop") await this.startMember(group, member, input.request);
        }
        receipt.completed.push(member.id);
        if (input.request) this.persist();
      }
      if (input.request) { receipt.done = true; this.persist(); }
      return (await this.list()).find((g) => g.id === id);
    });
  }
  async terminal(id: string, member: string) {
    this.get(id);
    const run = this.journal.runs[runKey(id, member)];
    if (!run || !await this.recover(run)) throw new Error("This member has no live terminal. Start it, or read its saved log.");
    return { machine: run.machine, pane: run.pane ?? "" };
  }
  logs(id: string, member: string) {
    this.get(id);
    const run = this.journal.runs[runKey(id, member)];
    if (!run) return { text: "No command has run yet." };
    const file = path.join(this.folder(run), "output.log");
    if (!fs.existsSync(file)) return { text: run.error ?? "The command has not produced a log yet." };
    const fd = fs.openSync(file, "r");
    try { const size = fs.fstatSync(fd).size, buffer = Buffer.alloc(Math.min(size, 65536)); fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length)); return { text: buffer.toString("utf8") }; }
    finally { fs.closeSync(fd); }
  }
}
