// Images on a message: paste, drop or pick them, see thumbnails before sending, and see what
// went out afterwards. Each image is uploaded to the daemon as soon as it is added
// (POST /api/uploads); a message carries the stored absolute paths, which the relay pastes
// into the agent's input box so Claude Code and Codex attach them as images.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ClipboardEvent, type DragEvent, type ReactNode } from "react";
import { draftStore, type DraftImage } from "../lib/drafts";
import { post } from "../lib/api";
import { IMAGE_ACCEPT, IMAGE_TYPES, MAX_IMAGE_BYTES, MAX_IMAGES_PER_MESSAGE, fileName, formatBytes, uploadUrl } from "../../shared/images";
import { ImageGallery, ImagePreview, type ChatImage } from "./ImageGallery";
import "./attach.css";

export type Attachment = {
  key: string; name: string; bytes: number; preview: string;
  status: "uploading" | "ready" | "failed"; path?: string; url?: string | null; error?: string;
};

const NO_IMAGES: DraftImage[] = [];
const ACCEPTED = new Set<string>(Object.values(IMAGE_TYPES));
let seq = 0;

function readAsDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("the browser could not read the file"));
    r.readAsDataURL(f);
  });
}

/**
 * Attachments for one message box. `blocked` is the reason images can't go to this target
 * (an agent that doesn't load images from paths); adding one then only shows that reason.
 */
export function useAttachments(blocked?: string | null, draftKey?: string) {
  const frames = useRef(new Map<string | undefined, Attachment[]>());
  const saved = useSyncExternalStore(draftStore.subscribe, () => draftKey ? draftStore.read(draftKey).images : NO_IMAGES);
  const restore = (previous: Attachment[] = []): Attachment[] => [
    ...saved.map((a): Attachment => ({ ...a, status: "ready", preview: previous.find((x) => x.key === a.key)?.preview ?? a.url ?? uploadUrl(a.path) ?? "" })),
    ...previous.filter((a) => a.status !== "ready"),
  ];
  const [state, setState] = useState(() => ({ key: draftKey, saved, items: restore() }));
  const items = state.key === draftKey && state.saved === saved ? state.items : restore(state.key === draftKey ? state.items : frames.current.get(draftKey) ?? []);
  if (state.key !== draftKey || state.saved !== saved) setState({ key: draftKey, saved, items });
  frames.current.set(draftKey, items);
  const activeKey = useRef(draftKey);
  activeKey.current = draftKey;
  const setItems = (change: (xs: Attachment[]) => Attachment[]) => {
    // Persist at the mutation, including uploads finishing after the box unmounts.
    const next = change(frames.current.get(draftKey) ?? []);
    frames.current.set(draftKey, next);
    if (draftKey) {
      const images: DraftImage[] = next.flatMap((a) => a.status === "ready" && a.path ? [{ key: a.key, name: a.name, bytes: a.bytes, path: a.path, url: a.url ?? null }] : []);
      draftStore.update(draftKey, { images });
    }
    if (activeKey.current === draftKey) { live.current = next; setState({ key: draftKey, saved: draftKey ? draftStore.read(draftKey).images : NO_IMAGES, items: next }); }
  };
  const [notice, setNotice] = useState<string | null>(null);
  const live = useRef(items);
  live.current = items;
  useEffect(() => () => { for (const xs of frames.current.values()) for (const a of xs) URL.revokeObjectURL(a.preview); }, []);

  const patch = (key: string, p: Partial<Attachment>) => setItems((xs) => xs.map((x) => (x.key === key ? { ...x, ...p } : x)));

  const add = useCallback((files: File[]) => {
    if (!files.length) return;
    if (blocked) { setNotice(blocked); return; }
    const problems: string[] = [];
    const room = MAX_IMAGES_PER_MESSAGE - live.current.length;
    const fresh: { a: Attachment; f: File }[] = [];
    for (const f of files) {
      const name = f.name || "pasted image";
      if (!ACCEPTED.has(f.type)) { problems.push(`${name} is not a PNG, JPEG, GIF or WebP image.`); continue; }
      if (f.size > MAX_IMAGE_BYTES) { problems.push(`${name} is ${formatBytes(f.size)}; the limit is ${formatBytes(MAX_IMAGE_BYTES)}. Shrink or crop it first.`); continue; }
      if (fresh.length >= room) { problems.push(`One message takes at most ${MAX_IMAGES_PER_MESSAGE} images; ${name} was left out.`); continue; }
      fresh.push({ f, a: { key: `att${Date.now()}-${++seq}`, name, bytes: f.size, preview: URL.createObjectURL(f), status: "uploading" } });
    }
    setNotice(problems.length ? problems.join(" ") : null);
    if (!fresh.length) return;
    setItems((xs) => [...xs, ...fresh.map((x) => x.a)]);
    for (const { a, f } of fresh) {
      readAsDataUrl(f)
        .then((data) => post<{ path: string; url: string | null }>("/api/uploads", { name: a.name, data }))
        .then((r) => patch(a.key, { status: "ready", path: r.path, url: r.url }))
        .catch((e: any) => patch(a.key, { status: "failed", error: `Not uploaded: ${e.message}` }));
    }
  }, [blocked, draftKey]);

  const remove = useCallback((key: string) => {
    setItems((xs) => { const gone = xs.find((x) => x.key === key); if (gone) URL.revokeObjectURL(gone.preview); return xs.filter((x) => x.key !== key); });
    setNotice(null);
  }, [draftKey]);
  const clear = useCallback(() => { setItems((xs) => { for (const x of xs) URL.revokeObjectURL(x.preview); return []; }); setNotice(null); }, [draftKey]);

  /** Paste: image files on the clipboard (a screenshot) become attachments; text still pastes. */
  const onPaste = useCallback((e: ClipboardEvent) => {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    if (!e.clipboardData.getData("text/plain")) e.preventDefault();
    add(files);
  }, [add]);

  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const hasFiles = (e: DragEvent) => [...e.dataTransfer.types].includes("Files");
  const dropProps = {
    onDragEnter: (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); depth.current++; setDragging(true); },
    onDragOver: (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = blocked ? "none" : "copy"; },
    onDragLeave: (e: DragEvent) => { if (!hasFiles(e)) return; depth.current = Math.max(0, depth.current - 1); if (!depth.current) setDragging(false); },
    onDrop: (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); depth.current = 0; setDragging(false); add([...e.dataTransfer.files]); },
  };

  const ready = items.filter((x) => x.status === "ready" && x.path).map((x) => x.path!);
  return {
    items, add, remove, clear, onPaste, dropProps, dragging, notice, blocked: blocked ?? null, say: setNotice,
    paths: ready,
    uploading: items.some((x) => x.status === "uploading"),
    failed: items.some((x) => x.status === "failed"),
  };
}
export type Attachments = ReturnType<typeof useAttachments>;

