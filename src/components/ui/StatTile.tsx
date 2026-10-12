import type { ReactNode } from "react";
import { cx } from "./cx";

export type StatTone = "default" | "fairway" | "hazard" | "flag" | "ghost" | "beer" | "sky" | "ink";

const TONE: Record<StatTone, string> = {
  default: "bg-paper border-line text-ink",
  fairway: "bg-fairway border-fairway-dark text-white",
  hazard: "bg-hazard border-ink text-ink",
  flag: "bg-flag border-flag-dark text-white",
  ghost: "bg-ghost border-ghost-dark text-white",
  beer: "bg-beer border-beer-dark text-ink",
  sky: "bg-sky border-sky-dark text-white",
  ink: "bg-ink border-ink text-white",
};

/** A big number with a small label: "NET -4", "DRINKS 11". */
export function StatTile({
  label,
  value,
  sub,
  tone = "default",
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: StatTone;
  className?: string;
}) {
  return (
    <div className={cx("flex min-w-0 flex-col rounded-2xl border-2 px-3 py-2.5", TONE[tone], className)}>
      <span className="truncate text-xs font-extrabold uppercase tracking-wider opacity-90">{label}</span>
      <span className="num truncate text-3xl font-black leading-tight">{value}</span>
      {sub && <span className="truncate text-sm font-bold opacity-90">{sub}</span>}
    </div>
  );
}
