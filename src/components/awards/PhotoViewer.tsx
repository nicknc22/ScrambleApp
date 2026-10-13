"use client";
// Full-screen photo viewer: swipe / arrows / keys to page, Download (fetch -> blob -> a[download]),
// Share when the browser can share files. Rendered in a portal above sheets (z 70, under toasts).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button, IconChevronLeft, IconChevronRight, IconClose, IconShare, useIsClient, useToast } from "@/components/ui";
import { fetchBlob, saveBlob } from "./download";

export interface ViewerPhoto {
  path: string;
  url: string | null;
  /** Caption line ("Big Nick · Shotgun · Hole 4"). */
  caption: ReactNode;
  /** Plain-text caption for labels. */
  label: string;
  fileName: string;
}

function canShareFiles(file: File): boolean {
  try {
    return typeof navigator !== "undefined" && typeof navigator.share === "function" && !!navigator.canShare?.({ files: [file] });
  } catch {
    return false;
  }
}

export function PhotoViewer({
  photos,
  index,
  onIndex,
  onClose,
}: {
  photos: readonly ViewerPhoto[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const isClient = useIsClient();
  if (!isClient || photos.length === 0) return null;
  return createPortal(<ViewerPanel photos={photos} index={Math.min(Math.max(0, index), photos.length - 1)} onIndex={onIndex} onClose={onClose} />, document.body);
}

function ViewerPanel({
  photos,
  index,
  onIndex,
  onClose,
}: {
  photos: readonly ViewerPhoto[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<"download" | "share" | null>(null);
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const closeRef = useRef<HTMLButtonElement>(null);
  const swipe = useRef<{ x: number; y: number; id: number } | null>(null);
  const photo = photos[index];
  const count = photos.length;
  const hasPrev = index > 0;
  const hasNext = index < count - 1;

  const latest = useRef({ index, count, onIndex, onClose });
  useEffect(() => {
    latest.current = { index, count, onIndex, onClose };
  });

  useEffect(() => {
    const prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      const l = latest.current;
      if (e.key === "Escape") {
        e.preventDefault();
        l.onClose();
      } else if (e.key === "ArrowLeft" && l.index > 0) {
        l.onIndex(l.index - 1);
      } else if (e.key === "ArrowRight" && l.index < l.count - 1) {
        l.onIndex(l.index + 1);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      if (prevFocus && document.contains(prevFocus)) prevFocus.focus({ preventScroll: true });
    };
  }, []);

  const getBlob = async (): Promise<Blob | null> => {
    if (!photo.url) {
      toast.error("That photo isn't available yet. It may still be uploading.", { title: "No photo" });
      return null;
    }
    try {
      return await fetchBlob(photo.url);
    } catch {
      toast.error("Couldn't grab that photo. Find some signal and try again.", { title: "Download failed" });
      return null;
    }
  };

  const download = async () => {
    if (busy) return;
    setBusy("download");
    try {
      const blob = await getBlob();
      if (blob) {
        saveBlob(blob, photo.fileName);
        toast.success("Saved. Blackmail material secured.", { emoji: "📸", id: "photo-saved" });
      }
    } finally {
      setBusy(null);
    }
  };

  const share = async () => {
    if (busy) return;
    setBusy("share");
    try {
      const blob = await getBlob();
      if (!blob) return;
      const file = new File([blob], photo.fileName, { type: blob.type || "image/jpeg" });
      if (canShareFiles(file)) {
        try {
          await navigator.share({ files: [file], title: photo.label });
        } catch (e) {
          if ((e as Error)?.name !== "AbortError") saveBlob(blob, photo.fileName);
        }
      } else {
        saveBlob(blob, photo.fileName);
      }
    } finally {
      setBusy(null);
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    swipe.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const s = swipe.current;
    swipe.current = null;
    if (!s || s.id !== e.pointerId) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
    if (dx < 0 && hasNext) onIndex(index + 1);
    if (dx > 0 && hasPrev) onIndex(index - 1);
  };

  const broken = failed[photo.path] || !photo.url;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Photo ${index + 1} of ${count}: ${photo.label}`}
      data-testid="photo-viewer"
      className="fixed inset-0 z-[70] flex animate-fade-in flex-col bg-ink text-white"
    >
      <div className="flex shrink-0 items-center gap-2 pt-[env(safe-area-inset-top)] pr-2 pl-[max(16px,env(safe-area-inset-left))]">
        <span className="num shrink-0 rounded-full border-2 border-white px-2.5 py-1 text-sm font-black">
          {index + 1} / {count}
        </span>
        <span className="min-w-0 flex-1 truncate text-base font-bold">{photo.caption}</span>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close photo"
          className="btn my-1 h-12 w-12 shrink-0 rounded-full! border-white bg-white/10 p-0! text-white active:bg-white/25"
        >
          <IconClose size={26} strokeWidth={3} />
        </button>
      </div>

      <div className="relative min-h-0 flex-1 touch-pan-y select-none" onPointerDown={onPointerDown} onPointerUp={onPointerUp}>
        {broken ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-8 text-center">
            <span className="text-6xl" aria-hidden="true">
              📵
            </span>
            <p className="text-lg font-black">Photo still uploading (or the signal died).</p>
          </div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={photo.path}
            src={photo.url!}
            alt={photo.label}
            draggable={false}
            onError={() => setFailed((f) => ({ ...f, [photo.path]: true }))}
            className="absolute inset-0 h-full w-full animate-fade-in object-contain"
          />
        )}
        {hasPrev && (
          <button
            type="button"
            onClick={() => onIndex(index - 1)}
            aria-label="Previous photo"
            className="btn absolute top-1/2 left-2 h-14 w-14 -translate-y-1/2 rounded-full! border-white bg-ink/70 p-0! text-white active:bg-ink"
          >
            <IconChevronLeft size={30} strokeWidth={3} />
          </button>
        )}
        {hasNext && (
          <button
            type="button"
            onClick={() => onIndex(index + 1)}
            aria-label="Next photo"
            className="btn absolute top-1/2 right-2 h-14 w-14 -translate-y-1/2 rounded-full! border-white bg-ink/70 p-0! text-white active:bg-ink"
          >
            <IconChevronRight size={30} strokeWidth={3} />
          </button>
        )}
      </div>

      <div className="flex shrink-0 gap-2 px-[max(16px,env(safe-area-inset-left))] pt-3 pb-[calc(12px+env(safe-area-inset-bottom))]">
        <Button variant="hazard" size="lg" full loading={busy === "download"} disabled={!photo.url} onClick={download} leading={<span aria-hidden="true">⬇️</span>}>
          Download
        </Button>
        <Button
          variant="secondary"
          size="lg"
          loading={busy === "share"}
          disabled={!photo.url}
          onClick={share}
          className="shrink-0"
          aria-label="Share photo"
        >
          <IconShare size={22} strokeWidth={2.75} />
        </Button>
      </div>
    </div>
  );
}
