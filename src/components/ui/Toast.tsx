"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cx } from "./cx";
import { IconClose } from "./icons";

export type ToastTone = "info" | "success" | "error" | "roast";

export interface ToastAction {
  label: string;
  onAction: () => void;
}

export interface ToastOptions {
  /** Main line. */
  message: ReactNode;
  /** Optional bold first line. */
  title?: ReactNode;
  tone?: ToastTone;
  emoji?: string;
  /** e.g. { label: "Undo", onAction } — adds a draining countdown bar. */
  action?: ToastAction;
  /** ms before auto-dismiss. Default 10 s with an action, 5.5 s for error/roast, else 4 s. 0 = sticky. */
  duration?: number;
  /** Showing a toast with an existing id replaces it (and restarts its timer). */
  id?: string;
}

export interface ToastApi {
  show: (opts: ToastOptions) => string;
  info: (message: ReactNode, opts?: Omit<ToastOptions, "message" | "tone">) => string;
  success: (message: ReactNode, opts?: Omit<ToastOptions, "message" | "tone">) => string;
  error: (message: ReactNode, opts?: Omit<ToastOptions, "message" | "tone">) => string;
  roast: (message: ReactNode, opts?: Omit<ToastOptions, "message" | "tone">) => string;
  dismiss: (id: string) => void;
}

interface ToastItem extends ToastOptions {
  id: string;
  tone: ToastTone;
  duration: number;
  version: number;
}

export const UNDO_MS = 10_000;
const MAX_VISIBLE = 3;
const MAX_KEPT = 8;

/** Default auto-dismiss time for a toast. */
export function toastDuration(opts: Pick<ToastOptions, "duration" | "action" | "tone">): number {
  if (opts.duration !== undefined) return Math.max(0, opts.duration);
  if (opts.action) return UNDO_MS;
  if (opts.tone === "error" || opts.tone === "roast") return 5500;
  return 4000;
}

const TONE: Record<ToastTone, { box: string; action: string; bar: string; emoji: string }> = {
  info: { box: "bg-ink text-white border-ink", action: "bg-hazard text-ink border-hazard", bar: "bg-hazard", emoji: "📣" },
  success: { box: "bg-fairway text-white border-fairway-dark", action: "bg-paper text-ink border-ink", bar: "bg-white", emoji: "✅" },
  error: { box: "bg-flag text-white border-flag-dark", action: "bg-paper text-ink border-ink", bar: "bg-white", emoji: "🤦" },
  roast: { box: "bg-hazard text-ink border-ink", action: "bg-ink text-white border-ink", bar: "bg-ink", emoji: "🔥" },
};

const ToastContext = createContext<ToastApi | null>(null);

/** Hosts the toast stack (bottom of the screen, above the tab bar). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const seq = useRef(0);

  const dismiss = useCallback((id: string) => {
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
    setToasts((ts) => ts.filter((x) => x.id !== id));
  }, []);

  const show = useCallback(
    (opts: ToastOptions) => {
      const id = opts.id ?? `toast-${++seq.current}`;
      const tone = opts.tone ?? "info";
      const duration = toastDuration({ ...opts, tone });
      const item: ToastItem = { ...opts, id, tone, duration, version: ++seq.current };
      setToasts((ts) => [...ts.filter((x) => x.id !== id), item].slice(-MAX_KEPT));
      const old = timers.current.get(id);
      if (old) clearTimeout(old);
      timers.current.delete(id);
      if (duration > 0) timers.current.set(id, setTimeout(() => dismiss(id), duration));
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach((t) => clearTimeout(t));
      map.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      show,
      dismiss,
      info: (message, o) => show({ ...o, message, tone: "info" }),
      success: (message, o) => show({ ...o, message, tone: "success" }),
      error: (message, o) => show({ ...o, message, tone: "error" }),
      roast: (message, o) => show({ ...o, message, tone: "roast" }),
    }),
    [show, dismiss],
  );

  const visible = toasts.slice(-MAX_VISIBLE);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 z-[80] mx-auto flex max-w-xl flex-col gap-2 px-3"
        style={{ bottom: "calc(var(--toast-bottom, 16px) + env(safe-area-inset-bottom, 0px))" }}
      >
        {visible.map((t) => (
          <ToastCard key={`${t.id}:${t.version}`} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss: () => void }) {
  const tone = TONE[toast.tone];
  const emoji = toast.emoji ?? tone.emoji;
  return (
    <div
      role={toast.tone === "error" ? "alert" : "status"}
      className={cx("pointer-events-auto relative animate-toast-in overflow-hidden rounded-2xl border-2 shadow-hard", tone.box)}
    >
      <div className="flex items-center gap-2 py-1 pr-0.5 pl-3">
        {emoji && (
          <span className="shrink-0 text-2xl leading-none" aria-hidden="true">
            {emoji}
          </span>
        )}
        <div className="min-w-0 flex-1 py-1.5">
          {toast.title && <p className="text-[15px] leading-tight font-black break-words">{toast.title}</p>}
          <p className="text-sm leading-snug font-bold break-words">{toast.message}</p>
        </div>
        {toast.action && (
          <button
            type="button"
            onClick={() => {
              toast.action?.onAction();
              onDismiss();
            }}
            className={cx("btn min-h-12 shrink-0 px-3 text-base font-black uppercase", tone.action)}
          >
            {toast.action.label}
          </button>
        )}
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl opacity-90 active:bg-black/15"
        >
          <IconClose size={22} strokeWidth={3} />
        </button>
      </div>
      {toast.action && toast.duration > 0 && (
        <div className="h-1.5 w-full bg-black/25" aria-hidden="true">
          <div
            className={cx("toast-countdown h-full w-full", tone.bar)}
            style={{ ["--toast-dur" as string]: `${toast.duration}ms` }}
          />
        </div>
      )}
    </div>
  );
}

const noopToast: ToastApi = {
  show: () => "",
  info: () => "",
  success: () => "",
  error: () => "",
  roast: () => "",
  dismiss: () => {},
};

/** Toast API. Outside a ToastProvider it is a harmless no-op. */
export function useToast(): ToastApi {
  return useContext(ToastContext) ?? noopToast;
}
