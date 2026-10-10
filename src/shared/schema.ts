// Canonical world-model schemas shared by daemon, hooks, MCP server and UI.
// Authored entities (missions, lenses, notes, artifacts, workspace spec) are
// stored as files; projected entities (sessions, workers, tasks) are derived.
import { z } from "zod";

// ---------- primitives ----------
export const AgentKind = z.enum(["claude", "codex", "pi", "opencode", "other"]);
export type AgentKind = z.infer<typeof AgentKind>;

export const Level = z.enum(["L0", "L1", "L2", "L3", "L4"]);
export type Level = z.infer<typeof Level>;
export const LEVEL_RANK: Record<Level, number> = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };

export const WorkerStatus = z.enum(["idle", "working", "blocked", "done", "unknown", "exited"]);
export type WorkerStatus = z.infer<typeof WorkerStatus>;
export const WorkerPermissionMode = z.enum(["auto", "acceptEdits", "bypassPermissions", "manual", "dontAsk", "plan"]);

// ---------- events ----------
export const EventRecord = z.object({
  ts: z.string(), // ISO
  id: z.string(),
  source: z.string(), // hook.claude | hook.codex | herdr | guard | attention | intent | evidence | evolution | ui | daemon
  type: z.string(),
  session: z.string().optional(),
  agent: AgentKind.optional(),
  cwd: z.string().optional(),
  pane: z.string().optional(),
  data: z.record(z.string(), z.any()).default({}),
});
export type EventRecord = z.infer<typeof EventRecord>;

// ---------- missions ----------
export const MissionState = z.enum(["open", "paused", "done", "dropped"]);
export const MissionHealth = z.enum(["active", "blocked", "needs-review", "idle"]);
export const SessionRef = z.object({ source: z.enum(["claude", "codex"]), id: z.string() });
export type SessionRef = z.infer<typeof SessionRef>;

export const DoneCriterion = z.object({
  id: z.string(),
  text: z.string(),
  kind: z.enum(["test", "e2e", "screenshot", "review", "other"]).default("other"),
});

export const Mission = z.object({
  private: z.boolean().optional(),
  id: z.string(), // slug
  title: z.string(),
  state: MissionState.default("open"),
  archive: z.boolean().default(false),
  goal: z.string().default(""), // markdown body
  done_when: z.array(DoneCriterion).default([]),
  repos: z.array(z.string()).default([]), // absolute repo roots
  branches: z.array(z.string()).default([]),
  sessions: z.array(SessionRef).default([]),
  crews: z.array(z.string()).default([]), // firstmate task ids
  lenses: z.array(z.string()).default([]),
  blocks: z.array(z.string()).default([]), // mission ids this mission blocks
  override: z.object({ reason: z.string(), at: z.string() }).nullable().default(null),
  created: z.string(),
  updated: z.string(),
});
export type Mission = z.infer<typeof Mission>;

export const MissionProposal = z.object({
  id: z.string(),
  title: z.string(),
  goal: z.string(),
  repos: z.array(z.string()),
  branches: z.array(z.string()),
  sessions: z.array(SessionRef),
  first_ts: z.string(),
  last_ts: z.string(),
  status: z.enum(["pending", "accepted", "rejected", "expired"]).default("pending"),
  reason: z.string().default(""),
  merge_into: z.string().nullable().default(null), // existing mission id suggested by Jev
});
export type MissionProposal = z.infer<typeof MissionProposal>;

// ---------- lenses ----------
export const Lens = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().default(""),
  missions: z.array(z.string()).default([]),
  rule: z.object({ repo: z.string().optional(), text: z.string().optional() }).partial().default({}),
  color: z.string().optional(),
  /** Sessions the group holds directly, outside any idea (keys like claude:<id>), dropped on it from the map. */
  sessions: z.array(z.string()).default([]),
  /** Projects (keys from the map's Unfiled groups: the repo name, lower case) whose unfiled work the group holds. */
  projects: z.array(z.string()).default([]),
});
export type Lens = z.infer<typeof Lens>;

