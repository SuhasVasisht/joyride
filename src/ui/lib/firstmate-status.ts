/** Firstmate worker waits remain active; captain-authored pauses are stops. */
export function firstmateStatus(status: string, line = "", source: "worker" | "captain" = "worker") {
  const reason = line.replace(/^[a-z-]+(?:\s*\[[^\]]*\])*:\s*/i, "").trim();
  const statuses: Record<string, { chip: string; label: string }> = {
    working: { chip: "working", label: "Working" }, starting: { chip: "working", label: "Starting" },
    "needs-decision": { chip: "blocked", label: "Needs your decision" }, blocked: { chip: "blocked", label: "Blocked" },
    held: { chip: "blocked", label: "Waiting on you" },
    paused: source === "captain" ? { chip: "idle", label: "Paused" } : { chip: "working", label: "Waiting on its own run" },
    waiting: { chip: "idle", label: "Waiting on another task" }, queued: { chip: "idle", label: "Queued" },
    done: { chip: "done", label: "Done" }, merged: { chip: "done", label: "Merged" }, reported: { chip: "done", label: "Reported" },
    failed: { chip: "fail", label: "Failed" }, resolved: { chip: "done", label: "Decision closed" },
  };
  const display = statuses[status] ?? { chip: "unknown", label: status ? status[0].toUpperCase() + status.slice(1) : "Unknown" };
  return { ...display, tone: display.chip, reason };
}
