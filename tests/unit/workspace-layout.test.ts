import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { sandboxDaemon } from "../sandbox.ts";

let d: Awaited<ReturnType<typeof sandboxDaemon>>;
let file: string;
beforeAll(async () => {
  d = await sandboxDaemon("workspace-layout", ["map"]);
  file = path.join(d.sb.env.JOYRIDE_HOME, "workspace.yaml");
});
afterAll(async () => { await d?.stop(); });

it("serves only the map layout, title and theme, with no evolution API", async () => {
  fs.writeFileSync(file, "title: Chart room\nhome: {group_by: repo}\ntheme: {ink: navy}\nviews: []\nmission_panels: []\n");
  const r = await d.req("GET", "/api/workspace/spec");
  expect(r.status).toBe(200);
  expect(Object.keys(r.body).sort()).toEqual(["home", "theme", "title"]);
  expect(r.body).toMatchObject({ title: "Chart room", home: { group_by: "repo" }, theme: { ink: "navy" } });
  for (const route of ["/api/workspace/proposals", "/api/workspace/interactions", "/api/query"]) {
    expect((await d.req("POST", route, {})).status).toBe(404);
  }
});

it("keeps the last readable layout on invalid YAML and recovers when fixed", async () => {
  fs.writeFileSync(file, "title: Broken\nhome: [");
  expect((await d.req("GET", "/api/workspace/spec")).body.title).toBe("Chart room");
  fs.writeFileSync(file, "title: Recovered\n");
  expect((await d.req("GET", "/api/workspace/spec")).body.title).toBe("Recovered");
});

it("serves defaults when the file is missing", async () => {
  fs.unlinkSync(file);
  expect((await d.req("GET", "/api/workspace/spec")).body).toMatchObject({ title: "Joyride", home: { group_by: "lens" }, theme: {} });
});
