// Notes the fleet files in Firstmate's captain inbox (bin/fm-inbox.sh note): durable, safe while
// Firstmate is mid-turn, and idempotent per request id, so a retry never adds a second note.
//   joined     one batched note when watched sessions first appear (never one per pane)
//   hand-back  when the captain hands a session's helm back: what they said while at the helm, and the
//              session's intent now, so "reconcile it at the next supervision review" has data behind it
import { createHash } from "node:crypto";
import type { FleetMember } from "./roster.ts";

export const JOINED_SHOWN = 30;

const goalOf = (m: Pick<FleetMember, "goal" | "title">) => (m.goal || m.title || "no goal yet").replace(/\s+/g, " ").slice(0, 140);
const place = (m: Pick<FleetMember, "cwd">) => m.cwd || "unknown folder";

export function joinedRequestId(keys: string[]): string {
  return `fleet-joined-${createHash("sha256").update([...keys].sort().join("\n")).digest("hex").slice(0, 24)}`;
}

export function joinedNote(members: FleetMember[], operatorDoc: string): string {
  const n = members.length;
  const lines = [
    `Joyride fleet: ${n} session${n === 1 ? "" : "s"} joined the fleet as watched. The captain started ${n === 1 ? "it" : "them"}: you supervise and guide, and never own ${n === 1 ? "its" : "their"} process, checkout or end of life.`,
    ...members.slice(0, JOINED_SHOWN).map((m) => `- ${m.worker} · ${place(m)} · ${m.state}${m.state === "blocked" || m.state === "needs-decision" || m.state === "failed" ? ` (${m.why.replace(/\s+/g, " ").slice(0, 120)})` : ""} · ${goalOf(m)}`),
  ];
  if (n > JOINED_SHOWN) lines.push(`- and ${n - JOINED_SHOWN} more: run \`joyride fleet\` for the full roster.`);
  lines.push(`See the roster with \`joyride fleet\`. Steer a watched session only with \`joyride steer <worker> "<text>"\`. How (and where joyride lives): ${operatorDoc}`);
  return lines.join("\n");
}

export type CaptainSaid = { at: string; text: string };

export function handBackNote(o: {
  member: Pick<FleetMember, "worker" | "title" | "cwd" | "tier" | "task">; since: string | null; said: CaptainSaid[];
  intention: { goal?: string; now?: string; next?: string } | null; operatorDoc: string;
}): string {
  const m = o.member;
  const owner = m.tier === "crew" ? `crew on ${m.task}` : "watched";
  const lines = [`Joyride fleet: the captain handed back the helm of ${m.worker}${m.title ? ` "${m.title.replace(/\s+/g, " ").slice(0, 80)}"` : ""} (${owner}, ${place(m)}).`];
  if (o.said.length) {
    lines.push(`While at the helm${o.since ? ` (since ${o.since})` : ""} the captain said:`);
    for (const s of o.said.slice(-8)) lines.push(`- ${s.text.replace(/\s+/g, " ").slice(0, 300)}`);
  } else lines.push("Joyride saw no message from the captain while they held the helm.");
  const i = o.intention;
  if (i && (i.goal || i.now || i.next)) lines.push(`Its intent now: goal: ${i.goal || "?"}; now: ${i.now || "?"}; next: ${i.next || "?"}.`);
  lines.push(m.tier === "crew"
    ? `Reconcile it at your next supervision review; steer it again with fm-send.sh ${m.task}.`
    : `Reconcile it at your next supervision review; steer it again only with \`joyride steer ${m.worker} "<text>"\`. How: ${o.operatorDoc}`);
  return lines.join("\n");
}
