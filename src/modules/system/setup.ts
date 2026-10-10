// The setup checklist (GET /api/system/setup): every piece Joyride and Firstmate need on this
// Mac, each with a plain-language status and the one fix for it. computeSetup() takes all of
// its probes as dependencies, so unit tests stub commands, tools and Herdr.
import { FM_TOOL_SPECS, installCommand, type Found, type ToolSpec } from "./tools.ts";

export type SetupStatus = "ok" | "missing" | "warn" | "unknown";
export type SetupFix = {
  kind: "button" | "command" | "link";
  label: string;
  /** button: what the page does (install:<component>, herdr-start, firstmate-start, gh-login, notify-test). */
  action?: string;
  /** command: what to run; button: the command it runs, shown under the button. */
  command?: string;
  /** link: where it goes (#/worker/<id> or https://…). */
  href?: string;
  /** Why the fix can't run yet. */
  disabled?: string;
  /** For checks Joyride can't see: the person can mark the item done. */
  ack?: boolean;
};
export type SetupItem = { id: string; title: string; group: "required" | "optional"; status: SetupStatus; detail: string; fix: SetupFix | null; needs_you?: boolean };
export type SetupReport = {
  items: SetupItem[];
  summary: { required: { done: number; total: number }; optional: { done: number; total: number }; done: number; total: number; blocking: number };
  /** Send a new user here first: something required is missing and they have not opened the page yet. */
  land: boolean;
  at: string;
};

export type RunResult = { code: number; out: string };
export type WorkerLite = { id: string; status: string; last_message?: string | null; title?: string | null };
export type FirstmateLite = { running: boolean; pane: { worker: string; status: string } | null; herdr_connected: boolean; vendor: { present: boolean } };
export type SetupDeps = {
  daemon: { pid: number; port: number };
  /** Installer component status strings (hooks, skills, pstack, evals). */
  componentStatus(name: string): string | null;
  findTool(name: string): Found | null;
  run(cmd: string, args: string[]): Promise<RunResult>;
  herdr(): { connected: boolean; version?: string | null; error?: string | null; panes?: number } | null;
  /** POST /api/herdr/start is registered (another module adds it). */
  herdrStartRoute: boolean;
  firstmate(): FirstmateLite | null;
  worker(id: string): WorkerLite | null;
  /** Visible screens of Claude Code panes, to spot "Your login expires in 1 day". */
  claudeScreens(): Promise<string[]>;
  jev: { available: boolean; key: boolean; fake: boolean };
  notifications: { enabled: boolean; lastTest: { sent: boolean; reason?: string; at: string } | null };
  acks: Record<string, string>;
  seen: boolean;
  test: boolean;
};

const ok = (s: SetupStatus) => s === "ok";
const fmtDate = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { month: "short", day: "numeric" }); };
const installFix = (component: string, label: string, command = `./bin/joyride install ${component}`): SetupFix => ({ kind: "button", label, action: `install:${component}`, command });

/** Firstmate's last message reads as a question or a request for the captain. */
export function isWaiting(w: WorkerLite | null): boolean {
  if (!w) return false;
  if (w.status === "blocked") return true;
  if (w.status === "working") return false;
  const msg = String(w.last_message ?? "").trim();
  if (!msg) return false;
  const tail = lastParagraph(msg);
  return /\?\s*$/.test(tail) || /\b(reply|let me know|approve|your call|need(s)? (you|from you|your)|waiting (on|for) you|should i|do you want|which (one|option)|tell me)\b/i.test(tail);
}
export function lastParagraph(msg: string): string {
  const parts = msg.trim().split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return (parts[parts.length - 1] ?? "").replace(/`/g, "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
}

/** Claude Code prints "⚠ Your login expires in 1 day · run /login to renew" when the login is close to expiring. */
export function claudeLoginNotice(screens: string[]): { level: "warn" | "missing"; text: string } | null {
  let warn: string | null = null;
  for (const s of screens) {
    if (/OAuth token (has )?expired|Please run \/login|Invalid API key/i.test(s)) return { level: "missing", text: "A Claude Code session says its login has expired." };
    const m = s.match(/login expires in ([^·\n.]+)/i);
    if (m && !warn) warn = m[1].trim();
  }
  return warn ? { level: "warn", text: `Claude Code says your login expires in ${warn}.` } : null;
}

function hooksItem(d: SetupDeps): SetupItem {
  const st = d.componentStatus("hooks") ?? "";
  const m = st.match(/claude hooks: (\d+)\/(\d+), codex hooks: (\d+)\/(\d+)/);
  const full = m && m[1] === m[2] && m[3] === m[4] && m[2] !== "0";
  return {
    id: "hooks", title: "Hooks in Claude Code and Codex", group: "required",
    status: full ? "ok" : "missing",
    detail: full ? "Every Claude Code and Codex session reports to Joyride, and the guard holds risky actions until you allow them."
      : `Without the hooks Joyride can't see new sessions or hold risky actions${m ? ` (Claude ${m[1]} of ${m[2]}, Codex ${m[3]} of ${m[4]} installed)` : ""}.`,
    fix: full ? null : installFix("hooks", "Install hooks"),
  };
}

