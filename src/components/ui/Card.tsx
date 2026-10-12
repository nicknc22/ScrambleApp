import type { HTMLAttributes } from "react";
import { cx } from "./cx";

export type CardTone = "default" | "fairway" | "hazard" | "flag" | "ghost" | "beer" | "sky" | "ink" | "sand";

const TONE: Record<CardTone, string> = {
  default: "bg-paper border-line",
  fairway: "bg-fairway-soft border-fairway",
  hazard: "bg-hazard-soft border-ink",
  flag: "bg-flag-soft border-flag",
  ghost: "bg-ghost-soft border-ghost",
  beer: "bg-beer-soft border-beer-dark",
  sky: "bg-sky-soft border-sky",
  ink: "bg-ink border-ink text-white",
  sand: "bg-sand border-transparent",
};

/** Class string for card-looking things (e.g. a tappable <button> card). */
export function cardClasses(opts: { tone?: CardTone; padded?: boolean; className?: string } = {}) {
  const { tone = "default", padded = true, className } = opts;
  return cx("block rounded-2xl border-2", TONE[tone], padded && "p-4", className);
}

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  tone?: CardTone;
  /** 16px padding (default true). */
  padded?: boolean;
}

/** Rounded, bordered surface. Tones tint the background for warnings, ghost beers, etc. */
export function Card({ tone = "default", padded = true, className, ...rest }: CardProps) {
  return <div className={cardClasses({ tone, padded, className })} {...rest} />;
}
