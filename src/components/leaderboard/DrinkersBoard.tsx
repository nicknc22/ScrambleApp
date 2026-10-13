"use client";
// Individual drinking leaderboard: drinks, shotguns, shots, total (ties share a rank).
import type { UUID } from "@/lib/types";
import type { Derived } from "@/lib/engine/types";
import { Avatar, EmptyState, PlayerName, cx, teamColor } from "@/components/ui";
import { drinkerRanks } from "./model";

const GRID = "grid grid-cols-[1.75rem_minmax(0,1fr)_1.9rem_1.9rem_1.9rem_2.6rem] items-center gap-x-1";

export function DrinkersBoard({ derived, meId }: { derived: Derived; meId: UUID | null }) {
  const rows = drinkerRanks(derived.drinkers);
  if (rows.length === 0) {
    return (
      <EmptyState emoji="🍺" title="No drinkers yet">
        Nobody&apos;s on a team yet, so nobody&apos;s drinking on the record. Yet.
      </EmptyState>
    );
  }
  const topTotal = rows[0]?.total ?? 0;
  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-2xl border-2 border-ink bg-paper shadow-hard-sm" data-testid="drinkers">
        <div className={cx(GRID, "bg-ink py-1.5 pr-2 pl-2 text-[10px] leading-tight font-black tracking-tight text-white uppercase")} aria-hidden="true">
          <span>#</span>
          <span>Player</span>
          <span className="text-center">
            🍺
            <br />
            Drk
          </span>
          <span className="text-center">
            💥
            <br />
            SG
          </span>
          <span className="text-center">
            🥃
            <br />
            Shot
          </span>
          <span className="text-right">
            <br />
            Total
          </span>
        </div>
        <ol aria-label="Drinkers">
          {rows.map((r) => {
            const p = derived.playerById[r.player_id];
            const team = r.team_id ? derived.teamById[r.team_id] : undefined;
            const king = topTotal > 0 && r.total === topTotal;
            const mine = meId !== null && r.player_id === meId;
            return (
              <li
                key={r.player_id}
                data-testid="drinker-row"
                data-player-id={r.player_id}
                aria-label={`${p ? p.name : "Somebody"}: ${r.drinks} drinks, ${r.shotguns} shotguns, ${r.shots} shots, ${r.total} total`}
                className={cx(
                  GRID,
                  "min-h-14 border-t-2 border-line py-1.5 pr-2 pl-2 first:border-t-0",
                  king ? "bg-beer-soft" : mine ? "bg-hazard-soft" : "",
                )}
              >
                <span className="num text-[15px] font-black">{r.rank_label}</span>
                <span className="flex min-w-0 items-center gap-2">
                  <Avatar player={p} teamSortOrder={team?.sort_order ?? null} size="sm" showCrown={false} />
                  <span className="min-w-0">
                    <span className="block truncate text-[15px] leading-tight font-extrabold">
                      {king && (
                        <span className="mr-1" aria-label="most drinks">
                          🏆
                        </span>
                      )}
                      <PlayerName player={p} />
                    </span>
                    <span className="flex items-center gap-1 truncate text-[12px] leading-tight font-bold text-muted">
                      {mine && <span className="shrink-0 rounded bg-ink px-1 text-[10px] font-black text-white">YOU</span>}
                      <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: teamColor(team?.sort_order ?? null).bg }} />
                      <span className="truncate">{team?.name ?? "No team"}</span>
                    </span>
                  </span>
                </span>
                <span className="num text-center text-[15px] font-bold">{r.drinks}</span>
                <span className="num text-center text-[15px] font-bold">{r.shotguns}</span>
                <span className="num text-center text-[15px] font-bold">{r.shots}</span>
                <span className={cx("num text-right font-black", king ? "loud text-[22px] text-beer-dark" : "text-[18px]")}>{r.total}</span>
              </li>
            );
          })}
        </ol>
      </div>
      <p className="text-sm font-semibold text-muted">
        Shotguns and shots count as a drink <em>and</em> bank a mulligan. {topTotal > 0 ? "🏆 marks the liver of the day." : "Somebody crack one."}
      </p>
    </div>
  );
}
