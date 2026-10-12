"use client";
import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from "react";
import { cx } from "./cx";

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** Visually hide the label (still read by screen readers). */
  hideLabel?: boolean;
}

/** Big labeled input (56px tall, 2px ink border, never zooms on iOS). */
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, hint, error, hideLabel = false, className, id, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const hintId = `${inputId}-hint`;
  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      <label htmlFor={inputId} className={cx("text-sm font-extrabold uppercase tracking-wider text-ink", hideLabel && "sr-only")}>
        {label}
      </label>
      <input
        ref={ref}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={hint || error ? hintId : undefined}
        className={cx(
          "h-14 w-full min-w-0 rounded-xl border-2 bg-paper px-4 text-lg font-bold text-ink placeholder:font-semibold placeholder:text-muted/80",
          error ? "border-flag" : "border-ink",
        )}
        {...rest}
      />
      {(error || hint) && (
        <p id={hintId} className={cx("text-sm font-bold", error ? "text-flag" : "text-muted")}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
});
