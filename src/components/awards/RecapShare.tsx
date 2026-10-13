"use client";
// Recap card: preview the server-rendered PNG and share it (Web Share with files) or download it.
import { useState } from "react";
import { Button, IconRefresh, IconShare, SectionHeader, Spinner, useToast } from "@/components/ui";
import { fetchBlob, saveBlob } from "./download";
import { slugify } from "./photos";

/** Cheap stable hash (djb2) for cache-busting the preview when the results change. */
export function contentKey(parts: readonly unknown[]): string {
  const s = JSON.stringify(parts);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function recapUrl(code: string, version: string): string {
  return `/api/t/${encodeURIComponent(code)}/recap?v=${encodeURIComponent(version)}`;
}

type LoadState = "loading" | "ok" | "error";

export function RecapShare({ code, tripName, version }: { code: string; tripName: string; version: string }) {
  const toast = useToast();
  const [retry, setRetry] = useState(0);
  const src = `${recapUrl(code, version)}${retry ? `&r=${retry}` : ""}`;
  const [loaded, setLoaded] = useState<{ src: string; state: LoadState }>({ src, state: "loading" });
  const state: LoadState = loaded.src === src ? loaded.state : "loading";
  const [busy, setBusy] = useState<"share" | "download" | null>(null);
  const fileName = `${slugify(tripName) || "scramble"}-recap.png`;

  const getFile = async (): Promise<{ blob: Blob; file: File } | null> => {
    try {
      const blob = await fetchBlob(src, { timeoutMs: 45_000 });
      return { blob, file: new File([blob], fileName, { type: "image/png" }) };
    } catch {
      toast.error("Couldn't build the recap card. You need signal for this one.", { title: "Recap failed" });
      return null;
    }
  };

  const share = async () => {
    if (busy) return;
    setBusy("share");
    try {
      const got = await getFile();
      if (!got) return;
      let canShare = false;
      try {
        canShare = typeof navigator.share === "function" && !!navigator.canShare?.({ files: [got.file] });
      } catch {
        canShare = false;
      }
      if (canShare) {
        try {
          await navigator.share({ files: [got.file], title: tripName, text: `${tripName}: final results` });
        } catch (e) {
          if ((e as Error)?.name === "AbortError") return;
          saveBlob(got.blob, fileName);
          toast.info("Sharing didn't work, so we downloaded it instead.", { emoji: "⬇️" });
        }
      } else {
        saveBlob(got.blob, fileName);
        toast.success("Recap card downloaded. Go post it.", { emoji: "🖼️" });
      }
    } finally {
      setBusy(null);
    }
  };

  const download = async () => {
    if (busy) return;
    setBusy("download");
    try {
      const got = await getFile();
      if (got) {
        saveBlob(got.blob, fileName);
        toast.success("Recap card downloaded.", { emoji: "🖼️" });
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="space-y-3" aria-labelledby="awards-recap" data-testid="recap">
      <SectionHeader
        title={<span id="awards-recap">Recap card</span>}
        subtitle="Final standings and every award in one image. Send it to the group chat."
      />
      <div className="relative mx-auto aspect-[1080/1350] w-full max-w-sm overflow-hidden rounded-2xl border-2 border-ink bg-fairway shadow-hard">
        {state !== "error" && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={src}
            src={src}
            alt={`Recap card for ${tripName}: final standings and awards`}
            data-testid="recap-img"
            onLoad={() => setLoaded({ src, state: "ok" })}
            onError={() => setLoaded({ src, state: "error" })}
            className="absolute inset-0 h-full w-full object-contain"
          />
        )}
        {state === "loading" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-fairway text-white">
            <Spinner size={36} label="Drawing the recap card" />
            <p className="loud text-xl">Printing the trophies…</p>
          </div>
        )}
        {state === "error" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-sand px-6 text-center">
            <span className="text-5xl" aria-hidden="true">
              📵
            </span>
            <p className="text-lg font-black">The recap card needs signal.</p>
            <Button variant="secondary" onClick={() => setRetry((n) => n + 1)} leading={<IconRefresh size={20} strokeWidth={3} />}>
              Try again
            </Button>
          </div>
        )}
      </div>
      <Button
        variant="primary"
        size="xl"
        full
        loading={busy === "share"}
        onClick={share}
        leading={<IconShare size={24} strokeWidth={3} />}
        data-testid="recap-share"
      >
        Share recap
      </Button>
      <Button variant="secondary" full loading={busy === "download"} onClick={download}>
        Download PNG
      </Button>
    </section>
  );
}
