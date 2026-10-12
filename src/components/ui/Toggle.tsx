"use client";
import type { ReactNode } from "react";
import { cx } from "./cx";

/** Full-width on/off row (role="switch"), 56px tall, with a label and optional description. */
export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx("flex min-h-14 w-full items-center gap-3 rounded-2xl text-left disabled:opacity-45", className)}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-lg font-extrabold leading-tight text-ink">{label}</span>
        {description && <span className="mt-0.5 block text-sm font-semibold text-muted">{description}</span>}
      </span>
      <span
        aria-hidden="true"
        className={cx(
          "relative inline-flex h-9 w-16 shrink-0 items-center rounded-full border-2 border-ink transition-colors",
          checked ? "bg-fairway" : "bg-line",
        )}
      >
        <span
          className={cx(
            "absolute h-7 w-7 rounded-full border-2 border-ink bg-paper transition-transform",
            checked ? "translate-x-[28px]" : "translate-x-[2px]",
          )}
        />
      </span>
    </button>
  );
}
