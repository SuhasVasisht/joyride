import { describe, expect, it } from "vitest";
import { firstmateStatus } from "../../src/ui/lib/firstmate-status";

describe("Firstmate status display", () => {
  it.each([
    ["working", "Working", "working"],
    ["paused", "Waiting on its own run", "working"],
    ["blocked", "Blocked", "blocked"],
    ["needs-decision", "Needs your decision", "blocked"],
    ["done", "Done", "done"],
  ])("displays worker %s", (status, label, chip) => {
    expect(firstmateStatus(status)).toEqual({ label, chip, tone: chip, reason: "" });
  });
  it("keeps the self-wait reason without protocol metadata", () => {
    expect(firstmateStatus("paused", "paused [key=checks] [at=123]: e2e running; resumes when it exits")).toEqual({
      label: "Waiting on its own run", chip: "working", tone: "working", reason: "e2e running; resumes when it exits",
    });
  });
  it("keeps a captain-paused idea stopped", () => {
    expect(firstmateStatus("paused", "", "captain")).toEqual({ label: "Paused", chip: "idle", tone: "idle", reason: "" });
  });
});
