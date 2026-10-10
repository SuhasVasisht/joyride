// What an agent is trying to do, in a glance: its goal, what it is doing now,
// what comes next, and what it waits on you for (the intentions module).
import { useIntention } from "../lib/intentions";
import { timeAgo } from "../lib/api";
import "./intent.css";

export function IntentPanel({ sessionKey, compact = false }: { sessionKey: string | null | undefined; compact?: boolean }) {
  const r = useIntention(sessionKey);
  if (!sessionKey || r === "unavailable") return null;
  const v = r;
  const it = v?.intention;
  if (!it) {
    return (
      <p className={`intent intent-empty${compact ? " compact" : ""}`} aria-busy={!v || v.pending} data-intent-state={v?.pending || !v ? "pending" : v.error ? "error" : "none"}>
        {!v || v.pending ? "Reading the conversation to say what it is working on…" : v.error ? "Joyride couldn't summarise this conversation yet. It tries again after the next turn." : "No summary yet. It appears after the agent's next turn."}
      </p>
    );
  }
  return (
    <section className={`intent${compact ? " compact" : ""}`} aria-label="What it is trying to do" data-intent={sessionKey}
      title={`Summarised from the conversation ${timeAgo(it.generated)}${v?.stale ? "; a newer summary is on its way" : ""}`}>
      <p className="intent-goal">{it.goal}</p>
      <dl className="intent-steps">
        <div><dt>Now</dt><dd>{it.now}</dd></div>
        <div><dt>Next</dt><dd>{it.next}</dd></div>
        {it.waiting_on ? <div className="intent-waiting"><dt>Waiting on you</dt><dd>{it.waiting_on}</dd></div> : null}
      </dl>
    </section>
  );
}
