const STOP = new Set("a an the and or but if then else of to in on at by for with from as is are was were be been being it its this that these those there here we you they i he she them our your their not no do does did done can could should would will may might must have has had into over under about than so such via per use used using when where which who what why how all any each more most other some only also just very too out up down off again further once both few own same s t don".split(" "));
export function tokens(s: string): string[] {
  const out: string[] = [];
  for (let w of (s ?? "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 2 || STOP.has(w)) continue;
    if (w.length > 4 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
    out.push(w);
  }
  return out;
}

/** Rank fusion keeps scores from different indexes on the same scale. */
export function reciprocalRankFusion(lists: string[][], k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) for (const [i, key] of [...new Set(list)].entries()) {
    scores.set(key, (scores.get(key) ?? 0) + 1 / (k + i + 1));
  }
  return scores;
}

export function rankText(docs: { key: string; title: string; text: string }[], query: string): string[] {
  const words = [...new Set(tokens(query))];
  if (!words.length) return [];
  const pool = docs.map((d) => ({ ...d, words: [...tokens(d.title), ...tokens(d.title), ...tokens(d.text)] }));
  const avg = pool.reduce((s, d) => s + d.words.length, 0) / (pool.length || 1) || 1;
  const df = new Map(words.map((w) => [w, pool.filter((d) => d.words.includes(w)).length]));
  return pool.map((d) => {
    let score = 0;
    for (const w of words) {
      const count = d.words.filter((t) => t === w).length;
      if (count) score += Math.log(1 + (pool.length - (df.get(w) ?? 0) + 0.5) / ((df.get(w) ?? 0) + 0.5))
        * count * 2.2 / (count + 1.2 * (0.25 + 0.75 * d.words.length / avg));
    }
    return { key: d.key, score };
  }).filter((d) => d.score > 0).sort((a, b) => b.score - a.score || a.key.localeCompare(b.key)).map((d) => d.key);
}
