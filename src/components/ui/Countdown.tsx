"use client";
import { useEffect, useRef, useState } from "react";
import { cx } from "./cx";

/** Split ms into parts and format: "2d 4h", "3h 12m", "12:05", "0:09". */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function toMs(to: string | number | Date): number {
  if (to instanceof Date) return to.getTime();
  if (typeof to === "number") return to;
  return Date.parse(to);
}

/** Live countdown to a time ("Tee time in 1h 12m"). Ticks every second; calls onDone once. */
export function Countdown({
  to,
  onDone,
  doneText = "Now!",
  className,
}: {
  to: string | number | Date;
  onDone?: () => void;
  /** Shown at zero. */
  doneText?: string;
  className?: string;
}) {
  const target = toMs(to);
  const [now, setNow] = useState(() => Date.now());
  const onDoneRef = useRef(onDone);
  const fired = useRef(false);
  useEffect(() => {
    onDoneRef.current = onDone;
  });
  useEffect(() => {
    fired.current = false;
    const tick = () => {
      const t = Date.now();
      setNow(t);
      if (t >= target && !fired.current) {
        fired.current = true;
        onDoneRef.current?.();
      }
    };
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [target]);
  const left = Number.isFinite(target) ? target - now : 0;
  return (
    <span className={cx("num", className)} suppressHydrationWarning>
      {left <= 0 ? doneText : formatCountdown(left)}
    </span>
  );
}
