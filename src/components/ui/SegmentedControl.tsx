"use client";
import type { ReactNode } from "react";
import { cx } from "./cx";

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Small count/badge after the label. */
  badge?: ReactNode;
  disabled?: boolean;
}

/**
 * Sub-tabs (e.g. Standings · Drinkers · Contests · Drives). 48px tall; tabs grow to fill the row.
 * Labels never wrap or truncate: if they can't fit, the control scrolls sideways inside itself.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
}: {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cx("no-scrollbar flex w-full gap-0.5 overflow-x-auto rounded-2xl border-2 border-ink bg-sand p-1", className)}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={cx(
              "flex min-h-12 flex-[1_0_auto] items-center justify-center gap-0.5 rounded-xl px-1.5 text-[13px] leading-tight font-extrabold whitespace-nowrap transition-colors disabled:opacity-40 min-[400px]:px-2 min-[400px]:text-[15px]",
              active ? "bg-ink text-white shadow-hard-sm" : "text-ink active:bg-line",
            )}
          >
            <span>{o.label}</span>
            {o.badge !== undefined && o.badge !== null && (
              <span
                className={cx(
                  "num shrink-0 rounded-full px-1 py-0.5 text-[11px] leading-none font-black",
                  active ? "bg-hazard text-ink" : "bg-ink text-white",
                )}
              >
                {o.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
