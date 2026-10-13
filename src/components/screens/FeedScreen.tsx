"use client";
// Feed tab: composer, filter chips, then the newest-first stream of automatic events and player
// posts with photos and reactions. Writes only through store.dispatch (post.create, reaction.set,
// feed.delete).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FeedEvent, ReactionKind } from "@/lib/types";
import { renderFeedEvent, type RenderedEvent } from "@/lib/events/templates";
import { useClientState, useTripStore } from "@/lib/client/react";
import { BottomSheet, Button, Chip, EmptyState, displayName, useConfirm, useToast } from "@/components/ui";
import { Screen } from "@/components/shell/Screen";
import { useShellNav } from "@/components/shell/nav";
import { Composer, POSTED_TOAST_ID } from "@/components/feed/Composer";
import { FeedCard } from "@/components/feed/FeedCard";
import { PhotoViewer } from "@/components/feed/PhotoViewer";
import {
  FEED_FILTERS,
  FEED_PAGE_SIZE,
  canDeleteEvent,
  deleteNeedsCommissioner,
  emptyReactionSummary,
  feedNow,
  matchesFilter,
  sortFeed,
  summarizeReactions,
  type FeedFilter,
} from "@/components/feed/model";

const EMPTY_SUMMARY = emptyReactionSummary();

