"use client";
// "Whose tee shot?" — one chip per teammate, tap the selected chip again to clear. Directly under
// it: the drive-minimum status for the nine (per-player counts, soft/hard/impossible/missed).
import type { Player, UUID } from "@/lib/types";
import type { DriveNineStatus } from "@/lib/engine/types";
import { Card, Chip, IconCheck, displayName, cx } from "@/components/ui";
import type { DriveTone, DriveView } from "./model";

const TONE: Record<DriveTone, string> = {
  done: "border-fairway bg-fairway-soft text-ink",
  ok: "border-line bg-sand text-ink",
  soft: "border-ink bg-hazard text-ink",
  hard: "border-flag-dark bg-flag text-white",
  impossible: "border-flag-dark bg-flag text-white",
  missed: "border-flag bg-flag-soft text-ink",
};

const ICON: Record<DriveTone, string> = { done: "✅", ok: "🏌️", soft: "⚠️", hard: "🚨", impossible: "💀", missed: "🚩" };

export function DriveStatusLine({ view, className }: { view: DriveView; className?: string }) {
  return (
    <p
      className={cx("flex items-start gap-2 rounded-xl border-2 px-3 py-2 text-[15px] leading-snug font-extrabold", TONE[view.tone], className)}
      data-testid="drive-status"
      data-tone={view.tone}
    >
      <span aria-hidden="true">{ICON[view.tone]}</span>
      <span className="min-w-0">{view.text}</span>
    </p>
  );
}

export function TeeShotPanel({
  hole,
  members,
  selected,
  nine,
  driveView,
  disabled,
  onSelect,
}: {
  hole: number;
  members: Player[];
  selected: UUID | null;
  nine: DriveNineStatus | undefined;
  driveView: DriveView | null;
  disabled: boolean;
  onSelect: (playerId: UUID | null) => void;
}) {
  return (
    <Card className="space-y-3 border-ink" data-testid="teeshot-panel">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-lg leading-tight font-black uppercase">Whose tee shot?</h2>
        <span className="shrink-0 text-xs font-black tracking-wide text-muted uppercase">Drives · {nine?.nine === 2 ? "back" : "front"} 9</span>
      </div>
      <div className="grid grid-cols-2 gap-2" role="group" aria-label={`Whose tee shot was used on hole ${hole}`}>
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
              className="min-h-14 w-full justify-start gap-2 pr-3 pl-2 text-[17px]"
              leading={
                <span
                  className={cx(
                    "num inline-flex h-8 min-w-8 shrink-0 items-center justify-center gap-0.5 rounded-full px-1.5 text-base font-black",
                    on ? "bg-white text-fairway-dark" : count === 0 ? "bg-flag text-white" : "bg-ink text-white",
                  )}
                  aria-hidden="true"
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
