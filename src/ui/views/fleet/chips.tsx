// Ownership is shown, not grouped: every session card carries an owner chip (crew or watched) and a
// helm chip (who is steering it right now). Display only; neither chip changes who steers.
import type { WorkerView } from "../../lib/types";
import "./fleet.css";

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export function ownerText(w: Pick<WorkerView, "owner" | "crew">): { label: string; title: string } {
  const tier = w.owner?.tier ?? "watched";
  if (tier === "crew") {
    const task = w.owner?.task ?? w.crew;
    return { label: "Crew", title: `Firstmate crew${task ? ` on task ${task}` : ""}. Firstmate launched it and owns its lifecycle.` };
  }
  if (tier === "control") return { label: "Firstmate", title: "Firstmate's own control pane." };
  if (tier === "excluded") return { label: "Yours only", title: "You keep this session to yourself: it is out of the fleet, so Firstmate does not steer it or answer its prompts. Include it again from the fleet page." };
  return { label: "Watched", title: "You started this session. Firstmate watches it with the rest of the fleet; it did not launch it and does not own its checkout." };
}

export function helmText(h: WorkerView["helm"]): { label: string; title: string } | null {
  if (!h) return null;
  if (h.by === "firstmate") return { label: "Helm: Firstmate", title: "Firstmate is at the helm. When you steer this session yourself, you take the helm until its turn ends plus 15 quiet minutes." };
  const how = h.via === "joyride-reply" ? "from Joyride" : h.via === "joyride-terminal" ? "in Joyride's terminal" : "in its pane";
  const when = h.until ? `until ${clock(h.until)}, 15 quiet minutes after its turn ended` : "until its turn ends, plus 15 quiet minutes";
  return { label: "Helm: you", title: `You steered it ${how}${h.since ? ` at ${clock(h.since)}` : ""}, so you hold the helm ${when}.` };
}

/** `task` shows a crewmate's task id in the chip; it is always in the tooltip. */
export function OwnerChip({ w, compact = false, task: showTask = !compact }: { w: Pick<WorkerView, "owner" | "crew">; compact?: boolean; task?: boolean }) {
  const tier = w.owner?.tier ?? "watched";
  const t = ownerText(w);
  const task = tier === "crew" ? w.owner?.task ?? w.crew : null;
  return (
    <span className={`fleet-chip owner t-${tier}${compact ? " compact" : ""}`} data-owner={tier} title={t.title}>
      {t.label}{task && showTask ? <span className="fc-task">{task}</span> : null}
    </span>
  );
}

export function HelmChip({ w, compact = false }: { w: Pick<WorkerView, "helm">; compact?: boolean }) {
  const t = helmText(w.helm);
  if (!t) return null;
  const by = w.helm!.by;
  if (compact && by !== "captain") return null;
  return <span className={`fleet-chip helm by-${by}${compact ? " compact" : ""}`} data-helm={by} title={t.title}>{compact ? "Your helm" : t.label}</span>;
}

/**
 * Both chips, as one row. `compact` (far zoom, quiet lists) shows only what differs from the default:
 * a crew owner, and the helm when it is yours.
 */
export function FleetChips({ w, compact = false, task = !compact, className = "" }: { w: Pick<WorkerView, "owner" | "crew" | "helm">; compact?: boolean; task?: boolean; className?: string }) {
  const watched = (w.owner?.tier ?? "watched") === "watched";
  return (
    <span className={`fleet-chips${compact ? " compact" : ""} ${className}`.trim()}>
      {compact && watched ? null : <OwnerChip w={w} compact={compact} task={task} />}
      <HelmChip w={w} compact={compact} />
    </span>
  );
}
