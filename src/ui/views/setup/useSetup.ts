// The setup checklist from GET /api/system/setup, shared by the setup page, the guide's
// first step and the rail card.
import { useApi } from "../../lib/api";

export type SetupStatus = "ok" | "missing" | "warn" | "unknown";
export type SetupFix = { kind: "button" | "command" | "link"; label: string; action?: string; command?: string; href?: string; disabled?: string; ack?: boolean };
export type SetupItem = { id: string; title: string; group: "required" | "optional"; status: SetupStatus; detail: string; fix: SetupFix | null; needs_you?: boolean };
export type SetupReport = {
  items: SetupItem[];
  summary: { required: { done: number; total: number }; optional: { done: number; total: number }; done: number; total: number; blocking: number };
  land: boolean;
  at: string;
};

export function useSetup(opts: { pollMs?: number } = {}) {
  return useApi<SetupReport>("/api/system/setup", ["setup"], opts);
}

/** "3 required steps left" style summary for cards. */
export function setupLine(r: SetupReport | null): string {
  if (!r) return "";
  const { required, blocking } = r.summary;
  if (!blocking) return `All ${required.total} required steps are in place.`;
  return `${required.done} of ${required.total} required steps done. ${blocking} still missing.`;
}
