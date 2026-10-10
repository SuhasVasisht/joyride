// An idea's generated headline, now and next (idea_brief), for the map's idea islands and the idea page.
// The text morphs in place when a new brief lands; a stale brief stays visible, marked "updating".
import { useIdeaBrief, type IdeaBrief as Brief } from "./api";
import { Pulse } from "./motion";
import "./nudges.css";

export function IdeaBriefView({ brief, compact }: { brief: Brief | null | undefined; compact?: boolean }) {
  if (!brief || (!brief.headline && brief.status === "pending")) return <p className="nd-brief pending meta" aria-busy="true">Writing a summary…</p>;
  if (!brief.headline) return null;
  return (
    <Pulse value={[brief.headline, brief.now, brief.next]} className={`nd-brief${compact ? " compact" : ""}`}>
      <p className="nd-brief-head" data-brief-headline>{brief.headline}{brief.status === "stale" ? <span className="nd-brief-tag"> · updating</span> : null}</p>
      {compact ? null : (
        <dl className="nd-brief-lines">
          <dt>Now</dt><dd>{brief.now}</dd>
          <dt>Next</dt><dd>{brief.next}</dd>
        </dl>
      )}
    </Pulse>
  );
}

export function IdeaBrief({ idea, compact }: { idea: string; compact?: boolean }) {
  const { data } = useIdeaBrief(idea);
  return <IdeaBriefView brief={data} compact={compact} />;
}
