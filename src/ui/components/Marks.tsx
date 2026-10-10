// Chart symbols. Mission health is a light (buoy) mark; workers are vessel marks.
// Shape and fill differ per state so colour is never the only cue.

export function HealthMark({ health, size = 14 }: { health: string; size?: number }) {
  const label = { active: "Active", blocked: "Blocked", "needs-review": "Needs review", idle: "Idle" }[health] ?? health;
  return (
    <svg className={`mark health-mark h-${health}`} width={size} height={size} viewBox="0 0 16 16" role="img" aria-label={label}>
      {health === "blocked" ? (
        <>
          <circle cx="8" cy="8" r="7" fill="none" stroke="var(--signal)" strokeWidth="1.5" />
          <circle cx="8" cy="8" r="4" fill="var(--signal)" />
        </>
      ) : health === "needs-review" ? (
        <path d="M8 1.8 L14.2 8 L8 14.2 L1.8 8 Z" fill="var(--review)" />
      ) : health === "active" ? (
        <circle cx="8" cy="8" r="5.5" fill="var(--working)" />
      ) : (
        <circle cx="8" cy="8" r="5" fill="none" stroke="var(--idle)" strokeWidth="1.6" />
      )}
    </svg>
  );
}

const VESSEL_FILL: Record<string, string> = { working: "var(--working)", blocked: "var(--signal)", done: "var(--review)" };

/** A small vessel: a pointed hull. Idle/unknown vessels are drawn hollow. */
export function VesselMark({ status, size = 12, agent }: { status: string; size?: number; agent?: string }) {
  const fill = VESSEL_FILL[status];
  const label = `${agent ? agent + " " : ""}${status}`;
  return (
    <svg className={`mark vessel-mark v-${status}`} width={size} height={size} viewBox="0 0 16 16" role="img" aria-label={label}>
      <path d="M2 4.5 H10.5 L14.5 8 L10.5 11.5 H2 Z" fill={fill ?? "var(--paper-raised)"} stroke={fill ?? "var(--idle)"} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}
