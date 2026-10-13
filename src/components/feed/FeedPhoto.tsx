"use client";
// A photo in a feed card: lazy, aspect-safe (box takes the photo's ratio, clamped 4:5..16:9),
// tap for full screen. A post still uploading shows its local preview with an "Uploading" badge.
import { useState } from "react";
import { cx } from "@/components/ui";
import { photoAspect } from "./model";

export function FeedPhoto({
  src,
  alt,
  pending,
  onOpen,
  big = false,
}: {
  src: string | null;
  alt: string;
  pending: boolean;
  onOpen: (src: string) => void;
  big?: boolean;
}) {
  // Remount when the URL changes (local blob -> remote URL) so load/error state starts fresh.
  return <PhotoInner key={src ?? "none"} src={src} alt={alt} pending={pending} onOpen={onOpen} big={big} />;
}

function PhotoInner({ src, alt, pending, onOpen, big }: { src: string | null; alt: string; pending: boolean; onOpen: (src: string) => void; big: boolean }) {
  const [ratio, setRatio] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  if (!src || failed) {
    return (
      <button
        type="button"
        onClick={() => {
          setFailed(false);
          setAttempt((a) => a + 1);
        }}
        className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-line-strong bg-sand text-muted"
        data-testid="feed-photo-missing"
      >
        <span className="text-4xl" aria-hidden="true">
          {pending ? "⏫" : "📷"}
        </span>
        <span className="text-[15px] font-bold">{pending ? "Uploading…" : "Photo didn't load. Tap to retry."}</span>
      </button>
    );
  }

  const url = attempt > 0 && !/^(blob:|data:)/.test(src) ? `${src}${src.includes("?") ? "&" : "?"}r=${attempt}` : src;
  return (
    <button
      type="button"
      onClick={() => onOpen(src)}
      aria-label="Open photo full screen"
      data-testid="feed-photo"
      className={cx("relative block w-full overflow-hidden rounded-xl border-2 border-ink bg-sand", big && "shadow-hard-sm")}
      style={{ aspectRatio: ratio ?? 4 / 3 }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- user photos from storage / local blobs */}
      <img
        src={url}
        alt={alt}
        loading="lazy"
        decoding="async"
        className="absolute inset-0 h-full w-full object-cover"
        onLoad={(e) => setRatio(photoAspect(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight))}
        onError={() => setFailed(true)}
      />
      {pending && (
        <span
          className="absolute top-2 left-2 inline-flex items-center gap-1 rounded-full border-2 border-ink bg-hazard px-2 py-1 text-[12px] font-black uppercase"
          data-testid="photo-uploading"
        >
          <span className="inline-block animate-bounce" aria-hidden="true">
            ⏫
          </span>
          Uploading
        </span>
      )}
    </button>
  );
}
