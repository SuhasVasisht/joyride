// The ghost card's model (CP5): what each target sends, how the card names it, and the receipts stepper.
import { describe, it, expect } from "vitest";
import { intentFor, steps, targetKey, targetLabel, type Progress } from "../../src/ui/components/compose/ghost.ts";

const progress = (stage: Progress["stage"], extra: Partial<Progress> = {}): Progress => ({ stage, note: null, reply: null, task: null, unread_too_long: false, firstmate_running: false, ...extra });

describe("ghost card", () => {
  it("sends a task target as a steer, an idea as a task request, and new as a new idea", () => {
    expect(intentFor({ kind: "task", id: "jr-a", title: "A", idea: null, p: 0.9 }, "more")).toEqual({ kind: "steer_task", target: "jr-a", payload: { text: "more" } });
    expect(intentFor({ kind: "idea", id: "one-fleet", title: "One fleet", p: 1 }, "do x")).toEqual({ kind: "create_task", target: "one-fleet", payload: { brief: "do x" } });
    expect(intentFor({ kind: "new", title: null, p: 0.8 }, "do y")).toEqual({ kind: "create_task", target: "new", payload: { brief: "do y" } });
  });

  it("names where it goes", () => {
    expect(targetLabel({ kind: "task", id: "jr-a", title: "Fix export", idea: null, p: 0 })).toEqual({ verb: "More work for", name: "Fix export" });
    expect(targetLabel({ kind: "idea", id: "i", title: "One fleet", p: 0 })).toEqual({ verb: "Adding to", name: "One fleet" });
    expect(targetLabel({ kind: "new", title: null, p: 0 }, { title: "Nightly backups" })).toEqual({ verb: "Starting a new idea", name: "Nightly backups" });
    expect(targetKey({ kind: "new", title: null, p: 0 })).toBe("new");
    expect(targetKey({ kind: "idea", id: "i", title: "", p: 0 })).toBe("idea:i");
  });

  it("walks Sent · Read · Became task from the receipts", () => {
    const states = (p?: Progress) => steps(p).map((s) => `${s.label}:${s.state}`);
    expect(states(undefined)).toEqual(["Sent:current", "Read:todo", "Became task:todo"]);
    expect(states(progress("sent"))).toEqual(["Sent:done", "Read:current", "Became task:todo"]);
    expect(states(progress("read"))).toEqual(["Sent:done", "Read:done", "Became task:current"]);
    expect(states(progress("replied"))).toEqual(["Sent:done", "Replied:done", "Became task:current"]);
    expect(states(progress("task", { task: { id: "jr-x", title: "X", mission: "m", status: "working" } }))).toEqual(["Sent:done", "Read:done", "Task jr-x:done"]);
  });
});
