import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { sandboxDaemon } from "../sandbox.ts";

const realConfig = fs.readFileSync(path.resolve("joyride.config.example.yaml"), "utf8");
const commentLines = (text: string) => text.split("\n").filter((line) => line.trimStart().startsWith("#"));

let d: Awaited<ReturnType<typeof sandboxDaemon>>;
let file: string;
beforeAll(async () => {
  d = await sandboxDaemon("config-comments", ["system"]);
  file = path.join(d.sb.env.JOYRIDE_HOME, "joyride.config.yaml");
});
afterAll(() => d.stop());

describe("config writes", () => {
  it("round-trips the real config through model and notification settings without losing any comments or formatting", async () => {
    fs.writeFileSync(file, realConfig);
    const current = YAML.parse(realConfig);
    const tasks = structuredClone(current.llm.tasks);
    tasks.idea_naming.model = "sonnet";
    const r = await d.req("PUT", "/api/system/config", { llm: { default: current.llm.default, tasks } });
    expect(r.status).toBe(200);
    expect(r.body.commit).toBeTruthy();
    const expected = realConfig.replace("idea_naming:          { backend: codex, model: gpt-6.1-sol", "idea_naming:          { backend: codex, model: sonnet");
    expect(fs.readFileSync(file, "utf8")).toBe(expected);
    expect(commentLines(fs.readFileSync(file, "utf8"))).toEqual(commentLines(realConfig));
    expect((await d.req("PUT", "/api/system/config", { notifications: { macos: false, min_level: "L4" } })).status).toBe(200);
    expect(fs.readFileSync(file, "utf8")).toBe(expected.replace("macos: true", "macos: false").replace("min_level: L3", "min_level: L4"));
  });

  it("retains inline comments, quotes, blank lines, flow layout and key order, including a no-op save", async () => {
    const source = '# config\r\nnotifications:\r\n    macos: true    # switch\r\n    min_level: "L3" # level\r\n\r\npreview_ports: [4320,  4329] # ports\r\n';
    fs.writeFileSync(file, source);
    expect((await d.req("PUT", "/api/system/config", { notifications: { macos: false, min_level: "L4" } })).status).toBe(200);
    const expected = source.replace("macos: true", "macos: false").replace('"L3"', '"L4"');
    expect(fs.readFileSync(file, "utf8")).toBe(expected);
    expect((await d.req("PUT", "/api/system/config", { notifications: { macos: false, min_level: "L4" } })).status).toBe(200);
    expect(fs.readFileSync(file, "utf8")).toBe(expected);
  });

  it("adds and removes overrides while retaining comments and unrelated formatting", async () => {
    const source = '# config\nllm:\n  default: { backend: codex, model: "gpt-6-luna" } # default\n  tasks:\n    # old explanation\n    idea_naming: { backend: codex, model: gpt-6-luna } # inline explanation\nnotifications: { macos: true,  min_level: L3 }\n';
    fs.writeFileSync(file, source);
    expect((await d.req("PUT", "/api/system/config", { llm: { tasks: { idea_naming: { backend: "codex", model: "sonnet", effort: "high" }, session_intent: { backend: "codex", model: "gpt-6-luna" } } } })).status).toBe(200);
    let saved = fs.readFileSync(file, "utf8");
    expect(saved).toContain('notifications: { macos: true,  min_level: L3 }');
    expect(saved).toContain('# inline explanation');
    expect(YAML.parse(saved).llm.tasks.idea_naming.effort).toBe("high");
    const removed = await d.req("PUT", "/api/system/config", { llm: { tasks: { session_intent: { backend: "codex", model: "gpt-6-luna" } } } });
    expect(removed.status).toBe(200);
    saved = fs.readFileSync(file, "utf8");
    expect(saved).toContain('# old explanation');
    expect(saved).toContain('# inline explanation');
    expect(Object.keys(YAML.parse(saved).llm.tasks)).toEqual(["session_intent"]);
  });

  it("keeps comments when resetting the last override and can add a section to a missing config", async () => {
    const source = '# config\nllm:\n  tasks:\n    # override\n    idea_naming: { backend: codex, model: gpt-6-luna } # model\nnotifications: { macos: true, min_level: L3 }\n';
    fs.writeFileSync(file, source);
    const reset = await d.req("PUT", "/api/system/config", { llm: { tasks: {} } });
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);
    const saved = fs.readFileSync(file, "utf8");
    for (const comment of ["# config", "# override", "# model"]) expect(saved).toContain(comment);
    expect(YAML.parse(saved).llm.tasks).toEqual({});
    expect(saved).toContain("notifications: { macos: true, min_level: L3 }");
    fs.unlinkSync(file);
    expect((await d.req("PUT", "/api/system/config", { notifications: { macos: false, min_level: "L4" } })).status).toBe(200);
    expect(YAML.parse(fs.readFileSync(file, "utf8"))).toEqual({ notifications: { macos: false, min_level: "L4" } });
  });

  it("adds settings after a final line without a newline and preserves custom indentation", async () => {
    const source = '# config\nllm:\n    default: { backend: codex, model: "gpt-6-luna" } # model';
    fs.writeFileSync(file, source);
    const added = await d.req("PUT", "/api/system/config", { notifications: { macos: false, min_level: "L4" } });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    const saved = fs.readFileSync(file, "utf8");
    expect(saved).toContain(source + "\nnotifications:");
    expect(YAML.parse(saved).notifications).toEqual({ macos: false, min_level: "L4" });
  });

  it("keeps supplied YAML verbatim and rejects invalid updates without touching the file", async () => {
    const source = '# authored\nnotifications: { macos: true, min_level: "L3" } # inline\n';
    expect((await d.req("PUT", "/api/system/config", { yaml: source })).status).toBe(200);
    expect(fs.readFileSync(file, "utf8")).toBe(source);
    expect((await d.req("PUT", "/api/system/config", { notifications: { min_level: "bad" } })).status).toBe(400);
    expect(fs.readFileSync(file, "utf8")).toBe(source);
    expect((await d.req("PUT", "/api/system/config", { yaml: 'notifications: [' })).status).toBe(400);
    expect(fs.readFileSync(file, "utf8")).toBe(source);
  });
});
