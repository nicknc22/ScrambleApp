"use client";
// Tap-to-move: tap a player on the Teams board, pick where he goes. The reliable path on phones.
import { useClientState } from "@/lib/client/react";
import { Avatar, Badge, BottomSheet, IconChevronRight, cx, displayName, teamColor } from "@/components/ui";
import { MAX_TEAM_SIZE, liveTeams, membersByTeam, teamIdByPlayer } from "./model";

export function MoveSheet({ playerId, onClose, onMove }: { playerId: string | null; onClose: () => void; onMove: (teamId: string | null) => void }) {
  const view = useClientState((s) => s.view);
  const player = playerId ? (view?.players.find((p) => p.id === playerId && !p.deleted_at) ?? null) : null;
  const open = player !== null;
  const teams = view ? liveTeams(view) : [];
  const members = view ? membersByTeam(view) : new Map<string, never[]>();
  const current = view && player ? (teamIdByPlayer(view).get(player.id) ?? null) : null;

  const pick = (teamId: string | null) => {
    onClose();
    if (teamId !== current) onMove(teamId);
  };

  return (
    <BottomSheet open={open} onClose={onClose} title={player ? `Move ${displayName(player)}` : ""}>
      {player && (
        <div className="space-y-2 pb-2" data-testid="move-sheet">
          {teams.length === 0 && <p className="text-base font-bold text-muted">No teams yet. Close this and hit Add team.</p>}
          {teams.map((t) => {
            const n = members.get(t.id)?.length ?? 0;
            const here = current === t.id;
            const full = !here && n >= MAX_TEAM_SIZE;
            const c = teamColor(t.sort_order);
            const names = (members.get(t.id) ?? []).map((p) => displayName(p)).join(", ");
            return (
              <button
                key={t.id}
                type="button"
                disabled={full}
                onClick={() => pick(t.id)}
                aria-label={`Move to ${t.name}`}
                className={cx(
                  "flex min-h-16 w-full items-center gap-3 rounded-2xl border-2 px-3 py-2 text-left transition-transform active:scale-[0.98] disabled:opacity-45",
                  here ? "border-ink bg-sand" : "border-ink bg-paper",
                )}
              >
                <span aria-hidden="true" className="h-9 w-9 shrink-0 rounded-full border-2 border-ink" style={{ backgroundColor: c.bg }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-lg leading-tight font-black">{t.name}</span>
                  <span className="block truncate text-sm font-bold text-muted">{names || "Nobody yet"}</span>
                </span>
                {here ? (
                  <Badge tone="ink">Here now</Badge>
                ) : full ? (
                  <Badge tone="flag">Full</Badge>
                ) : (
                  <span className="num shrink-0 text-base font-black">
                    {n}/{MAX_TEAM_SIZE}
                  </span>
                )}
                {!here && !full && <IconChevronRight size={22} strokeWidth={3} className="shrink-0" />}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => pick(null)}
            aria-label="Move to Unassigned"
            className={cx(
              "flex min-h-16 w-full items-center gap-3 rounded-2xl border-2 border-dashed px-3 py-2 text-left active:scale-[0.98]",
              current === null ? "border-ink bg-sand" : "border-ink bg-hazard-soft",
            )}
          >
            <Avatar player={player} size="md" teamSortOrder={null} showCrown={false} />
            <span className="min-w-0 flex-1">
              <span className="block text-lg leading-tight font-black">Unassigned</span>
              <span className="block text-sm font-bold text-muted">Bench him. Everybody has to be on a team to start.</span>
            </span>
            {current === null && <Badge tone="ink">Here now</Badge>}
          </button>
        </div>
      )}
    </BottomSheet>
  );
}
