// Sandbox data for the map / mission / rail / worker specs. Every call is
// idempotent because all specs in one Playwright run share one sandbox daemon.
// Only ever points at the sandbox port (E2E_PORT), never the real daemon.
import { fakeHerdrControl, FAKE_SESSIONS } from "../fixtures/fake-herdr";
export { FAKE_SESSIONS };

export const PORT = Number(process.env.E2E_PORT ?? 4399);
if (PORT === 4317 || PORT === 3000) throw new Error("e2e helpers refuse to run against the real daemon port");
export const BASE = `http://127.0.0.1:${PORT}`;
export const HERDR_SOCK = `/tmp/joyride-e2e-${PORT}/herdr.sock`;
export const herdr = (method: string, params: Record<string, unknown> = {}) => fakeHerdrControl(HERDR_SOCK, method, params);

export async function call<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : (null as T) };
}

export const W = { working: "local:w1:p1", blocked: "local:w1:p2", codex: "local:w2:p1" } as const;

/** Missions spread over two repos and a lens, linked to the fake Herdr workers. */
export async function seedWorld() {
  await call("POST", "/api/lenses", { id: "reporting", title: "Reporting", description: "Report page work", missions: ["csv-export", "report-scaffold"] });
  const missions = [
    {
      id: "csv-export", title: "CSV export for the report page", repos: ["/tmp/joyride-fixture-repos/alpha"], branches: ["main"],
      goal: "Let analysts export the monthly report as CSV, totals row included, without breaking the existing PDF export.",
      sessions: [`claude:${FAKE_SESSIONS.claudeWorking}`, `claude:${FAKE_SESSIONS.claudeBlocked}`],
      done_when: [
        { id: "c1", text: "Unit tests for the CSV writer pass", kind: "test" },
        { id: "c2", text: "Playwright test downloads a CSV with a totals row", kind: "e2e" },
        { id: "c3", text: "Screenshot of the export button next to the date filter", kind: "screenshot" },
      ],
    },
    {
      id: "report-scaffold", title: "Scaffold the report page", repos: ["/tmp/joyride-fixture-repos/alpha"], branches: ["main"],
      goal: "Route, layout and empty states for the report page.", sessions: ["claude:44444444-4444-4444-8444-444444444444"],
      done_when: [{ id: "c1", text: "Page renders with an empty state", kind: "screenshot" }],
    },
    {
      id: "idempotent-sync", title: "Make the nightly sync idempotent", repos: ["/tmp/joyride-fixture-repos/beta"], branches: ["master"],
      goal: "Re-running the nightly sync must not duplicate rows; failed batches retry safely.",
      sessions: [`codex:${FAKE_SESSIONS.codexIdle}`, "claude:55555555-5555-4555-8555-555555555555", "claude:66666666-6666-4666-8666-666666666666"],
      done_when: [{ id: "c1", text: "Running the sync twice leaves the row count unchanged", kind: "test" }, { id: "c2", text: "Retry test passes", kind: "test" }],
      blocks: ["oauth-login"],
    },
    {
      id: "oauth-login", title: "OAuth login flow", repos: ["/tmp/joyride-fixture-repos/alpha"], branches: ["feature/auth"],
      goal: "Sign in with the company identity provider.", sessions: ["claude:33333333-3333-4333-8333-333333333333"], done_when: [],
    },
  ];
  for (const m of missions) {
    const r = await call("POST", "/api/missions", m);
    if (r.status !== 201 && r.status !== 409) throw new Error(`seed mission ${m.id}: ${r.status} ${JSON.stringify(r.body)}`);
    if (r.status === 409) {
      const reset = await call("PUT", `/api/missions/${m.id}`, { ...m, archive: false, state: "open", lenses: [] });
      if (reset.status !== 200) throw new Error(`reset mission ${m.id}: ${reset.status} ${JSON.stringify(reset.body)}`);
    }
  }
  return missions;
}

/** Raise an attention item unless an open one with the same title exists. */
export async function raise(item: Record<string, unknown>) {
  const open = (await call<any[]>("GET", "/api/attention?open=1&limit=500")).body;
  const hit = open.find((a) => a.title === item.title);
  if (hit) return hit;
  const r = await call("POST", "/api/attention", item);
  if (r.status !== 200) throw new Error(`raise: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

export async function guardRequest(title: string, command: string, opts: { session?: string | null; rule?: string } = {}) {
  const session = opts.session === undefined ? `claude:${FAKE_SESSIONS.claudeBlocked}` : opts.session;
  const r = await call("POST", "/api/guard/requests", {
    rule: opts.rule ?? "git-push", title, tool: "Bash", input: { command }, session: session ? session.split(":").slice(1).join(":") : null, agent: "claude", cwd: "/tmp/joyride-fixture-repos/alpha",
  });
  if (r.status !== 200) throw new Error(`guard request: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { id: string; decision: string };
}

export async function waitUntil<T>(fn: () => Promise<T>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try { const v = await fn(); if (v) return v; last = v; } catch (e) { last = e; }
    if (Date.now() > end) throw new Error(`waitUntil timed out (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Open an idea in full on the map (idea focus): every task card open, with who runs it, its crew and their chips. */
export async function openIdea(page: import("@playwright/test").Page, id: string) {
  const { expect } = await import("@playwright/test");
  const idea = page.locator(`.mission-node[data-mission="${id}"]`);
  const { panTo } = await import("./chart-pan");
  // Its health mark: on the card itself, not a link or a control.
  const mark = idea.locator(":scope > .mn-head > .health-mark");
  await panTo(mark);
  await mark.click();
  await expect(idea).toHaveClass(/d-full/);
  return idea;
}
