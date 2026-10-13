"use client";
// Hole number (huge), par, yardage, contest badge, team net to par, leaderboard position + thru.
// Kept tight: the tee-shot chips and the stepper sit under it and must fit the first screen. The
// team (for the commissioner or a spectator) is named in TeamHoleScreen's team strip above it.
import type { Hole, TeeSet } from "@/lib/types";
import type { StandingRow } from "@/lib/engine/types";
import { formatToPar } from "@/lib/engine/format";
import { Badge, cx } from "@/components/ui";

export function HoleHeader({
  hole,
  holeRow,
  teeSet,
  standing,
}: {
  hole: number;
  holeRow: Hole | undefined;
  teeSet: TeeSet;
  standing: StandingRow | undefined;
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
      <div className="flex items-end gap-3 px-4 pt-1 pb-1.5">
        <div className="flex min-w-0 shrink-0 items-baseline gap-1.5">
          <span className="text-[11px] font-black tracking-[0.25em] uppercase opacity-90">Hole</span>
          <span className="loud num text-[3.5rem] leading-[0.8] tracking-tight" data-testid="hole-number" style={{ textShadow: "0 4px 0 rgba(0,0,0,0.35)" }}>
            {hole}
          </span>
        </div>
        <div className="flex min-w-0 flex-1 flex-col items-end gap-0.5 text-right">
          {contest === "ctp" && (
            <Badge tone="hazard" size="sm" className="py-0.5!">
              🎯 Closest to pin
            </Badge>
          )}
          {contest === "ld" && (
            <Badge tone="hazard" size="sm" className="py-0.5!">
              💥 Long drive
            </Badge>
          )}
          <div className="flex items-baseline gap-2">
            {yards ? <span className="num text-base leading-none font-extrabold opacity-95">{yards} yd</span> : null}
            <span className="loud text-4xl leading-none">Par {par}</span>
          </div>
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
    <div className="flex min-w-0 items-baseline justify-center gap-1.5 px-2 py-0.5">
      <dt className="text-[11px] font-black tracking-widest uppercase opacity-90">{label}</dt>
      <dd className={cx("num text-lg leading-6 font-black", big && "text-hazard")}>{value}</dd>
    </div>
  );
}
