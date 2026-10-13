"use client";
// Per-team drink bursts for the inline Undo chip in the drinks panel, and photo drinks still
// saving. Module state (not component state) so leaving the Play tab and coming back inside the 10
// seconds keeps the chip and its clock. The rules live in model.ts (burstAfterLog / burstAfterUndo
// / undoChipView).
import { useEffect, useState, useSyncExternalStore } from "react";
import type { UUID } from "@/lib/types";
import { DRINK_UNDO_MS, DRINK_UNDONE_MS, EMPTY_BURST, undoChipView, undoneMarkFor, type DrinkUndoBurst, type UndoChipView } from "./model";

const bursts = new Map<UUID, DrinkUndoBurst>();
const listeners = new Set<() => void>();

export const drinkBursts = {
  get(teamId: UUID): DrinkUndoBurst {
    return bursts.get(teamId) ?? EMPTY_BURST;
  },
  set(teamId: UUID, burst: DrinkUndoBurst): void {
    bursts.set(teamId, burst);
    listeners.forEach((l) => l());
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

const NONE: readonly UUID[] = [];
const saving = new Map<UUID, readonly UUID[]>();

/** Photo drinks tapped but not logged yet (the photo is compressing), per team: one entry per drink. */
export const drinkPhotosSaving = {
  get(teamId: UUID): readonly UUID[] {
    return saving.get(teamId) ?? NONE;
  },
  add(teamId: UUID, playerId: UUID): void {
    saving.set(teamId, [...drinkPhotosSaving.get(teamId), playerId]);
    listeners.forEach((l) => l());
  },
  remove(teamId: UUID, playerId: UUID): void {
    const list = [...drinkPhotosSaving.get(teamId)];
    const i = list.indexOf(playerId);
    if (i < 0) return;
    list.splice(i, 1);
    saving.set(teamId, list.length > 0 ? list : NONE);
    listeners.forEach((l) => l());
  },
};

export interface DrinkUndoView {
  chip: UndoChipView | null;
  /** Row that just had its drink undone. */
  undonePlayerId: UUID | null;
  /** Rows with a photo drink still saving ("Saving photo…"). */
  savingPhotoFor: readonly UUID[];
}

/** The team's Undo chip, re-evaluated a few times a second while one is up (for the countdown). */
export function useDrinkUndo(teamId: UUID, targetHole: number): DrinkUndoView {
  const burst = useSyncExternalStore(
    drinkBursts.subscribe,
    () => drinkBursts.get(teamId),
    () => EMPTY_BURST,
  );
  const savingPhotoFor = useSyncExternalStore(
    drinkBursts.subscribe,
    () => drinkPhotosSaving.get(teamId),
    () => NONE,
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const end = Math.max(burst.at + DRINK_UNDO_MS, (burst.undone?.at ?? 0) + DRINK_UNDONE_MS);
    const tick = () => {
      const t = Date.now();
      setNow(t);
      if (t > end) clearInterval(timer);
    };
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 250);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [burst]);
  // `now` lags a fresh log by up to one tick; never read the burst as older than it is.
  const at = Math.max(now, burst.at, burst.undone?.at ?? 0);
  return { chip: undoChipView(burst, at, targetHole), undonePlayerId: undoneMarkFor(burst, at), savingPhotoFor };
}
