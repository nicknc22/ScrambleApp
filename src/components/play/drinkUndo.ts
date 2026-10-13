"use client";
// Per-team drink bursts for the inline Undo chip in the drinks panel. Module state (not component
// state) so leaving the Play tab and coming back inside the 10 seconds keeps the chip and its
// clock. The rules live in model.ts (burstAfterLog / burstAfterUndo / undoChipView).
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

export interface DrinkUndoView {
  chip: UndoChipView | null;
  /** Row that just had its drink undone. */
  undonePlayerId: UUID | null;
}

/** The team's Undo chip, re-evaluated a few times a second while one is up (for the countdown). */
export function useDrinkUndo(teamId: UUID): DrinkUndoView {
  const burst = useSyncExternalStore(
    drinkBursts.subscribe,
    () => drinkBursts.get(teamId),
    () => EMPTY_BURST,
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
  return { chip: undoChipView(burst, at), undonePlayerId: undoneMarkFor(burst, at) };
}
