import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./image-gallery.css";

export type ChatImage = { src: string; label: string };
const Gallery = createContext<(index: number) => void>(() => {});

/** One message's images. Native modal focus keeps the underlying worker sheet in place. */
export function ImageGallery({ images, children }: { images: ChatImage[]; children: ReactNode }) {
  const [index, setIndex] = useState<number | null>(null);
  const close = useCallback(() => setIndex(null), []);
  return <Gallery.Provider value={setIndex}>
    {children}
    {index !== null && images[index] ? <Lightbox images={images} index={index} select={setIndex} close={close} /> : null}
  </Gallery.Provider>;
}

export function ImagePreview({ image, index, className, lazy = true }: { image: ChatImage; index: number; className?: string; lazy?: boolean }) {
  const open = useContext(Gallery);
  const [broken, setBroken] = useState(false);
  if (!image.src || broken) return <span className="image-missing chip" title="The image file is unavailable">Image</span>;
  return <button type="button" className={`image-preview${className ? ` ${className}` : ""}`} aria-label={`View ${image.label}`} onClick={() => open(index)}>
    <img src={image.src} alt={image.label} loading={lazy ? "lazy" : undefined} onError={() => setBroken(true)} />
  </button>;
}

function Lightbox({ images, index, select, close }: { images: ChatImage[]; index: number; select: (n: number) => void; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const image = images[index];
  const move = (n: number) => select((index + n + images.length) % images.length);
  useEffect(() => {
    const previous = document.activeElement;
    const el = dialog.current;
    el?.showModal();
    return () => { el?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  return createPortal(<dialog ref={dialog} className="image-lightbox" aria-label="Image viewer"
    onCancel={(e) => { e.preventDefault(); close(); }}
    onClick={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) close(); }}
    onKeyDown={(e) => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); close(); }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); move(e.key === "ArrowLeft" ? -1 : 1); }
    }}>
    <div className="image-lightbox-panel">
      <div className="image-lightbox-toolbar">
        <span>{image.label}{images.length > 1 ? ` (${index + 1} of ${images.length})` : ""}</span>
        <a href={image.src} target="_blank" rel="noreferrer noopener">Open original</a>
        <button type="button" className="btn ghost" aria-label="Close image viewer" onClick={close} autoFocus>×</button>
      </div>
      <img key={image.src} src={image.src} alt={image.label} />
      {images.length > 1 ? <div className="image-lightbox-nav">
        <button type="button" className="btn ghost" onClick={() => move(-1)} aria-label="Previous image">←</button>
        <button type="button" className="btn ghost" onClick={() => move(1)} aria-label="Next image">→</button>
      </div> : null}
    </div>
  </dialog>, document.body);
}
