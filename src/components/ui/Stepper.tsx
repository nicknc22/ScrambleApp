"use client";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { cx } from "./cx";
import { IconMinus, IconPlus } from "./icons";

export interface StepperProps {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Small uppercase label above the number, e.g. "Strokes". */
  label?: ReactNode;
  /** Line under the number, e.g. "Par 4 · net 2". */
  hint?: ReactNode;
  /** Custom rendering of the value. */
  format?: (v: number) => ReactNode;
  /** xl: 72px buttons and a giant number (default). lg: 56px buttons. */
  size?: "lg" | "xl";
  disabled?: boolean;
  /** Hold a button to repeat (default true). */
  longPress?: boolean;
  decrementLabel?: string;
  incrementLabel?: string;
  className?: string;
}

const HOLD_DELAY_MS = 450;
const REPEAT_MS = 110;

/** Huge −/+ stepper with the value centered. Hold to repeat. */
export function Stepper({
  value,
  onChange,
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY,
  step = 1,
  label,
  hint,
  format,
  size = "xl",
  disabled = false,
  longPress = true,
  decrementLabel = "Decrease",
  incrementLabel = "Increase",
  className,
}: StepperProps) {
  const labelId = useId();
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const repeatTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const suppressClick = useRef(false);

  useEffect(() => {
    valueRef.current = value;
    onChangeRef.current = onChange;
  });

  const stop = () => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    if (repeatTimer.current) clearInterval(repeatTimer.current);
    holdTimer.current = null;
    repeatTimer.current = null;
  };
  useEffect(() => stop, []);

  const bump = (dir: 1 | -1) => {
    const next = Math.min(max, Math.max(min, valueRef.current + dir * step));
    if (next === valueRef.current) {
      stop();
      return;
    }
    valueRef.current = next;
    onChangeRef.current(next);
  };

  const clickDir = (dir: 1 | -1) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    bump(dir);
  };
  const startHold = (dir: 1 | -1) => {
    if (!longPress || disabled) return;
    stop();
    suppressClick.current = false;
    holdTimer.current = setTimeout(() => {
      suppressClick.current = true;
      bump(dir);
      repeatTimer.current = setInterval(() => bump(dir), REPEAT_MS);
    }, HOLD_DELAY_MS);
  };

  const btn = size === "xl" ? "h-[72px] w-[72px]" : "h-14 w-14";
  const icon = size === "xl" ? 34 : 28;
  const atMin = value <= min;
  const atMax = value >= max;

  return (
    <div role="group" aria-labelledby={label ? labelId : undefined} className={cx("flex items-center gap-3", className)}>
      <button
        type="button"
        aria-label={decrementLabel}
        disabled={disabled || atMin}
        className={cx(
          "btn shrink-0 rounded-full! border-ink bg-paper p-0! text-ink shadow-hard-sm [-webkit-touch-callout:none] active:bg-sand",
          btn,
        )}
        onClick={() => clickDir(-1)}
        onPointerDown={() => startHold(-1)}
        onPointerUp={stop}
        onPointerLeave={stop}
        onPointerCancel={stop}
        onContextMenu={(e) => e.preventDefault()}
      >
        <IconMinus size={icon} strokeWidth={3.5} />
      </button>
      <div className="flex min-w-0 flex-1 flex-col items-center text-center">
        {label && (
          <span id={labelId} className="text-xs font-extrabold uppercase tracking-widest text-muted">
            {label}
          </span>
        )}
        <span
          aria-live="polite"
          aria-atomic="true"
          className={cx("num font-black leading-none text-ink", size === "xl" ? "text-7xl" : "text-5xl")}
        >
          {format ? format(value) : value}
        </span>
        {hint && <span className="mt-1 text-sm font-bold text-muted">{hint}</span>}
      </div>
      <button
        type="button"
        aria-label={incrementLabel}
        disabled={disabled || atMax}
        className={cx(
          "btn shrink-0 rounded-full! border-fairway-dark bg-fairway p-0! text-white shadow-hard-sm [-webkit-touch-callout:none] active:bg-fairway-dark",
          btn,
        )}
        onClick={() => clickDir(1)}
        onPointerDown={() => startHold(1)}
        onPointerUp={stop}
        onPointerLeave={stop}
        onPointerCancel={stop}
        onContextMenu={(e) => e.preventDefault()}
      >
        <IconPlus size={icon} strokeWidth={3.5} />
      </button>
    </div>
  );
}
