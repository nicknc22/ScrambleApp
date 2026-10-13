"use client";
// Submit a contest entry: upload the photo (queued in the outbox), dispatch contest.submit, then
// celebrate (fanfare when it takes the lead) with a 10-second undo toast.
import { useCallback } from "react";
import type { ContestEntry, ContestKind, UUID } from "@/lib/types";
import type { OpInput } from "@/lib/ops";
import { newId } from "@/lib/ids";
import { ordinal } from "@/lib/engine/format";
import { useTripStore } from "@/lib/client/react";
import type { PhotoKind } from "@/lib/client/store";
import { displayName, useFanfare, useToast } from "@/components/ui";
import { undoInputs } from "./flow";
import { entryOf, formatContestDistance } from "./model";

export interface SubmitEntryArgs {
  kind: ContestKind;
  hole: number;
  playerId: UUID;
  /** The photo to upload with the entry (null = none). */
  photo: Blob | null;
  /** Builds the op once the photo path is known. */
  build: (entryId: UUID, photoPath: string | null) => OpInput;
  /** The player's active entry this one replaces (for undo). */
  previous: ContestEntry | null;
}

export type SubmitOutcome = { ok: true; entryId: UUID } | { ok: false; reason: string };

export function useSubmitEntry(): (args: SubmitEntryArgs) => Promise<SubmitOutcome> {
  const store = useTripStore();
  const toast = useToast();
  const fanfare = useFanfare();

  return useCallback(
    async ({ kind, hole, playerId, photo, build, previous }: SubmitEntryArgs): Promise<SubmitOutcome> => {
      let photoPath: string | null = null;
      if (photo) {
        try {
          photoPath = await store.addPhoto(photo, kind as PhotoKind);
        } catch (e) {
          const reason = `The photo didn't save (${e instanceof Error ? e.message : "unknown error"}). Try again or retake it.`;
          toast.error(reason, { emoji: "📷" });
          return { ok: false, reason };
        }
      }
      const entryId = newId();
      const res = store.dispatch(build(entryId, photoPath));
      if (!res.ok) {
        toast.error(res.reason, { title: "Entry not saved" });
        return { ok: false, reason: res.reason };
      }

      // Read back what the engine made of it (rank, validity) for the celebration.
      const derived = store.getState().derived;
      const summary = derived?.contests.find((c) => c.hole === hole);
      const view = entryOf(summary, playerId);
      const who = displayName(derived?.playerById[playerId]);
      const dist = view ? formatContestDistance(kind, view.distance) : "";
      const opId = res.op.id;

      const undo = async () => {
        if (await store.cancelPending(opId)) {
          toast.info("Entry undone. It never happened.", { emoji: "↩️" });
          return;
        }
        for (const input of undoInputs(entryId, previous, newId())) {
          const r = store.dispatch(input);
          if (!r.ok) {
            toast.error(r.reason, { title: "Couldn't undo" });
            return;
          }
        }
        toast.info(previous ? "Undone. Your previous entry is back." : "Entry undone.", { emoji: "↩️" });
      };

      const leading = view?.valid && view.rank === 1;
      if (view && !view.valid) {
        toast.show({
          tone: "info",
          emoji: "⚖️",
          title: `${who}: ${dist} sent to the commissioner`,
          message: view.invalid_reason ?? "It counts once the commish signs off.",
          action: { label: "Undo", onAction: () => void undo() },
        });
      } else if (leading) {
        fanfare.show({
          emoji: kind === "ld" ? "💥" : "🎯",
          title: kind === "ld" ? "Long drive leader" : "Closest to the pin",
          subtitle: `${who} · ${dist} · hole ${hole}`,
          tone: "hype",
          key: `contest-lead:${entryId}`,
        });
        toast.show({
          tone: "success",
          emoji: kind === "ld" ? "💥" : "🎯",
          title: `${who} leads hole ${hole}`,
          message: `${dist}. Everybody else: good luck.`,
          action: { label: "Undo", onAction: () => void undo() },
        });
      } else {
        toast.show({
          tone: "success",
          emoji: kind === "ld" ? "🏌️" : "⛳",
          title: `${who}: ${dist} on the board`,
          message: view?.rank ? `That's ${ordinal(view.rank)} for now. Not bad, not great.` : "Entry saved.",
          action: { label: "Undo", onAction: () => void undo() },
        });
      }
      return { ok: true, entryId };
    },
    [store, toast, fanfare],
  );
}
