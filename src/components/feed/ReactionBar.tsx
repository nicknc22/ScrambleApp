"use client";
// The six fixed reactions with counts; mine highlighted. Tap toggles.
import { REACTION_EMOJI, REACTION_KINDS, type ReactionKind } from "@/lib/types";
import { cx } from "@/components/ui";
import type { ReactionSummary } from "./model";

const LABEL: Record<ReactionKind, string> = {
  fire: "Fire",
  lol: "LOL",
  beer: "Cheers",
  dead: "Dead",
  goat: "GOAT",
  clown: "Clown",
};

export function ReactionBar({
  summary,
  onToggle,
  disabled,
  whoNames,
  dark = false,
}: {
  summary: ReactionSummary;
  onToggle: (kind: ReactionKind, on: boolean) => void;
  /** No player picked: buttons still show counts but explain on tap. */
  disabled?: boolean;
  whoNames?: (kind: ReactionKind) => string;
  /** On a dark card. */
  dark?: boolean;
}) {
  return (
    <div className="grid grid-cols-6 gap-1" role="group" aria-label="Reactions">
      {REACTION_KINDS.map((kind) => {
        const n = summary.counts[kind];
        const mine = summary.mine.has(kind);
        const who = n > 0 && whoNames ? whoNames(kind) : "";
        return (
          <button
            key={kind}
            type="button"
            aria-pressed={mine}
            aria-label={`${LABEL[kind]}${n > 0 ? `, ${n}` : ""}${mine ? ", yours" : ""}`}
            title={who || LABEL[kind]}
            data-testid={`react-${kind}`}
            data-count={n}
            onClick={() => onToggle(kind, !mine)}
            className={cx(
              "flex min-h-12 min-w-0 items-center justify-center gap-0.5 rounded-xl border-2 px-0.5 transition-transform active:scale-90",
              mine
                ? "border-ink bg-hazard text-ink shadow-hard-sm"
                : n > 0
                  ? dark
                    ? "border-white/50 bg-white/15 text-white"
                    : "border-line-strong bg-paper text-ink"
                  : dark
                    ? "border-transparent bg-white/10 text-white/80"
                    : "border-transparent bg-ink/[0.04] text-muted",
              disabled && "opacity-80",
            )}
          >
            <span className={cx("text-[20px] leading-none", n === 0 && !mine && "grayscale-[35%]")} aria-hidden="true">
              {REACTION_EMOJI[kind]}
            </span>
            {n > 0 && <span className="num text-[13px] leading-none font-black">{n}</span>}
          </button>
        );
      })}
    </div>
  );
}
