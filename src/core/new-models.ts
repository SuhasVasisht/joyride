import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DEFAULT_ACCOUNTS, resolveAccounts, type Account } from "./accounts.ts";
import { paths } from "../shared/paths.ts";
import type { Config, LlmBackend } from "../shared/schema.ts";

const Catalog = z.object({ models: z.array(z.object({ slug: z.string(), supported_reasoning_levels: z.array(z.object({ effort: z.string() })).default([]) })) });
const fallback = ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-astra", "gpt-5.6-luna", "gpt-5.6-sol"];
export function newModelCatalog(account: Account) {
  if (account.provider === "claude") return { source: "Claude CLI aliases", models: ["haiku", "sonnet", "opus"].map(model => ({ model, efforts: ["low", "medium", "high", "max"] })) };
  const file = path.join(account.home ?? paths.codexDir, "models_cache.json");
  try {
    const catalog = Catalog.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    return { source: file, models: catalog.models.map(m => ({ model: m.slug, efforts: m.supported_reasoning_levels.map(e => e.effort) })) };
  } catch {
    return { source: "Joyride defaults (Codex catalog unavailable)", models: fallback.map(model => ({ model, efforts: ["low", "medium", "high", "xhigh", "max"] })) };
  }
}
export function newModelAccount(choice: LlmBackend, cfg: Config): Account {
  const accounts = resolveAccounts(cfg.usage.accounts?.length ? cfg.usage.accounts : DEFAULT_ACCOUNTS);
  const account = choice.account ? accounts.find(a => a.id === choice.account) : accounts.find(a => a.provider === choice.backend);
  if (!account) throw new Error(`Choose a configured ${choice.backend} account in Settings. Account "${choice.account ?? choice.backend}" is not in usage.accounts.`);
  if (account.provider !== choice.backend) throw new Error(`Account "${account.id}" runs ${account.provider}, but this role uses ${choice.backend}. Choose a ${choice.backend} account.`);
  if (!choice.model.trim()) throw new Error("Choose a model for this role in Settings.");
  const catalog = newModelCatalog(account);
  const model = catalog.models.find(m => m.model === choice.model);
  if (!model && !(choice.backend === "claude" && /^claude-(?:haiku|sonnet|opus)-[\w.-]+$/.test(choice.model))) throw new Error(`Model "${choice.model}" is not supported by ${account.label}. Choose one of: ${catalog.models.map(m => m.model).join(", ")}. Catalog: ${catalog.source}.`);
  if (choice.effort && !(model?.efforts ?? ["low", "medium", "high", "max"]).includes(choice.effort)) throw new Error(`Model "${choice.model}" does not support ${choice.effort} effort. Choose ${model?.efforts.join(", ") || "the CLI default"}.`);
  return account;
}
export function badNewModels(cfg: Config): string | null {
  for (const [role, choice] of Object.entries(cfg.new_models)) {
    if (choice.backend === "jev") continue;
    try { newModelAccount(choice, cfg); } catch (e) { return `new_models.${role}: ${e instanceof Error ? e.message : String(e)}`; }
  }
  return null;
}
export function newModelArgs(choice: LlmBackend, permission: Config["workers"]["permission_mode"]): string[] {
  if (choice.backend === "codex") return ["-m", choice.model, "-s", permission === "bypassPermissions" ? "danger-full-access" : permission === "plan" ? "read-only" : "workspace-write", "-a", permission === "manual" || permission === "plan" ? "on-request" : "never", ...(choice.effort ? ["-c", `model_reasoning_effort=${choice.effort}`] : [])];
  return ["--model", choice.model, ...(choice.effort ? ["--effort", choice.effort] : [])];
}
