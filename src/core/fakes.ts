// Deterministic stand-ins for Jev and the heavy LLM, enabled with
// JOYRIDE_FAKE_MODELS=1 (unit + e2e tests). Modules may register task-specific
// fakes with registerLlmFake(task, fn) so tests exercise realistic shapes.
import type { JevQuestion, JevResult } from "./jev.ts";
import { z } from "zod";

export const fakeModels = () => process.env.JOYRIDE_FAKE_MODELS === "1";

const words = (s: unknown) => new Set(JSON.stringify(s ?? "").toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? []);
const URGENT = /\?|blocked|permission|approve|which (one|option)|should i|decide|waiting for|need(s)? your|error|failed|crash/i;

export function fakeJev(state: unknown, questions: Record<string, JevQuestion>): JevResult {
  const text = JSON.stringify(state ?? "");
  const sw = words(state);
  const answers: JevResult["answers"] = {};
  for (const [id, q] of Object.entries(questions)) {
    if (id === "new_route") {
      const s = z.object({ candidate: z.object({ route: z.enum(["deterministic", "firstmate", "agent"]) }) }).parse(state);
      const choice = s.candidate.route;
      answers[id] = { type: "choice", choice, probabilities: { deterministic: choice === "deterministic" ? 1 : 0, firstmate: choice === "firstmate" ? 1 : 0, agent: choice === "agent" ? 1 : 0 }, confidence: 1 };
      continue;
    }
    if (q.type === "noul") {
      let p = URGENT.test(text) ? 0.82 : 0.18;
      // Lets hill-climb tests see a judge improve: once the instructions say optional offers
      // don't count, a finished report that merely offers more work stops counting as blocked.
      if (/optional offer/i.test(q.instructions) && /(want me to also|would you like|let me know|anything else|should i also)/i.test(text) && !/(which (one|do you)|can you (either|confirm)|do you want me to (cancel|resume|delete)|what'?s the|password)/i.test(text)) p = 0.2;
      answers[id] = { type: "noul", noul: p };
    } else if (q.type === "choice") {
      const opts = Object.entries(q.criteria);
      let best = opts[0]?.[0] ?? "";
      let bestScore = -1;
      for (const [k, desc] of opts) {
        const ow = words(`${k} ${desc ?? ""}`);
        let s = 0; for (const w of ow) if (sw.has(w)) s++;
        if (URGENT.test(text) && /L3|block|question|decision|approval/i.test(`${k} ${desc}`)) s += 3;
        if (s > bestScore) { bestScore = s; best = k; }
      }
      const probabilities = Object.fromEntries(opts.map(([k]) => [k, k === best ? 0.7 : 0.3 / Math.max(1, opts.length - 1)]));
      answers[id] = { type: "choice", choice: best, probabilities, confidence: 0.7 };
    } else {
      const levels = q.criteria;
      const mid = Math.floor(levels.length / 2);
      answers[id] = { type: "score", score: mid, confidence: 0.6, probabilities: Object.fromEntries(levels.map((l, i) => [l, i === mid ? 0.6 : 0.4 / Math.max(1, levels.length - 1)])) };
    }
  }
  return { answers, usage: { input_tokens: text.length / 4 }, model: "jev-fake", ms: 1 };
}

type LlmFake = (prompt: string, schema?: any) => any;
const llmFakes = new Map<string, LlmFake>();
export function registerLlmFake(task: string, fn: LlmFake) { llmFakes.set(task, fn); }

function fromSchema(schema: any, key = "value"): any {
  if (!schema) return `fake ${key}`;
  if (schema.enum) return schema.enum[0];
  switch (schema.type) {
    case "object": return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([k, v]) => [k, fromSchema(v, k)]));
    case "array": return schema.items ? [fromSchema(schema.items, key)] : [];
    case "number": case "integer": return 0.5;
    case "boolean": return false;
    default: return `fake ${key}`;
  }
}
export function fakeLlm(prompt: string, opts: { task?: string; schema?: any }) {
  const f = opts.task ? llmFakes.get(opts.task) : undefined;
  if (f) return f(prompt, opts.schema);
  return opts.schema ? fromSchema(opts.schema) : `fake response (${prompt.slice(0, 40)})`;
}
