"use client";
// The big strokes stepper with a live net preview ("4 − 2 🍺 = 2 net"). Save lives in the bottom bar.
import { Card, Stepper, cx } from "@/components/ui";
import { MAX_STROKES, MIN_STROKES, netPreview, scoreName, type ScoreDraftView } from "./model";

export function ScorePanel({
  hole,
  par,
  credit,
  draft,
  disabled,
  onChange,
}: {
  hole: number;
  par: number;
  /** Drink credit on this hole. */
  credit: number;
  draft: ScoreDraftView;
  disabled: boolean;
  onChange: (strokes: number) => void;
}) {
  const preview = netPreview(draft.value, credit, par);
  const name = scoreName(draft.value, par);
  const under = draft.value < par;
  const over = draft.value - par >= 2;
  return (
    <Card padded={false} className="overflow-hidden border-ink" data-testid="score-panel">
      <div className="flex items-center justify-between gap-2 border-b-2 border-line px-4 py-1.5">
        <h2 className="text-lg font-black uppercase">Team score</h2>
        <span
          className={cx(
            "rounded-full border-2 px-2.5 py-0.5 text-sm font-black uppercase",
            draft.dirty ? "border-ink bg-hazard text-ink" : "border-fairway-dark bg-fairway text-white",
          )}
          data-testid="score-status"
        >
          {draft.dirty ? (draft.saved === null ? "Not saved" : "Unsaved change") : "✓ Saved"}
        </span>
      </div>
      <div className="px-3 pt-2.5 pb-2.5">
        <Stepper
          value={draft.value}
          onChange={onChange}
          min={MIN_STROKES}
          max={MAX_STROKES}
          label={`Strokes · hole ${hole}`}
          disabled={disabled}
          decrementLabel="One fewer stroke"
          incrementLabel="One more stroke"
          hint={<span className={cx("font-black uppercase", under ? "text-fairway-dark" : over ? "text-flag-dark" : "text-muted")}>{name}</span>}
        />
        <div
          className="num mt-2 flex items-center justify-center gap-2 rounded-2xl border-2 border-beer-dark bg-beer-soft px-3 py-1.5 text-center text-xl font-black"
          data-testid="net-preview"
          aria-live="polite"
        >
          <span>{preview.text}</span>
          <span className="rounded-full bg-ink px-2 py-0.5 text-sm text-white">{preview.netToPar}</span>
        </div>
        {draft.dirty && draft.saved !== null && (
          <p className="mt-2 text-center text-sm font-bold text-muted">Saved right now: {draft.saved}. Tap Save to change it.</p>
        )}
      </div>
    </Card>
  );
}
