"use client";
// The big strokes stepper with a live net preview ("4 − 2 🍺 = 2 net"). Save lives in the bottom bar.
// Kept compact: it sits under the tee-shot chips and its buttons clear the action bar on a phone.
import { Card, Stepper, cx } from "@/components/ui";
import { MAX_STROKES, MIN_STROKES, netPreview, scoreHeader, scoreName, type ScoreDraftView } from "./model";

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
  const header = scoreHeader(draft);
  const empty = header.kind === "empty";
  return (
    <Card padded={false} className="overflow-hidden border-ink" data-testid="score-panel">
      {/* The score's name ("Birdie") is the card's title, not a line under the number: the stepper
          stays as tall as its buttons, so it fits the first screen under the tee-shot chips. Until
          somebody touches the stepper, the par it shows is only a default: "Team score" + a grey
          "No score yet" (a yellow "Not saved" there read like something was already wrong). */}
      <div className="flex min-h-7 items-center justify-between gap-2 border-b-2 border-line px-4">
        <h2 className="flex min-w-0 items-baseline">
          {!empty && <span className="sr-only">Team score: </span>}
          <span
            className={cx(
              "truncate text-base font-black uppercase",
              empty ? "text-ink" : under ? "text-fairway-dark" : over ? "text-flag-dark" : "text-ink",
            )}
            data-testid="score-name"
          >
            {empty ? "Team score" : name}
          </span>
        </h2>
        <span
          className={cx(
            "shrink-0 rounded-full border-2 px-2.5 text-sm leading-5 font-black whitespace-nowrap uppercase",
            header.kind === "empty" && "border-line bg-sand text-muted",
            header.kind === "dirty" && "border-ink bg-hazard text-ink",
            header.kind === "saved" && "border-fairway-dark bg-fairway text-white",
          )}
          data-testid="score-status"
          data-state={header.kind}
        >
          {header.badge}
        </span>
      </div>
      <div className="px-3 pt-2 pb-2">
        <Stepper
          value={draft.value}
          onChange={onChange}
          min={MIN_STROKES}
          max={MAX_STROKES}
          // The hole header right above names the hole; the label only names the stepper for screen
          // readers (a visible line would cost the first screen its net preview).
          label={<span className="sr-only">Strokes · hole {hole}</span>}
          disabled={disabled}
          decrementLabel="One fewer stroke"
          incrementLabel="One more stroke"
        />
        <div
          className="num mt-1.5 flex items-center justify-center gap-2 rounded-2xl border-2 border-beer-dark bg-beer-soft px-3 py-0.5 text-center text-xl font-black"
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
