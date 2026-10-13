"use client";
// One feed item. Templated events render via renderFeedEvent (emoji/title/body/tone/big); player
// posts show the author, text and photo; AI roasts and commissioner overrides get their own looks.
import { memo } from "react";
import type { FeedEvent, Player, ReactionKind, Team } from "@/lib/types";
import type { RenderedEvent } from "@/lib/events/templates";
import { Avatar, IconButton, PlayerName, cx, teamColor } from "@/components/ui";
import { ALWAYS_BIG, cardVariant, isRecentEvent, relativeTime, type CardVariant, type ReactionSummary } from "./model";
import { FeedPhoto } from "./FeedPhoto";
import { ReactionBar } from "./ReactionBar";

const BOX: Record<CardVariant, string> = {
  post: "border-ink bg-paper",
  ai_roast: "border-ink bg-ink text-white",
  override: "border-ink bg-hazard-soft",
  results_changed: "border-flag-dark bg-flag text-white",
  // Transparency, not a scandal: a quiet dashed card (the template says who removed what).
  removed: "border-line-strong border-dashed bg-sand",
  ghost: "border-ghost-dark bg-ghost text-white",
  groom: "border-ink bg-gold text-ink",
  final: "border-ink bg-gold text-ink",
  lead: "border-ink bg-hazard text-ink",
  hype: "border-fairway bg-fairway-soft",
  roast: "border-flag bg-flag-soft",
  alert: "border-ink bg-hazard-soft",
  fanfare: "border-ghost bg-ghost-soft",
  info: "border-line bg-paper",
};

const DARK: ReadonlySet<CardVariant> = new Set<CardVariant>(["ai_roast", "ghost", "results_changed"]);

/** Hazard-tape band across the top of the cards that are about the rules being bent. */
const STRIPED: ReadonlySet<CardVariant> = new Set<CardVariant>(["override", "results_changed"]);

export interface FeedCardProps {
  ev: FeedEvent;
  r: RenderedEvent;
  author: Player | null;
  team: Team | null;
  nowMs: number;
  photoSrc: string | null;
  /** Created on this phone and not yet confirmed by the server. */
  pending: boolean;
  /** Its photo is still uploading from this phone (the post itself may already be synced). */
  photoPending?: boolean;
  /** Changes with every fresh snapshot (photo cards only): a photo that didn't load retries. */
  photoRefreshKey?: string | null;
  reactions: ReactionSummary;
  meId: string | null;
  canDelete: boolean;
  /** Display name for a player id (for "who reacted"). */
  nameOf: (playerId: string) => string;
  onReact: (ev: FeedEvent, kind: ReactionKind, on: boolean) => void;
  onMenu: (ev: FeedEvent) => void;
  onOpenPhoto: (src: string, caption: string) => void;
}

