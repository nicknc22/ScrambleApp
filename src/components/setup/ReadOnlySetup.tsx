"use client";
// What a non-commissioner sees on Setup: teams, tee times, the money on the line, and the way in.
import { useClientState } from "@/lib/client/react";
import { formatCents } from "@/lib/engine/format";
import { Avatar, Button, Card, IconUnlock, PlayerName, SectionHeader, TeamPill } from "@/components/ui";
import { useShellNav } from "@/components/shell/nav";
import { formatTeeTime, rosterGroups } from "@/components/shell/roster";
import { contestHoles, maxExposureCents, payoutLabel } from "./model";

export function ReadOnlySetup() {
  const view = useClientState((s) => s.view);
  const meId = useClientState((s) => s.meId);
  const nav = useShellNav();
  if (!view) return null;
  const groups = rosterGroups(view, { includeEmptyTeams: true });
  const st = view.trip.settings;
  const holes = contestHoles(view.holes);
  return (
    <div className="space-y-4" data-testid="setup-readonly">
      <Card tone="ink" className="space-y-3">
        <p className="text-2xl leading-tight font-black">🔒 Commissioner only</p>
        <p className="text-[15px] font-bold">You can look, but only the commissioner can touch. Got the PIN?</p>
        <Button variant="hazard" size="lg" full onClick={nav.openSettings} leading={<IconUnlock size={22} />} data-testid="unlock-commissioner">
          Unlock commissioner
        </Button>
      </Card>

      <SectionHeader title="Teams" subtitle={`${groups.reduce((n, g) => n + g.players.length, 0)} players`} />
      <div className="space-y-3">
        {groups.map((g) => (
          <Card key={g.team?.id ?? "free"} className="space-y-2">
            <div className="flex items-center gap-2">
              <TeamPill team={g.team} size="lg" />
              {g.team?.tee_time && <span className="text-sm font-black">⏰ {formatTeeTime(g.team.tee_time)}</span>}
            </div>
            {g.players.length === 0 ? (
              <p className="text-sm font-bold text-muted">Nobody yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {g.players.map((p) => (
                  <li key={p.id} className="flex items-center gap-2 text-[17px] font-extrabold">
                    <Avatar player={p} teamSortOrder={g.team?.sort_order ?? null} size="sm" showCrown={false} />
                    <PlayerName player={p} you={p.id === meId} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        ))}
      </div>

      <SectionHeader title="Pots" />
      <Card className="space-y-1 text-[15px] font-bold">
        <p>
          Team match: <span className="font-black">{formatCents(st.team_match_ante_cents)}</span> a head · {payoutLabel(st.team_match_payout)}
        </p>
        <p>
          Contests: <span className="font-black">{formatCents(st.contest_ante_cents)}</span> a hole × {holes.length}
        </p>
        <p className="pt-1 text-lg font-black">In for up to {formatCents(maxExposureCents(st, holes.length))}</p>
      </Card>
    </div>
  );
}