// ---------- sessions & workers (projected) ----------
export const SessionView = z.object({
  key: z.string(), // `${source}:${id}`
  source: z.enum(["claude", "codex"]),
  id: z.string(),
  title: z.string(),
  cwd: z.string(),
  repo: z.string().nullable(), // git toplevel
  branch: z.string().nullable(),
  first_prompt: z.string().default(""),
  started: z.string(),
  updated: z.string(),
  turns: z.number().default(0),
  tokens: z.number().default(0),
  model: z.string().nullable().default(null),
  transcript: z.string(), // path
  mission: z.string().nullable().default(null),
  archived: z.boolean().default(false),
});
export type SessionView = z.infer<typeof SessionView>;

/**
 * Who owns a live worker: `crew` (Firstmate launched it for a task and holds its lifecycle), `control`
 * (Firstmate's own pane), `watched` (the captain started it; Firstmate supervises it) or `excluded`
 * (the captain started it and keeps it to themself: fleet.yaml lists it). Crew identity comes from the
 * task's recorded Herdr pane (`via: pane`) or the FM_TASK_ID its hooks report (`via: env`), never from the cwd.
 */
export const OwnerTier = z.enum(["crew", "watched", "control", "excluded"]);
export type OwnerTier = z.infer<typeof OwnerTier>;
export const WorkerOwner = z.object({
  tier: OwnerTier,
  task: z.string().nullable().default(null), // Firstmate task id, for crew
  via: z.enum(["pane", "pid", "env", "control"]).nullable().default(null),
});
export type WorkerOwner = z.infer<typeof WorkerOwner>;

/**
 * Who is steering a live worker right now: `firstmate` (the default) or `captain`, from the captain's
 * last steer until that turn ends plus 15 quiet minutes (`until`; null while the turn runs), or until
 * the captain hands it back. Null for Firstmate's own pane and for sessions the captain keeps to themself.
 */
export const WorkerHelm = z.object({
  by: z.enum(["captain", "firstmate"]),
  since: z.string().nullable().default(null), // the captain's steer that took the helm
  until: z.string().nullable().default(null),
  via: z.string().nullable().default(null), // how the captain steered: direct, joyride-reply, joyride-terminal
});
export type WorkerHelm = z.infer<typeof WorkerHelm>;

export const WorkerView = z.object({
  id: z.string(), // machine:pane or machine:pid
  machine: z.string().default("local"),
  agent: AgentKind,
  status: WorkerStatus,
  pane: z.string().nullable(),
  terminal_id: z.string().optional(),
  pid: z.number().nullable(),
  cwd: z.string(),
  repo: z.string().nullable(),
  session: z.string().nullable(), // session key
  title: z.string().default(""),
  current_action: z.string().default(""),
  last_message: z.string().default(""),
  controllable: z.boolean(), // can receive replies (herdr-managed)
  updated: z.string(),
  mission: z.string().nullable().default(null), // the session's mission, else its crew task's mission
  crew: z.string().nullable().default(null), // Firstmate task id when owner.tier is crew
  owner: WorkerOwner.default({ tier: "watched", task: null, via: null }),
  helm: WorkerHelm.nullable().default(null),
});
export type WorkerView = z.infer<typeof WorkerView>;

/** A chat reply stays addressed to the connection that displayed its conversation. */
export const ReplyBinding = z.object({
  session: z.string().nullable(),
  terminal_id: z.string().optional(),
  control: z.boolean(),
});
export type ReplyBinding = z.infer<typeof ReplyBinding>;

