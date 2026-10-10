import { planNew, resolveName, defaultPlace, placeScope, type MapIndex, type PlanContext } from "./new-plan.ts";
import { itemKind } from "./board.ts";
import { listItems, noteLines } from "./compose.ts";
import { standaloneIntent } from "./standalone-plan.ts";
import type { AnimationKind, NewAction, NewCandidate, ScreenContext, ScreenElement, UiAction } from "./freeform.ts";

export type NewWorld = MapIndex & {
  elements: ScreenElement[];
  notes: { id: string; title: string; bullets: string[]; scope: string; status: string }[];
  accounts: { id: string; label: string; provider: string }[];
  resumable?: { key: string; cwd: string; source: "claude" | "codex"; id: string }[];
  groupRepos?: Record<string, string[]>;
  ideaRepos?: Record<string, string[]>;
};
const enc = encodeURIComponent;
const resource = (action: Extract<NewAction, { kind: "resource" }>["action"], target = "", payload: Record<string, unknown> = {}): NewAction => ({ kind: "resource", action, target, payload });
const intent = (intent: Extract<NewAction, { kind: "intent" }>["intent"], target: string, payload: Record<string, unknown> = {}): NewAction => ({ kind: "intent", intent, target, payload });
const map = (action: string, args: Record<string, unknown>): NewAction => ({ kind: "map", action, args });
const api = (method: Extract<NewAction, { kind: "api" }>["method"], path: string, body: Record<string, unknown> = {}): NewAction => ({ kind: "api", method, path, body });
const direct = (actions: NewAction[], animation: AnimationKind, summary: string): NewCandidate => ({ route: "deterministic", actions, animation, summary });
const ui = (command: UiAction, summary: string) => direct([{ kind: "ui", command }], "view", summary);
const agent = (reason: string): NewCandidate => ({ route: "agent", reason });
const name = (s: string) => s.trim().replace(/^["']|["']$/g, "").replace(/[.!]+$/, "");

export function placeContext(c: ScreenContext): PlanContext {
  const p = c.place;
  const focus = c.focused;
  return p?.kind === "idea" ? { idea: { id: p.id, title: p.title } } : p?.kind === "group" ? { group: { id: p.id, title: p.title } }
    : p?.kind === "unfiled" ? { unfiled: true } : focus?.kind === "idea" ? { idea: focus } : focus?.kind === "group" ? { group: focus } : {};
}

function target(typed: string, kinds: ScreenElement["kind"][], world: NewWorld, c: ScreenContext): ScreenElement | null {
  if (/^(?:this|that|it|here|this (?:idea|group|session|worker|task|note|list|link|artifact|ask))$/i.test(typed.trim())) {
    const ref = [c.selected, c.hovered, c.focused, c.place?.kind === "idea" || c.place?.kind === "group" ? c.place : null].find((e) => e && kinds.includes(e.kind));
    return ref ? world.elements.find((e) => e.kind === ref.kind && e.id === ref.id) ?? null : null;
  }
  const pool = world.elements.filter((e) => kinds.includes(e.kind));
  const typedName = typed.replace(/^(?:worker|note|list|link|artifact|ask|idea|group|session|task)\s+/i, "");
  const exact = pool.filter((e) => e.id === typedName);
  if (exact.length === 1) return exact[0];
  // resolveName is shared with the map planner; its ambiguity rules must agree.
  const matches = resolveName(typed.replace(/^(?:worker|note|list|link|artifact|ask|idea|group|session|task)\s+/i, ""), pool.map((e) => ({ ...e, kind: "idea" })));
  return matches.length === 1 ? pool.find((e) => e.id === matches[0].id) ?? null : null;
}
const pages: Record<string, string> = { map: "map", home: "map", agents: "agents", fleet: "agents", crew: "agents?owner=crew", tasks: "agents?owner=crew", board: "board", notes: "board", artifacts: "artifacts", reports: "artifacts", search: "knowledge", knowledge: "knowledge", settings: "settings", setup: "setup", usage: "usage", accounts: "usage", evidence: "evidence", guide: "start", "start session": "start-session", "needs you": "agents?show=needs-you", "my helm": "agents?show=your-helm", "suggested ideas": "agents?show=suggested" };

/** Parse only requests whose complete arguments are known. Jev judges this candidate before execution. */
export function candidateNew(raw: string, w: NewWorld, c: ScreenContext): NewCandidate {
  const text = raw.trim();
  const words = text.replace(/^(?:please\s+|(?:can|could|would|will) you (?:please )?)/i, "");
  const t = words.replace(/[.!]+$/, "");
  const ctx = placeContext(c);
  let m: RegExpExecArray | null;
  if (standaloneIntent(t)) return { route: "standalone", summary: "Starting your standalone session…" };
  if (/^(?:task|new task)\s*:|^(?:ask|have|get) firstmate to\b/i.test(t)) return { route: "firstmate", brief: text, idea: ctx.idea?.id ?? null, title: text.split("\n")[0].slice(0, 100), summary: "Sent the task to Firstmate." };
  if ((m = /^(open|show|close|hide) (?:the )?(?:command )?palette$/i.exec(t))) return ui({ action: "palette", show: /^(open|show)$/i.test(m[1]) }, "Changed the command palette.");
  if (/^(?:show|focus|scroll to) (?:the )?(?:attention rail|approvals|needs-you rail)$/i.test(t)) return ui({ action: "attention" }, "Opened needs you in the rail.");
  if (/^(?:close|dismiss) (?:this|the(?: current)?|current) (?:sheet|drawer|dialog)$/i.test(t)) return ui({ action: "navigate", path: "map" }, "Closed the sheet.");
  if ((m = /^(?:go to|show|open|navigate to|take me to|switch to) (?:the )?(.+?)(?: page)?$/i.exec(t))) {
    const page = pages[m[1].toLowerCase()];
    if (page) return ui({ action: "navigate", path: page }, `Opened ${m[1]}.`);
    const e = /^agents (?:in|for) /i.test(m[1]) ? null : target(m[1], ["idea", "session", "worker", "task", "artifact", "note", "group"], w, c);
    if (e) return e.kind === "note" || e.kind === "group" ? ui({ action: "reveal", kind: e.kind === "note" ? "item" : "region", id: e.kind === "group" ? `lens:${e.id}` : e.id }, `Opened ${e.title}.`)
      : ui({ action: "navigate", path: `${e.kind === "idea" ? "mission" : e.kind === "artifact" ? "artifacts" : e.kind}/${enc(e.id)}` }, `Opened ${e.title}.`);
  }
  if ((m = /^(?:zoom(?: the map)?(?: to)?|show (?:the )?map at) (far|mid|near|fit|in|out)$/i.exec(t))) return ui({ action: "zoom", level: m[1].toLowerCase() === "in" ? "near" : m[1].toLowerCase() === "out" ? "far" : m[1].toLowerCase() === "mid" ? "mid" : m[1].toLowerCase() === "fit" ? "fit" : m[1].toLowerCase() === "near" ? "near" : "far" }, "Changed map zoom.");
  if (/^(?:fit|reset|zoom out to) (?:the )?(?:whole )?map(?: to everything)?$/i.test(t)) return ui({ action: "zoom", level: "fit" }, "Fit the map.");
  if (/^(?:clear focus|unfocus|back to (?:the )?(?:whole )?map)$/i.test(t)) return ui({ action: "navigate", path: "map" }, "Opened the whole map.");
  if ((m = /^(?:focus|zoom in on|look at) (.+)$/i.exec(t))) {
    const e = target(m[1], ["idea", "group"], w, c);
    if (e) return ui({ action: "reveal", kind: e.kind === "idea" ? "idea" : "region", id: e.kind === "group" ? `lens:${e.id}` : e.id }, `Focused ${e.title}.`);
  }
  if ((m = /^(show|hide) archived ideas(?: on the map)?$/i.exec(t))) return ui({ action: "archive", show: m[1].toLowerCase() === "show" }, `${m[1]} archived ideas.`);
  if ((m = /^(show|open|hide|close) (?:the )?(?:rail|sidebar|attention rail)$/i.exec(t))) return ui({ action: "rail", show: /^(show|open)$/i.test(m[1]) }, "Changed the rail.");
  if ((m = /^(?:open|show|switch to) (?:the )?(chat|terminal|context)(?: tab)?$/i.exec(t))) {
    const command: UiAction = { action: "tab", tab: m[1].toLowerCase() === "chat" ? "chat" : m[1].toLowerCase() === "terminal" ? "terminal" : "context" };
    if (/^worker\//.test(c.route)) return ui(command, `Opened ${m[1]}.`);
    const worker = target("this", ["worker"], w, c);
    if (worker) return direct([{ kind: "ui", command: { action: "navigate", path: `worker/${enc(worker.id)}` } }, { kind: "ui", command }], "view", `Opened ${worker.title}'s ${m[1]} tab.`);
    return agent("Resolve which worker's tab to open from the screen context.");
  }
  if ((m = /^(?:search|find in (?:search|knowledge)) (?:for )?(.+)$/i.exec(t))) return ui({ action: "navigate", path: `knowledge?q=${enc(m[1])}` }, `Searching for ${m[1]}.`);
  if ((m = /^(?:show|filter) (crew|yours|running|idle|done|needs you|at my helm|suggested ideas)(?: agents| sessions| tasks)?$/i.exec(t))) {
    const filter: Record<string, string> = { crew: "owner=crew", yours: "owner=yours", running: "state=running", idle: "state=idle", done: "state=done", "needs you": "show=needs-you", "at my helm": "show=your-helm", "suggested ideas": "show=suggested" };
    return ui({ action: "navigate", path: `agents?${filter[m[1].toLowerCase()]}` }, `Showing ${m[1]}.`);
  }
  if ((m = /^sort agents by (?:most )?(recent|ideas)$/i.exec(t))) return ui({ action: "navigate", path: `agents?order=${m[1].toLowerCase()}` }, "Changed agent sorting.");
  if ((m = /^(?:show|filter) agents (?:in|for) (.+)$/i.exec(t))) {
    const e = target(m[1], ["idea"], w, c);
    if (e) return ui({ action: "navigate", path: `agents?idea=${enc(e.id)}` }, `Showing agents in ${e.title}.`);
  }
  if ((m = /^pan (?:the )?map (left|right|up|down) (\d+)(?: pixels)?$/i.exec(t)) && c.view) {
    const n = Number(m[2]), v = c.view;
    return ui({ action: "view", s: v.s, tx: v.tx + (/left/i.test(m[1]) ? n : /right/i.test(m[1]) ? -n : 0), ty: v.ty + (/up/i.test(m[1]) ? n : /down/i.test(m[1]) ? -n : 0) }, "Panned the map.");
  }
  if ((m = /^(?:recheck|check whether) (?:ask )?(.+?)(?: is still needed)?$/i.exec(t))) {
    const e = target(m[1], ["ask"], w, c);
    if (e) return direct([intent("recheck_ask", e.id)], "attention", "Asked Firstmate to re-check this ask.");
  }
  if ((m = /^undo (?:acknowledgement|acknowledgment|ack) (.+)$/i.exec(t))) {
    const e = target(m[1], ["attention"], w, c);
    if (e) return direct([resource("undo-ack", e.id)], "attention", "Reopened the attention item.");
  }
  if ((m = /^(?:start|launch|open) (?:a |new )?session(?: (?:in|on|for|at))? (.+)$/i.exec(t))) {
    const e = target(m[1], ["idea", "group", "project"], w, c);
    if (e && (e.kind === "idea" || e.kind === "group" || e.kind === "project")) return direct([intent("launch_session", e.id, { here: e.kind === "project" ? { kind: "project", title: e.title, cwd: e.id } : { kind: e.kind, id: e.id } })], "agent", `Started a session in ${e.title}.`);
  }
  if ((m = /^(?:resume|restart) (?:session )?(.+)$/i.exec(t))) {
    const e = target(m[1], ["session"], w, c);
    const saved = e && w.resumable?.find((s) => s.key === e.id && s.cwd.startsWith("/"));
    if (e && saved) return direct([intent("launch_session", saved.cwd, { cwd: saved.cwd, agent: saved.source, resume: saved.id, label: e.title })], "agent", `Resumed ${e.title} in its saved folder.`);
    if (e) return agent("Read the saved session's folder and harness before resuming it. Its originating account is not recorded; do not guess an account requested by the user.");
  }
  if (/^(?:start|launch) firstmate$/i.test(t)) return direct([intent("start_firstmate", "firstmate")], "firstmate", "Started Firstmate.");
  if ((m = /^(?:switch|change) (?:the )?firstmate(?: primary)? (?:to|onto) (.+)$/i.exec(t))) {
    const name = m[1].toLowerCase();
    const exact = w.accounts.filter((a) => [a.id.toLowerCase(), a.label.toLowerCase()].includes(name));
    const hits = exact.length ? exact : w.accounts.filter((a) => a.provider === name);
    if (hits.length === 1) return direct([intent("switch_firstmate", "firstmate", { account: hits[0].id })], "firstmate", `Switched Firstmate to ${hits[0].label}.`);
    return agent("Resolve the requested Firstmate account against its current choices.");
  }
  if ((m = /^(?:reply to|steer|tell) (.+?) with image (\S+)\s*:\s+([\s\S]+)$/i.exec(words))) {
    const e = target(m[1], ["worker", "task"], w, c);
    if (e) return direct([intent(e.kind === "task" ? "steer_task" : "reply", e.id, { text: m[3], images: [m[2]] })], "reply", `Sent the message and uploaded image to ${e.title}.`);
  }
  if ((m = /^(?:reply to|steer|tell|message|send to) (.+?)\s*:\s+([\s\S]+)$/i.exec(words))) {
    const e = target(m[1], ["worker", "task"], w, c);
    if (e) return direct([intent(e.kind === "task" ? "steer_task" : "reply", e.id, { text: m[2] })], "reply", `Sent to ${e.title}.`);
  }
  if ((m = /^type in (?:worker |terminal )?(.+?)\s*:\s+([\s\S]+)$/i.exec(words))) {
    const e = target(m[1], ["worker"], w, c);
    if (e) return direct([api("POST", `/api/workers/${enc(e.id)}/input`, { data: m[2] })], "reply", `Typed in ${e.title}.`);
  }
  if ((m = /^(?:answer|resolve) (.+?)\s*:\s+([\s\S]+)$/i.exec(words))) {
    const e = target(m[1], ["ask"], w, c);
    if (e) {
      const held = /^(done|release)\s*:\s*([\s\S]+)$/i.exec(m[2]);
      return direct([intent("answer_ask", e.id, held ? { mode: held[1].toLowerCase(), answer: held[2] } : { answer: m[2] })], "reply", `Answered ${e.title}.`);
    }
  }
  if ((m = /^(?:acknowledge|got it|dismiss|mark seen)\s+(.+)$/i.exec(t))) {
    const e = target(m[1], ["attention"], w, c) ?? target(m[1], ["ask"], w, c);
    if (e) return direct([e.kind === "attention" ? resource("ack", e.id) : intent("answer_ask", e.id, { answer: "Got it" })], "attention", `Acknowledged ${e.title}.`);
  }
  if ((m = /^snooze (.+?) for (\d+) (minutes?|hours?)$/i.exec(t))) {
    const e = target(m[1], ["attention"], w, c);
    if (e) return direct([resource("snooze", e.id, { until: new Date(Date.now() + Number(m[2]) * (/hour/i.test(m[3]) ? 3600000 : 60000)).toISOString() })], "attention", `Snoozed ${e.title}.`);
  }
  if ((m = /^(allow always|allow|approve|deny) (?:prompt |approval )?(.+)$/i.exec(t))) {
    const e = target(m[2], ["worker", "ask"], w, c);
    if (e) return direct([e.kind === "worker" ? intent("answer_prompt", e.id, { choice: /always/i.test(m[1]) ? "allow_always" : /deny/i.test(m[1]) ? "deny" : "allow" }) : intent("answer_ask", e.id, { answer: /deny/i.test(m[1]) ? "deny" : "allow" })], "attention", `Answered ${e.title}.`);
  }
  if ((m = /^(?:hand back|keep to myself|exclude|include|put back in the fleet|save and close|focus pane|move to herdr) (.+)$/i.exec(t))) {
    const e = target(m[1], ["worker"], w, c);
    if (e) return direct([/^focus pane/i.test(t) ? intent("focus", e.id) : /^move to herdr/i.test(t) ? intent("move_to_herdr", e.id) : resource(/^hand back/i.test(t) ? "hand-back" : /^(keep|exclude)/i.test(t) ? "exclude" : /^(include|put back)/i.test(t) ? "include" : "prune", e.id, { worker: e.id, why: "Requested through New." })], "reply", `Updated ${e.title}.`);
  }
  if ((m = /^(?:create|make|add|new) (?:an? )?(?:empty )?idea(?: called| named)?\s*:\s*([\s\S]+)$/i.exec(words))) return direct([resource("new-idea", "", { title: name(m[1]), goal: m[1], state: "open" })], "idea", `Created idea ${name(m[1])}.`);
  if ((m = /^(?:rename|retitle) idea (.+?) (?:to|as) (.+)$/i.exec(t))) {
    const e = target(m[1], ["idea"], w, c);
    if (e) return direct([resource("edit-idea", e.id, { title: name(m[2]) })], "idea", `Renamed ${e.title}.`);
  }
  if ((m = /^(?:set|change|edit|update) (.+?) (?:goal|description)\s*:\s*([\s\S]+)$/i.exec(words))) {
    const e = target(m[1], ["idea"], w, c);
    if (e) return direct([resource("edit-idea", e.id, { goal: m[2] })], "idea", `Updated ${e.title}.`);
  }
  if ((m = /^(pause|resume|drop|archive|unarchive|finish|mark done) (?:idea )?(.+)$/i.exec(t))) {
    const e = target(m[2], ["idea"], w, c);
    if (e) return direct([/archive/i.test(m[1]) ? resource("edit-idea", e.id, { archive: m[1].toLowerCase() === "archive" }) : resource("state-idea", e.id, { state: /^pause/i.test(m[1]) ? "paused" : /^drop/i.test(m[1]) ? "dropped" : /^resume/i.test(m[1]) ? "open" : "done" })], "idea", `Updated ${e.title}.`);
  }
  if ((m = /^(?:move|place) group (.+?) (?:to|at) (-?\d+(?:\.\d+)?),?\s+(-?\d+(?:\.\d+)?)$/i.exec(t))) {
    const e = target(m[1], ["group"], w, c);
    if (e) return direct([map("move-group", { group: e.id, x: Number(m[2]), y: Number(m[3]) })], "move", `Moved ${e.title}.`);
  }
  if ((m = /^reset (?:position of )?group (.+)$/i.exec(t))) {
    const e = target(m[1], ["group"], w, c);
    if (e) return direct([map("move-group", { group: e.id, reset: true })], "move", `Reset ${e.title}'s position.`);
  }
  if ((m = /^(?:edit|replace|rewrite) (?:note |list |link )?(.+?)\s*:\s*([\s\S]+)$/i.exec(words))) {
    const e = target(m[1], ["note"], w, c);
    if (e) return direct([/^.*list /i.test(t.slice(0, t.indexOf(":"))) ? map("edit-list", { note: e.id, items: listItems(m[2]) }) : map("edit-note", { note: e.id, text: m[2] })], "note", `Updated ${e.title}.`);
  }
  if ((m = /^(?:tick|check off|complete|untick|uncheck) (.+?) (?:in|on) (.+)$/i.exec(t))) {
    const e = target(m[2], ["note"], w, c), note = w.notes.find((n) => n.id === e?.id);
    if (note) {
      const at = note.bullets.findIndex((b) => b.replace(/^\[[ x]\]\s*/, "").toLowerCase() === name(m![1]).toLowerCase());
      if (at >= 0) return direct([map("edit-list", { note: note.id, items: note.bullets.map((b, i) => i === at ? `${/^(untick|uncheck)/i.test(t) ? "[ ]" : "[x]"} ${b.replace(/^\[[ x]\]\s*/, "")}` : b) })], "list", `Updated ${note.title}.`);
    }
  }
  if ((m = /^(?:add item|remove item|rename item) (.+?) (?:in|to|from) (.+?)(?:\s*:\s*(.+))?$/i.exec(t))) {
    const e = target(m[2], ["note"], w, c), note = w.notes.find((n) => n.id === e?.id);
    if (note) {
      const bullets = /^add/i.test(t) ? [...note.bullets, `[ ] ${m[1]}`] : note.bullets.flatMap((b) => b.replace(/^\[[ x]\]\s*/, "").toLowerCase() === name(m![1]).toLowerCase() ? /^remove/i.test(t) ? [] : m![3] ? [b.slice(0, 4) + m![3]] : [b] : [b]);
      if (bullets.length) return direct([map("edit-list", { note: note.id, items: bullets })], "list", `Updated ${note.title}.`);
    }
  }
  if ((m = /^(?:archive|delete|remove|restore|unarchive) (?:note|list|link|card) (.+)$/i.exec(t))) {
    const e = target(m[1], ["note"], w, c);
    if (e) return direct([map(/^(restore|unarchive)/i.test(t) ? "restore-note" : "archive-note", { note: e.id })], "note", `Updated ${e.title}.`);
  }
  if ((m = /^(?:move|file|put) (?:note|list|link|card) (.+?) (?:to|in|into|on) (.+)$/i.exec(t))) {
    const e = target(m[1], ["note"], w, c), p = target(m[2], ["idea", "group"], w, c);
    if (e && (p || /^(unfiled|hub)$/i.test(m[2]))) return direct([map("move-note", { note: e.id, scope: p ? `${p.kind === "idea" ? "mission" : "group"}:${p.id}` : "global" })], "move", `Moved ${e.title}.`);
  }
  if ((m = /^(?:tell firstmate about|send note to firstmate|save and tell firstmate) (.+)$/i.exec(t))) {
    const e = target(m[1], ["note"], w, c);
    if (e) return direct([intent("tell_note", e.id)], "firstmate", "Sent the note to Firstmate.");
  }
  if ((m = /^(accept|reject|reopen) (?:proposal|suggestion) (.+)$/i.exec(t))) return direct([resource(/^accept/i.test(m[1]) ? "accept-proposal" : /^reject/i.test(m[1]) ? "reject-proposal" : "reopen-proposal", name(m[2]))], "idea", "Updated the proposal.");
  if (/^(?:backfill|scan for suggested ideas)$/i.test(t)) return direct([resource("backfill")], "idea", "Scanned for ideas.");
  if ((m = /^(?:reverify|verify evidence for|judge evidence for) (.+)$/i.exec(t))) {
    const e = target(m[1], ["idea"], w, c);
    if (e) return direct([intent("reverify", e.id)], "idea", "Requested evidence verification.");
  }
  if (/^(?:scan|refresh|find new) artifacts$/i.test(t)) return direct([resource("scan-artifacts")], "link", "Scanned for artifacts.");
  if ((m = /^(?:edit|update) artifact (.+?) summary\s*:\s*([\s\S]+)$/i.exec(words))) {
    const e = target(m[1], ["artifact"], w, c);
    if (e) return direct([resource("edit-artifact", e.id, { summary: m[2] })], "link", `Updated ${e.title}.`);
  }
  if ((m = /^(?:register|add) artifact\s*:\s*(.+)$/i.exec(t))) return direct([resource("register-artifact", "", { url: m[1], title: m[1] })], "link", "Registered the artifact.");
  if ((m = /^(enable|disable|turn on|turn off) (?:macos )?notifications$/i.exec(t))) return direct([resource("settings", "", { notifications: { macos: /^(enable|turn on)/i.test(m[1]) } })], "settings", "Updated notifications.");
  if ((m = /^set notification level (L[1-4])$/i.exec(t))) return direct([resource("settings", "", { notifications: { min_level: m[1].toUpperCase() } })], "settings", "Updated notification level.");
  if ((m = /^set (jev|default) model (.+)$/i.exec(t))) return direct([resource("settings", "", m[1].toLowerCase() === "jev" ? { jev: { model: m[2] } } : { llm: { default: { model: m[2] } } })], "settings", "Updated the model.");
  if (/^(?:test|send a test) notification$/i.test(t)) return direct([resource("notify-test")], "settings", "Sent a test notification.");
  if ((m = /^install (?:the )?(hooks|mcp|skills|pstack|evals|agents|treehouse|tasks-axi|quota-axi|chrome-devtools-axi|lavish-axi|gh|gh-axi|no-mistakes)$/i.exec(t))) return direct([api("POST", "/api/system/install", { component: m[1].toLowerCase() })], "settings", "Started the requested installer. Its progress is on Setup.");
  if ((m = /^mark setup (\S+) (done|incomplete)$/i.exec(t))) return direct([api("POST", "/api/system/setup/ack", { id: m[1], done: m[2].toLowerCase() === "done" })], "settings", "Updated the setup check.");
  if (/^dismiss setup hints$/i.test(t)) return direct([api("POST", "/api/system/setup/seen")], "settings", "Dismissed setup hints.");
  if (/^(?:sign in to github|start github login)$/i.test(t)) return direct([api("POST", "/api/system/setup/gh-login")], "agent", "Opened GitHub login in a private session. Follow its offered prompts.");
  if (/^focus github login$/i.test(t)) return direct([api("POST", "/api/system/setup/gh-login/focus")], "view", "Focused GitHub login.");
  if ((m = /^remove (?:remembered |guard )?rule (\S+)$/i.exec(t))) return direct([api("DELETE", `/api/guard/rules/${enc(m[1])}`)], "settings", "Removed the remembered rule.");
  if ((m = /^open firstmate (.+) file$/i.exec(t))) {
    const files: Record<string, string> = { captain: "captain.md", preferences: "captain.md", "shared captain": "captain-shared.md", learnings: "learnings.md", "memory archive": "memory-archive.md" };
    const file = files[name(m[1]).toLowerCase()] ?? name(m[1]);
    if (["captain.md", "captain-shared.md", "learnings.md", "memory-archive.md"].includes(file)) return direct([resource("open-preferences", file)], "settings", "Opened Firstmate preferences.");
    return agent("Read the Firstmate preference file catalogue and resolve which file was requested.");
  }
  if ((m = /^(dismiss|nudge) request (\S+)$/i.exec(t))) return direct([resource(/^dismiss/i.test(m[1]) ? "dismiss-request" : "nudge-request", m[2])], "firstmate", "Updated the Firstmate request.");

  // Resolve deictic names only in commands, never replace words inside saved prose.
  let resolved = words;
  // Short content cues support the same explicit locations as "add a note in ...".
  resolved = resolved.replace(/^(note|list|link|pdf|checklist)\s+(?=(?:in|on|to|under|into)\s)/i, "add a $1 ");
  const location = /^(?:(?:add|make|create|save|write|pin|drop)\s+(?:an?\s+)?)(?:note|list|link|pdf|checklist)\s+(?:in|on|under|into)\s+(.+?)\s*:\s*[\s\S]+$/i.exec(resolved);
  if (location && !/^(unfiled|hub|here)$/i.test(location[1]) && !target(location[1], ["idea", "group"], w, c)) return agent("The named board does not resolve to exactly one idea or group.");
  const picked = c.selected ?? c.hovered ?? c.focused;
  if (picked && /^(move|put|file|hide|unhide|rename|merge|delete|remove|park|set aside)/i.test(t)) resolved = resolved.replace(/\b(?:this|that|it)(?: (?:idea|group|session|worker|task))?\b/i, picked.title);
  const place = defaultPlace(ctx);
  if (place.kind !== "unfiled") {
    resolved = resolved.replace(/\b(?:in|on|to|into|under|for) here(?=\s*[:\n]|$)/i, (s) => `${s.split(" ")[0]} ${place.title}`);
    resolved = resolved.replace(/\b(note|list|link|checklist) here(?=\s*[:\n])/i, `$1 in ${place.title}`);
  }
  const plan = planNew(resolved, w, ctx);
  if (plan.notes.length || !plan.steps.length || plan.steps.some((s) => s.kind === "choose")) return agent("Resolve ambiguous names or missing parameters using the screen and map.");
  const actions: NewAction[] = [];
  let animation: AnimationKind = "move";
  for (const s of plan.steps) {
    if (s.kind === "map") { actions.push(map(s.action, s.args)); animation = /^(move|file)-/.test(s.action) ? "move" : /group/.test(s.action) ? "group" : "move"; }
    else if (s.kind === "note" || s.kind === "list") {
      if (!s.lines.length) return agent("Work out the requested note or list contents.");
      actions.push(map(s.kind === "list" ? "list" : "note", s.kind === "list" ? { items: s.lines, scope: placeScope(s.place), ...(s.title ? { title: s.title } : {}) } : { text: s.lines.join("\n"), scope: placeScope(s.place), ...(s.title ? { title: s.title } : {}) }));
      animation = s.kind === "list" ? "list" : itemKind(s.lines) === "link" ? "link" : "note";
    } else if (s.kind === "firstmate") {
      if (!/^(?:@?firstmate|fm|tell firstmate|message firstmate|ping firstmate|update firstmate|fyi:|update:|heads up:|question:)/i.test(t)) return agent("Interpret this question with context and make the answer visible.");
      actions.push(intent("tell_firstmate", "firstmate", { text: s.text, ...(s.idea ? { idea: s.idea } : {}) })); animation = "firstmate";
    }
    else if (s.kind === "task") {
      if (plan.steps.length !== 1 || /\b(?:artifact|canvas|map|here|this|that|agents?|sessions?|workers?|notes?|lists?|proposals?|suggestions?|guard|settings|hooks|quota|spend)\b/i.test(t) || /^(?:find|search|research|compare|summari[sz]e|analy[sz]e|look up|sort|group|install|uninstall|resume)\b/i.test(t)) return agent("This needs an agent to inspect context, search or perform several steps.");
      return { route: "firstmate", brief: text, idea: s.idea, title: text.split("\n")[0].slice(0, 100), summary: "Sent the task to Firstmate." };
    } else if (s.kind === "idea") return agent("Decide whether to create an empty idea or start work, using the supplied context.");
  }
  if (!actions.length) return agent("Interpret the request and make its result visible on the map.");
  return direct(actions, animation, plan.steps.map((s) => s.say).join(". "));
}
