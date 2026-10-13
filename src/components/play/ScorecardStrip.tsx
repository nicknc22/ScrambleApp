"use client";
// All 18 holes in a strip that scrolls sideways inside its card (never the page). Each cell:
// strokes (or ·), net, drink dot, contest icon; current hole highlighted. Tap to view/edit a hole.
import { useEffect, useRef } from "react";
import type { TeamHoleLine } from "@/lib/engine/types";
import { Card, cx } from "@/components/ui";
import { nineTotals, stripCells, stripHint, type ScoreTone } from "./model";

const STROKE_SHAPE: Record<ScoreTone, string> = {
  ace: "rounded-full bg-gold text-ink ring-2 ring-ink",
  eagle: "rounded-full bg-fairway-dark text-white ring-2 ring-fairway ring-offset-1",
  birdie: "rounded-full bg-fairway text-white",
  par: "rounded-lg text-ink",
  bogey: "rounded-md border-2 border-ink text-ink",
  double: "rounded-md bg-flag text-white",
  none: "text-line-strong text-3xl",
};

export function ScorecardStrip({
  lines,
  currentHole,
  viewing,
  unsavedHoles,
  onSelect,
  title = "Scorecard",
  canEdit = true,
}: {
  lines: TeamHoleLine[];
  currentHole: number;
  viewing: number | null;
  unsavedHoles: number[];
  onSelect: (hole: number) => void;
  title?: string;
  /** Scores can still change from this phone ("Tap a hole to fix it" vs "... to see it"). */
  canEdit?: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const cells = stripCells(lines, currentHole, viewing ?? -1, unsavedHoles);
  const [out, inn, total] = nineTotals(lines);
  const focus = viewing ?? currentHole;

  // Keep the hole on screen centered in the strip (scrollLeft only: never scrolls the page).
  useEffect(() => {
    const el = scroller.current;
    const cell = el?.querySelector<HTMLElement>(`[data-hole="${focus}"]`);
    if (!el || !cell) return;
    el.scrollLeft = Math.max(0, cell.offsetLeft - el.clientWidth / 2 + cell.offsetWidth / 2);
  }, [focus]);

  return (
    <Card padded={false} className="overflow-hidden border-ink" data-testid="scorecard-strip">
      <div className="flex items-baseline justify-between gap-2 px-4 pt-3">
        <h2 className="text-lg font-black uppercase">{title}</h2>
        <span className="text-sm font-bold text-muted">{stripHint(canEdit)}</span>
      </div>
      <div ref={scroller} className="no-scrollbar mt-2 flex gap-1.5 overflow-x-auto overscroll-x-contain px-3 pb-3" role="list">
        {cells.map((c) => (
          <div key={c.hole} role="listitem" className={cx("flex shrink-0", c.hole === 10 && "ml-2 border-l-2 border-dashed border-line pl-2")}>
            <button
              type="button"
              data-hole={c.hole}
              aria-label={c.label}
              aria-current={c.current ? "step" : undefined}
              aria-pressed={c.viewing}
              onClick={() => onSelect(c.hole)}
              className={cx(
                "relative flex w-[54px] flex-col items-center gap-1 rounded-xl border-2 px-0.5 pt-1 pb-1.5 transition-transform active:scale-95",
                c.current ? "border-ink bg-hazard" : "border-line bg-paper",
                c.viewing && "outline-3 outline-offset-1 outline-sky",
              )}
            >
              <span className="flex items-center gap-0.5 text-[11px] leading-none font-black">
                {c.hole}
                {c.contest === "ctp" && <span aria-hidden="true">🎯</span>}
                {c.contest === "ld" && <span aria-hidden="true">💥</span>}
              </span>
              <span className={cx("num flex h-8 w-8 items-center justify-center text-xl leading-none font-black", STROKE_SHAPE[c.tone])}>
                {c.strokes ?? "·"}
              </span>
              <span className={cx("num text-[11px] leading-none font-extrabold", c.net === null ? "text-transparent" : "text-muted")}>
                {c.net === null ? "–" : `net ${c.net}`}
              </span>
              <span className="flex h-3 items-center gap-0.5" aria-hidden="true">
                {c.drinks > 0 && (
                  <>
                    <span className="h-2.5 w-2.5 rounded-full border border-beer-dark bg-beer" />
                    {c.drinks > 1 && <span className="num text-[10px] leading-none font-black text-beer-dark">{c.drinks}</span>}
                  </>
                )}
              </span>
              {c.unsaved && (
                <span className="absolute -top-1.5 -right-1.5 rounded-full border-2 border-ink bg-hazard px-1 text-[9px] leading-3 font-black" aria-hidden="true">
                  ✎
                </span>
              )}
            </button>
          </div>
        ))}
      </div>
      <dl className="grid grid-cols-3 divide-x-2 divide-line border-t-2 border-line">
        {[out, inn, total].map((t) => (
          <div key={t.label} className="flex min-w-0 flex-col items-center px-1 py-2">
            <dt className="text-[11px] font-black tracking-widest text-muted uppercase">
              {t.label} <span className="font-bold">· par {t.par}</span>
            </dt>
            <dd className="num text-lg leading-tight font-black">
              {t.played === 0 ? "–" : t.strokes}
              {t.played > 0 && <span className="ml-1 text-sm font-extrabold text-muted">net {t.net}</span>}
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