// ---------- attention ----------
export const AttentionItem = z.object({
  id: z.string(),
  level: Level,
  floor: Level,
  kind: z.enum(["question", "decision", "approval", "review", "error", "progress", "idle", "guard", "nudge", "overlap", "proposal"]),
  title: z.string(),
  why: z.string(),
  session: z.string().nullable(),
  worker: z.string().nullable(),
  mission: z.string().nullable(),
  opened: z.string(),
  resolved: z.string().nullable(),
  resolution: z.string().nullable(),
  snoozed_until: z.string().nullable().default(null),
  jev: z.object({ level: Level.optional(), p_needs_human: z.number().optional(), probabilities: z.record(z.string(), z.number()).optional() }).nullable().default(null),
  ref: z.record(z.string(), z.any()).default({}),
});
export type AttentionItem = z.infer<typeof AttentionItem>;

// ---------- intents ----------
export const IntentKind = z.enum([
  "reply", "approve", "deny", "steer_task", "create_task", "launch_session",
  "reverify", "answer_prompt", "focus", "move_to_herdr",
  "start_firstmate", "switch_firstmate", "hand_back", "exclude_session", "include_session", "answer_ask", "retire_worker",
  "tell_note", "recheck_ask", "tell_firstmate",
]);
/** Who asked for an intent: the captain (Joyride's page, CLI or API), Firstmate, or the evolution mission. */
export const IntentOrigin = z.enum(["captain", "firstmate", "evolution"]);
export type IntentOrigin = z.infer<typeof IntentOrigin>;
export const Intent = z.object({
  id: z.string(),
  kind: IntentKind,
  target: z.string(), // worker id / session key / mission id / guard request id
  payload: z.record(z.string(), z.any()).default({}),
  origin: IntentOrigin.default("captain"),
  status: z.enum(["pending", "sent", "acked", "failed"]).default("pending"),
  error: z.string().nullable().default(null),
  created: z.string(),
  updated: z.string(),
});
export type Intent = z.infer<typeof Intent>;

// ---------- guard ----------
export const GuardRule = z.object({
  id: z.string(),
  title: z.string(),
  tools: z.array(z.string()).default(["Bash"]), // tool names; "mcp__*" globs allowed
  match: z.array(z.string()).default([]), // regexes against command / serialized input
  unless: z.array(z.string()).default([]),
  level: z.enum(["gate", "ambiguous"]).default("gate"),
});
export const GuardPolicy = z.object({
  timeout_seconds: z.number().default(300),
  rules: z.array(GuardRule),
  auto_approve: z.array(z.object({ id: z.string(), title: z.string(), jev_question: z.string(), threshold: z.number() })).default([]),
});
export type GuardPolicy = z.infer<typeof GuardPolicy>;

export const GuardRequest = z.object({
  id: z.string(),
  rule: z.string(),
  title: z.string(),
  tool: z.string(),
  summary: z.string(),
  input: z.any(),
  session: z.string().nullable(),
  agent: AgentKind,
  cwd: z.string(),
  created: z.string(),
  deadline: z.string(),
  decision: z.enum(["pending", "allow", "deny", "timeout"]).default("pending"),
  decided_at: z.string().nullable().default(null),
  reason: z.string().default(""),
});
export type GuardRequest = z.infer<typeof GuardRequest>;

// ---------- evidence ----------
export const EvidenceItem = z.object({
  id: z.string(),
  mode: z.enum(["attested", "inferred"]),
  name: z.string(),
  command: z.string().default(""),
  exit_code: z.number().nullable(),
  log_tail: z.string().default(""),
  log_blob: z.string().nullable().default(null),
  screenshots: z.array(z.object({ blob: z.string(), name: z.string(), caption: z.string().nullable().default(null) })).default([]),
  assertions: z.object({ passed: z.number(), failed: z.number(), skipped: z.number() }).nullable().default(null),
  claim: z.string().default(""),
  session: z.string().nullable(),
  mission: z.string().nullable(),
  cwd: z.string(),
  branch: z.string().nullable(),
  sha: z.string().nullable(),
  created: z.string(),
});
export type EvidenceItem = z.infer<typeof EvidenceItem>;