function componentItem(d: SetupDeps, o: { id: string; component: string; title: string; group: "required" | "optional"; okWhen: (s: string) => boolean; okText: string; missingText: string }): SetupItem {
  const st = d.componentStatus(o.component);
  const good = st != null && o.okWhen(st);
  return { id: o.id, title: o.title, group: o.group, status: st == null ? "unknown" : good ? "ok" : "missing", detail: good ? o.okText : o.missingText, fix: good ? null : installFix(o.component, "Install") };
}

function toolItem(d: SetupDeps, t: ToolSpec, title = `${t.title} (${t.name})`): SetupItem {
  const f = d.findTool(t.name);
  const base = { id: `tool:${t.name}`, title, group: t.tier, fix: null as SetupFix | null };
  if (f?.on_path) return { ...base, status: "ok", detail: `${t.does} Installed at ${f.path}.` };
  if (f) return { ...base, status: "warn", detail: `${t.does} It is installed at ${f.path}, but that folder is not on your PATH, so Firstmate can't find it. Add the folder to PATH in ~/.zshrc and open a new terminal.`, fix: { kind: "command", label: "Add to PATH", command: `echo 'export PATH="${f.path.replace(/\/[^/]+$/, "")}:$PATH"' >> ~/.zshrc` } };
  return { ...base, status: "missing", detail: t.does, fix: installFix(t.name, `Install ${t.name}`, installCommand(t)) };
}