/** Device clock, ticking every 30 s (relative times). */
function useClock(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function FeedScreen() {
  const store = useTripStore();
  const view = useClientState((s) => s.view);
  const derived = useClientState((s) => s.derived);
  const meId = useClientState((s) => s.meId);
  const isCommissioner = useClientState((s) => s.isCommissioner);
  const serverTime = useClientState((s) => s.snapshot?.meta.server_time ?? null);
  const confirmedFeed = useClientState((s) => s.snapshot?.state.feed_events ?? null);
  const nav = useShellNav();
  const toast = useToast();
  const confirm = useConfirm();
  const clock = useClock();
  const nowMs = feedNow(clock, serverTime);

  const [filter, setFilter] = useState<FeedFilter>("all");
  const [limit, setLimit] = useState(FEED_PAGE_SIZE);
  const [menuFor, setMenuFor] = useState<FeedEvent | null>(null);
  const [photo, setPhoto] = useState<{ src: string; caption: string } | null>(null);

  const feedEvents = view?.feed_events;
  const sorted = useMemo(() => (feedEvents ? sortFeed(feedEvents) : []), [feedEvents]);
  const rendered = useMemo(() => {
    const out = new Map<string, RenderedEvent>();
    if (!view || !derived) return out;
    for (const ev of sorted) out.set(ev.id, renderFeedEvent(ev, view, derived));
    return out;
  }, [sorted, view, derived]);
  const reactions = useMemo(() => summarizeReactions(view?.reactions ?? [], meId), [view?.reactions, meId]);
  const confirmedIds = useMemo(() => new Set((confirmedFeed ?? []).map((e) => e.id)), [confirmedFeed]);
  const filtered = useMemo(
    () => (filter === "all" ? sorted : sorted.filter((ev) => matchesFilter(ev, filter, rendered.get(ev.id)?.tone))),
    [sorted, filter, rendered],
  );

  const playerById = derived?.playerById;
  const nameOf = useCallback((id: string) => displayName(playerById?.[id] ?? view?.players.find((p) => p.id === id) ?? null), [playerById, view?.players]);

  const onReact = useCallback(
    (ev: FeedEvent, kind: ReactionKind, on: boolean) => {
      if (!meId) {
        toast.info("Pick your name first (menu → Switch player). Lurkers don't get a vote.", { id: "react-no-me" });
        return;
      }
      const res = store.dispatch({ type: "reaction.set", feed_event_id: ev.id, player_id: meId, kind, on });
      if (!res.ok) toast.error(res.reason, { title: "Reaction didn't stick", id: `react-${ev.id}` });
    },
    [meId, store, toast],
  );

  const onOpenPhoto = useCallback((src: string, caption: string) => setPhoto({ src, caption }), []);
  const closePhoto = useCallback(() => setPhoto(null), []);
  const onMenu = useCallback(
    (ev: FeedEvent) => {
      toast.dismiss(POSTED_TOAST_ID); // it would sit on top of the sheet's buttons
      setMenuFor(ev);
    },
    [toast],
  );

  const doDelete = async (ev: FeedEvent) => {
    setMenuFor(null);
    const asCommish = deleteNeedsCommissioner(ev, meId);
    const ok = await confirm({
      title: ev.type === "post" ? "Delete this post?" : "Delete this feed item?",
      body: asCommish
        ? "It disappears for everyone. Once the round is live, deleting someone else's stuff posts a Commissioner override. Transparency."
        : "It disappears for everyone. Reactions go with it.",
      emoji: "🗑️",
      confirmLabel: "Delete it",
      tone: "danger",
    });
    if (!ok) return;
    const res = store.dispatch(asCommish ? { type: "feed.delete", event_id: ev.id, as_commissioner: true } : { type: "feed.delete", event_id: ev.id });
    if (res.ok) toast.success("Gone. It never happened.", { emoji: "🗑️", id: `deleted-${ev.id}` });
    else toast.error(res.reason, { title: "Couldn't delete" });
  };

  if (!view || !derived) return null;

  const me = meId ? (derived.playerById[meId] ?? null) : null;
  const visible = filtered.slice(0, limit);
  const remaining = filtered.length - visible.length;

  return (
    <Screen>
      <Composer meId={me ? meId : null} myName={me ? displayName(me) : null} onPickName={nav.switchPlayer} />

      <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 pb-0.5" role="group" aria-label="Filter the feed">
        {FEED_FILTERS.map((f) => (
          <Chip
            key={f.value}
            tone="ink"
            selected={filter === f.value}
            showCheck={false}
            leading={<span aria-hidden="true">{f.emoji}</span>}
            onClick={() => {
              setFilter(f.value);
              setLimit(FEED_PAGE_SIZE);
            }}
            className="shrink-0 px-3.5 text-[15px]"
            data-testid={`feed-filter-${f.value}`}
          >
            {f.label}
          </Chip>
        ))}
      </div>

      {visible.length === 0 ? (
        filter === "all" ? (
          <EmptyState emoji="📭" title="Dead quiet">
            Nothing has happened yet. Post something, tee off, or crack a beer. The feed is hungry.
          </EmptyState>
        ) : (
          <EmptyState emoji="🦗" title="Nothing here">
            No {FEED_FILTERS.find((f) => f.value === filter)?.label.toLowerCase()} yet.
          </EmptyState>
        )
      ) : (
        <ol className="space-y-3" aria-label="Feed" data-testid="feed-list">
          {visible.map((ev) => {
            const r = rendered.get(ev.id) ?? renderFeedEvent(ev, view, derived);
            const authorId = ev.type === "post" ? (ev.player_id ?? ev.actor_id) : null;
            const author = authorId ? (derived.playerById[authorId] ?? view.players.find((p) => p.id === authorId) ?? null) : null;
            const team = ev.team_id ? (derived.teamById[ev.team_id] ?? view.teams.find((t) => t.id === ev.team_id) ?? null) : null;
            return (
              <li key={ev.id}>
                <FeedCard
                  ev={ev}
                  r={r}
                  author={author}
                  team={team}
                  nowMs={nowMs}
                  photoSrc={ev.photo_path ? store.photoUrl(ev.photo_path) : null}
                  pending={!confirmedIds.has(ev.id)}
                  reactions={reactions.get(ev.id) ?? EMPTY_SUMMARY}
                  meId={me ? meId : null}
                  canDelete={canDeleteEvent(ev, meId, isCommissioner)}
                  nameOf={nameOf}
                  onReact={onReact}
                  onMenu={onMenu}
                  onOpenPhoto={onOpenPhoto}
                />
              </li>
            );
          })}
        </ol>
      )}

      {remaining > 0 && (
        <Button variant="secondary" size="lg" full onClick={() => setLimit((n) => n + FEED_PAGE_SIZE)} data-testid="feed-more">
          Show more ({remaining} older)
        </Button>
      )}
      {remaining === 0 && filtered.length > FEED_PAGE_SIZE && (
        <p className="py-2 text-center text-[14px] font-bold text-muted">That&apos;s everything. You&apos;ve read the whole saga.</p>
      )}

      <BottomSheet
        open={!!menuFor}
        onClose={() => setMenuFor(null)}
        title={menuFor?.type === "post" ? "Post options" : "Feed item options"}
      >
        {menuFor && (
          <div className="space-y-2.5 pb-1">
            {deleteNeedsCommissioner(menuFor, meId) && (
              <p className="text-[15px] font-semibold text-muted">Commissioner powers. Use them wisely (you won&apos;t).</p>
            )}
            <Button variant="danger" size="lg" full leading={<span aria-hidden="true">🗑️</span>} onClick={() => void doDelete(menuFor)} data-testid="feed-delete">
              Delete
            </Button>
            <Button variant="secondary" size="lg" full onClick={() => setMenuFor(null)}>
              Never mind
            </Button>
          </div>
        )}
      </BottomSheet>

      <PhotoViewer src={photo?.src ?? null} caption={photo?.caption} onClose={closePhoto} />
    </Screen>
  );
}
