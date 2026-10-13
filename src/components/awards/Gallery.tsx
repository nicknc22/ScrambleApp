"use client";
// Gallery: every photo of the round in a grid; tap for the full-screen viewer; download all as a
// zip (jszip, loaded on demand) with progress and per-file failure handling.
import { useState } from "react";
import type JSZip from "jszip";
import type { Derived } from "@/lib/engine/types";
import type { TripStore } from "@/lib/client/store";
import { Button, EmptyState, PlayerName, SectionHeader, Spinner, displayName, useToast } from "@/components/ui";
import { buildPhotoZip, saveBlob, type ZipProgress } from "./download";
import { galleryKindLabel, photoFileName, zipFileName, type GalleryKind, type GalleryPhoto } from "./photos";
import { PhotoViewer, type ViewerPhoto } from "./PhotoViewer";

const KIND_EMOJI: Record<GalleryKind, string> = {
  drink: "🍺",
  shotgun: "💥",
  shot: "🥃",
  ctp: "🎯",
  ld: "💣",
  post: "📣",
  feed: "📸",
};

/** Viewer entries for gallery photos (url via the store: local blob while pending, else storage). */
export function toViewerPhotos(photos: readonly GalleryPhoto[], derived: Pick<Derived, "playerById">, photoUrl: (p: string) => string | null): ViewerPhoto[] {
  return photos.map((p, i) => {
    const player = p.player_id ? derived.playerById[p.player_id] : undefined;
    const parts = [galleryKindLabel(p.kind), p.hole !== null ? `Hole ${p.hole}` : null].filter(Boolean) as string[];
    return {
      path: p.path,
      url: photoUrl(p.path),
      caption: (
        <>
          {player && (
            <>
              <PlayerName player={player} /> ·{" "}
            </>
          )}
          {parts.join(" · ")}
        </>
      ),
      label: [player ? displayName(player) : null, ...parts].filter(Boolean).join(" · "),
      fileName: photoFileName(p, i, player ? displayName(player) : null),
    };
  });
}

export function Gallery({
  photos,
  viewerPhotos,
  tripName,
  store,
  onOpen,
}: {
  photos: readonly GalleryPhoto[];
  viewerPhotos: readonly ViewerPhoto[];
  tripName: string;
  store: Pick<TripStore, "photoUrl">;
  onOpen: (index: number) => void;
}) {
  const toast = useToast();
  const [progress, setProgress] = useState<ZipProgress | null>(null);
  const [broken, setBroken] = useState<Record<string, boolean>>({});

  const downloadAll = async () => {
    if (progress) return;
    setProgress({ done: 0, failed: 0, total: viewerPhotos.length });
    try {
      let JSZipCtor: new () => JSZip;
      try {
        const mod = (await import("jszip")) as unknown as { default?: new () => JSZip };
        JSZipCtor = mod.default ?? (mod as unknown as new () => JSZip);
      } catch {
        toast.error("Couldn't load the zipper. You need signal for this one.", { title: "Download failed" });
        return;
      }
      const result = await buildPhotoZip(
        viewerPhotos.map((p) => ({ url: p.url, name: p.fileName })),
        { JSZip: JSZipCtor, onProgress: setProgress, concurrency: 4 },
      );
      if (result.added === 0) {
        toast.error("Not a single photo would download. Find some signal and try again.", { title: "Download failed" });
        return;
      }
      if (result.failed.length > 0) {
        result.zip.file("MISSING.txt", `These photos couldn't be downloaded (still uploading, or no signal):\n${result.failed.join("\n")}\n`);
      }
      const blob = await result.zip.generateAsync({ type: "blob", mimeType: "application/zip" });
      saveBlob(blob, zipFileName(tripName));
      if (result.failed.length > 0) {
        toast.show({
          tone: "info",
          emoji: "🗜️",
          title: `Zipped ${result.added} of ${viewerPhotos.length}`,
          message: `${result.failed.length} ${result.failed.length === 1 ? "photo" : "photos"} wouldn't download (still uploading?). Try again later for the rest.`,
          duration: 8000,
        });
      } else {
        toast.success(`All ${result.added} photos zipped. Evidence preserved.`, { emoji: "🗜️" });
      }
    } catch (e) {
      console.error("[gallery] zip failed", e);
      toast.error("The zip blew up. Try again, or save photos one at a time.", { title: "Download failed" });
    } finally {
      setProgress(null);
    }
  };

  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <section className="space-y-3" aria-labelledby="awards-gallery" data-testid="gallery">
      <SectionHeader
        title={<span id="awards-gallery">Gallery</span>}
        subtitle={
          photos.length === 0 ? "No photos. Pics or it didn't happen." : `${photos.length} ${photos.length === 1 ? "photo" : "photos"} of questionable decisions`
        }
      />
      {photos.length === 0 ? (
        <EmptyState emoji="📵" title="No photos">
          Nobody took a single picture. Did any of this even happen?
        </EmptyState>
      ) : (
        <>
          <ul className="grid grid-cols-3 gap-1.5">
            {photos.map((p, i) => {
              const url = store.photoUrl(p.path);
              return (
                <li key={p.path}>
                  <button
                    type="button"
                    onClick={() => onOpen(i)}
                    aria-label={`Open photo ${i + 1}: ${viewerPhotos[i]?.label ?? galleryKindLabel(p.kind)}`}
                    data-testid="gallery-photo"
                    className="relative block aspect-square w-full overflow-hidden rounded-xl border-2 border-ink bg-sand active:scale-[0.97]"
                  >
                    <span className="absolute inset-0 flex items-center justify-center text-3xl" aria-hidden="true">
                      {KIND_EMOJI[p.kind]}
                    </span>
                    {url && !broken[p.path] && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={url}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        draggable={false}
                        onError={() => setBroken((b) => ({ ...b, [p.path]: true }))}
                        className="absolute inset-0 h-full w-full object-cover"
                      />
                    )}
                    <span
                      className="absolute bottom-1 left-1 rounded-full border-2 border-ink bg-paper px-1.5 text-xs leading-5 font-black"
                      aria-hidden="true"
                    >
                      {KIND_EMOJI[p.kind]}
                      {p.hole !== null ? ` ${p.hole}` : ""}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <Button
            variant="ink"
            size="lg"
            full
            onClick={downloadAll}
            disabled={!!progress}
            leading={progress ? <Spinner size={20} label="Zipping" /> : <span aria-hidden="true">🗜️</span>}
            data-testid="download-all"
          >
            {progress ? `Zipping ${progress.done} / ${progress.total}…` : "Download all (zip)"}
          </Button>
          {progress && (
            <div
              className="h-3 overflow-hidden rounded-full border-2 border-ink bg-sand"
              role="progressbar"
              aria-label="Zip progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
            >
              <div className="h-full bg-fairway transition-[width]" style={{ width: `${pct}%` }} />
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** Gallery + its viewer, wired to local open state. */
export function GalleryWithViewer(props: Omit<Parameters<typeof Gallery>[0], "onOpen"> & { openIndex: number | null; setOpenIndex: (i: number | null) => void }) {
  const { openIndex, setOpenIndex, ...rest } = props;
  return (
    <>
      <Gallery {...rest} onOpen={(i) => setOpenIndex(i)} />
      {openIndex !== null && (
        <PhotoViewer photos={rest.viewerPhotos} index={openIndex} onIndex={(i) => setOpenIndex(i)} onClose={() => setOpenIndex(null)} />
      )}
    </>
  );
}
