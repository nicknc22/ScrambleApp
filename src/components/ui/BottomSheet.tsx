"use client";
import { useEffect, useId, useRef, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cx } from "./cx";
import { IconClose } from "./icons";

const noopSubscribe = () => () => {};
/** true on the client after hydration, false during SSR (no setState-in-effect needed). */
export function useIsClient(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

// Open sheets, innermost last: only the top sheet reacts to Escape / traps focus.
const sheetStack: string[] = [];
let scrollLocks = 0;
let savedBodyOverflow = "";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  /** Heading shown next to the close button (also the dialog's accessible name). */
  title?: ReactNode;
  /** Accessible name when there is no visible title. */
  ariaLabel?: string;
  children?: ReactNode;
  /** Sticky action area at the bottom (respects the home-indicator safe area). */
  footer?: ReactNode;
  /** Overlay tap, Escape, drag-down and the X close it (default true). */
  dismissible?: boolean;
  /** auto: as tall as the content (max 92% of the screen). tall: always 92%. */
  size?: "auto" | "tall";
  className?: string;
}

/**
 * Modal bottom sheet: drag handle (drag down to close), focus trap, Escape/overlay close,
 * body scroll lock, focus restored on close. Rendered in a portal on document.body.
 * Put `data-autofocus` on the element that should get focus when it opens.
 */
export function BottomSheet(props: BottomSheetProps) {
  const isClient = useIsClient();
  if (!props.open || !isClient) return null;
  return createPortal(<SheetPanel {...props} />, document.body);
}

function SheetPanel({ onClose, title, ariaLabel, children, footer, dismissible = true, size = "auto", className }: BottomSheetProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const dismissibleRef = useRef(dismissible);
  const drag = useRef<{ startY: number; dy: number; pointerId: number } | null>(null);

  useEffect(() => {
    onCloseRef.current = onClose;
    dismissibleRef.current = dismissible;
  });

  useEffect(() => {
    const panel = panelRef.current;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    sheetStack.push(id);
    if (scrollLocks++ === 0) {
      savedBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    const initial = panel?.querySelector<HTMLElement>("[data-autofocus]") ?? panel;
    initial?.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (sheetStack[sheetStack.length - 1] !== id || !panel) return;
      if (e.key === "Escape") {
        if (dismissibleRef.current) {
          e.preventDefault();
          onCloseRef.current();
        }
        return;
      }
      if (e.key !== "Tab") return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!panel.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const i = sheetStack.lastIndexOf(id);
      if (i >= 0) sheetStack.splice(i, 1);
      if (--scrollLocks <= 0) {
        scrollLocks = 0;
        document.body.style.overflow = savedBodyOverflow;
      }
      if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus({ preventScroll: true });
    };
  }, [id]);

  const requestClose = () => {
    if (dismissibleRef.current) onCloseRef.current();
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dismissible || (e.target as HTMLElement).closest("button, a, input")) return;
    drag.current = { startY: e.clientY, dy: 0, pointerId: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const panel = panelRef.current;
    if (!d || !panel || d.pointerId !== e.pointerId) return;
    d.dy = Math.max(0, e.clientY - d.startY);
    panel.style.transition = "none";
    panel.style.transform = `translateY(${d.dy}px)`;
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const panel = panelRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    if (panel) {
      panel.style.transition = "transform 180ms ease-out";
      panel.style.transform = "";
    }
    if (d.dy > 90) requestClose();
  };

  return (
    <div className="fixed inset-0 z-[60] flex flex-col justify-end">
      <div className="absolute inset-0 animate-fade-in bg-ink/60 touch-none" aria-hidden="true" onClick={requestClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : ariaLabel}
        tabIndex={-1}
        className={cx(
          "relative mx-auto flex w-full max-w-xl animate-sheet-up flex-col rounded-t-[28px] border-2 border-b-0 border-ink bg-paper text-ink shadow-[0_-8px_30px_rgba(0,0,0,0.25)] outline-none",
          size === "tall" ? "h-[92dvh]" : "max-h-[92dvh]",
          className,
        )}
      >
        <div
          className="shrink-0 touch-none select-none pt-2"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <div className="mx-auto h-1.5 w-12 rounded-full bg-line-strong" aria-hidden="true" />
          {(title || dismissible) && (
            <div className="flex min-h-14 items-center gap-2 py-1 pr-2 pl-4">
              <h2 id={titleId} className="min-w-0 flex-1 text-2xl font-black leading-tight">
                {title}
              </h2>
              {dismissible && (
                <button
                  type="button"
                  onClick={requestClose}
                  aria-label="Close"
                  className="btn h-12 w-12 shrink-0 rounded-full! border-transparent bg-sand p-0! text-ink active:bg-line"
                >
                  <IconClose size={24} strokeWidth={3} />
                </button>
              )}
            </div>
          )}
        </div>
        <div className={cx("min-h-0 flex-1 overflow-y-auto overscroll-contain px-4", footer ? "pb-4" : "pb-[calc(20px+env(safe-area-inset-bottom))]")}>
          {children}
        </div>
        {footer && (
          <div className="shrink-0 border-t-2 border-line bg-paper px-4 pt-3 pb-[calc(12px+env(safe-area-inset-bottom))]">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
