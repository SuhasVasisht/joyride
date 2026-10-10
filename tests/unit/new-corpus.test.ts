import { describe, it, expect } from "vitest";
import corpus from "../fixtures/new-corpus.json";
import { candidateNew } from "../../src/shared/freeform-plan.ts";
import { newWorld, newContext } from "../fixtures/new-world.ts";
import { mapAction } from "../../src/shared/map-actions.ts";
import { ScreenContext } from "../../src/shared/freeform.ts";

describe("New labelled corpus", () => {
  it("contains at least 150 independent labels covering the inventory", () => {
    expect(corpus.length).toBeGreaterThanOrEqual(150);
    expect(new Set(corpus.map((c) => c.item)).size).toBeGreaterThanOrEqual(70);
  });
  for (const row of corpus) it(`${row.id}: ${row.text}`, () => {
    const parsed = candidateNew(row.text, newWorld, ScreenContext.parse({ ...newContext, ...row.context }));
    expect(parsed).toMatchObject(row.expected);
    if (parsed.route === "deterministic") for (const a of parsed.actions) if (a.kind === "map") expect(() => mapAction(a.action).prepare(a.args)).not.toThrow();
  });
  it("uses screen targets for this and here, without a choice", () => {
    const context = { ...newContext, place: { kind: "group", id: "research", title: "Research" } as const, selected: { kind: "idea", id: "csv-export", title: "CSV export" } as const };
    expect(candidateNew("Move this idea to Core", newWorld, context)).toMatchObject({ route: "deterministic", actions: [{ action: "move-idea", args: { idea: "csv-export", to_group: "core" } }] });
    expect(candidateNew("Add a note here: check Friday", newWorld, context)).toMatchObject({ route: "deterministic", actions: [{ action: "note", args: { text: "check Friday", scope: "group:research" } }] });
  });
  it("does not choose between two same-name targets", () => {
    expect(candidateNew("Move CSV export to Core", { ...newWorld, ideas: [...newWorld.ideas, { ...newWorld.ideas[1], id: "csv-copy" }] }, newContext).route).toBe("agent");
  });
  it("keeps inferred batch suggestion triage on the agent route", () => {
    expect(candidateNew("Triage suggestions new-batch-a and new-batch-b together, accepting both", newWorld, newContext).route).toBe("agent");
    expect(candidateNew("Review proposals for duplication", newWorld, newContext).route).toBe("agent");
  });
  it("opens a selected worker before changing its tab and resolves a missing worker through an agent", () => {
    expect(candidateNew("Open terminal tab", newWorld, { ...newContext, selected: { kind: "worker", id: "local:docs", title: "Docs worker" } })).toMatchObject({ route: "deterministic", actions: [{ kind: "ui", command: { action: "navigate", path: "worker/local%3Adocs" } }, { kind: "ui", command: { action: "tab", tab: "terminal" } }] });
    expect(candidateNew("Open terminal tab", newWorld, newContext).route).toBe("agent");
  });
});


it("resolves an exact primary account name before a shared provider name", () => {
  const world = { ...newWorld, accounts: [
    { id: "claude-code", label: "Claude Code", provider: "claude" },
    { id: "codex", label: "Codex", provider: "codex" },
    { id: "codex-2", label: "Codex 2", provider: "codex" },
    { id: "cursor", label: "Cursor", provider: "cursor" },
  ] };
  for (const [name, account] of [["Codex", "codex"], ["Codex 2", "codex-2"], ["codex-2", "codex-2"]])
    expect(candidateNew(`Switch Firstmate to ${name}`, world, newContext)).toMatchObject({ route: "deterministic", actions: [{ kind: "intent", intent: "switch_firstmate", target: "firstmate", payload: { account } }] });
});
