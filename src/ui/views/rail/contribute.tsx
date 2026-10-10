import type { Contribution } from "../../lib/registry";
import { api } from "../../lib/api";
import type { GuardRequest } from "../../lib/types";
import { ApprovalsTray, decideGuard } from "./Approvals";
import { Digest, NeedsYou, Review } from "./Attention";
import "./rail.css";

export default function contribute(): Contribution {
  return {
    rail: [
      { id: "approvals", order: 10, component: ApprovalsTray },
      { id: "attention", order: 20, component: NeedsYou },
      { id: "review", order: 30, component: Review },
      { id: "digest", order: 40, component: Digest },
    ],
    commands: async () => {
      let pending: GuardRequest[] = [];
      try { pending = await api<GuardRequest[]>("/api/guard/pending"); } catch { return []; }
      return pending.flatMap((r) => [
        { id: `guard-allow:${r.id}`, title: `Allow: ${r.title}`, hint: r.summary.slice(0, 48), group: "Approvals", keywords: `approve allow guard ${r.rule} ${r.summary}`, run: () => decideGuard(r.id, "allow").then(() => undefined) },
        { id: `guard-deny:${r.id}`, title: `Deny: ${r.title}`, hint: r.summary.slice(0, 48), group: "Approvals", keywords: `deny reject guard ${r.rule} ${r.summary}`, run: () => decideGuard(r.id, "deny").then(() => undefined) },
      ]);
    },
  };
}
