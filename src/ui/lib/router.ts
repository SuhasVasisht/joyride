// Hash router: #/map, #/mission/<id>, #/worker/<id>, #/session/<key>, ...
import { useEffect, useState } from "react";

export type Route = { name: string; params: string[]; query: URLSearchParams; raw: string };
export function parse(hash = location.hash): Route {
  const raw = hash.replace(/^#\/?/, "");
  const [p, qs] = raw.split("?");
  const parts = (p || "map").split("/").map(decodeURIComponent);
  return { name: parts[0], params: parts.slice(1), query: new URLSearchParams(qs ?? ""), raw };
}
export function go(path: string) { location.hash = "#/" + path.replace(/^#?\/?/, ""); }
export const href = (path: string) => "#/" + path.replace(/^#?\/?/, "");
export function useRoute() {
  const [r, setR] = useState(parse());
  useEffect(() => { const f = () => setR(parse()); window.addEventListener("hashchange", f); return () => window.removeEventListener("hashchange", f); }, []);
  return r;
}
