"use client";
// Rule reminder for threesomes (spec "Threesomes"): one player hits an extra ball on every shot.
import { Card, IconClose } from "@/components/ui";

export function ThreesomeReminder({ onDismiss }: { onDismiss: () => void }) {
  return (
    <Card tone="ghost" padded={false} className="flex items-center gap-2 py-0.5 pr-0.5 pl-3" data-testid="threesome-reminder">
      <span className="text-2xl leading-none" aria-hidden="true">
        🏌️‍♂️
      </span>
      <div className="min-w-0 flex-1 py-1.5">
        <p className="text-[15px] leading-snug font-bold">
          <span className="font-black uppercase">Threesome:</span> someone hits a 4th ball every shot. Rotate.
        </p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Hide the threesome reminder for this hole"
        className="btn h-12 w-12 shrink-0 border-transparent bg-transparent p-0! text-ink active:bg-ghost/20"
      >
        <IconClose size={22} strokeWidth={3} />
      </button>
    </Card>
  );
}
