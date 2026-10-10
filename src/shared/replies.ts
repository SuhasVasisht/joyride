// Match Joyride replies to transcript turns, sharing pickup and image recovery rules.
export const normText = (s: string) => s.replace(/\[Image(?:\s*#\d+)?\]/gi, " ").replace(/\s+/g, " ").trim();
export const imageMarkers = (s: string) => (s.match(/\[Image\s*#\d+\]/gi) ?? []).length;

type Reply = { id: string; text: string; images: string[]; created: string };
type Turn = { role: string; ts: string | null; text: string; images?: string[] };

/** Each reply claims its own text and image slots, including image-only and joined replies. */
export function matchReplies(replies: Reply[], turns: Turn[]) {
  const users = turns.flatMap((t, turn) => t.role === "user" ? [{
    turn, at: t.ts ? Date.parse(t.ts) : NaN, rest: normText(t.text),
    images: Math.max(t.images?.length ?? 0, imageMarkers(t.text)), offset: 0, paths: t.images ?? [],
  }] : []);
  const matches: { id: string; turn: number; offset: number; images: string[] }[] = [];
  for (const r of [...replies].sort((a, b) => a.created.localeCompare(b.created))) {
    const want = normText(r.text).slice(0, 1000), count = r.images.length;
    const hit = users.find((u) => (Number.isNaN(u.at) || u.at >= Date.parse(r.created) - 5000)
      && (want ? u.rest.includes(want) : count > 0)
      && u.images >= count
      && r.images.every((p, i) => !u.paths[u.offset + i] || u.paths[u.offset + i] === p));
    if (!hit) continue;
    matches.push({ id: r.id, turn: hit.turn, offset: hit.offset, images: r.images });
    if (want) hit.rest = hit.rest.replace(want, " ");
    hit.images -= count;
    hit.offset += count;
  }
  return matches;
}
