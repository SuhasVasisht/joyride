import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { z } from "zod";
import { normalizeUrl } from "../../../shared/artifact-url";
import { api, useApi } from "../../lib/api";
import { href, parse, useRoute } from "../../lib/router";
import { Markdown } from "../knowledge/ui";
import { ItemSheet } from "../knowledge/ItemSheet";
import type { ArtifactView } from "./ArtifactsPage";
import "./artifact-reader.css";

const Reading = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("html") }),
  z.object({ kind: z.literal("markdown"), text: z.string() }),
  z.object({ kind: z.literal("preview"), content_type: z.string() }),
  z.object({ kind: z.literal("unavailable"), reason: z.enum(["remote", "missing", "unsupported"]) }),
]);
type ReadingState = z.infer<typeof Reading>;
const ArtifactHistory = z.object({ artifactOrigin: z.string(), artifactDepth: z.union([z.literal(1), z.literal(2)]) });

function changeHash(hash: string, state: unknown, replace = false) {
  if (replace) history.replaceState(state, "", hash);
  else history.pushState(state, "", hash);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

/** Keep the originating page mounted, including its scroll, canvas and composer. */
export function openArtifact(id: string) {
  const route = parse();
  const qs = new URLSearchParams(route.query);
  qs.set("artifact", id);
  qs.delete("reading");
  const origin = location.hash || "#/map";
  const path = route.raw.split("?")[0] || "map";
  qs.set("reading", "details");
  history.pushState({ artifactOrigin: origin, artifactDepth: 1 }, "", href(`${path}?${qs}`));
  qs.delete("reading");
  changeHash(href(`${path}?${qs}`), { artifactOrigin: origin, artifactDepth: 2 });
}

export function readArtifact(id: string) {
  const route = parse();
  if (route.query.get("artifact") !== id && route.query.get("open")?.replace(/^artifact:/, "") !== id) return openArtifact(id);
  const qs = new URLSearchParams(route.query);
  qs.delete("reading");
  const state = ArtifactHistory.safeParse(history.state);
  changeHash(href(`${route.raw.split("?")[0]}?${qs}`), state.success ? { ...state.data, artifactDepth: 2 } : null, !state.success);
}

function currentArtifact() {
  const route = parse();
  const open = route.query.get("open");
  return route.query.get("artifact") ?? (route.name === "knowledge" && open && (open.startsWith("artifact:") || route.params[0] === "artifacts") ? open.replace(/^artifact:/, "") : null);
}

export function ArtifactOverlay() {
  const route = useRoute();
  const id = currentArtifact();
  const { data: artifacts } = useApi<ArtifactView[]>("/api/artifacts", ["artifacts"]);
  // One listener covers artifact links in canvas cards, notes, panels and transcripts.
  useEffect(() => {
    const click = (e: MouseEvent) => {
      if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.defaultPrevented) return;
      const link = e.target instanceof Element ? e.target.closest("a") : null;
      if (!link) return;
      const target = new URL(link.href, location.href);
      if (link.closest("[data-chat], .artifact-markdown, .ts-doc")) {
        const artifact = artifacts?.find(a => a.url && normalizeUrl(a.url) === normalizeUrl(target.href));
        if (artifact) { e.preventDefault(); link.focus({ preventScroll: true }); openArtifact(artifact.id); return; }
      }
      if (target.origin !== location.origin || target.pathname !== location.pathname) return;
      const destination = parse(target.hash);
      const key = destination.name === "artifacts" ? destination.params[0] : destination.name === "knowledge" ? destination.query.get("open")?.replace(/^artifact:/, "") : null;
      if (!key || !/^[a-z0-9][a-z0-9._-]{0,120}$/.test(key)) return;
      e.preventDefault();
      link.focus({ preventScroll: true });
      openArtifact(key);
    };
    document.addEventListener("click", click);
    return () => document.removeEventListener("click", click);
  }, [artifacts]);
  return id ? <ArtifactWindow key={id} id={id} details={route.query.get("reading") === "details"} /> : null;
}

