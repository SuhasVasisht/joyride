import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ServerDefinition, ServerRun, type ServerGroupView, type ServerState } from "../../src/shared/servers";
import { ServerCard } from "../../src/ui/views/servers/ServersPage";

const group = (state: ServerState): ServerGroupView => {
  const definition = ServerDefinition.parse({ id: "review-links", name: "Reports review", project: "Reports", change: "Old data", url: "http://127.0.0.1:4325/reports",
    members: [{ id: "frontend", name: "Frontend", cwd: "/project", command: "node app.mjs", ports: [4325], url: "http://127.0.0.1:4325/reports" }],
  });
  return { ...definition, state, pending: false, instances: definition.members.map(member => ({ ...member, state, pending: false, reason: null,
    run: ServerRun.parse({ nonce: "db4a84a6-b2f2-409f-9c04-5f4d162ecfa2", machine: "local", socket: "/lab/socket", phase: "launched", pane: "owned-pane", terminal: "owned-terminal", workspace: "owned-workspace", member, change: definition.change, branch: "", url: definition.url, error: null }),
  })) };
};
const render = (g: ServerGroupView) => renderToStaticMarkup(createElement(ServerCard, { group: g }));
describe("review URL readiness", () => {
  it.each(["stopped", "starting", "failed", "unknown"] satisfies ServerState[])("keeps %s URLs visible without exposing working links", state => {
    const html = render(group(state));
    expect(html).not.toContain('href="http://127.0.0.1:4325/reports"');
    expect(html).toContain("http://127.0.0.1:4325/reports");
    expect(html).toContain("Not ready to open");
  });
  it("opens only the running launch's URL when a different URL is pending", () => {
    const g = group("running");
    g.url = "http://127.0.0.1:4329/new-change";
    g.members[0].url = g.url; g.instances[0].url = g.url;
    g.pending = true; g.instances[0].pending = true;
    const html = render(g);
    expect(html).toContain('href="http://127.0.0.1:4325/reports"');
    expect(html).not.toContain('href="http://127.0.0.1:4329/new-change"');
    expect(html).toContain("http://127.0.0.1:4329/new-change");
  });
  it("withholds a partial group's review link while keeping its running member accessible", () => {
    const g = { ...group("running"), state: "partial" } satisfies ServerGroupView;
    const backend = { ...g.members[0], id: "backend", name: "Backend", url: undefined };
    g.members.push(backend);
    g.instances.push({ ...backend, state: "stopped", reason: null, run: null, pending: false });
    const html = render(g);
    expect(html).not.toMatch(/<a[^>]+>Open review<\/a>/);
    expect(html).toMatch(/<a[^>]+>Open Frontend<\/a>/);
  });
});
