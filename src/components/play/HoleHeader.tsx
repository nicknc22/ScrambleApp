"use client";
// Hole number (huge), par, yardage, contest badge, team net to par, leaderboard position + thru.
// Kept tight: the tee-shot chips and the stepper sit under it and must fit the first screen. The
// team (for the commissioner or a spectator) is named in TeamHoleScreen's team strip above it.
// On a contest hole the badge is the way in ("🎯 Closest to pin · Enter ›"), same size as a plain
// badge: its 48px hit area is a transparent ::after, so the header never grows.
import type { Hole, TeeSet } from "@/lib/types";
import type { StandingRow } from "@/lib/engine/types";
import { formatToPar } from "@/lib/engine/format";
import { Badge, cx } from "@/components/ui";

/** Badge look (Badge tone "hazard", size "sm", tighter padding), shared by the plain and the button badge. */
const BADGE =
  "inline-flex shrink-0 items-center gap-1 rounded-full border-2 border-ink bg-hazard px-2 py-0.5 text-[11px] leading-none font-extrabold tracking-wide whitespace-nowrap text-ink uppercase";

export function HoleHeader({
  hole,
  holeRow,
  teeSet,
  standing,
  onContest,
}: {
  hole: number;
  holeRow: Hole | undefined;
  teeSet: TeeSet;
  standing: StandingRow | undefined;
  /** Open this hole's contest entry (only when it can be entered right now). */
  onContest?: () => void;
}) {
  const par = holeRow?.par ?? 4;
  const yards = holeRow?.yardage?.[teeSet];
  const contest = holeRow?.contest ?? "none";
  const started = !!standing && standing.thru > 0;
  const ctp = contest === "ctp";
  return (
    // No overflow-hidden (the stats row rounds its own corners): it would clip the badge's hit area.
    <section
      className="relative rounded-3xl border-2 border-ink text-white shadow-hard"
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
        <div className="@container flex min-w-0 flex-1 flex-col items-end gap-0.5 text-right">
          {contest !== "none" &&
            (onContest ? (
              <button
                type="button"
                onClick={onContest}
                // Same name at every width (the verb hides on narrow columns).
                aria-label={ctp ? "Closest to pin · Enter" : "Long drive · Measure"}
                className={cx(
                  BADGE,
                  "relative shadow-[0_2px_0_0_var(--color-ink)] active:translate-y-px active:shadow-none",
                  // 51px tall hit area (19px badge + 12 above + 20 below, over the par line), 8px wider.
                  "after:absolute after:-inset-x-2 after:-top-3 after:-bottom-5 after:content-['']",
                )}
                data-testid="hole-contest"
              >
                <span aria-hidden="true">{ctp ? "🎯" : "💣"}</span>
                {ctp ? "Closest to pin" : "Long drive"}
                {/* The verb only when the column has room for it (a 2-digit hole on a 360px phone doesn't). */}
                <span className={cx("hidden", ctp ? "@[13.5rem]:inline" : "@[12.5rem]:inline")}>· {ctp ? "Enter" : "Measure"}</span>
                {/* 11px line box like the label, so the badge stays exactly as tall as a plain one. */}
                <span aria-hidden="true" className="text-[13px] leading-[11px]">
                  ›
                </span>
              </button>
            ) : (
              <Badge tone="hazard" size="sm" className="py-0.5!" data-testid="hole-contest">
                {ctp ? "🎯 Closest to pin" : "💣 Long drive"}
              </Badge>
            ))}
          {/* Never wraps ("PAR / 4", "407 / yd" on holes 10-18 at 360px): a narrow column (2-digit
              hole on a small phone) gets a smaller par and yardage; a very narrow one drops the yardage. */}
          <div className="flex items-baseline gap-2 whitespace-nowrap" data-testid="hole-par-line">
            {yards ? (
              <span className="num hidden text-sm leading-none font-extrabold opacity-95 @[9.5rem]:inline @[11rem]:text-base" data-testid="hole-yards">
                {yards} yd
              </span>
            ) : null}
            <span className="loud text-3xl leading-none @[11rem]:text-4xl">Par {par}</span>
          </div>
        </div>
      </div>
      <dl className="grid grid-cols-3 divide-x-2 divide-white/25 rounded-b-[22px] border-t-2 border-white/25 bg-black/25">
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
