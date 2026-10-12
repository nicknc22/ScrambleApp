"use client";
// "Who are you?" Roster grid grouped by team. Tap your name -> stored on this device.
import { useState } from "react";
import { useClientState, useTripStore } from "@/lib/client/react";
import type { Player, Team } from "@/lib/types";
import {
  Avatar,
  Badge,
  BottomSheet,
  Button,
  EmptyState,
  IconRefresh,
  IconUnlock,
  PlayerName,
  TeamPill,
  teamColor,
} from "@/components/ui";
import { CommissionerUnlock } from "@/components/shell/CommissionerUnlock";
import { formatTeeTime, rosterGroups } from "@/components/shell/roster";

export interface JoinScreenProps {
  /** Called after store.setMe(playerId). */
  onJoined?: (playerId: string) => void;
  /** Commissioner only: skip picking a player (setup before the roster exists). */
  onSkip?: () => void;
  /** Shown when switching players: go back without changing anything. */
  onCancel?: () => void;
}

const STATUS_BADGE = {
  setup: { tone: "hazard", text: "Pre-round" },
  live: { tone: "flag", text: "● Live" },
  final: { tone: "ink", text: "Final" },
} as const;

export function JoinScreen({ onJoined, onSkip, onCancel }: JoinScreenProps) {
  const store = useTripStore();
  const view = useClientState((s) => s.view);
  const meId = useClientState((s) => s.meId);
  const isCommissioner = useClientState((s) => s.isCommissioner);
  const [pinOpen, setPinOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  if (!view) return null;
  const trip = view.trip;
  const groups = rosterGroups(view);
  const status = STATUS_BADGE[trip.status];

  const pick = (p: Player) => {
    store.setMe(p.id);
    onJoined?.(p.id);
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      await store.refresh();
    } catch {
      /* the offline badge says why */
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="min-h-dvh bg-paper pb-[calc(24px+env(safe-area-inset-bottom))]" data-testid="join-screen">
      <header
        className="border-b-2 border-ink px-gutter pt-[calc(20px+env(safe-area-inset-top))] pb-6 text-white"
        style={{ background: "radial-gradient(circle at 85% 0%, #15a356 0%, #0a7d3e 45%, #064d27 100%)" }}
      >
        <div className="mx-auto max-w-xl">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-black tracking-[0.16em] uppercase">⛳ {trip.app_name || "Scramble"}</span>
            <Badge tone={status.tone} size="md">
              {status.text}
            </Badge>
          </div>
          <h1 className="loud mt-3 text-[clamp(2.4rem,12vw,3.75rem)] break-words">{trip.name}</h1>
          <p className="mt-2 text-base font-bold">{trip.settings.course_name}</p>
        </div>
      </header>

      <main className="mx-auto max-w-xl px-gutter pt-5">
        <h2 className="loud text-4xl">Who are you?</h2>
        <p className="mt-1 text-lg font-bold text-ink">Tap your name. This phone will remember it.</p>

        {groups.length === 0 ? (
          <EmptyState
            emoji="🦗"
            title="Nobody's here yet"
            action={
              <Button variant="secondary" size="lg" full loading={refreshing} onClick={refresh} leading={<IconRefresh size={22} />}>
                Check again
              </Button>
            }
          >
            The commissioner hasn&apos;t added the roster yet. Go hassle him in the group chat.
          </EmptyState>
        ) : (
          <div className="mt-5 space-y-6">
            {groups.map((g) => (
              <RosterGroupBlock key={g.team?.id ?? "free"} team={g.team} players={g.players} meId={meId} onPick={pick} />
            ))}
          </div>
        )}

        <div className="mt-8 space-y-3 border-t-2 border-line pt-5">
          {onCancel && (
            <Button variant="secondary" size="lg" full onClick={onCancel}>
              Never mind, go back
            </Button>
          )}
          {isCommissioner ? (
            onSkip && (
              <Button variant="ink" size="lg" full onClick={onSkip}>
                I&apos;m just setting up. Skip for now
              </Button>
            )
          ) : (
            <Button variant="ghost" full onClick={() => setPinOpen(true)} leading={<IconUnlock size={20} />}>
              Commissioner? Unlock with PIN
            </Button>
          )}
        </div>
      </main>

      <BottomSheet open={pinOpen} onClose={() => setPinOpen(false)} title="Commissioner unlock">
        <div className="pb-4">
          <CommissionerUnlock
            onUnlocked={() => {
              setPinOpen(false);
            }}
          />
        </div>
      </BottomSheet>
    </div>
  );
}

function RosterGroupBlock({
  team,
  players,
  meId,
  onPick,
}: {
  team: Team | null;
  players: Player[];
  meId: string | null;
  onPick: (p: Player) => void;
}) {
  const c = teamColor(team ? team.sort_order : null);
  const tee = formatTeeTime(team?.tee_time);
  return (
    <section>
      <div className="mb-2.5 flex items-center gap-2">
        {team ? <TeamPill team={team} size="md" /> : <span className="text-lg font-black uppercase">Free agents</span>}
        {tee && <span className="text-sm font-extrabold text-muted">Tee {tee}</span>}
      </div>
      <ul className="grid grid-cols-2 gap-2.5">
        {players.map((p) => (
          <li key={p.id} className="min-w-0">
            <button
              type="button"
              onClick={() => onPick(p)}
              data-testid="join-player"
              className="flex min-h-[72px] w-full items-center gap-2 rounded-2xl border-2 border-ink bg-paper py-2 pr-1.5 pl-2 text-left shadow-hard-sm transition-transform active:translate-y-0.5 active:shadow-none"
              style={{ borderLeftWidth: 8, borderLeftColor: c.bg }}
            >
              <Avatar player={p} teamSortOrder={team?.sort_order ?? null} size="sm" showCrown={false} />
              <span className="line-clamp-3 min-w-0 flex-1 text-[17px] leading-tight font-black [overflow-wrap:anywhere] min-[400px]:text-lg">
                <PlayerName player={p} you={p.id === meId} />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
