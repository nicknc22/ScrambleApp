"use client";
// Hole number (huge), par, yardage, contest badge, team net to par, leaderboard position + thru.
import type { Hole, Team, TeeSet } from "@/lib/types";
import type { StandingRow } from "@/lib/engine/types";
import { formatToPar } from "@/lib/engine/format";
import { Badge, IconUserSwap, TeamPill, cx } from "@/components/ui";

export function HoleHeader({
  hole,
  holeRow,
  teeSet,
  team,
  isMyTeam,
  standing,
  canSwitch,
  onSwitch,
}: {
  hole: number;
  holeRow: Hole | undefined;
  teeSet: TeeSet;
  team: Team;
  isMyTeam: boolean;
  standing: StandingRow | undefined;
  canSwitch: boolean;
  onSwitch: () => void;
}) {
  const par = holeRow?.par ?? 4;
  const yards = holeRow?.yardage?.[teeSet];
  const contest = holeRow?.contest ?? "none";
  const started = !!standing && standing.thru > 0;
  return (
    <section
      className="relative overflow-hidden rounded-3xl border-2 border-ink text-white shadow-hard"
      style={{ background: "radial-gradient(circle at 85% 0%, #15a356 0%, #0a7d3e 42%, #064d27 100%)" }}
      aria-label={`Hole ${hole}, par ${par}`}
      data-testid="hole-header"
    >
      {(!isMyTeam || canSwitch) && (
        <div className="flex items-center gap-2 px-4 pt-3">
          <TeamPill team={team} size="sm" you={isMyTeam} className="max-w-[60%] border-white" />
          <span className="min-w-0 flex-1" />
          {canSwitch && (
            <button
              type="button"
              onClick={onSwitch}
              className="btn min-h-12 shrink-0 rounded-full! border-white/80 bg-white/10 px-3 text-sm font-black text-white active:bg-white/25"
            >
              <IconUserSwap size={18} strokeWidth={2.75} />
              Switch team
            </button>
          )}
        </div>
      )}
      <div className="flex items-end gap-3 px-4 pt-2 pb-2">
        <div className="min-w-0 shrink-0">
          <div className="text-[11px] font-black tracking-[0.25em] uppercase opacity-90">Hole</div>
          <div className="loud num text-[4.75rem] leading-[0.8] tracking-tight" data-testid="hole-number" style={{ textShadow: "0 4px 0 rgba(0,0,0,0.35)" }}>
            {hole}
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col items-end gap-1 text-right">
          <div className="flex items-baseline gap-2">
            {yards ? <span className="num text-base leading-none font-extrabold opacity-95">{yards} yd</span> : null}
            <span className="loud text-4xl leading-none">Par {par}</span>
          </div>
          {contest === "ctp" && (
            <Badge tone="hazard" size="md">
              🎯 Closest to pin
            </Badge>
          )}
          {contest === "ld" && (
            <Badge tone="hazard" size="md">
              💥 Long drive
            </Badge>
          )}
        </div>
      </div>
      <dl className="grid grid-cols-3 divide-x-2 divide-white/25 border-t-2 border-white/25 bg-black/25">
        <Stat label="To par" value={started ? formatToPar(standing!.net_to_par) : "E"} big={started && standing!.net_to_par < 0} />
        <Stat label="Pos" value={standing?.pos_label ?? "–"} />
        <Stat label="Thru" value={standing?.thru_label ?? "–"} />
      </dl>
    </section>
  );
}

function Stat({ label, value, big = false }: { label: string; value: string; big?: boolean }) {
  return (
    <div className="flex min-w-0 items-baseline justify-center gap-1.5 px-2 py-1">
      <dt className="text-[11px] font-black tracking-widest uppercase opacity-90">{label}</dt>
      <dd className={cx("num text-xl leading-tight font-black", big && "text-hazard")}>{value}</dd>
    </div>
  );
}
