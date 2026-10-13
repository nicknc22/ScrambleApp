"use client";
// The inline 10-second Undo chip (drinks panel rows, the Mulligans card): "↩ Undo" + what it takes
// back + seconds left, with a bar that drains over the 10 seconds. It sits in a spot that was never
// a button (in place of a name or a caption), so nothing floats over other controls.
import { useState } from "react";
import { DRINK_UNDO_MS } from "./model";

export function InlineUndoChip({
  ariaLabel,
  detail,
  remainingMs,
  elapsedMs,
  onUndo,
  testId,
  count,
}: {
  ariaLabel: string;
  /** Second line: "🍺 −1 stroke", "♻️ Mulligan used · hole 4". */
  detail: string;
  remainingMs: number;
  /** Time since the window started (offsets the drain bar after a remount). */
  elapsedMs: number;
  onUndo: () => void;
  testId: string;
  count?: number;
}) {
  const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
  // The bar is a CSS animation: start it once, part-way through after a remount (tab switch).
  const [startOffset] = useState(elapsedMs);
  return (
    <button
      type="button"
      onClick={onUndo}
      aria-label={ariaLabel}
      className="btn relative h-12 min-w-0 flex-1 flex-col items-stretch justify-center gap-0.5 overflow-hidden rounded-[14px]! border-ink bg-ink px-2.5! pb-1 text-left text-white shadow-hard-sm active:bg-muted"
      data-testid={testId}
      data-count={count}
    >
      <span className="flex items-center gap-1.5 leading-none">
        <span className="text-lg leading-none" aria-hidden="true">
          ↩
        </span>
        <span className="text-[15px] font-black tracking-wide uppercase">Undo</span>
        <span className="num ml-auto shrink-0 rounded-full bg-hazard px-1.5 text-[13px] leading-[18px] font-black text-ink" aria-hidden="true">
          {seconds}
        </span>
      </span>
      <span className="truncate text-[11px] leading-tight font-extrabold opacity-90">{detail}</span>
      <span className="absolute inset-x-0 bottom-0 h-1 bg-white/25" aria-hidden="true">
        <span
          className="toast-countdown block h-full w-full bg-hazard"
          style={{ ["--toast-dur" as string]: `${DRINK_UNDO_MS}ms`, animationDelay: `-${startOffset}ms` }}
        />
      </span>
    </button>
  );
}
