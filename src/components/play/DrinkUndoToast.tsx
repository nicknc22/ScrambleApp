"use client";
// The merged drink-undo toast: one per team burst, two single lines (title + message, truncated)
// so it stays compact. Its marker attribute lets ActionBar park the toast over the tab bar while it
// is up, so it never covers the drink buttons a teammate is about to tap (or Save / On the tee).
import type { ToastAction, ToastOptions, ToastTone } from "@/components/ui";
import type { ToastCopy } from "./model";

/** Marker on the toast's message; ActionBar's CSS keys off it. */
export const DRINK_UNDO_ATTR = "data-drink-undo";

export function drinkUndoToast(opts: ToastCopy & { id: string; tone: ToastTone; action?: ToastAction; duration?: number }): ToastOptions {
  return {
    id: opts.id,
    tone: opts.tone,
    emoji: opts.emoji,
    action: opts.action,
    duration: opts.duration,
    title: <span className="block truncate">{opts.title}</span>,
    message: (
      <span className="block truncate" {...{ [DRINK_UNDO_ATTR]: "" }}>
        {opts.message}
      </span>
    ),
  };
}
