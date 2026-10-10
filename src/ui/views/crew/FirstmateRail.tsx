import { isPrimaryIdle } from "../../../shared/firstmate-primary";
import { FirstmatePrimary } from "./FirstmatePrimary";
import { useFirstmate } from "./crew";

export function FirstmateRail() {
  const { data, reload } = useFirstmate();
  if (!data?.running && !data?.primary?.error) return null;
  return <section className="rail-sec" data-rail="firstmate" aria-labelledby="rail-firstmate">
    <h3 id="rail-firstmate">Firstmate</h3>
    <FirstmatePrimary primary={data.primary} running={data.running} idle={isPrimaryIdle(data.pane?.status)} reload={reload} />
  </section>;
}