function ArtifactWindow({ id, details }: { id: string; details: boolean }) {
  const { data: artifact, error } = useApi<ArtifactView>(`/api/artifacts/${encodeURIComponent(id)}`, ["artifacts"]);
  const [reading, setReading] = useState<ReadingState | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const showingDetails = details || artifact?.kind === "pr" || artifact?.kind === "session";
  const detailsRef = useRef(showingDetails);
  detailsRef.current = showingDetails;
  const showDetails = useCallback(() => {
    const state = ArtifactHistory.safeParse(history.state);
    if (state.success && state.data.artifactDepth === 2) { history.back(); return; }
    const r = parse(); const qs = new URLSearchParams(r.query); qs.set("reading", "details");
    changeHash(href(`${r.raw.split("?")[0]}?${qs}`), history.state, true);
  }, []);
  const close = useCallback(() => {
    const state = ArtifactHistory.safeParse(history.state);
    if (state.success) history.go(-state.data.artifactDepth);
    else {
      const r = parse(); const qs = new URLSearchParams(r.query);
      qs.delete("artifact"); qs.delete("reading"); qs.delete("expand");
      if (qs.get("open")?.replace(/^artifact:/, "") === id) qs.delete("open");
      changeHash(href(`${r.raw.split("?")[0]}${qs.size ? `?${qs}` : ""}`), null, true);
    }
  }, [id]);
  useEffect(() => {
    let active = true;
    setReading(null); setReadError(null);
    api<unknown>(`/api/artifacts/${encodeURIComponent(id)}/reading`).then((value) => {
      const result = Reading.parse(value);
      if (active) setReading(result);
    }).catch((e: unknown) => { if (active) setReadError(e instanceof Error ? e.message : "The saved content could not be read."); });
    return () => { active = false; };
  }, [id, artifact?.snapshot_blob]);
  useEffect(() => {
    const previous = document.activeElement;
    const shell = document.querySelector<HTMLElement>(".shell");
    const wasInert = shell?.inert ?? false;
    const ariaHidden = shell?.getAttribute("aria-hidden");
    const overflow = document.body.style.overflow;
    if (shell) { shell.inert = true; shell.setAttribute("aria-hidden", "true"); }
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector(".palette-backdrop")) return;
      if (e.key === "Escape") {
        e.preventDefault(); e.stopImmediatePropagation();
        if (detailsRef.current) close(); else showDetails();
      }
      if (e.key === "Tab") {
        const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], select, input, textarea, iframe, [tabindex="0"]') ?? [])].filter(el => el.getClientRects().length);
        const first = controls[0], last = controls.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    const message = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return;
      if (e.data === "joyride:preview-escape") showDetails();
      if (e.data === "joyride:preview-tab") back.current?.focus();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("message", message);
    return () => {
      window.removeEventListener("keydown", onKey, true); window.removeEventListener("message", message);
      if (shell) { shell.inert = wasInert; if (ariaHidden == null) shell.removeAttribute("aria-hidden"); else shell.setAttribute("aria-hidden", ariaHidden); }
      document.body.style.overflow = overflow;
      if (previous instanceof HTMLElement && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, [close, showDetails]);
  useEffect(() => {
    const control = showingDetails ? dialog.current?.querySelector<HTMLElement>(".sheet-close") : back.current;
    control?.focus({ preventScroll: true });
    if (showingDetails) dialog.current?.querySelector(".pane-sheet")?.setAttribute("aria-modal", "true");
  }, [showingDetails]);
  const title = artifact?.title ?? "Artifact";
  const preview = `/api/artifacts/${encodeURIComponent(id)}/preview?expanded=1`;
  return createPortal(
    <div ref={dialog} className="artifact-window">
      {showingDetails ? <ItemSheet target={{ entity: "artifact", id }} onClose={close} onOpen={(key) => {
        if (key.startsWith("artifact:")) openArtifact(key.slice(9));
        else { close(); location.hash = href(`knowledge?open=${encodeURIComponent(key)}`); }
      }} /> : <section className="artifact-reader" role="dialog" aria-modal="true" aria-label={`Read ${title}`} data-testid="artifact-reader">
        <header className="artifact-reader-toolbar">
          <button ref={back} type="button" className="btn" onClick={showDetails} aria-keyshortcuts="Escape">Back to details</button>
          <h2 title={title}>{title}</h2>
          <div className="artifact-reader-actions">
            {artifact?.snapshot_blob ? <a className="btn ghost" href={`/api/artifacts/${encodeURIComponent(id)}/download`} download>Download source</a> : null}
            <button type="button" className="btn" onClick={close} aria-label="Close and return">Close</button>
          </div>
        </header>
        {error || readError ? <ReadingFallback artifact={artifact} message={`Could not read the saved content. ${error ?? readError} Refresh the artifact or re-register its local file.`} />
          : !reading ? <div className="artifact-reading-state" role="status">Loading the report…</div>
          : reading.kind === "unavailable" ? <ReadingFallback artifact={artifact} message={reading.reason === "remote" ? "Joyride has the link and summary, but no saved copy of the original report. Open the original to read it. If that link has expired or needs a login, register an HTML or Markdown export to keep a readable copy here." : reading.reason === "missing" ? "The saved report is missing. Re-register its local HTML or Markdown file to read it here." : "This file cannot be displayed as a report. Download its source or open the original."} />
          : <div className="artifact-reading-content" hidden={showingDetails}>
            {reading.kind === "markdown" ? <div className="artifact-markdown-scroll"><article className="artifact-markdown"><Markdown text={reading.text} doc /></article></div>
              : reading.kind === "preview" && /^image\/(?!svg)/.test(reading.content_type) ? <div className="artifact-image-scroll"><img src={preview} alt={title} /></div>
              : <iframe ref={frame} title={`Report: ${title}`} data-testid="artifact-reader-frame" src={preview} sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" />}
          </div>}
      </section>}
    </div>, document.body,
  );
}

function ReadingFallback({ artifact, message }: { artifact: ArtifactView | null; message: string }) {
  return <div className="artifact-reading-state" data-testid="artifact-reading-state">
    <h3>The original report is unavailable here</h3><p>{message}</p>
    {artifact?.url ? <a className="btn" href={artifact.url} target="_blank" rel="noreferrer">Open original</a> : null}
    {artifact?.summary ? <div className="artifact-fallback-summary"><h4>Saved summary</h4><Markdown text={artifact.summary} small /></div> : null}
  </div>;
}
