"use client";
import type { Team } from "@/lib/types";
import { Badge, IconMenu, TeamPill, cx } from "@/components/ui";
import { TripOfflineBadge } from "./TripOfflineBadge";

/** Sticky compact header: app + trip name, my team, commissioner badge, menu. Offline strip under it. */
export function TripHeader({
  appName,
  tripName,
  team,
  isCommissioner,
  hasPlayer,
  canPickPlayer = true,
  onMenu,
  onPickPlayer,
}: {
  appName: string;
  tripName: string;
  team: Pick<Team, "name" | "sort_order"> | null;
  isCommissioner: boolean;
  /** A player is chosen on this device. */
  hasPlayer: boolean;
  /** The roster has someone to pick (hides "Pick your name" on an empty roster). */
  canPickPlayer?: boolean;
  onMenu: () => void;
  onPickPlayer: () => void;
}) {
  return (
    <header className="sticky top-0 z-30 border-b-2 border-ink bg-paper pt-[env(safe-area-inset-top)]">
      <div className="mx-auto flex h-14 max-w-xl items-center gap-2 pr-1 pl-[max(12px,env(safe-area-inset-left))]">
        <svg width="30" height="30" viewBox="0 0 48 48" aria-hidden="true" className="shrink-0">
          <ellipse cx="20" cy="42" rx="16" ry="4" fill="#0a7d3e" />
          <path d="M17 42V5" stroke="#0b0f0c" strokeWidth="4.5" strokeLinecap="round" />
          <path d="M19 6l22 8-22 8z" fill="#ffd60a" stroke="#0b0f0c" strokeWidth="3" strokeLinejoin="round" />
        </svg>
        <div className="min-w-0 flex-1 leading-none">
          <div className="truncate text-[11px] font-black tracking-[0.14em] text-fairway-dark uppercase">{appName}</div>
          <div className="truncate text-[17px] font-black text-ink" data-testid="trip-name">
            {tripName}
          </div>
        </div>
        {isCommissioner && (
          <Badge tone="ink" className="max-[399px]:hidden" title="Commissioner powers on">
            Commish
          </Badge>
        )}
        {hasPlayer ? (
          team ? (
            <TeamPill team={team} size="sm" className="max-w-[34vw]" />
          ) : null
        ) : !canPickPlayer ? null : (
          <button
            type="button"
            onClick={onPickPlayer}
            className="btn min-h-10 shrink-0 rounded-full! border-ink bg-hazard px-3 text-sm font-black text-ink"
          >
            Pick your name
          </button>
        )}
        <button
          type="button"
          onClick={onMenu}
          aria-label="Menu"
          data-testid="menu-button"
          className={cx("btn h-12 w-12 shrink-0 border-transparent bg-transparent p-0! text-ink active:bg-sand", isCommissioner && "relative")}
        >
          <IconMenu size={28} strokeWidth={3} />
          {isCommissioner && (
            <span className="absolute top-2 right-2 h-2.5 w-2.5 rounded-full border-2 border-paper bg-fairway min-[400px]:hidden" aria-hidden="true" />
          )}
        </button>
      </div>
      <TripOfflineBadge variant="bar" />
    </header>
  );
}
