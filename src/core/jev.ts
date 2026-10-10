// TypeSafe System One (Jev) client: typed judgments and probabilities.
// Contract verified against jev-1.13.0.
import { loadConfig, loadEnv } from "./config.ts";
import { fakeModels, fakeJev } from "./fakes.ts";

export type JevQuestion =
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: string[] };

export type JevAnswer = { type: string; noul?: number; choice?: string; probabilities?: Record<string, number>; confidence?: number; score?: number };
export type JevResult = { answers: Record<string, JevAnswer>; usage: { input_tokens?: number; output_tokens?: number }; model: string; ms: number };

export const q = {
  noul: (instructions: string, t?: string, f?: string): JevQuestion => (t || f ? { type: "noul", instructions, criteria: { true: t ?? "", false: f ?? "" } } : { type: "noul", instructions }),
  choice: (instructions: string, criteria: Record<string, string | null>): JevQuestion => ({ type: "choice", instructions, criteria }),
  score: (instructions: string, levels: string[]): JevQuestion => ({ type: "score", instructions, criteria: levels }),
};

export class JevError extends Error {}

let stats = { calls: 0, input_tokens: 0, ms: 0, errors: 0 };
export const jevStats = () => ({ ...stats });

export function jevAvailable() { loadEnv(); return fakeModels() || Boolean(process.env.JEV_API_KEY); }

/** One request, many questions (parallel server-side, independent). Retries 429/529. */
export async function jev(state: unknown, questions: Record<string, JevQuestion>, opts: { timeoutMs?: number; retries?: number; model?: string } = {}): Promise<JevResult> {
  if (fakeModels()) { stats.calls++; return fakeJev(state, questions); }
  loadEnv();
  const key = process.env.JEV_API_KEY;
  if (!key) throw new JevError("JEV_API_KEY is not set");
  const cfg = loadConfig();
  const body = JSON.stringify({ state, model: opts.model ?? cfg.jev.model, questions });
  const retries = opts.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    const t0 = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 30000);
    try {
      const r = await fetch(`${cfg.jev.base_url}/v1/systemone`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body, signal: ac.signal });
      if ((r.status === 429 || r.status === 529) && attempt < retries) { await new Promise((s) => setTimeout(s, 500 * 2 ** attempt)); continue; }
      if (!r.ok) throw new JevError(`HTTP ${r.status}: ${(await r.text()).slice(0, 400)}`);
      const p: any = await r.json();
      const ms = Date.now() - t0;
      stats.calls++; stats.ms += ms; stats.input_tokens += p.usage?.input_tokens ?? 0;
      return { answers: p.answers ?? {}, usage: p.usage ?? {}, model: p.model ?? cfg.jev.model, ms };
    } catch (e: any) {
      if (attempt < retries && (e.name === "AbortError" || /fetch failed/.test(e.message))) continue;
      stats.errors++;
      throw e instanceof JevError ? e : new JevError(e.message);
    } finally { clearTimeout(timer); }
  }
}

export const pick = (r: JevResult, id: string) => r.answers[id]?.choice ?? null;
export const yes = (r: JevResult, id: string) => r.answers[id]?.noul ?? null;
export const probs = (r: JevResult, id: string) => r.answers[id]?.probabilities ?? {};