export const Verdict = z.object({
  id: z.string(),
  mission: z.string(),
  verdict: z.enum(["pass", "fail", "insufficient"]),
  probabilities: z.record(z.string(), z.number()).default({}),
  confidence: z.number().nullable().default(null),
  per_criterion: z.array(z.object({ criterion: z.string(), verdict: z.enum(["pass", "fail", "insufficient"]), p: z.number().optional() })).default([]),
  downgraded_by_caption: z.boolean().default(false),
  evidence: z.array(z.string()),
  created: z.string(),
});
export type Verdict = z.infer<typeof Verdict>;

// ---------- artifacts ----------
export const Artifact = z.object({
  private: z.boolean().optional(),
  id: z.string(),
  title: z.string(),
  url: z.string().nullable(),
  kind: z.enum(["claude-artifact", "chatgpt", "pr", "report", "file", "other", "session"]),
  source: z.string().default(""), // creator (claude, codex, human)
  session: z.string().nullable().default(null),
  mission: z.string().nullable().default(null),
  local_source: z.string().nullable().default(null),
  snapshot_blob: z.string().nullable().default(null),
  created: z.string(),
  summary: z.string().default(""),
  embeddable: z.boolean().default(false),
});
export type Artifact = z.infer<typeof Artifact>;

// ---------- workspace spec ----------
export const WorkspaceSpec = z.object({
  title: z.string().default("Joyride"),
  home: z.object({
    group_by: z.enum(["lens", "repo", "health", "none"]).default("lens"),
    show_archive: z.boolean().default(false),
    regions: z.array(z.object({ id: z.string(), title: z.string(), lens: z.string().optional(), repo: z.string().optional() })).default([]),
    rail: z.array(z.enum(["attention", "approvals", "review", "digest", "proposals", "usage", "nudges"])).default(["approvals", "usage", "attention", "nudges", "review", "digest"]),
  }).default({ group_by: "lens", show_archive: false, regions: [], rail: ["approvals", "usage", "attention", "nudges", "review", "digest"] }),
  theme: z.record(z.string(), z.string()).default({}),
});
export type WorkspaceSpec = z.infer<typeof WorkspaceSpec>;

// ---------- firstmate (projected) ----------
export const TaskView = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  kind: z.string().default(""), // ship | scout | ...
  harness: z.string().nullable().default(null),
  worktree: z.string().nullable().default(null),
  branch: z.string().nullable().default(null),
  last_event: z.string().default(""),
  updated: z.string().nullable().default(null),
  report: z.string().nullable().default(null),
  depends_on: z.array(z.string()).default([]),
  mission: z.string().nullable().default(null),
});
export type TaskView = z.infer<typeof TaskView>;

// ---------- config ----------
export const LlmEffort = z.enum(["low", "medium", "high", "xhigh", "max"]);
export const LlmBackend = z.object({
  backend: z.enum(["claude", "codex"]).default("codex"),
  model: z.string().default("gpt-6-luna"),
  /** Reasoning effort: codex `-c model_reasoning_effort=…`, claude `--effort …`. Unset inherits the CLI's own default. */
  effort: LlmEffort.optional(),
  /** A `usage.accounts` id whose login this task runs on (CODEX_HOME or CLAUDE_CONFIG_DIR). Unset inherits the daemon's environment. */
  account: z.string().optional(),
});
export type LlmBackend = z.infer<typeof LlmBackend>;
export const NewRouting = z.union([z.object({ backend: z.literal("jev"), model: z.string().trim().min(1).optional() }), LlmBackend]);
export const NewModels = z.object({
  routing: NewRouting.default({ backend: "jev" }),
  small_job: LlmBackend.default({ backend: "codex", model: "gpt-6-luna" }),
  standalone: LlmBackend.default({ backend: "codex", model: "gpt-6-luna" }),
}).prefault({});
/** One subscription account: a usage card, and a login Joyride can launch Claude and Codex sessions on. */
export const UsageAccount = z.object({
  /** Stable id for launches (`launch_session` payload `account`); defaults to the label as a slug. */
  id: z.string().optional(),
  provider: z.enum(["claude", "codex", "cursor"]),
  label: z.string().optional(),
  /** Credential folder: CODEX_HOME for Codex, CLAUDE_CONFIG_DIR for Claude. Unset means the default login. Cursor has none. */
  home: z.string().optional(),
});
export type UsageAccount = z.infer<typeof UsageAccount>;
export const SleepPreventionState = z.discriminatedUnion("state", [
  z.object({ state: z.literal("off") }),
  z.object({ state: z.literal("unsupported") }),
  z.object({ state: z.literal("active"), pid: z.number() }),
  z.object({ state: z.literal("error"), error: z.string() }),
]);
export type SleepPreventionState = z.infer<typeof SleepPreventionState>;

