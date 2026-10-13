"use client";
// Post composer: text + a photo from the camera or the library. Photos are compressed and queued
// via store.addPhoto (works offline); the post is a post.create op with a client-made event id.
import { useEffect, useId, useState, type ChangeEvent } from "react";
import { newId } from "@/lib/ids";
import { useTripStore } from "@/lib/client/react";
import { Button, IconCamera, IconClose, buttonClasses, cx, useToast } from "@/components/ui";
import { canSubmitPost, cleanPostText, MAX_POST_CHARS } from "./model";

/** The "Posted" undo toast (one at a time); the feed dismisses it when a sheet opens over it. */
export const POSTED_TOAST_ID = "feed-posted";

const PLACEHOLDERS = [
  "Talk your trash…",
  "Say something you'll regret…",
  "Who's choking? Spill it…",
  "Describe that shank in detail…",
];

export function Composer({ meId, myName, onPickName }: { meId: string | null; myName: string | null; onPickName: () => void }) {
  const store = useTripStore();
  const toast = useToast();
  const camId = useId();
  const libId = useId();
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(false);
  const [placeholder] = useState(() => PLACEHOLDERS[Math.floor(Math.random() * PLACEHOLDERS.length)]);

  // Revoke the preview URL when it is replaced or the composer unmounts.
  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  if (!meId) {
    return (
      <div className="flex items-center gap-3 rounded-2xl border-2 border-dashed border-ink bg-sand px-4 py-3" data-testid="composer-locked">
        <span className="text-3xl" aria-hidden="true">
          🫥
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[16px] leading-tight font-black">You&apos;re lurking.</p>
          <p className="text-[14px] leading-tight font-semibold text-muted">Pick your name to post and react.</p>
        </div>
        <Button variant="ink" onClick={onPickName}>
          Pick name
        </Button>
      </div>
    );
  }

  const pickFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    e.target.value = ""; // let the same file be picked again
    if (!f) return;
    if (f.type && !f.type.startsWith("image/")) {
      toast.error("That's not a photo. Pictures only.");
      return;
    }
    let url: string | null = null;
    try {
      url = URL.createObjectURL(f);
    } catch {
      url = null;
    }
    setFile(f);
    setPreview(url);
  };

  const clearPhoto = () => {
    setFile(null);
    setPreview(null);
  };

  const submit = async () => {
    if (busy || !canSubmitPost(text, !!file)) return;
    setBusy(true);
    let photoPath: string | null = null;
    let photoDropped = false;
    try {
      if (file) photoPath = await store.addPhoto(file, "posts");
    } catch (err) {
      console.error("[feed] photo failed", err);
      // Nothing could shrink it to an uploadable JPEG. Words still post; a photo-only post can't.
      if (!cleanPostText(text)) {
        toast.error("Couldn't read that photo. Try another one (or a screenshot of it).", { title: "Photo failed" });
        setBusy(false);
        return;
      }
      photoDropped = true;
    }
    const eventId = newId();
    const res = store.dispatch({ type: "post.create", event_id: eventId, text: cleanPostText(text), photo_path: photoPath });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.reason, { title: "Didn't post" });
      return;
    }
    setText("");
    clearPhoto();
    if (photoDropped) toast.error("The photo wouldn't shrink to something we can upload, so your words went up without it.", { title: "Posted, minus the photo", emoji: "📷" });
    const opId = res.op.id;
    toast.show({
      id: POSTED_TOAST_ID,
      tone: "success",
      emoji: "📣",
      title: "Posted",
      message: photoPath ? "Photo's going up. Everyone will see it." : "It's out there now. No take-backs (except Undo).",
      action: {
        label: "Undo",
        onAction: () => {
          void (async () => {
            const cancelled = await store.cancelPending(opId);
            const del = cancelled ? null : store.dispatch({ type: "feed.delete", event_id: eventId });
            if (del && !del.ok) toast.error(del.reason, { title: "Couldn't undo", id: `post-undo-${eventId}` });
            else toast.info("Post deleted. Cowardly, but allowed.", { id: `post-undo-${eventId}` });
          })();
        },
      },
    });
  };

  const over = text.trim().length > MAX_POST_CHARS;
  const ready = canSubmitPost(text, !!file);

  return (
    <form
      className="rounded-2xl border-2 border-ink bg-paper p-3 shadow-hard-sm"
      data-testid="composer"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={`${camId}-text`} className="sr-only">
        Post as {myName ?? "you"}
      </label>
      <textarea
        id={`${camId}-text`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        rows={text.length > 70 || text.includes("\n") ? 4 : focused || text ? 2 : 1}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        maxLength={MAX_POST_CHARS + 200}
        className={cx(
          "block w-full resize-none rounded-xl border-2 bg-sand px-3 py-2.5 text-[17px] leading-snug font-semibold text-ink placeholder:text-muted/80 focus:bg-paper",
          over ? "border-flag" : "border-line",
        )}
        data-testid="composer-text"
      />
      {text.length > MAX_POST_CHARS - 200 && (
        <p className={cx("mt-1 text-right text-[12px] font-bold", over ? "text-flag" : "text-muted")}>
          {text.trim().length}/{MAX_POST_CHARS}
          {over ? " · Hemingway, chill." : ""}
        </p>
      )}

      {preview && (
        <div className="relative mt-2 inline-block">
          {/* eslint-disable-next-line @next/next/no-img-element -- local preview blob */}
          <img src={preview} alt="Photo to post" className="h-28 max-w-full rounded-xl border-2 border-ink object-cover" data-testid="composer-preview" />
          <button
            type="button"
            onClick={clearPhoto}
            aria-label="Remove photo"
            className="btn absolute -top-3 -right-3 h-12 w-12 rounded-full! border-ink bg-paper p-0! text-ink shadow-hard-sm"
          >
            <IconClose size={22} strokeWidth={3} />
          </button>
        </div>
      )}

      <div className="mt-2.5 flex items-center gap-2">
        <label className={buttonClasses({ variant: "secondary", className: "relative shrink-0 gap-1.5 px-3 focus-within:outline-3 focus-within:outline-sky" })}>
          <IconCamera size={22} strokeWidth={2.5} />
          <span className="text-[15px]">Camera</span>
          <input
            id={camId}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={pickFile}
            className="sr-only"
            data-testid="composer-camera"
          />
        </label>
        <label className={buttonClasses({ variant: "secondary", className: "relative shrink-0 gap-1.5 px-3 focus-within:outline-3 focus-within:outline-sky" })}>
          <span className="text-xl leading-none" aria-hidden="true">
            🖼️
          </span>
          <span className="text-[15px]">Library</span>
          <input id={libId} type="file" accept="image/*" onChange={pickFile} className="sr-only" data-testid="composer-library" />
        </label>
        <Button type="submit" className="ml-auto min-w-0 flex-1 px-3" disabled={!ready} loading={busy} data-testid="composer-submit">
          Post
        </Button>
      </div>
    </form>
  );
}
