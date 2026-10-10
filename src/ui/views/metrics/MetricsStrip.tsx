// A quiet line of key numbers from /api/metrics: how long people wait on you,
// and how many are waiting now. Not a hero widget.
import { useNeedsYou, openNeedsYou } from "../../lib/needs-you";
import { useApi } from "../../lib/api";
import { duration } from "../../components/primitives";

type Latency = { count: number; p50_ms: number | null; p90_ms: number | null };
type Metrics = { open: Record<string, number>; blocked_to_unblocked: Record<string, Latency> };

export function MetricsStrip() {
  const { data } = useApi<Metrics>("/api/metrics", ["metrics", "attention"], { pollMs: 60_000 });
  const { items, ready } = useNeedsYou();
  const waiting = items.length;
  const today = data?.blocked_to_unblocked?.["1d"];
  return (
    <div className="metrics-strip" aria-label="Key numbers">
      {ready && waiting > 0 ? <button type="button" className="metric hot btn link" data-metric="open-l3l4" onClick={openNeedsYou}><b>{waiting}</b> waiting on you</button> : null}
      <span className="metric" data-metric="unblock-p50" title="Median time from an L3/L4 item opening to its resolution, last 24 hours">
        {today?.count
          ? <>Unblocked in <b>{duration(today.p50_ms)}</b> median today, over {today.count}</>
          : <>No unblocks timed today</>}
      </span>
    </div>
  );
}
