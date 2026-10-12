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
    <div className={cx("flex min-w-0 flex-col rounded-2xl border-2 px-2.5 py-2", TONE[tone], className)}>
      <span className="text-[11px] leading-tight font-extrabold tracking-wide uppercase [overflow-wrap:anywhere]">{label}</span>
      <span className="num truncate text-[clamp(1.4rem,7vw,1.875rem)] leading-tight font-black">{value}</span>
      {sub && <span className="text-sm leading-tight font-bold [overflow-wrap:anywhere]">{sub}</span>}
    </div>
  );
}
