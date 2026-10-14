"use client";
// Confirm for "On the tee: hole N+1" / "Round complete": the big button saves what the stepper
// shows and advances; a hole with no score also offers advancing without one; then Never mind.
// Leaving a hole with no drive picked asks "Whose drive on hole N?" right here (the team's chips,
// one tap = teeshot.set), loud and red when skipping it can cost the drive minimum.
import type { Player, UUID } from "@/lib/types";
import { BottomSheet, Button, Chip, displayName, cx } from "@/components/ui";
import type { AdvanceConfirm, AdvanceDriveAsk } from "./model";

export type AdvanceChoice = "confirm" | "skip";

export interface AdvanceDrive {
  ask: AdvanceDriveAsk;
  members: Player[];
  /** The hole's tee shot right now (live: it updates when a chip is tapped). */
  selected: UUID | null;
  onSelect: (playerId: UUID | null) => void;
}

export function AdvanceSheet({
  prompt,
  drive = null,
  onChoose,
}: {
  prompt: AdvanceConfirm | null;
  drive?: AdvanceDrive | null;
  onChoose: (choice: AdvanceChoice | null) => void;
}) {
  return (
    <BottomSheet
      open={prompt !== null}
      onClose={() => onChoose(null)}
      title={prompt?.title}
      footer={
        prompt && (
          <div className="flex flex-col gap-2.5">
            <Button variant={prompt.tone} size="xl" full onClick={() => onChoose("confirm")} data-testid="advance-confirm">
              {prompt.confirmLabel}
            </Button>
            {prompt.skipLabel && (
              <Button variant="secondary" size="lg" full onClick={() => onChoose("skip")} data-testid="advance-skip">
                {prompt.skipLabel}
              </Button>
            )}
            <Button variant="ghost" size="lg" full onClick={() => onChoose(null)}>
              Never mind
            </Button>
          </div>
        )
      }
    >
      {prompt && (
        <div className="flex flex-col items-center gap-2 pt-1 pb-2 text-center">
          {/* The drive question needs the room more than the emoji does. */}
          {!drive && (
            <div className="text-6xl leading-none" aria-hidden="true">
              {prompt.emoji}
            </div>
          )}
          <div className="text-lg font-semibold text-ink">{prompt.body}</div>
          {drive && <AdvanceDrivePicker drive={drive} />}
        </div>
      )}
    </BottomSheet>
  );
}

export function AdvanceDrivePicker({ drive }: { drive: AdvanceDrive }) {
  const { ask, members, selected, onSelect } = drive;
  return (
    <section
      className={cx("mt-1 w-full space-y-2 rounded-2xl border-2 p-2.5 text-left", ask.urgent && !selected ? "border-flag bg-flag-soft" : "border-ink bg-paper")}
      aria-label={ask.title}
      data-testid="advance-drive"
      data-urgent={ask.urgent ? "true" : "false"}
    >
      <h3 className="px-1 text-base leading-tight font-black uppercase">
        {ask.urgent && !selected && <span aria-hidden="true">🚨 </span>}
        {ask.title}
      </h3>
      {ask.note && !selected && (
        <p className="px-1 text-[15px] leading-snug font-extrabold text-flag-dark" data-testid="advance-drive-note">
          {ask.note}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2" role="group" aria-label={`Whose drive was used on hole ${ask.hole}`}>
        {members.map((p) => {
          const on = selected === p.id;
          return (
            <Chip
              key={p.id}
              selected={on}
              onClick={() => onSelect(on ? null : p.id)}
              aria-label={`${displayName(p)}'s tee shot on hole ${ask.hole}${on ? " (selected, tap to clear)" : ""}`}
              className="w-full justify-start pr-3 pl-3 text-[17px]"
              data-testid="advance-drive-chip"
            >
              {displayName(p)}
              {p.is_groom ? " 👑" : ""}
            </Chip>
          );
        })}
      </div>
    </section>
  );
}
