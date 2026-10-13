"use client";
// Shared bits for the Setup tab: dispatch-with-toast, the sticky offset under the shell header,
// and a compact number row for settings lists (the Stepper primitive is sized for scoring).
import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { useTripStore } from "@/lib/client/react";
import type { Op, OpInput } from "@/lib/ops";
import { IconMinus, IconPlus, cx, useToast, type ToastApi } from "@/components/ui";

/** Dispatch and toast the rejection reason. Returns the op when accepted, else null. */
export function useSetupDispatch(): (input: OpInput, errorTitle?: string) => Op | null {
  const store = useTripStore();
  const toast = useToast();
  return useCallback(
    (input: OpInput, errorTitle = "Nope") => {
      const r = store.dispatch(input);
      if (!r.ok) {
        toast.error(r.reason, { title: errorTitle });
        return null;
      }
      return r.op;
    },
    [store, toast],
  );
}

const HEADER_FALLBACK = 56;

/** Height of the shell's sticky header (it grows with the offline strip), for sticky bars under it. */
export function useHeaderHeight(): number {
  const [top, setTop] = useState(HEADER_FALLBACK);
  useEffect(() => {
    const header =
      document.querySelector<HTMLElement>('[data-testid="trip-shell"] > header') ?? document.querySelector<HTMLElement>("header");
    if (!header) return;
    const update = () => {
      const h = Math.round(header.getBoundingClientRect().height);
      if (h > 0) setTop(h);
    };
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(update);
      ro.observe(header);
    } else {
      update();
    }
    window.addEventListener("resize", update);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);
  return top;
}

/** Label + description on the left, 48px −/+ and the value on the right. */
export function NumberRow({
  label,
  description,
  value,
  onChange,
  min,
  max,
  step = 1,
  format,
  error,
  disabled,
  testId,
}: {
  label: ReactNode;
  description?: ReactNode;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => ReactNode;
  error?: string | null;
  disabled?: boolean;
  testId?: string;
}) {
  const id = useId();
  const bump = (dir: 1 | -1) => {
    const next = Math.round((value + dir * step) * 100) / 100;
    onChange(Math.min(max, Math.max(min, next)));
  };
  const labelText = typeof label === "string" ? label : "value";
  return (
    <div className="py-1" data-testid={testId}>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div id={id} className="text-[17px] leading-tight font-extrabold text-ink">
            {label}
          </div>
          {description && <div className="mt-0.5 text-sm leading-snug font-semibold text-muted">{description}</div>}
        </div>
        <div role="group" aria-labelledby={id} className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            aria-label={`Less ${labelText}`}
            disabled={disabled || value <= min}
            onClick={() => bump(-1)}
            className="btn h-12 w-12 rounded-full! border-ink bg-paper p-0! text-ink active:bg-sand"
          >
            <IconMinus size={22} strokeWidth={3.5} />
          </button>
          <span aria-live="polite" className="num min-w-[3.5rem] text-center text-xl leading-none font-black text-ink">
            {format ? format(value) : value}
          </span>
          <button
            type="button"
            aria-label={`More ${labelText}`}
            disabled={disabled || value >= max}
            onClick={() => bump(1)}
            className="btn h-12 w-12 rounded-full! border-fairway-dark bg-fairway p-0! text-white active:bg-fairway-dark"
          >
            <IconPlus size={22} strokeWidth={3.5} />
          </button>
        </div>
      </div>
      {error && <p className="mt-1 text-sm font-bold text-flag">{error}</p>}
    </div>
  );
}

/** Bordered group with a heavy uppercase label (settings-style). */
export function Group({ title, children, className, tone = "default" }: { title?: ReactNode; children: ReactNode; className?: string; tone?: "default" | "hazard" }) {
  return (
    <section
      className={cx(
        "space-y-3 rounded-2xl border-2 p-4",
        tone === "hazard" ? "border-ink bg-hazard-soft" : "border-line bg-paper",
        className,
      )}
    >
      {title && <h3 className="border-b-2 border-ink pb-1 text-sm font-black tracking-[0.12em] uppercase">{title}</h3>}
      {children}
    </section>
  );
}

/** Light haptic tick when the device supports it. */
export function buzz(ms = 12) {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* bonus only */
  }
}

/** Toast ids Setup uses for undo-able actions. */
export const SETUP_TOAST_IDS = ["player-added", "player-saved", "team-move", "team-added", "team-shuffle", "pots-saved"] as const;

/** Clear Setup's own toasts before opening a sheet (while a sheet is open, toasts park over its title). */
export function clearSetupToasts(toast: ToastApi) {
  for (const id of SETUP_TOAST_IDS) toast.dismiss(id);
}
