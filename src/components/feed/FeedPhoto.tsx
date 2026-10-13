"use client";
// A photo in a feed card: lazy, aspect-safe (box takes the photo's ratio, clamped 4:5..16:9),
// tap for full screen. A post still uploading from this phone shows its local preview with an
// "Uploading" badge. A photo another phone is still uploading 404s here for a while (ops never
// wait for their photo), so a failed load is retried on its own: with backoff for about 3
// minutes, and again whenever a fresh snapshot arrives. While the event is recent it reads
// "Photo on its way…", never "didn't load".
import { useCallback, useEffect, useRef, useState } from "react";
import { cx } from "@/components/ui";
import { PHOTO_REFRESH_RETRY_MIN_MS, photoAspect, photoPlaceholder, photoRetryDelay } from "./model";

export function FeedPhoto({
  src,
  alt,
  pending,
  onOpen,
  big = false,
  recent = false,
  refreshKey = null,
}: {
  src: string | null;
  alt: string;
  /** Still uploading from this phone. */
  pending: boolean;
  onOpen: (src: string) => void;
  big?: boolean;
  /** The event is only a few minutes old: a missing photo is probably still on its way. */
  recent?: boolean;
  /** Changes with every fresh snapshot: a photo that failed to load gets another try. */
  refreshKey?: string | null;
}) {
  // Remount when the URL changes (local blob -> remote URL) so load/error state starts fresh.
  return <PhotoInner key={src ?? "none"} src={src} alt={alt} pending={pending} onOpen={onOpen} big={big} recent={recent} refreshKey={refreshKey} />;
}

type LoadStatus = "loading" | "ok" | "failed" | "retrying";

export interface PhotoRetry {
  status: LoadStatus;
  /** URL for the visible <img> (cache-busted after a retry). */
  url: string | null;
  /** URL to probe in a hidden <img> while retrying. */
  probeUrl: string | null;
  onLoad: () => void;
  onError: () => void;
  /** Try again now (a tap on the placeholder). */
  retry: () => void;
}

/**
 * Load state for a remote photo with automatic retries (see the file comment). Reusable by other
 * photo thumbnails (e.g. contest cards). Key the caller on `src` so a new URL starts fresh.
 */
export function usePhotoRetry(src: string | null, refreshKey: string | null): PhotoRetry {
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [attempt, setAttempt] = useState(0);
  const failures = useRef(0);
  const lastTry = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const local = !src || /^(blob:|data:)/.test(src);
  // A fresh snapshot arrived (the uploading phone may be done): retry a failed photo, though not
  // more often than every few seconds.
  const [seenKey, setSeenKey] = useState(refreshKey);
  const [refreshDue, setRefreshDue] = useState(false);
  if (refreshKey !== seenKey) {
    setSeenKey(refreshKey);
    setRefreshDue(true);
  }

  const startRetry = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    lastTry.current = Date.now();
    setRefreshDue(false);
    setAttempt((a) => a + 1);
    setStatus("retrying");
  }, []);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  useEffect(() => {
    if (!refreshDue || status !== "failed" || local) return;
    const t = setTimeout(startRetry, Math.max(0, PHOTO_REFRESH_RETRY_MIN_MS - (Date.now() - lastTry.current)));
    return () => clearTimeout(t);
  }, [refreshDue, status, local, startRetry]);

  const bust = (n: number) => (!src || n === 0 || local ? src : `${src}${src.includes("?") ? "&" : "?"}r=${n}`);

  return {
    status,
    url: bust(attempt),
    probeUrl: status === "retrying" ? bust(attempt) : null,
    onLoad: () => {
      failures.current = 0;
      setStatus("ok");
    },
    onError: () => {
      failures.current += 1;
      setStatus("failed");
      if (local) return;
      // Backoff for about 3 minutes; after that only fresh snapshots (and taps) retry.
      const delay = photoRetryDelay(failures.current);
      if (timer.current) clearTimeout(timer.current);
      timer.current = delay === null ? null : setTimeout(startRetry, delay);
    },
    retry: startRetry,
  };
}

function PhotoInner({
  src,
  alt,
  pending,
  onOpen,
  big,
  recent,
  refreshKey,
}: {
  src: string | null;
  alt: string;
  pending: boolean;
  onOpen: (src: string) => void;
  big: boolean;
  recent: boolean;
  refreshKey: string | null;
}) {
  const [ratio, setRatio] = useState<number | null>(null);
  const photo = usePhotoRetry(src, refreshKey);

  if (!src || photo.status === "failed" || photo.status === "retrying") {
    const ph = photoPlaceholder({ uploadingHere: pending, recent });
    return (
      <button
        type="button"
        onClick={photo.retry}
        className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-line-strong bg-sand text-muted"
        data-testid="feed-photo-missing"
        data-state={ph.state}
      >
        <span className={cx("text-4xl", ph.state === "coming" && "animate-pulse")} aria-hidden="true">
          {ph.emoji}
        </span>
        <span className="text-[15px] font-bold">{ph.text}</span>
        {photo.probeUrl && (
          // Hidden probe: a retry shows the photo only once it actually loads (no broken-image flash).
          // eslint-disable-next-line @next/next/no-img-element -- user photos from storage
          <img src={photo.probeUrl} alt="" aria-hidden="true" className="hidden" onLoad={photo.onLoad} onError={photo.onError} />
        )}
      </button>
    );
  }

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
        src={photo.url ?? src}
        alt={alt}
        loading="lazy"
        decoding="async"
        className="absolute inset-0 h-full w-full object-cover"
        onLoad={(e) => {
          setRatio(photoAspect(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight));
          photo.onLoad();
        }}
        onError={photo.onError}
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
