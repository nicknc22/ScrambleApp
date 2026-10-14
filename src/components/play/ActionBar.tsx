"use client";
// Sticky bottom action bar, just above the tab bar: Save + "Done with N? / Tee off N+1" (or the
// big On the tee CTA).
// The thumb zone: scoring a hole is stepper -> Save -> Next without reaching up. No toast ever sits
// on it: Play shows its notices at the top (PlayToastPlacement) and its Undos inline.
import type { ReactNode } from "react";
import { IconCheck, IconChevronLeft, IconChevronRight, cx } from "@/components/ui";

/** Height of the bar content (without safe area). */
export const ACTION_BAR_H = 80;

/**
 * Put on a toast's message element (e.g. `<span data-toast-stack>`) when its action label is long
 * ("⛳ Tee off & count it"): on Play the action then gets its own row, right-aligned under the text,
 * instead of squeezing the text into a sliver beside it.
 */
export const STACKED_TOAST = "data-toast-stack";

/**
 * On Play, the toast host moves to the top of the screen, right under the header and Play's
 * sticky banners (`top`): the bottom half is the stepper, Save / On the tee and the tab bar, and a
 * toast parked there sat on the stepper. Only the newest notice shows, it is tap-through (an
 * informational notice never swallows a tap meant for what is under it) and has no ✕; a toast's
 * own action button (a contest entry's Undo) stays tappable.
 */
export function PlayToastPlacement({ top }: { top: number }) {
  return (
    <style>{`[data-toast-host]{top:${Math.round(top)}px !important;bottom:auto !important}
[data-toast-host]>:not(:last-child){display:none !important}
[data-toast-host]>*{pointer-events:none !important}
[data-toast-host] button[aria-label="Dismiss"]{display:none !important}
[data-toast-host] button{pointer-events:auto !important}
[data-toast-host]>:has([${STACKED_TOAST}])>div:first-child{flex-wrap:wrap}
[data-toast-host]>:has([${STACKED_TOAST}])>div:first-child>div{flex-basis:calc(100% - 48px)}
[data-toast-host]>:has([${STACKED_TOAST}])>div:first-child>button{margin:0 6px 6px auto}`}</style>
  );
}

export function ActionBar({ children }: { children: ReactNode }) {
  return (
    <>
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

export function SaveButton({
  value,
  dirty,
  untouched = false,
  untouchedSub = "Hole out, then",
  disabled,
  onSave,
}: {
  value: number;
  dirty: boolean;
  /**
   * The stepper still shows the untouched par default on an empty hole: a quiet outline button
   * ("Hole out, then / Save 4") instead of the big green one, so a fresh hole doesn't look like it
   * has a score waiting to be saved. Saving it is fill-if-empty (a teammate's score wins).
   */
  untouched?: boolean;
  /** Small line over the untouched button (default "Hole out, then"). */
  untouchedSub?: string;
  disabled?: boolean;
  onSave: () => void;
}) {
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
  if (untouched) {
    return (
      <button
        type="button"
        onClick={onSave}
        disabled={disabled}
        className="btn min-h-16 flex-1 flex-col gap-0.5 border-fairway-dark bg-paper px-3 text-fairway-dark active:bg-fairway-soft"
        data-testid="save-score"
        data-untouched="true"
      >
        <span className="text-[11px] leading-none font-black tracking-widest uppercase">{untouchedSub}</span>
        <span className="flex items-baseline gap-1.5 text-xl leading-none font-black uppercase">
          Save <span className="num text-[1.6rem] leading-none">{value}</span>
        </span>
      </button>
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
  /** Big line, e.g. "Tee off 6". */
  label: ReactNode;
  /** Small line above, e.g. "Done with 5?". */
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
        // Tight padding / chevron / tracking: "Done with 17? / Tee off 18" must fit half a 360px bar.
        "btn min-h-16 flex-1 gap-1 px-2.5 text-left shadow-hard-sm",
        tone === "ink" && "border-ink bg-ink text-white active:bg-muted",
        tone === "flag" && "border-flag-dark bg-flag text-white active:bg-flag-dark",
        tone === "secondary" && "border-ink bg-paper text-ink active:bg-sand",
      )}
    >
      {direction === "back" && <IconChevronLeft size={22} strokeWidth={3} className="shrink-0" />}
      <span className="flex min-w-0 flex-col leading-none">
        <span className="truncate text-[11px] font-black tracking-widest uppercase opacity-90">{sub}</span>
        <span className="truncate text-xl font-black tracking-tight uppercase">{label}</span>
      </span>
      {direction === "next" && <IconChevronRight size={22} strokeWidth={3} className="ml-auto shrink-0" />}
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
