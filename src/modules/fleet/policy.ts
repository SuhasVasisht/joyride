// The fleet policy: fleet.yaml in the data root, authored by the captain and committed on every change.
//   membership: all | opt-in   all: every live session joins the fleet unless excluded; opt-in: only `included`
//   excluded: [...]            what the captain keeps to themself (watched sessions only; crew is Firstmate's)
//   included: [...]            under opt-in, what the captain handed to Firstmate
//   authority: [...]           what Firstmate may do to a watched session through Joyride: steer, answer_prompt, retire_worker
// An entry is a session key (claude:<id>), a worker id (local:w1:p2) or an absolute folder (every session under it).
// A missing file is the default policy. An unreadable or malformed one fails closed (closedPolicy):
// Firstmate gets no authority, and membership can't change until the captain fixes the file.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { isUnder } from "../live/common.ts";

export const FLEET_ACTIONS = ["steer", "answer_prompt", "retire_worker"] as const;
export type FleetAction = (typeof FLEET_ACTIONS)[number];

export const FleetPolicy = z.object({
  membership: z.enum(["all", "opt-in"]).default("all"),
  excluded: z.array(z.string().min(1)).default([]),
  included: z.array(z.string().min(1)).default([]),
  pruning: z.object({
    idle_hours: z.number().positive().default(72),
    proposal_days: z.number().positive().default(14),
    archive_days: z.number().positive().default(30),
  }).default({ idle_hours: 72, proposal_days: 14, archive_days: 30 }),
  authority: z.array(z.enum(FLEET_ACTIONS)).default([...FLEET_ACTIONS]),
});
export type FleetPolicy = z.infer<typeof FleetPolicy>;
export const DEFAULT_POLICY: FleetPolicy = FleetPolicy.parse({});
const CLOSED = "Until it is fixed, Firstmate may not steer or answer any watched session, or retire its pane, and no session joins or leaves the fleet.";

/**
 * What applies while fleet.yaml is broken: no authority for Firstmate, and the last good membership
 * (or, with none, every session kept out), so a typo never hands Firstmate a session the captain kept.
 */
export function closedPolicy(lastGood: FleetPolicy | null): FleetPolicy {
  return lastGood ? { ...lastGood, authority: [] } : { ...DEFAULT_POLICY, membership: "opt-in", authority: [] };
}

const HEADER = `# Fleet policy (docs/fleet-operator.md). Joyride commits every change.
# membership: all (every live session joins the fleet; excluded ones stay yours) or opt-in (only included ones join).
# Entries are session keys (claude:<id>), worker ids (local:w1:p2) or absolute folders.
# authority: what Firstmate may do to a watched session through Joyride (steer, answer_prompt, retire_worker).
`;

export function parsePolicy(text: string | null): { policy: FleetPolicy; error: string | null } {
  if (text == null || !text.trim()) return { policy: DEFAULT_POLICY, error: null };
  try {
    const r = FleetPolicy.safeParse(YAML.parse(text) ?? {});
    if (r.success) return { policy: r.data, error: null };
    const issue = r.error.issues[0];
    return { policy: closedPolicy(null), error: `fleet.yaml: ${issue.path.join(".") || "file"}: ${issue.message}. ${CLOSED}` };
  } catch (e: any) {
    return { policy: closedPolicy(null), error: `fleet.yaml is not valid YAML (${String(e.message).split("\n")[0]}). ${CLOSED}` };
  }
}

export const renderPolicy = (p: FleetPolicy) => HEADER + YAML.stringify(p);

export function readPolicy(file: string): { policy: FleetPolicy; error: string | null } {
  let text: string | null = null;
  try { text = fs.readFileSync(file, "utf8"); } catch (e: any) { if (e.code !== "ENOENT") return { policy: closedPolicy(null), error: `Can't read ${file}: ${e.message}. ${CLOSED}` }; }
  return parsePolicy(text);
}

type Member = { id: string; session: string | null; cwd: string };

/** The entry in `list` that names this worker: its session key, its worker id, or a folder it runs under. */
export function entryFor(list: string[], w: Member): string | null {
  for (const e of list) {
    if (e === w.id || (w.session && e === w.session)) return e;
    if (path.isAbsolute(e) && w.cwd && isUnder(w.cwd, e)) return e;
  }
  return null;
}

/** Whether a session the captain started stays out of the fleet. */
export function isExcluded(p: FleetPolicy, w: Member): boolean {
  if (entryFor(p.excluded, w)) return true;
  return p.membership === "opt-in" && !entryFor(p.included, w);
}

/**
 * The policy after excluding (or including back) one target. Returns null when nothing changes. A live
 * session is kept out by its session key and its worker id both, so /clear or a resume that starts a
 * new session in the same pane stays the captain's.
 */
export function withMembership(p: FleetPolicy, target: string, w: Member | null, keep: "exclude" | "include"): FleetPolicy | null {
  const key = w ? (w.session ?? w.id) : target;
  const keys = w ? [...new Set([w.session, w.id].filter((k): k is string => Boolean(k)))] : [target];
  // Only entries that name this target exactly: including one session never drops a folder entry.
  const names = (e: string) => e === target || (w != null && (e === w.id || e === w.session));
  if (keep === "exclude") {
    if (w ? isExcluded(p, w) : p.excluded.includes(key)) return null;
    return { ...p, excluded: [...p.excluded, ...keys.filter((k) => !p.excluded.includes(k))], included: p.included.filter((e) => !names(e)) };
  }
  const excluded = p.excluded.filter((e) => !names(e));
  const included = p.membership === "opt-in" && !(w ? entryFor(p.included, w) : p.included.includes(key)) ? [...p.included, key] : p.included;
  if (excluded.length === p.excluded.length && included.length === p.included.length) return null;
  return { ...p, excluded, included };
}
