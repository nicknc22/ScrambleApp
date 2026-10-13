"use client";
// Per-team state for the Mulligans card's inline Undo chip. Module state (like drinkUndo.ts) so
// leaving the Play tab and coming back inside the 10 seconds keeps the chip and its clock. The
// rules live in model.ts (mulliganUndoView / canUndoMulligan).
import { useEffect, useState, useSyncExternalStore } from "react";
import type { UUID } from "@/lib/types";
import { DRINK_UNDO_MS, DRINK_UNDONE_MS, mulliganUndoView, type MulliganUndo, type MulliganUndoView } from "./model";

const slots = new Map<UUID, MulliganUndo | null>();
const listeners = new Set<() => void>();

export const mulliganUndos = {
  get(teamId: UUID): MulliganUndo | null {
    return slots.get(teamId) ?? null;
  },
  set(teamId: UUID, undo: MulliganUndo | null): void {
    slots.set(teamId, undo);
    listeners.forEach((l) => l());
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** The team's mulligan Undo chip (or "back in the bank" mark), re-evaluated while one is up. */
export function useMulliganUndo(teamId: UUID): MulliganUndoView | null {
  const undo = useSyncExternalStore(
    mulliganUndos.subscribe,
    () => mulliganUndos.get(teamId),
    () => null,
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!undo) return;
    const end = undo.undoneAt !== null ? undo.undoneAt + DRINK_UNDONE_MS : undo.at + DRINK_UNDO_MS;
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
  }, [undo]);
  // `now` lags a fresh use by up to one tick; never read the slot as older than it is.
  return mulliganUndoView(undo, Math.max(now, undo?.at ?? 0, undo?.undoneAt ?? 0));
}
