"use client";
// "Whose drive did you use?" — one chip per teammate, tap the selected chip again to clear. Each
// chip's badge counts that player's drives used on this nine (a 0 is red only when it's urgent,
// yellow when it's getting close). Directly under it: the drive-minimum status for the nine, two
// lines at most, leading with the holes left. Compact on purpose: it is the first card under the
// hole, and a foursome's two rows of chips and the stepper under them must fit the first screen of
// a phone. While the red sticky drive banner says it, the line isn't repeated.
import type { Player, UUID } from "@/lib/types";
import type { DriveNineStatus } from "@/lib/engine/types";
import { Card, Chip, IconCheck, displayName, cx } from "@/components/ui";
import { driveCountTone, type DriveCountTone, type DriveTone, type DriveView } from "./model";

const TONE: Record<DriveTone, string> = {
  done: "text-fairway-dark",
  ok: "text-muted",
  soft: "bg-hazard text-ink",
  hard: "bg-flag text-white",
  impossible: "bg-flag text-white",
  missed: "bg-flag-soft text-ink",
};

const ICON: Record<DriveTone, string> = { done: "✅", ok: "🏌️", soft: "⚠️", hard: "🚨", impossible: "💀", missed: "🚩" };

const COUNT: Record<DriveCountTone, string> = {
  selected: "border-white bg-white text-fairway-dark",
  some: "border-ink bg-ink text-white",
  urgent: "border-flag bg-flag text-white",
  warn: "border-ink bg-hazard text-ink",
  zero: "border-ink bg-sand text-ink",
};

export function DriveStatusLine({ view, className }: { view: DriveView; className?: string }) {
  const quiet = view.tone === "ok" || view.tone === "done";
  return (
    <p
      className={cx(
        "px-1 text-[13px] leading-[18px]",
        // Nothing urgent: a quiet line, but never cut off (a foursome's names take two lines at 360).
        quiet ? "line-clamp-2 font-bold" : "line-clamp-2 rounded-lg px-2 py-0.5 font-extrabold",
        TONE[view.tone],
        className,
      )}
      data-testid="drive-status"
      data-tone={view.tone}
    >
      <span aria-hidden="true">{ICON[view.tone]}</span> {view.text}
    </p>
  );
}

export function TeeShotPanel({
  hole,
  members,
  selected,
  nine,
  driveView,
  driveTone = null,
  disabled,
  onSelect,
}: {
  hole: number;
  members: Player[];
  selected: UUID | null;
  nine: DriveNineStatus | undefined;
  /** The status line (null while the red sticky banner says it). */
  driveView: DriveView | null;
  /** The nine's tone, for the chips' 0 badges (passed even while the banner shows). */
  driveTone?: DriveTone | null;
  disabled: boolean;
  onSelect: (playerId: UUID | null) => void;
}) {
  return (
    <Card padded={false} className="space-y-1.5 border-ink px-3 pt-1 pb-1.5" data-testid="teeshot-panel">
      {/* One line, always: the title plus the "Drives used" label only where both fit (never on a
          360-430 px phone). A second header line would push the stepper under the action bar on a
          390x664 iPhone; the chips' badges and the status line under them carry the counts. */}
      <div className="@container px-1">
        <div className="flex items-baseline justify-between gap-x-2">
          <h2 className="text-base leading-tight font-black uppercase">Whose drive did you use?</h2>
          <span
            className="hidden shrink-0 text-xs leading-4 font-black tracking-wide whitespace-nowrap text-muted uppercase @[27rem]:inline"
            data-testid="drive-nine-label"
          >
            Drives used · {nine?.nine === 2 ? "back" : "front"} 9
          </span>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2" role="group" aria-label={`Whose drive was used on hole ${hole}`}>
        {members.map((p) => {
          const on = selected === p.id;
          const count = nine?.counts[p.id] ?? 0;
          return (
            <Chip
              key={p.id}
              selected={on}
              showCheck={false}
              disabled={disabled}
              onClick={() => onSelect(on ? null : p.id)}
              aria-label={`${displayName(p)}'s tee shot${on ? " (selected, tap to clear)" : ""}, ${count} ${count === 1 ? "drive" : "drives"} this nine`}
              className="w-full justify-start gap-2 pr-3 pl-1.5 text-[17px]"
              leading={
                <span
                  className={cx(
                    "num inline-flex h-8 min-w-8 shrink-0 items-center justify-center gap-0.5 rounded-full border-2 px-1 text-base font-black",
                    COUNT[driveCountTone(count, on, driveTone)],
                  )}
                  aria-hidden="true"
                  data-testid="drive-count"
                >
                  {on && <IconCheck size={16} strokeWidth={4} />}
                  {count}
                </span>
              }
            >
              {displayName(p)}
              {p.is_groom ? " 👑" : ""}
            </Chip>
          );
        })}
      </div>
      {driveView && <DriveStatusLine view={driveView} />}
    </Card>
  );
}
