"use client";
// Sticky bottom action bar, just above the tab bar: Save + Next hole (or the big On the tee CTA).
// The thumb zone: scoring a hole is stepper -> Save -> Next without reaching up.
import type { ReactNode } from "react";
import { IconCheck, IconChevronLeft, IconChevronRight, cx } from "@/components/ui";

/** Height of the bar content (without safe area); toasts float above it. */
export const ACTION_BAR_H = 80;

export function ActionBar({ children }: { children: ReactNode }) {
  return (
    <>
      {/* Toasts sit above the tab bar by default; lift them above this bar too (!important beats the
          shell's inline var), so no toast ever lands on Save / On the tee or the tab bar. The stack
          only grows upward from there. (Drink logs have no toast at all: their Undo is inline in the
          drinks panel.) While a modal sheet is open, globals.css parks toasts near the top. */}
      <style>{`:root{--toast-bottom:calc(var(--tabbar-h) + ${ACTION_BAR_H + 10}px) !important}`}</style>
      <div
        className="fixed inset-x-0 z-[35] border-t-2 border-ink bg-paper/95 pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] backdrop-blur"
        style={{ bottom: "calc(var(--tabbar-h) + env(safe-area-inset-bottom, 0px))" }}
        data-testid="play-action-bar"
      >
        <div className="mx-auto flex max-w-xl items-stretch gap-2 px-4 py-2" style={{ minHeight: ACTION_BAR_H - 2 }}>
          {children}
        </div>
      </div>
    </>
  );
}

/** Spacer so the last card scrolls clear of the fixed bar. */
export function ActionBarSpacer() {
  return <div aria-hidden="true" style={{ height: ACTION_BAR_H }} />;
}

export function SaveButton({ value, dirty, disabled, onSave }: { value: number; dirty: boolean; disabled?: boolean; onSave: () => void }) {
  if (!dirty) {
    return (
      <div
        className="flex min-h-16 flex-1 items-center justify-center gap-1.5 rounded-[18px] border-2 border-fairway bg-fairway-soft px-3 text-lg font-black text-fairway-dark uppercase"
        role="status"
        data-testid="saved-state"
      >
        <IconCheck size={24} strokeWidth={3.5} />
        Saved
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onSave}
      disabled={disabled}
      className="btn btn-xl min-h-16 flex-1 border-fairway-dark bg-fairway px-3 text-white shadow-hard-sm active:bg-fairway-dark"
      data-testid="save-score"
    >
      Save <span className="num text-3xl leading-none">{value}</span>
    </button>
  );
}

export function NextButton({
  label,
  sub,
  tone = "ink",
  direction = "next",
  disabled,
  onClick,
  testId,
  ariaLabel,
}: {
  /** Accessible name, e.g. "On the tee: hole 6". */
  ariaLabel: string;
  /** Big line, e.g. "Hole 6". */
  label: ReactNode;
  /** Small line above, e.g. "On the tee". */
  sub: ReactNode;
  tone?: "ink" | "flag" | "secondary";
  direction?: "next" | "back";
  disabled?: boolean;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      aria-label={ariaLabel}
      className={cx(
        "btn min-h-16 flex-1 gap-1.5 px-3 text-left shadow-hard-sm",
        tone === "ink" && "border-ink bg-ink text-white active:bg-muted",
        tone === "flag" && "border-flag-dark bg-flag text-white active:bg-flag-dark",
        tone === "secondary" && "border-ink bg-paper text-ink active:bg-sand",
      )}
    >
      {direction === "back" && <IconChevronLeft size={26} strokeWidth={3} className="shrink-0" />}
      <span className="flex min-w-0 flex-col leading-none">
        <span className="text-[11px] font-black tracking-widest uppercase opacity-90">{sub}</span>
        <span className="truncate text-xl font-black uppercase">{label}</span>
      </span>
      {direction === "next" && <IconChevronRight size={26} strokeWidth={3} className="ml-auto shrink-0" />}
    </button>
  );
}

/** The giant "On the tee: Hole N" button that opens the drink window. */
export function TeeButton({ hole, onClick, disabled }: { hole: number; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid="tee-cta"
      className="btn btn-xl relative min-h-16 flex-1 animate-pulse-ring border-ink bg-hazard text-2xl text-ink shadow-hard"
    >
      <span aria-hidden="true">⛳</span>
      On the tee: Hole {hole}
    </button>
  );
}
