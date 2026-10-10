// Which lens a mission is charted under. Explicit membership (the mission's own `lenses`, then a
// lens's `missions` list) wins over a lens rule, so a move on the map always lands where it was dropped.
type LensLike = { id: string; missions: string[]; rule?: { repo?: string; text?: string } };
type MissionLike = { id: string; title: string; goal: string; repos: string[]; lenses: string[] };

const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

/** The lens claims the mission by naming it, from either side. */
export const lensNames = (l: LensLike, m: MissionLike) => m.lenses.includes(l.id) || l.missions.includes(m.id);

/** The lens claims the mission by its repo or text rule. */
export const lensRule = (l: LensLike, m: MissionLike) =>
  (!!l.rule?.repo && m.repos.some((r) => r === l.rule!.repo || base(r) === l.rule!.repo)) ||
  (!!l.rule?.text && `${m.title} ${m.goal}`.toLowerCase().includes(l.rule.text.toLowerCase()));

export const lensMatch = (l: LensLike, m: MissionLike) => lensNames(l, m) || lensRule(l, m);

/** The mission's lens on the map: its first own lens, else a lens that lists it, else the first rule match. */
export function primaryLens<L extends LensLike>(m: MissionLike, lenses: L[]): L | undefined {
  for (const id of m.lenses) { const l = lenses.find((x) => x.id === id); if (l) return l; }
  return lenses.find((l) => l.missions.includes(m.id)) ?? lenses.find((l) => lensRule(l, m));
}