export async function computeSetup(d: SetupDeps): Promise<SetupReport> {
  const items: SetupItem[] = [];
  const add = (i: SetupItem) => { if (d.acks[i.id] && i.status === "unknown") items.push({ ...i, status: "ok", detail: `You marked this done on ${fmtDate(d.acks[i.id])}. ${i.detail}`, fix: null }); else items.push(i); };

  // ---------- required ----------
  add({ id: "daemon", title: "Joyride is running", group: "required", status: "ok", detail: `The daemon answers on 127.0.0.1:${d.daemon.port} (process ${d.daemon.pid}). If it ever stops, the next Claude Code or Codex session starts it again.`, fix: null });
  add(hooksItem(d));
  add({
    id: "codex-hooks-trust", title: "Trust Joyride's hooks in Codex", group: "required", status: "unknown",
    detail: "Codex runs new hooks only after you trust them once. Joyride can't see whether you have. Until then Codex sessions show up here but are not guarded.",
    fix: { kind: "command", label: "Run inside Codex", command: "/hooks", ack: true },
  });

  const h = d.herdr();
  if (!h) add({ id: "herdr", title: "Herdr is running", group: "required", status: "unknown", detail: "The live module is not loaded, so Joyride can't reach Herdr.", fix: null });
  else if (h.connected) add({ id: "herdr", title: "Herdr is running", group: "required", status: "ok", detail: `Connected${h.version ? ` to Herdr ${h.version}` : ""}${h.panes != null ? `, ${h.panes} pane${h.panes === 1 ? "" : "s"} open` : ""}. Agents in Herdr panes can get replies and prompt answers from Joyride.`, fix: null });
  else add({
    id: "herdr", title: "Herdr is running", group: "required", status: "missing",
    detail: `Herdr holds the terminal panes your agents run in. Joyride can't reach it${h.error ? ` (${h.error})` : ""}.`,
    fix: d.herdrStartRoute ? { kind: "button", label: "Start Herdr", action: "herdr-start" } : { kind: "command", label: "Run in a terminal", command: "herdr" },
  });

  add(componentItem(d, { id: "evidence-skills", component: "skills", title: "Evidence skills", group: "required", okWhen: (s) => s === "installed", okText: "Agents record tests and screenshots with joyride-evidence, so missions can close on proof.", missingText: "Agents don't have the joyride-evidence and joyride-verify skills yet, so their proof won't reach the evidence panel." }));

  const basics = FM_TOOL_SPECS.filter((t) => t.basic);
  const missingBasics = basics.filter((t) => !d.findTool(t.name)?.on_path);
  const brewable = missingBasics.filter((t) => t.method === "brew").map((t) => t.name);
  add({
    id: "fm-basics", title: "Basic tools for Firstmate", group: "required",
    status: missingBasics.length ? "missing" : "ok",
    detail: missingBasics.length ? `Missing: ${missingBasics.map((t) => `${t.name} (${t.does})`).join(", ")}.` : "git, node, jq and herdr are installed.",
    fix: !missingBasics.length ? null : brewable.length ? { kind: "command", label: "Run in a terminal", command: `brew install ${brewable.join(" ")}` } : { kind: "link", label: "Install Herdr", href: "https://herdr.dev" },
  });
  for (const t of FM_TOOL_SPECS.filter((x) => x.tier === "required" && !x.basic)) add(toolItem(d, t));

  const fm = d.firstmate();
  if (!fm) add({ id: "firstmate", title: "Firstmate is running", group: "required", status: "unknown", detail: "The Firstmate module is not loaded.", fix: null });
  else if (fm.running && fm.pane) {
    const w = d.worker(fm.pane.worker);
    if (isWaiting(w)) {
      const q = lastParagraph(String(w?.last_message ?? ""));
      add({ id: "firstmate", title: "Firstmate is waiting for you", group: "required", status: "warn", needs_you: true, detail: q ? `It asked: ${q.length > 260 ? q.slice(0, 257) + "…" : q}` : "It is waiting on an answer in its pane.", fix: { kind: "link", label: "Answer Firstmate", href: `#/worker/${fm.pane.worker}` } });
    } else add({ id: "firstmate", title: "Firstmate is running", group: "required", status: "ok", detail: `It runs in Herdr pane ${fm.pane.worker}${w?.status ? ` and is ${w.status}` : ""}. Hand it bigger jobs from a mission's Crew panel.`, fix: { kind: "link", label: "Open Firstmate", href: `#/worker/${fm.pane.worker}` } });
  } else add({
    id: "firstmate", title: "Firstmate is running", group: "required", status: "missing",
    detail: "Firstmate plans bigger jobs and runs crews of agents for them. It starts in its own Herdr pane; the first start runs its own setup and asks you a few questions there.",
    fix: { kind: "button", label: "Start Firstmate", action: "firstmate-start", ...(!fm.herdr_connected ? { disabled: "Start Herdr first." } : !fm.vendor.present ? { disabled: "Firstmate is not vendored. Run ./bin/joyride vendor firstmate." } : {}) },
  });

  const notice = claudeLoginNotice(await d.claudeScreens().catch(() => []));
  add({
    id: "claude-login", title: "Claude Code login", group: "required",
    status: notice ? notice.level : "ok",
    detail: notice ? `${notice.text} Firstmate and every worker stop when it does. Run /login in any Claude Code session to renew it.` : "No Claude Code session in Herdr reports an expiring login.",
    fix: notice ? { kind: "command", label: "Run in any Claude session", command: "/login" } : null,
  });

  // ---------- optional ----------
  add(componentItem(d, { id: "pstack", component: "pstack", title: "P-Stack skills", group: "optional", okWhen: (s) => /^\d+ skills linked/.test(s), okText: "Planning, review and shipping skills for Claude Code and Codex.", missingText: "Planning, review and shipping skills for Claude Code and Codex, adapted from Cursor's P-Stack." }));
  add(componentItem(d, { id: "evals", component: "evals", title: "Evals skills", group: "optional", okWhen: (s) => /claude 9\/9/.test(s), okText: "Skills for building and checking LLM evals.", missingText: "Skills for building and checking LLM evals (error analysis, judges, synthetic data)." }));
  for (const t of FM_TOOL_SPECS.filter((x) => x.tier === "optional" && x.name !== "gh")) add(toolItem(d, t));

  const gh = d.findTool("gh");
  add(toolItem(d, FM_TOOL_SPECS.find((t) => t.name === "gh")!, "GitHub command line (gh)"));
  if (!gh) add({ id: "gh-login", title: "GitHub login", group: "optional", status: "missing", detail: "Firstmate's start-up check asks for a logged-in gh. Local-only projects never use it.", fix: { kind: "button", label: "Log in to GitHub", action: "gh-login", disabled: "Install the GitHub command line first." } });
  else {
    const r = await d.run(gh.path, ["auth", "status", "--hostname", "github.com"]);
    const account = r.out.match(/account (\S+)/)?.[1] ?? r.out.match(/Logged in to github\.com as (\S+)/)?.[1];
    add(r.code === 0
      ? { id: "gh-login", title: "GitHub login", group: "optional", status: "ok", detail: `gh is logged in to github.com${account ? ` as ${account}` : ""}.`, fix: null }
      : { id: "gh-login", title: "GitHub login", group: "optional", status: "missing", detail: "gh is not logged in. Firstmate's start-up check asks for it even though local-only projects never push.", fix: { kind: "button", label: "Log in to GitHub", action: "gh-login", command: "gh auth login --web --hostname github.com --git-protocol https" } });
  }

  const codex = d.findTool("codex");
  if (!codex) add({ id: "codex-login", title: "Codex login", group: "optional", status: "missing", detail: "Codex is not installed. Joyride works with Claude Code alone; install Codex to run Codex workers too.", fix: { kind: "link", label: "Get Codex", href: "https://developers.openai.com/codex/cli" } });
  else {
    const r = await d.run(codex.path, ["login", "status"]);
    const line = r.out.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "";
    add(r.code === 0 && !/not logged in/i.test(r.out)
      ? { id: "codex-login", title: "Codex login", group: "optional", status: "ok", detail: line ? `${line}.`.replace(/\.\.$/, ".") : "Codex is logged in.", fix: null }
      : { id: "codex-login", title: "Codex login", group: "optional", status: "missing", detail: "Codex is installed but not logged in, so Codex workers can't start.", fix: { kind: "command", label: "Run in a terminal", command: "codex login" } });
  }

  add(d.jev.key || d.jev.fake
    ? { id: "jev", title: "Jev key", group: "optional", status: "ok", detail: d.jev.key ? "JEV_API_KEY is set. Jev judges attention and evidence." : "This environment uses test models in place of Jev.", fix: null }
    : { id: "jev", title: "Jev key", group: "optional", status: "missing", detail: "Without JEV_API_KEY, Joyride falls back to simple rules for attention, evidence verdicts.", fix: { kind: "command", label: "Add to .env, then restart", command: "echo 'JEV_API_KEY=<your key>' >> .env && ./bin/joyride restart" } });

  const lt = d.notifications.lastTest;
  add(!d.notifications.enabled
    ? { id: "notifications", title: "macOS notifications", group: "optional", status: "warn", detail: "Notifications are turned off in Settings, so you won't hear about blocked agents or held actions.", fix: { kind: "link", label: "Open notification settings", href: "#/settings" } }
    : lt?.sent
      ? { id: "notifications", title: "macOS notifications", group: "optional", status: "ok", detail: `A test notification went out on ${fmtDate(lt.at)}.`, fix: { kind: "button", label: "Send another", action: "notify-test" } }
      : { id: "notifications", title: "macOS notifications", group: "optional", status: lt ? "warn" : "unknown", detail: lt ? `The last test didn't arrive: ${lt.reason ?? "unknown reason"}.` : "Send a test to check that macOS shows Joyride's notifications.", fix: { kind: "button", label: "Send a test notification", action: "notify-test" } });

  const req = items.filter((i) => i.group === "required"), opt = items.filter((i) => i.group === "optional");
  const blocking = req.filter((i) => i.status === "missing").length;
  return {
    items,
    summary: {
      required: { done: req.filter((i) => ok(i.status)).length, total: req.length },
      optional: { done: opt.filter((i) => ok(i.status)).length, total: opt.length },
      done: items.filter((i) => ok(i.status)).length, total: items.length, blocking,
    },
    land: blocking > 0 && !d.seen && !d.test,
    at: new Date().toISOString(),
  };
}
