"use client";
// Shell side effects: toasts for server rejections, fanfare for other people's big moments,
// unread feed count, recent-trip bookkeeping.
import { useEffect, useRef } from "react";
import type { OpResult, RejectCode } from "@/lib/ops";
import type { FeedEvent, TripState } from "@/lib/types";
import type { Derived } from "@/lib/engine/types";
import { renderFeedEvent } from "@/lib/events/templates";
import { readPref, rememberTrip, writePref } from "@/lib/client/ui-prefs";
import { useFanfare, useToast } from "@/components/ui";
import { fanfareForEvent } from "./feedFanfare";

const REJECT_FALLBACK: Record<RejectCode, string> = {
  not_live: "The round isn't live, so that didn't count.",
  forbidden: "Commissioner-only. Nice try.",
  not_found: "That thing doesn't exist anymore.",
  invalid: "The server looked at that and said no.",
  no_window: "No drink window open. Tap “On the tee” first.",
  conflict: "Somebody beat you to it. Refresh and try again.",
};

/** Toast every new entry in store.rejected. */
export function useRejectedToasts(rejected: readonly OpResult[] | undefined) {
  const toast = useToast();
  const seen = useRef(new Set<string>());
  useEffect(() => {
    for (const r of rejected ?? []) {
      const key = `${r.id}:${r.code ?? ""}`;
      if (seen.current.has(key)) continue;
      seen.current.add(key);
      toast.error(r.reason || (r.code ? REJECT_FALLBACK[r.code] : null) || "The server said no.", {
        title: "That didn't save",
        id: `rejected-${r.id}`,
      });
    }
  }, [rejected, toast]);
}

/** Full-screen fanfare for new groom mulligans / ghost beers (my team) / final results caused by others. */
export function useFeedFanfare(view: TripState | null, derived: Derived | null, meId: string | null, myTeamId: string | null, serverTime: string | null) {
  const fanfare = useFanfare();
  const seen = useRef<Set<string> | null>(null);
  const events = view?.feed_events;
  useEffect(() => {
    if (!events) return;
    if (seen.current === null) {
      // First snapshot on this page load is history, not news.
      seen.current = new Set(events.map((e) => e.id));
      return;
    }
    const parsed = serverTime ? Date.parse(serverTime) : NaN;
    const nowMs = Number.isFinite(parsed) ? Math.max(parsed, Date.now()) : Date.now();
    const render = (ev: FeedEvent) => (view && derived ? renderFeedEvent(ev, view, derived) : null);
    for (const ev of events) {
      if (seen.current.has(ev.id)) continue;
      seen.current.add(ev.id);
      const f = fanfareForEvent(ev, { meId, myTeamId, nowMs, render });
      if (f) fanfare.show(f);
    }
    // view/derived only feed the copy; re-running on them alone would be harmless but pointless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, meId, myTeamId, serverTime, fanfare]);
}

const feedSeenKey = (code: string) => `scramble:feed-seen:${code}`;

export function readFeedSeen(code: string): string | null {
  return readPref(feedSeenKey(code));
}

export function writeFeedSeen(code: string, iso: string | null) {
  writePref(feedSeenKey(code), iso);
}

/** Latest created_at among active feed events (ISO), or null. */
export function latestFeedAt(view: TripState | null): string | null {
  let latest: string | null = null;
  for (const e of view?.feed_events ?? []) {
    if (e.deleted_at) continue;
    if (latest === null || e.created_at > latest) latest = e.created_at;
  }
  return latest;
}

/** Feed events newer than `seenAt` that somebody else caused. */
export function countUnread(view: TripState | null, seenAt: string | null, meId: string | null): number {
  if (!view) return 0;
  let n = 0;
  for (const e of view.feed_events) {
    if (e.deleted_at) continue;
    if (meId && e.actor_id === meId) continue;
    if (seenAt === null || e.created_at > seenAt) n++;
  }
  return n;
}

/** Keep this trip in the home page's "recent trips" list. */
export function useRememberTrip(code: string, tripName: string | null | undefined) {
  useEffect(() => {
    if (tripName) rememberTrip(code, tripName);
  }, [code, tripName]);
}