export const FeedCard = memo(function FeedCard({
  ev,
  r,
  author,
  team,
  nowMs,
  photoSrc,
  pending,
  photoPending = false,
  photoRefreshKey = null,
  reactions,
  meId,
  canDelete,
  nameOf,
  onReact,
  onMenu,
  onOpenPhoto,
}: FeedCardProps) {
  const variant = cardVariant(ev.type, r.tone);
  const dark = DARK.has(variant);
  const big = r.big || ALWAYS_BIG.has(variant);
  const time = relativeTime(ev.created_at, nowMs);
  const mutedText = dark ? "text-white/75" : "text-muted";
  const whoNames = (kind: ReactionKind) => reactions.who[kind].map(nameOf).join(", ");
  const caption = variant === "post" ? `${r.title}${ev.text ? `: ${ev.text}` : ""}` : r.title;

  return (
    <article
      data-testid="feed-item"
      data-type={ev.type}
      data-id={ev.id}
      data-big={big || undefined}
      data-pending={pending || undefined}
      aria-label={variant === "post" ? `Post by ${r.title}` : r.title}
      className={cx(
        "relative overflow-hidden rounded-2xl border-2",
        BOX[variant],
        big ? "px-4 pt-4 pb-3 shadow-hard" : "px-3.5 pt-3 pb-3",
        pending && "opacity-90",
      )}
    >
      {STRIPED.has(variant) && (
        <div
          className="absolute inset-x-0 top-0 h-2"
          style={{ background: "repeating-linear-gradient(135deg, var(--color-ink) 0 10px, var(--color-hazard) 10px 20px)" }}
          aria-hidden="true"
        />
      )}
      {variant === "groom" && <div className="fanfare-rays pointer-events-none opacity-60" aria-hidden="true" />}

      <div className={cx("relative flex items-start gap-3", STRIPED.has(variant) && "pt-1.5")}>
        {variant === "post" ? (
          <Avatar player={author} teamSortOrder={team?.sort_order ?? null} size="md" showCrown={false} />
        ) : (
          <span className={cx("shrink-0 leading-none", big ? "animate-bounce-in text-[52px]" : "text-[34px]")} aria-hidden="true">
            {r.emoji}
          </span>
        )}
        <div className="min-w-0 flex-1">
          {variant === "ai_roast" && (
            <span className="mb-1 inline-flex items-center gap-1 rounded-full border-2 border-hazard bg-hazard px-2 py-0.5 text-[11px] font-black tracking-wider text-ink uppercase">
              🤖 AI Roast
            </span>
          )}
          {variant === "override" && (
            <span className="mb-1 inline-flex items-center gap-1 rounded-full border-2 border-ink bg-ink px-2 py-0.5 text-[11px] font-black tracking-wider text-hazard uppercase">
              ⚠️ Commissioner override
            </span>
          )}
          {variant === "results_changed" && (
            <span
              className="mb-1 inline-flex items-center gap-1 rounded-full border-2 border-ink bg-hazard px-2 py-0.5 text-[11px] font-black tracking-wider text-ink uppercase"
              data-testid="results-changed-badge"
            >
              🚨 Final results changed
            </span>
          )}
          <h3
            className={cx(
              "leading-[1.05] break-words",
              variant === "post" ? "text-[17px] font-black" : big ? "loud text-[28px]" : "text-[18px] font-black",
            )}
          >
            {variant === "post" ? <PlayerName player={author} you={!!meId && author?.id === meId} /> : r.title}
          </h3>
          <p className={cx("mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[13px] font-bold", mutedText)}>
            {team && (
              <span className="inline-flex min-w-0 items-center gap-1">
                <span
                  className="inline-block h-2.5 w-2.5 shrink-0 rounded-full border border-ink/30"
                  style={{ backgroundColor: teamColor(team.sort_order).bg }}
                  aria-hidden="true"
                />
                <span className="max-w-[11rem] truncate">{team.name}</span>
              </span>
            )}
            {team && time && <span aria-hidden="true">·</span>}
            {time && (
              <time dateTime={ev.created_at} data-testid="feed-time">
                {time}
              </time>
            )}
            {pending && (
              <span className={cx("rounded-full px-1.5 text-[11px] font-black uppercase", dark ? "bg-white/20" : "bg-sand text-ink")}>Sending…</span>
            )}
          </p>
        </div>
        {canDelete && (
          <IconButton
            label="Post options"
            onClick={() => onMenu(ev)}
            className={cx("-mt-1 -mr-1.5 text-2xl leading-none", dark && "text-white")}
            data-testid="feed-menu"
          >
            <span aria-hidden="true">⋯</span>
          </IconButton>
        )}
      </div>

      {r.body && (
        <p
          className={cx(
            "relative mt-2 break-words whitespace-pre-line",
            variant === "ai_roast" ? "text-[19px] leading-snug font-extrabold italic" : big ? "text-[18px] leading-snug font-bold" : "text-[16px] leading-snug font-semibold",
          )}
          data-testid="feed-body"
        >
          {variant === "ai_roast" ? `“${r.body}”` : r.body}
        </p>
      )}

      {ev.photo_path && (
        <div className="relative mt-3">
          <FeedPhoto
            src={photoSrc}
            alt={caption}
            pending={pending || photoPending}
            big={big}
            recent={isRecentEvent(ev.created_at, nowMs)}
            refreshKey={photoRefreshKey}
            onOpen={(src) => onOpenPhoto(src, caption)}
          />
        </div>
      )}

      <div className="relative mt-3">
        <ReactionBar summary={reactions} onToggle={(kind, on) => onReact(ev, kind, on)} disabled={!meId} whoNames={whoNames} dark={dark} />
      </div>
    </article>
  );
});
