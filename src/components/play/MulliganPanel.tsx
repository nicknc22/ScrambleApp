"use client";
// Team mulligan bank, "Use a mulligan (N left)" (earned only: one tap, the inline Undo is the
// safety net) and the gold Groom's Mulligan button on the groom's team while it's unused (the only
// way to spend it, through its confirm). Mulligans never touch the score math. The 10-second Undo
// for a mulligan just used is an inline chip in place of the card's caption (never a toast over the
// stepper or the action bar).
import type { MulliganSource } from "@/lib/types";
import { Button, Card, useConfirm } from "@/components/ui";
import { DRINK_UNDO_REARM_MS, type MulliganOptions, type MulliganUndoView } from "./model";
import { InlineUndoChip } from "./InlineUndoChip";

export function MulliganPanel({
  hole,
  options,
  groomOnTeam,
  groomName,
  disabled,
  onUse,
  undo = null,
  onUndo = () => {},
}: {
  hole: number;
  options: MulliganOptions;
  groomOnTeam: boolean;
  groomName: string;
  disabled: boolean;
  onUse: (source: MulliganSource) => void;
  /** Undo chip for the mulligan this phone just used (or its "back in the bank" mark). */
  undo?: MulliganUndoView | null;
  onUndo?: () => void;
}) {
  const confirm = useConfirm();
  // One tap spends one: the second tap of a double tap (right after a use) is ignored, so a
  // fumble never burns two mulligans when only the newest has an Undo.
  const justUsed = undo?.kind === "chip" && undo.elapsedMs < DRINK_UNDO_REARM_MS;

  const invokeGroom = async () => {
    const ok = await confirm({
      title: "Invoke the Groom's Mulligan?",
      body: `One per round, like a vow. ${groomName}'s do-over goes on hole ${hole} and the whole trip gets notified.`,
      emoji: "👑",
      confirmLabel: "Invoke it",
      tone: "hazard",
    });
    if (ok) onUse("groom");
  };

  return (
    <Card padded={false} className="overflow-hidden border-ink" data-testid="mulligan-panel">
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="flex h-16 w-16 shrink-0 flex-col items-center justify-center rounded-2xl border-2 border-ink bg-ghost-soft">
          <span className="num text-3xl leading-none font-black" data-testid="mulligan-bank">
            {options.earned}
          </span>
          <span className="text-[10px] font-black tracking-wider uppercase">in bank</span>
        </div>
        {undo?.kind === "chip" ? (
          <InlineUndoChip
            ariaLabel={undo.ariaLabel}
            detail={undo.detail}
            remainingMs={undo.remainingMs}
            elapsedMs={undo.elapsedMs}
            onUndo={onUndo}
            testId="mulligan-undo"
          />
        ) : (
          <div className="min-w-0 flex-1">
            <h2 className="text-lg leading-tight font-black uppercase">Mulligans</h2>
            {undo?.kind === "undone" ? (
              <p className="text-sm font-black text-flag-dark" data-testid="mulligan-undone">
                {undo.text}
              </p>
            ) : (
              <p className="text-sm font-bold text-muted">
                {options.earned > 0
                  ? `Every shotgun or shot banks one. ${options.usedTotal} used so far.`
                  : "Shotgun or shot something to bank one."}
              </p>
            )}
          </div>
        )}
      </div>
      <div className="grid gap-2 px-3 pb-3">
        <Button
          variant="secondary"
          size="lg"
          full
          disabled={disabled || options.earned <= 0 || justUsed}
          onClick={() => onUse("earned")}
          leading={<span aria-hidden="true">♻️</span>}
          data-testid="use-mulligan"
        >
          Use a mulligan ({options.earned} left)
        </Button>
        {groomOnTeam && options.groom && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => void invokeGroom()}
            className="btn btn-lg w-full border-ink bg-gold text-ink shadow-hard-sm active:bg-hazard-dark"
            style={{ backgroundImage: "repeating-linear-gradient(-45deg, rgba(255,255,255,0.25) 0 10px, transparent 10px 20px)" }}
          >
            <span aria-hidden="true">👑</span>
            <span className="font-black uppercase">Groom&apos;s Mulligan</span>
          </button>
        )}
        {groomOnTeam && !options.groom && (
          <p className="rounded-xl border-2 border-line bg-sand px-3 py-2 text-sm font-bold text-muted">👑 The Groom&apos;s Mulligan has been spent. History was rewritten once.</p>
        )}
      </div>
    </Card>
  );
}
