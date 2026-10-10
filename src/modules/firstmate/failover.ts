import { randomUUID } from "node:crypto";
import type { Account } from "../../core/accounts.ts";
import type { Config } from "../../shared/schema.ts";
import type { ProviderUsage, UsageSnapshot } from "../../shared/usage.ts";
import type { PrimaryInfo, PrimaryState } from "../../shared/firstmate-primary.ts";
import type { Turn, TranscriptState } from "../sessions/types.ts";
import type { HomeState } from "./state.ts";

export type Primary = PrimaryInfo & { env: Record<string, string> };
export type PrimaryPane = { machine: string; pane_id: string; status: string };
export type Observation = { primary: Primary; pane: PrimaryPane; screen: string; unchangedMs: number; usage: UsageSnapshot };

export function primaries(accounts: Account[], config: Config["firstmate"]["primaries"], defaultHomes: { claude: string; codex: string }): Primary[] {
  const order: NonNullable<Config["firstmate"]["primaries"]> = config ?? accounts.map((a) => ({ account: a.id }));
  return order.flatMap((p) => {
    const a = accounts.find((a) => a.id === p.account);
    if (!a) return [];
    const home = a.home ?? (a.provider === "cursor" ? null : defaultHomes[a.provider]);
    return [{ account: a.id, label: a.label, harness: a.provider, model: p.model ?? (a.provider === "codex" ? "gpt-6.1-sol" : null),
      env: home ? { [a.provider === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"]: home } : {} }];
  });
}

export function usageFor(usage: UsageSnapshot, account: string, time = Date.now()): ProviderUsage | null {
  // A cached or failed read cannot cause a takeover or establish successor capacity.
  if (!usage.fetchedAt || !Number.isFinite(Date.parse(usage.fetchedAt)) || time - Date.parse(usage.fetchedAt) > usage.maxAgeSeconds * 2000) return null;
  if (usage.generatedAt && (!Number.isFinite(Date.parse(usage.generatedAt)) || time - Date.parse(usage.generatedAt) > usage.maxAgeSeconds * 2000)) return null;
  const p = usage.providers.find((p) => p.account === account);
  return p?.state === "live" ? p : null;
}

export function hasCapacity(usage: UsageSnapshot, account: string, time = Date.now()): boolean {
  const p = usageFor(usage, account, time);
  if (!p || p.exhaustedNow || (p.runwaySeconds != null && p.runwaySeconds <= 0)) return false;
  const remaining = [p.effectiveRemaining, ...p.windows.filter((w) => w.reported).map((w) => w.percentRemaining)].filter((n): n is number => n !== null);
  return remaining.length > 0 && remaining.every((n) => n > 0);
}

export function nextPrimary(list: Primary[], account: string, usage: UsageSnapshot, time = Date.now()): Primary | null {
  return list.slice(list.findIndex((p) => p.account === account) + 1).find((p) => hasCapacity(usage, p.account, time)) ?? null;
}

export function exhaustionReason(o: Observation, nearZeroSeconds: number, time = Date.now()): string | null {
  const p = usageFor(o.usage, o.primary.account, time);
  if (p && (p.exhaustedNow || p.effectiveRemaining === 0 || p.windows.some((w) => w.reported && w.percentRemaining === 0)))
    return `${o.primary.label} has exhausted its allowance.`;
  const stalled = o.pane.status === "blocked" || o.pane.status === "idle" || o.unchangedMs >= 30_000;
  if (!stalled) return null;
  // Match provider error banners, not prose mentioning limits in a captain's request.
  const banner = o.screen.split("\n").find((line) => /^[\s│┃]*[●■!⚠⏺×✖\uFE0F]*\s*(?:you(?:'ve| have) (?:hit|reached) (?:your |the )?(?:usage |rate )?limit|usage limit (?:reached|exceeded)|rate limit (?:reached|exceeded)|(?:error[: ]+)?(?:429|too many requests)|you(?:'re| are) out of (?:extra )?usage)/i.test(line));
  if (banner) return `${o.primary.label} cannot continue: ${banner.trim()}`;
  if (p?.runwaySeconds != null && p.runwaySeconds <= nearZeroSeconds)
    return `${o.primary.label} has ${Math.round(p.runwaySeconds)} seconds of runway and its turn is stalled.`;
  return null;
}

export class ExhaustionConfirmation {
  private candidate: { account: string; since: number } | null = null;
  observe(account: string, reason: string | null, time: number, confirmationMs: number): string | null {
    if (!reason) { this.candidate = null; return null; }
    if (this.candidate?.account !== account) this.candidate = { account, since: time };
    return time - this.candidate.since >= confirmationMs ? reason : null;
  }
  reset() { this.candidate = null; }
}

export const HANDOFF_MAX_BYTES = 12 * 1024;
export const MAX_HANDOFF_ATTEMPTS = 3;
const excerpt = (text: string, bytes: number, tail = false): string => {
  const data = Buffer.from(text);
  if (data.length <= bytes) return text;
  const marker = "\n[Excerpt only. Read the saved context for the full text.]\n";
  const size = bytes - Buffer.byteLength(marker);
  const part = tail ? data.subarray(data.length - size) : data.subarray(0, size);
  const decoded = new TextDecoder().decode(part, { stream: true });
  return tail ? marker + decoded.replace(/^\uFFFD+/, "") : decoded + marker;
};

export function composeHandoff(o: { from: PrimaryInfo; to: PrimaryInfo; reason: string; transcript: TranscriptState | null; screen: string; home: HomeState; live: { id: string; task: string | null; status: string; action: string }[]; contextPath?: string; outgoingPath?: string; transcriptPath?: string | null }): string {
  const turns: Turn[] = o.transcript?.turns ?? [];
  const asks = turns.filter((t) => t.role === "user").slice(-8).map((t) => t.text).join("\n\n");
  const promises = turns.filter((t) => t.role === "assistant").slice(-8).map((t) => [t.text, ...t.tools.map((t) => `${t.name}: ${t.summary}`)].join("\n")).join("\n\n");
  const tasks = o.home.tasks.filter((t) => t.section !== "done").map((t) => `${t.id}: ${t.title}\nStatus: ${t.status}. Pane: ${t.pane ?? "none"}. Last update: ${t.last_event}\n${t.decisions.map((d) => JSON.stringify(d)).join("\n")}`);
  return excerpt([
    "Firstmate primary handoff", excerpt(`${o.from.label} (${o.from.harness}) to ${o.to.label} (${o.to.harness}${o.to.model ? `, ${o.to.model}` : ""}).\n${o.reason}`, 512),
    "Continue in this same FM_HOME. Preserve every live worker and all backlog, inbox and wake records. Do not spawn replacements for workers that are still alive.",
    "Full recovery sources. Read these files before continuing; sections below are bounded excerpts.",
    `Saved context: ${o.contextPath ?? "Read the original transcript and FM_HOME state files."}`,
    `Outgoing primary's handoff: ${o.outgoingPath ?? "Not recorded."} (may be absent if the outgoing primary was exhausted).`,
    `Original transcript: ${o.transcriptPath ?? "Unavailable; use the saved transcript context."}`,
    "Run bin/fm-session-start.sh, read this note through bin/fm-inbox.sh, drain bin/fm-wake-drain.sh, reconcile the decisions above, and follow the emitted supervision instructions for your harness. Acknowledge wakes only after handling them.",
    "Captain's recent messages, verbatim excerpts", excerpt(asks || "Transcript unavailable. Read the inbox and the pane tail below before proceeding.", 1500, true),
    "Messages queued or pulled back by the captain, verbatim excerpts", excerpt([...(o.transcript?.queue ?? []), ...(o.transcript?.pulled ?? [])].map((t) => t.text).join("\n\n") || "None recorded.", 1000, true),
    "Outgoing Firstmate's recent statements, promises and next actions", excerpt(promises || "Transcript unavailable; recover from the pane tail and home summary.", 1500, true),
    "Open tasks and decisions", excerpt([tasks.join("\n\n") || "No open tasks in the home projection.", JSON.stringify(o.home.summary_decisions)].join("\n"), 1500),
    "Live workers", excerpt(o.live.map((w) => `${w.id}: task ${w.task ?? "watched"}, ${w.status}, ${w.action}`).join("\n") || "None in the live projection.", 1000),
    "Home summary and pending wakes", excerpt(JSON.stringify({ summary: o.home.summary, wake: o.home.wake, secondmates: o.home.secondmates }), 1000),
    "Outgoing pane tail", excerpt(o.screen, 2000, true),
  ].join("\n\n"), HANDOFF_MAX_BYTES);
}

export function primaryArgs(primary: PrimaryInfo, permissionMode: Config["workers"]["permission_mode"]): string[] {
  const model = primary.model ? ["--model", primary.model] : [];
  if (primary.harness === "claude") return [...model, "--permission-mode", permissionMode];
  if (primary.harness === "cursor") return [...model, "--trust", ...(permissionMode === "bypassPermissions" ? ["--force"] : [])];
  // A primary's lock must die with its pane, rather than a shared app-server
  // that may also serve live crew. Firstmate's pinned hooks are owned by Joyride.
  return ["--no-daemon", ...model, ...(permissionMode === "bypassPermissions"
    ? ["--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust"]
    : ["--sandbox", permissionMode === "plan" ? "read-only" : "workspace-write", "--ask-for-approval", permissionMode === "dontAsk" ? "never" : "on-request"])];
}

export type FailoverIO = {
  state(): PrimaryState;
  save(state: PrimaryState): void;
  observe(): Promise<Observation | null>;
  choices(): Primary[];
  handoff(o: Observation, to: Primary, id: string, reason: string): Promise<string>;
  note(id: string, body: string): Promise<string>;
  stop(pane: PrimaryPane): Promise<void>;
  validate?(to: Primary): Promise<void>;
  launch(to: Primary, note: string): Promise<void>;
  /** Validate current source capacity before restoring it; captured readings can expire during startup. */
  recover?(source: Observation, note: string): Promise<void>;
};

/** One transition at a time, also shared with manual requests and daemon-start recovery. */
export class PrimaryFailover {
  private job: Promise<void> | null = null;
  private checking = false;
  readonly confirmation = new ExhaustionConfirmation();
  constructor(private io: FailoverIO, private settings: { confirmationMs: number; nearZeroSeconds: number }) {}
  busy() { return this.job !== null; }
  async check(time = Date.now()): Promise<void> {
    const state = this.io.state();
    if (this.job || this.checking || (state.phase !== "ready" && ((state.lastSwitch?.attempts ?? 0) >= MAX_HANDOFF_ATTEMPTS || time < (state.lastSwitch?.retryAt ?? 0)))) return;
    this.checking = true;
    try {
      const o = await this.io.observe();
      if (!o) { this.confirmation.reset(); return; }
      const signal = exhaustionReason(o, this.settings.nearZeroSeconds, time);
      const reason = this.confirmation.observe(o.primary.account, signal, time, this.settings.confirmationMs);
      if (!signal && this.io.state().phase === "ready" && this.io.state().error) this.io.save({ ...this.io.state(), error: null });
      if (!reason) return;
      const pending = this.io.state();
      const to = pending.phase !== "ready" && pending.lastSwitch?.from === o.primary.account
        ? this.io.choices().find((p) => p.account === pending.lastSwitch?.to) ?? null
        : nextPrimary(this.io.choices(), o.primary.account, o.usage, time);
      if (!to) {
        this.io.save({ ...this.io.state(), error: "Firstmate is out of capacity. No later account has a fresh reading with capacity. Refresh usage limits or sign in to another account." });
        return;
      }
      await this.switch(to.account, reason, true);
    } finally { this.checking = false; }
  }
  switch(account: string, reason = "Switched manually.", automatic = false): Promise<void> {
    if (this.job) return Promise.reject(new Error("Firstmate is already switching. Wait for this handoff to finish."));
    this.job = this.transition(account, reason, automatic).finally(() => { this.job = null; this.confirmation.reset(); });
    return this.job;
  }
  private async transition(account: string, reason: string, automatic: boolean): Promise<void> {
    const o = await this.io.observe();
    const to = this.io.choices().find((p) => p.account === account);
    if (!o) throw new Error("Firstmate is not running. Start Firstmate before switching accounts.");
    if (!to) throw new Error(`No Firstmate primary is configured for ${account}. Check firstmate.primaries.`);
    if (to.account === o.primary.account) return;
    const previous = this.io.state();
    const pending = previous.phase !== "ready" && previous.lastSwitch?.from === o.primary.account && previous.lastSwitch.to === to.account ? previous.lastSwitch : null;
    if (!pending && !hasCapacity(o.usage, to.account)) throw new Error(`${to.label} has no fresh usage reading with capacity. Refresh usage limits, then retry.`);
    const attempts = pending?.attempts ?? 0;
    const lastSwitch = { ...(pending ?? { id: randomUUID(), from: o.primary.account, to: to.account, reason, at: new Date().toISOString(), note: null }),
      attempts: (!automatic && attempts >= MAX_HANDOFF_ATTEMPTS ? 0 : attempts) + 1, retryAt: null };
    let state: PrimaryState = { current: o.primary, phase: "handoff", lastSwitch, error: null };
    const save = (phase: PrimaryState["phase"]) => { state = { ...state, phase }; this.io.save(state); };
    this.io.save(state);
    try {
      if (!hasCapacity(o.usage, to.account)) throw new Error(`${to.label} has no fresh usage reading with capacity. Refresh usage limits, then retry.`);
      const note = lastSwitch.note ?? await this.io.note(lastSwitch.id, await this.io.handoff(o, to, lastSwitch.id, lastSwitch.reason));
      state = { ...state, lastSwitch: { ...lastSwitch, note } };
      save("handoff");
      await this.io.validate?.(to);
      // Filing can take minutes. Recheck both identities and capacity before closing anything.
      const latest = await this.io.observe();
      if (!latest || latest.primary.account !== o.primary.account || latest.pane.machine !== o.pane.machine || latest.pane.pane_id !== o.pane.pane_id)
        throw new Error("The Firstmate primary changed while saving its handoff. The current primary was preserved. Refresh Firstmate before retrying.");
      if (!hasCapacity(latest.usage, to.account)) throw new Error(`${to.label} no longer has a fresh usage reading with capacity. The source was preserved. Refresh usage limits, then retry.`);
      save("stopping");
      await this.io.stop(o.pane);
      state = { ...state, current: to };
      save("starting");
      await this.io.launch(to, note);
      save("ready");
    } catch (e) {
      let recovery = "";
      if (state.phase === "starting" && state.lastSwitch?.note && this.io.recover) {
        try {
          await this.io.recover(o, state.lastSwitch.note);
          state = { ...state, current: o.primary };
          recovery = " The source was restored and can continue from the saved handoff.";
        } catch (restoreError) {
          recovery = ` Source recovery also failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}. Open Firstmate and retry startup.`;
        }
      }
      const exhausted = lastSwitch.attempts >= MAX_HANDOFF_ATTEMPTS;
      this.io.save({ ...state, lastSwitch: { ...lastSwitch, note: state.lastSwitch?.note ?? null, retryAt: Date.now() + 60_000 * lastSwitch.attempts }, phase: "failed",
        error: `Firstmate handoff failed: ${String(e instanceof Error ? e.message : e)}. Its home and handoff context are preserved.${recovery} ${exhausted ? `Automatic handoff paused after ${MAX_HANDOFF_ATTEMPTS} attempts. Fix inbox filing or startup, then retry from the Firstmate controls.` : "Joyride will retry this same handoff after backing off. Retry from the Firstmate controls to try now."}` });
      throw e;
    }
  }
}