export const Config = z.object({
  daemon: z.object({ prevent_sleep: z.boolean().default(false) }).prefault({}),
  knowledge: z.object({
    pipeline: z.enum(["on", "off"]).default("on"),
    owned_repos: z.array(z.string()).default([]),
    owned_orgs: z.array(z.string()).default([]),
    private_paths: z.array(z.string()).default([]),
    private_sessions: z.array(z.string()).default([]),
    tombstones: z.array(z.object({ source: z.string(), reason: z.string() })).default([]),
  }).prefault({}),
  port: z.number().default(4317),
  backfill_days: z.number().default(30),
  llm: z.object({
    default: LlmBackend.default({ backend: "codex", model: "gpt-6-luna" }),
    tasks: z.record(z.string(), LlmBackend).default({}), // per task-type override, keyed by the task names in src/shared/llm-tasks.ts
  }).default({ default: { backend: "codex", model: "gpt-6-luna" }, tasks: {} }),
  jev: z.object({ model: z.string().default("jev-latest"), base_url: z.string().default("https://api.typesafe.ai") }).default({ model: "jev-latest", base_url: "https://api.typesafe.ai" }),
  notifications: z.object({ macos: z.boolean().default(true), min_level: Level.default("L3") }).default({ macos: true, min_level: "L3" }),
  machines: z.array(z.object({ label: z.string(), herdr_session: z.string().optional(), herdr_machine: z.string().optional() })).default([]),
  firstmate: z.object({
    enabled: z.boolean().default(true), pane_label: z.string().default("firstmate"),
    /** Account ids from usage.accounts, in failover order. Unset follows the usage screen. */
    primaries: z.array(z.object({ account: z.string().trim().min(1), model: z.string().trim().min(1).optional() })).min(1)
      .refine((list) => new Set(list.map((p) => p.account)).size === list.length, "Firstmate primary accounts must be unique.").optional(),
    confirmation_seconds: z.number().min(5).max(120).default(15),
    near_zero_runway_seconds: z.number().min(0).max(600).default(60),
  }).default({ enabled: true, pane_label: "firstmate", confirmation_seconds: 15, near_zero_runway_seconds: 60 }),
  /** Permission mode for agents Joyride launches. The guard still applies. */
  workers: z.object({ permission_mode: WorkerPermissionMode.default("auto") }).default({ permission_mode: "auto" }),
  new_models: NewModels,
  /** manage: the daemon starts `herdr server` itself when the default machine's socket is down. */
  herdr: z.object({ manage: z.boolean().default(true) }).default({ manage: true }),
  /** accounts: unset means one Claude, one Codex and Cursor, each on its default login. */
  usage: z.object({ accounts: z.array(UsageAccount).optional() }).default({}),
  /** Idea housekeeping (src/modules/ideas): auto-filing Firstmate tasks into ideas. JOYRIDE_HOUSEKEEPING=0|1 overrides `auto`. */
  housekeeping: z.object({ auto: z.boolean().default(true) }).default({ auto: true }),
});
export type Config = z.infer<typeof Config>;
