"use client";
// Full-screen photo viewer: black backdrop, contained image, big close button. Tap anywhere or
// press Escape to close. Rendered in a portal above sheets (z 70), below toasts (z 80).
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { IconClose, useIsClient } from "@/components/ui";

export function PhotoViewer({ src, caption, onClose }: { src: string | null; caption?: string; onClose: () => void }) {
  const isClient = useIsClient();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!src) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const prev = document.body.style.overflow;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, [src, onClose]);
  if (!src || !isClient) return null;
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={caption ? `Photo: ${caption}` : "Photo"}
      data-testid="photo-viewer"
      className="fixed inset-0 z-[70] flex animate-fade-in flex-col bg-black"
      onClick={onClose}
    >
      <div className="flex shrink-0 items-center justify-between gap-3 px-3 pt-[max(12px,env(safe-area-inset-top))] pb-2">
        <p className="min-w-0 truncate text-[15px] font-bold text-white/90">{caption}</p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close photo"
          className="btn h-12 w-12 shrink-0 rounded-full! border-white/40 bg-white/15 p-0! text-white active:bg-white/30"
          ref={closeRef}
        >
          <IconClose size={26} strokeWidth={3} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center px-2 pb-[max(12px,env(safe-area-inset-bottom))]">
        {/* eslint-disable-next-line @next/next/no-img-element -- user photos from storage / local blobs */}
        <img src={src} alt={caption ?? "Photo"} className="max-h-full max-w-full object-contain" />
      </div>
    </div>,
    document.body,
  );
}
