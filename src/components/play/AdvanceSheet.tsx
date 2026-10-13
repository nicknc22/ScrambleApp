"use client";
// Confirm for "On the tee: hole N+1" / "Round complete": the big button saves what the stepper
// shows and advances; a hole with no score also offers advancing without one; then Never mind.
import { BottomSheet, Button } from "@/components/ui";
import type { AdvanceConfirm } from "./model";

export type AdvanceChoice = "confirm" | "skip";

export function AdvanceSheet({ prompt, onChoose }: { prompt: AdvanceConfirm | null; onChoose: (choice: AdvanceChoice | null) => void }) {
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
          <div className="text-6xl leading-none" aria-hidden="true">
            {prompt.emoji}
          </div>
          <div className="text-lg font-semibold text-ink">{prompt.body}</div>
        </div>
      )}
    </BottomSheet>
  );
}
