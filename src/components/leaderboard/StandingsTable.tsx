"use client";
// The live team table: Pos, Team, Thru, Gross, Drinks, Credit, Net, To par. Every column fits at
// 360px (compact tabular numbers, short headers, team names clamp). Tap a row for the team card.
import { useEffect, useRef, useState } from "react";
import type { Team, UUID } from "@/lib/types";
import type { StandingRow } from "@/lib/engine/types";
import { cx, teamColor } from "@/components/ui";
import { positionDeltas, standingsView, toParTone, type StandingView } from "./model";
import { useFlip } from "./useFlip";

const GRID = "grid grid-cols-[1.6rem_minmax(0,1fr)_1.45rem_1.65rem_1.4rem_1.65rem_1.65rem_2.35rem] items-center gap-x-[3px]";

const TO_PAR_CLASS: Record<ReturnType<typeof toParTone>, string> = {
  under: "text-fairway",
  even: "text-ink",
  over: "text-flag",
  none: "text-muted",
};

/** Moves since the last order change, kept for a few seconds so the arrows can be seen. */
function useMovers(order: readonly UUID[]): Record<UUID, number> {
  const key = order.join(",");
  const [seen, setSeen] = useState<{ key: string; order: readonly UUID[] }>({ key, order });
  const [movers, setMovers] = useState<{ deltas: Record<UUID, number>; stamp: number }>({ deltas: {}, stamp: 0 });
  if (seen.key !== key) {
    // React's "adjust state while rendering" pattern: compare with the previous render's order.
    setSeen({ key, order });
    setMovers((m) => ({ deltas: positionDeltas(seen.order, order), stamp: m.stamp + 1 }));
  }
  useEffect(() => {
    if (movers.stamp === 0) return;
    const t = setTimeout(() => setMovers((m) => ({ deltas: {}, stamp: m.stamp })), 6000);
    return () => clearTimeout(t);
  }, [movers.stamp]);
  return movers.deltas;
}

export function StandingsTable({
  standings,
  teamById,
  myTeamId,
  onOpenTeam,
}: {
  standings: readonly StandingRow[];
  teamById: Record<UUID, Team>;
  myTeamId: UUID | null;
  onOpenTeam: (teamId: UUID) => void;
}) {
  const rows = standingsView(standings, myTeamId);
  const order = rows.map((r) => r.team_id);
  const listRef = useRef<HTMLOListElement>(null);
  useFlip(listRef, order.join(","));
  const movers = useMovers(order);

  return (
    <div className="overflow-hidden rounded-2xl border-2 border-ink bg-paper shadow-hard-sm" data-testid="standings">
      <div
        className={cx(GRID, "bg-ink py-2 pr-1.5 pl-2.5 text-[10px] leading-none font-black tracking-tight text-white uppercase")}
        aria-hidden="true"
      >
        <span>Pos</span>
        <span className="pl-1">Team</span>
        <span className="text-center">Thru</span>
        <span className="text-right">Grs</span>
        <span className="text-center">Drk</span>
        <span className="text-right">Cred</span>
        <span className="text-right">Net</span>
        <span className="text-right leading-[1.05]">
          To
          <br />
          par
        </span>
      </div>
      <ol ref={listRef} className="relative" aria-label="Team standings">
        {rows.map((r) => (
          <StandingLine key={r.team_id} row={r} team={teamById[r.team_id]} moved={movers[r.team_id] ?? 0} onOpen={onOpenTeam} />
        ))}
      </ol>
    </div>
  );
}

function StandingLine({ row: r, team, moved, onOpen }: { row: StandingView; team: Team | undefined; moved: number; onOpen: (id: UUID) => void }) {
  const color = teamColor(team?.sort_order ?? null);
  const name = team?.name || "Unnamed team";
  const label = [
    `${name}${r.mine ? " (your team)" : ""}`,
    r.started ? `position ${r.pos_label}` : "not started",
    `thru ${r.thru_label}`,
    `gross ${r.gross}`,
    `${r.drinks} drinks`,
    `credit ${r.credit}`,
    `net ${r.net}`,
    `net to par ${r.to_par}`,
  ].join(", ");
  return (
    <li data-flip={r.team_id} className="border-t-2 border-line first:border-t-0">
      <button
        type="button"
        onClick={() => onOpen(r.team_id)}
        aria-label={`${label}. Open the scorecard.`}
        data-testid="standings-row"
        data-team-id={r.team_id}
        data-pos={r.pos_label}
        data-leader={r.leader || undefined}
        data-mine={r.mine || undefined}
        className={cx(
          GRID,
          "relative min-h-14 w-full py-2 pr-1.5 pl-2.5 text-left transition-colors active:bg-sand",
          r.leader ? "bg-gold/35" : r.mine ? "bg-hazard-soft" : "bg-paper",
          r.mine && "shadow-[inset_0_0_0_3px_var(--color-ink)]",
        )}
      >
        <span className="absolute inset-y-0 left-0 w-1.5" style={{ backgroundColor: color.bg }} aria-hidden="true" />
        <span className="relative flex flex-col items-start leading-none">
          <span className={cx("num font-black", r.leader ? "loud text-[19px]" : "text-[15px]")}>{r.pos_label}</span>
          {moved !== 0 && (
            <span
              className={cx("num mt-0.5 animate-pop text-[10px] font-black", moved > 0 ? "text-fairway" : "text-flag")}
              data-testid="pos-move"
            >
              {moved > 0 ? `▲${moved}` : `▼${-moved}`}
            </span>
          )}
        </span>
        <span className="flex min-w-0 items-center gap-1 pl-1">
          <span
            className={cx(
              "line-clamp-2 min-w-0 text-[14px] leading-[1.1] break-words min-[380px]:text-[15px]",
              r.leader ? "font-black italic" : "font-extrabold",
            )}
          >
            {r.mine && <span aria-hidden="true">★ </span>}
            {name}
          </span>
        </span>
        <span className="num text-center text-[14px] font-bold">{r.thru_label}</span>
        <span className="num text-right text-[14px] font-bold">{r.gross}</span>
        <span className="num text-center text-[14px] font-bold">{r.drinks}</span>
        <span className={cx("num text-right text-[14px] font-bold", r.credit !== "0" && "text-ghost")}>{r.credit}</span>
        <span className="num text-right text-[14px] font-extrabold">{r.net}</span>
        <span className={cx("num text-right font-black", r.leader ? "text-[20px]" : "text-[17px]", TO_PAR_CLASS[toParTone(r.to_par_value)])}>
          {r.to_par}
        </span>
      </button>
    </li>
  );
}
