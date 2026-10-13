"use client";
// Contest button for par 3s (Closest to pin) and par 5s (Measure drive), plus the current leader.
import type { ContestHoleSummary } from "@/lib/engine/types";
import type { HoleContest, Player, UUID } from "@/lib/types";
import { formatFeetInches } from "@/lib/engine/format";
import { Button, Card, displayName } from "@/components/ui";

export function ContestPanel({
  hole,
  contest,
  summary,
  playerById,
  canMeasure,
  disabled,
  onOpen,
}: {
  hole: number;
  contest: HoleContest;
  summary: ContestHoleSummary | undefined;
  playerById: Record<UUID, Player>;
  /** Long drive: only on the team's current hole. */
  canMeasure: boolean;
  disabled: boolean;
  onOpen: () => void;
}) {
  if (contest === "none") return null;
  const ctp = contest === "ctp";
  const leaders = (summary?.leader_ids ?? []).map((id) => displayName(playerById[id])).join(" & ");
  const best = summary?.best;
  const bestLabel = best === null || best === undefined ? null : ctp ? formatFeetInches(best) : `${best} yd`;
  const entries = summary?.entries.length ?? 0;
  return (
    <Card tone="sky" className="space-y-3 border-sky-dark" data-testid="contest-panel">
      <div className="flex items-start gap-3">
        <span className="text-4xl leading-none" aria-hidden="true">
          {ctp ? "🎯" : "💥"}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg leading-tight font-black uppercase">{ctp ? "Closest to pin" : "Long drive"} · hole {hole}</h2>
          <p className="text-[15px] font-bold">
            {bestLabel ? (
              <>
                Leader: <span className="font-black">{leaders || "?"}</span> at <span className="num font-black">{bestLabel}</span>
                {entries > 1 ? ` · ${entries} entries` : ""}
              </>
            ) : ctp ? (
              "No one's on the board. Own tee shot, on the green, photo with the flag."
            ) : (
              "No drives yet. Fairway only, stand at your ball, then measure."
            )}
          </p>
        </div>
      </div>
      {ctp ? (
        <Button variant="primary" size="lg" full disabled={disabled} onClick={onOpen} leading={<span aria-hidden="true">🎯</span>}>
          Closest to pin
        </Button>
      ) : (
        <>
          <Button variant="hazard" size="lg" full disabled={disabled || !canMeasure} onClick={onOpen} leading={<span aria-hidden="true">📏</span>}>
            Measure drive
          </Button>
          {!canMeasure && <p className="text-sm font-bold">Measuring only works on your team&apos;s current hole.</p>}
        </>
      )}
    </Card>
  );
}
