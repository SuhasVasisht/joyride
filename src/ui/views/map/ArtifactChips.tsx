// Linked artifacts as chips on the chart: each one opens the artifact in Joyride. Every kind
// renders; a kind the map has no glyph for gets the generic one and its name as the label.
import { href } from "../../lib/router";
import { KIND_LABEL } from "../artifacts/ArtifactsPage";
import type { MapArtifact } from "./world";

const GLYPH: Record<string, string> = { "claude-artifact": "◈", chatgpt: "◐", pr: "⌥", report: "▤", file: "▤", other: "↗" };
const kindLabel = (k: string) => KIND_LABEL[k] ?? (k.charAt(0).toUpperCase() + k.slice(1)).replace(/[-_]+/g, " ");

export function ArtifactChips({ list, max = 3, compact = false, more }: { list: MapArtifact[] | undefined; max?: number; compact?: boolean; more?: string }) {
  if (!list?.length) return null;
  const shown = list.slice(0, max);
  return (
    <span className={`art-chips${compact ? " compact" : ""}`} aria-label={`${list.length} linked artifact${list.length === 1 ? "" : "s"}`}>
      {shown.map((a) => (
        <a key={a.id} className={`art-chip art-kind-${a.kind}`} href={href(`artifacts/${encodeURIComponent(a.id)}`)} data-artifact={a.id}
          title={`${kindLabel(a.kind)}: ${a.title}`} aria-label={`Open artifact ${a.title}`} draggable={false}>
          <span className="ac-glyph" aria-hidden>{GLYPH[a.kind] ?? "◇"}</span>
          {compact ? null : <span className="ac-title">{a.title}</span>}
        </a>
      ))}
      {list.length > shown.length ? (
        more ? <a className="art-chip more" href={more} title="See every linked artifact" draggable={false}>+{list.length - shown.length}</a>
          : <span className="art-chip more">+{list.length - shown.length}</span>
      ) : null}
    </span>
  );
}
