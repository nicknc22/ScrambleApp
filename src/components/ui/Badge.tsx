import type { HTMLAttributes } from "react";
import { cx } from "./cx";

export type BadgeTone = "neutral" | "ink" | "fairway" | "hazard" | "flag" | "ghost" | "beer" | "sky" | "outline" | "gold";

const TONE: Record<BadgeTone, string> = {
  neutral: "bg-sand text-ink border-line",
  ink: "bg-ink text-white border-ink",
  fairway: "bg-fairway text-white border-fairway",
  hazard: "bg-hazard text-ink border-ink",
  flag: "bg-flag text-white border-flag",
  ghost: "bg-ghost text-white border-ghost",
  beer: "bg-beer text-ink border-beer-dark",
  sky: "bg-sky text-white border-sky",
  outline: "bg-paper text-ink border-ink",
  gold: "bg-gold text-ink border-ink",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  size?: "sm" | "md";
}

/** Small bold label pill: contest type, status, counts. */
export function Badge({ tone = "neutral", size = "sm", className, ...rest }: BadgeProps) {
  return (
    <span
      className={cx(
        "inline-flex shrink-0 items-center gap-1 rounded-full border-2 font-extrabold uppercase leading-none tracking-wide whitespace-nowrap",
        size === "sm" ? "px-2 py-1 text-[11px]" : "px-3 py-1.5 text-sm",
        TONE[tone],
        className,
      )}
      {...rest}
    />
  );
}
