"use client";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cx } from "./cx";
import { IconCheck } from "./icons";

export type ChipTone = "fairway" | "ink" | "ghost" | "hazard" | "flag" | "sky";

const SELECTED: Record<ChipTone, string> = {
  fairway: "bg-fairway text-white border-fairway-dark",
  ink: "bg-ink text-white border-ink",
  ghost: "bg-ghost text-white border-ghost-dark",
  hazard: "bg-hazard text-ink border-ink",
  flag: "bg-flag text-white border-flag-dark",
  sky: "bg-sky text-white border-sky-dark",
};

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  selected?: boolean;
  tone?: ChipTone;
  /** Avatar, emoji or icon before the label. */
  leading?: ReactNode;
  /** Show a check mark when selected (default true). */
  showCheck?: boolean;
}

/** Selectable pill (aria-pressed). Used for "whose tee shot", filters, pickers. 48px tall. */
export const Chip = forwardRef<HTMLButtonElement, ChipProps>(function Chip(
  { selected = false, tone = "fairway", leading, showCheck = true, className, children, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-pressed={selected}
      className={cx(
        "inline-flex min-h-12 max-w-full items-center gap-2 rounded-full border-2 px-4 text-base font-extrabold leading-tight transition-transform active:scale-[0.96] disabled:opacity-45",
        selected ? SELECTED[tone] : "border-ink bg-paper text-ink",
        className,
      )}
      {...rest}
    >
      {selected && showCheck ? <IconCheck size={20} strokeWidth={3.5} className="shrink-0" /> : leading}
      <span className="min-w-0 truncate">{children}</span>
    </button>
  );
});