/** The paperclip: opens the file picker. Disabled, with the reason as its title, when images can't go to this target. */
export function AttachButton({ att, label = "Attach images" }: { att: Attachments; label?: string }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className="btn ghost attach-btn" aria-label={label} title={att.blocked ?? `${label} (PNG, JPEG, GIF or WebP, up to ${formatBytes(MAX_IMAGE_BYTES)}). You can also paste or drop them here.`}
        aria-disabled={att.blocked ? true : undefined} onClick={() => (att.blocked ? att.say(att.blocked) : input.current?.click())}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 4.5 5.4 9.6a1.5 1.5 0 0 0 2.1 2.1l5.3-5.3a3 3 0 0 0-4.2-4.2L3.3 7.5a4.5 4.5 0 0 0 6.4 6.4l4.1-4.1" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      </button>
      <input ref={input} type="file" accept={IMAGE_ACCEPT} multiple hidden data-attach-input
        onChange={(e) => { att.add([...(e.target.files ?? [])]); e.target.value = ""; }} />
    </>
  );
}

/**
 * An attachment's name in the tray. Clipboard screenshots all arrive as image.png, so a repeated
 * name gets its place among the same-named ones ("image.png (2 of 3)") and each stays removable alone.
 */
function labelOf(items: Attachment[], i: number): string {
  const name = items[i].name;
  const same = items.filter((x) => x.name === name);
  return same.length > 1 ? `${name} (${same.indexOf(items[i]) + 1} of ${same.length})` : name;
}

/** Thumbnails waiting to go out with the message, each removable. */
export function AttachmentTray({ att }: { att: Attachments }) {
  if (!att.items.length && !att.notice) return null;
  return (
    <ImageGallery images={att.items.map((a, i) => ({ src: a.preview, label: labelOf(att.items, i) }))}><div className="attach-tray">
      {att.items.length ? (
        <ul className="attach-list" aria-label="Images to send">
          {att.items.map((a, i) => {
            const label = labelOf(att.items, i);
            return (
              <li key={a.key} className={`attach-item s-${a.status}`} data-attachment={a.status} title={a.error ?? `${label}, ${formatBytes(a.bytes)}`}>
                <ImagePreview image={{ src: a.preview, label }} index={i} lazy={false} />
                {a.status === "uploading" ? <span className="attach-badge">Uploading</span> : null}
                {a.status === "failed" ? <span className="attach-badge bad">Failed</span> : null}
                <button type="button" className="attach-remove" aria-label={`Remove ${label}`} onClick={() => att.remove(a.key)}>×</button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {att.items.map((a, i) => (a.error ? <p key={a.key} className="inline-error attach-note" role="alert">{labelOf(att.items, i)}: {a.error}. Remove it and attach it again.</p> : null))}
      {att.notice ? <p className="inline-error attach-note" role="alert">{att.notice}</p> : null}
    </div></ImageGallery>
  );
}

/** A message box that takes dropped images: highlights while files are dragged over it. */
export function DropZone({ att, className, children }: { att: Attachments; className?: string; children: ReactNode }) {
  return (
    <div className={`drop-zone${att.dragging ? " dragging" : ""}${att.blocked ? " blocked" : ""}${className ? ` ${className}` : ""}`} {...att.dropProps}>
      {children}
      {att.dragging ? <div className="drop-hint" aria-hidden>{att.blocked ?? "Drop images to attach them"}</div> : null}
    </div>
  );
}

/** Images on a message, with a neutral chip when the source file is unavailable. */
export function SentImages({ paths, className }: { paths: string[] | null | undefined; className?: string }) {
  if (!paths?.length) return null;
  const images: ChatImage[] = paths.map((p) => ({ src: uploadUrl(p) ?? "", label: p ? `Sent image ${fileName(p)}` : "Image" }));
  // Unavailable slots stay chips, and arrow navigation skips them.
  const available = images.filter((i) => i.src);
  return <ImageGallery images={available}>
    <ul className={`sent-images${className ? ` ${className}` : ""}`} aria-label={paths.length === 1 ? "1 image sent" : `${paths.length} images sent`}>
      {images.map((image, i) => <li key={`${paths[i]}-${i}`} className="sent-image">
        <ImagePreview image={image} index={available.indexOf(image)} />
      </li>)}
    </ul>
  </ImageGallery>;
}
