"use client";
// Fullscreen image overlay: click anywhere or Escape (topmost-only) closes.
import { useTopEscape } from "./modal";

export function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useTopEscape(onClose);
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={alt} onClick={onClose}>
      <img src={src} alt={alt} />
    </div>
  );
}
