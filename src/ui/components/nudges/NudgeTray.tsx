// The nudge tray: every visible nudge, answered in place, newest moment first after the most urgent.
// Rate limits live in the daemon (at most one per card, at most five at L1); what they hold back is
// counted and listed in Knowledge › To review. The tray also hosts the Tidied toasts, so they work on
// every page while the rail is open; the map can mount <TidiedToasts> itself.
import { useEffect, useState } from "react";
import { href } from "../../lib/router";
import { useNudges } from "./api";
import { NudgeCard } from "./NudgeCard";
import { TidiedToasts } from "./Toasts";
import "./nudges.css";

export function NudgeTray() {
  const { data, error } = useNudges();
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => { if (!flash) return; const t = setTimeout(() => setFlash(null), 4000); return () => clearTimeout(t); }, [flash]);
  const list = data?.nudges ?? [];
  const over = data?.counts.overflow ?? 0;
  return (
    <section className={`rail-sec nudge-tray${list.length ? " has-items" : ""}`} data-rail="nudges" aria-labelledby="rail-nudges">
      <h3 id="rail-nudges">Nudges {list.length ? <span className="count">{list.length}</span> : null}</h3>
      {error && !data ? <p className="inline-error">Nudges can't load: {error}. Check that the daemon is running.</p> : null}
      {flash ? <p className="nd-flash" role="status">{flash}</p> : null}
      {list.length ? (
        <ul className="rail-list nd-list">
          {list.map((n) => <NudgeCard key={n.id} n={n} onDone={setFlash} />)}
        </ul>
      ) : data ? <p className="meta nd-empty">Nothing to nudge you about.</p> : null}
      {over ? <p className="nd-more"><a href={href("knowledge")}>{over} more waiting in To review</a></p> : null}
      <TidiedToasts />
    </section>
  );
}
