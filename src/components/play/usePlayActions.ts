"use client";
// Every Play-tab write goes through here: store.dispatch (never the sync API), plus the toast /
// undo / fanfare that goes with it. Reads fresh state from the store inside each action so a
// callback created on an older render never stamps a stale hole.
import { useMemo, useRef } from "react";
import type { DrinkType, MulliganSource, UUID } from "@/lib/types";
import type { DispatchResult } from "@/lib/client/store";
import type { OpInput } from "@/lib/ops";
import { useTripStore } from "@/lib/client/react";
import { newId } from "@/lib/ids";
import { formatToPar } from "@/lib/engine/format";
import { UNDO_MS, displayName, useFanfare, useToast } from "@/components/ui";
import { drinkUndoToast } from "./DrinkUndoToast";
import {
  GROOM_FANFARE,
  drinkBurstCopy,
  drinkFeedback,
  drinkUndoneCopy,
  ghostFanfareCopy,
  noWindowMessage,
  roundCompleteFanfare,
  savedScoreLine,
  teeOffFanfare,
  type BurstDrink,
} from "./model";

export interface PlayActions {
  /** "On the tee" for a hole. Hole 1 gets the hype fanfare. */
  teeOff(hole: number): boolean;
  saveScore(hole: number, strokes: number, opts?: { announce?: boolean }): boolean;
  setTeeShot(hole: number, playerId: UUID | null): boolean;
  /** Log a drink on the team's open window (optionally with a photo of the empty). */
  logDrink(playerId: UUID, type: DrinkType, photo?: Blob | null): Promise<boolean>;
  spendMulligan(source: MulliganSource, hole: number): boolean;
  completeRound(): boolean;
}

type FailResult = Extract<DispatchResult, { ok: false }>;

/** Drinks logged in a row on this phone (newest last); the burst ends once its undo toast timed out. */
interface DrinkBurst {
  drinks: BurstDrink[];
  at: number;
}

function pushBurst(b: DrinkBurst, drink: BurstDrink): void {
  const now = Date.now();
  if (now - b.at > UNDO_MS) b.drinks = [];
  b.drinks.push(drink);
  b.at = now;
}

/** Take the newest drink off the burst; the re-shown toast restarts the burst's clock. */
function popBurst(b: DrinkBurst): BurstDrink | undefined {
  b.at = Date.now();
  return b.drinks.pop();
}

export function usePlayActions({ teamId, override }: { teamId: UUID; override: boolean }): PlayActions {
  const store = useTripStore();
  const toast = useToast();
  const fanfare = useFanfare();
  // Drinks logged in a row share ONE undo toast (fixed id): a stack of per-drink toasts would cover
  // the next teammate's buttons. Undo removes the latest; the burst ends when its toast times out.
  const burst = useRef<DrinkBurst>({ drinks: [], at: 0 });

  return useMemo<PlayActions>(() => {
    const extra = override ? { as_commissioner: true } : {};
    const dispatch = (input: OpInput) => store.dispatch({ ...input, ...extra } as OpInput);
    const fail = (r: FailResult) => {
      toast.error(r.reason || "That didn't work.", { title: "That didn't save", id: `play-fail-${r.code}` });
    };
    const teamName = () => store.getState().derived?.teamById[teamId]?.name ?? "Your team";
    const playerName = (id: UUID) => displayName(store.getState().derived?.playerById[id]);
    const roundStatus = () => store.getState().view?.team_round_state.find((r) => r.team_id === teamId)?.status ?? null;
    const roastNoWindow = (playerId: UUID) => {
      toast.roast(noWindowMessage(roundStatus(), `${playerId}:${Date.now()}`), { title: "That one doesn't count", emoji: "🚫" });
    };

    const drinkToastId = `drink-undo-${teamId}`;
    const showBurst = (undone: boolean) => {
      const drinks = burst.current.drinks;
      if (drinks.length === 0) {
        toast.show(drinkUndoToast({ id: drinkToastId, tone: "info", ...drinkUndoneCopy(drinks), duration: 3000 }));
        return;
      }
      const copy = undone ? drinkUndoneCopy(drinks) : drinkBurstCopy(drinks);
      toast.show(drinkUndoToast({ id: drinkToastId, tone: "success", ...copy, action: { label: "Undo", onAction: () => void undoLastDrink() } }));
    };

    /** Undo the burst's most recent drink; the toast comes back for the rest of the burst. */
    const undoLastDrink = async () => {
      const last = popBurst(burst.current);
      if (!last) return;
      let cancelled = false;
      try {
        cancelled = await store.cancelPending(last.opId);
      } catch {
        cancelled = false;
      }
      if (!cancelled) {
        const r = dispatch({ type: "drink.delete", drink_id: last.drinkId });
        if (!r.ok) return fail(r);
      }
      showBurst(true);
    };

    const undoMulligan = async (opId: UUID, mulliganId: UUID) => {
      let cancelled = false;
      try {
        cancelled = await store.cancelPending(opId);
      } catch {
        cancelled = false;
      }
      if (!cancelled) {
        const r = dispatch({ type: "mulligan.undo", mulligan_id: mulliganId });
        if (!r.ok) return fail(r);
      }
      toast.info("Mulligan put back in the bank.", { emoji: "↩️", id: `undo-${mulliganId}`, duration: 3000 });
    };

    return {
      teeOff(hole) {
        const r = dispatch({ type: "tee.open", team_id: teamId, hole });
        if (!r.ok) {
          fail(r);
          return false;
        }
        if (hole === 1) {
          fanfare.show({ tone: "hype", ...teeOffFanfare(teamName()), key: `teeoff-${teamId}` });
        } else {
          toast.show({ id: "tee-open", tone: "info", emoji: "⛳", title: `On the tee: hole ${hole}`, message: `Drinks now count on hole ${hole}.`, duration: 2500 });
        }
        return true;
      },

      saveScore(hole, strokes, opts) {
        const r = dispatch({ type: "score.set", team_id: teamId, hole, strokes });
        if (!r.ok) {
          fail(r);
          return false;
        }
        if (opts?.announce !== false) {
          const par = store.getState().derived?.holeByNumber[hole]?.par ?? 4;
          const line = savedScoreLine(strokes, par, hole);
          toast.show({ id: "score-saved", tone: "success", emoji: line.emoji, title: line.title, message: line.message, duration: 2500 });
        }
        return true;
      },

      setTeeShot(hole, playerId) {
        const r = dispatch({ type: "teeshot.set", team_id: teamId, hole, player_id: playerId });
        if (!r.ok) {
          fail(r);
          return false;
        }
        return true;
      },

      async logDrink(playerId, type, photo) {
        // The window is checked at tap time and again after the (async) photo compression.
        if ((store.getState().derived?.openWindow[teamId] ?? null) === null) {
          roastNoWindow(playerId);
          return false;
        }
        let photoPath: string | null = null;
        if (photo) {
          try {
            photoPath = await store.addPhoto(photo, "drinks");
          } catch (e) {
            console.warn("[play] drink photo failed", e);
            toast.error("The photo didn't take, so the drink is logged without it.", { title: "Photo fail", emoji: "📷" });
          }
        }
        const hole = store.getState().derived?.openWindow[teamId] ?? null;
        if (hole === null) {
          roastNoWindow(playerId);
          return false;
        }
        const drinkId = newId();
        const r = dispatch({ type: "drink.log", drink_id: drinkId, team_id: teamId, player_id: playerId, hole, drink_type: type, photo_path: photoPath });
        if (!r.ok) {
          if (r.code === "no_window") roastNoWindow(playerId);
          else fail(r);
          return false;
        }
        const value = store.getState().derived?.drinkValues[drinkId]?.value;
        const name = playerName(playerId);
        const fb = drinkFeedback(type, value, name, hole);
        if (fb.ghost) fanfare.show({ tone: "ghost", emoji: "👻", ...ghostFanfareCopy(name, value ?? 2), key: `ghost-${drinkId}` });
        pushBurst(burst.current, { opId: r.op.id, drinkId, name, type, value, hole });
        showBurst(false);
        return true;
      },

      spendMulligan(source, hole) {
        const mulliganId = newId();
        const r = dispatch({ type: "mulligan.use", mulligan_id: mulliganId, team_id: teamId, hole, source });
        if (!r.ok) {
          fail(r);
          return false;
        }
        const groom = source === "groom";
        if (groom) fanfare.show({ tone: "groom", ...GROOM_FANFARE, key: `groom-${mulliganId}` });
        const opId = r.op.id;
        toast.show({
          id: `mulligan-${mulliganId}`,
          tone: "success",
          emoji: groom ? "👑" : "♻️",
          title: groom ? "Groom's Mulligan used" : "Mulligan used",
          message: `Hole ${hole}. Hit it again. The first one never happened.`,
          action: { label: "Undo", onAction: () => void undoMulligan(opId, mulliganId) },
        });
        return true;
      },

      completeRound() {
        const r = dispatch({ type: "round.complete", team_id: teamId });
        if (!r.ok) {
          fail(r);
          return false;
        }
        const row = store.getState().derived?.standings.find((s) => s.team_id === teamId);
        fanfare.show({ tone: "hype", ...roundCompleteFanfare(teamName(), formatToPar(row?.net_to_par ?? 0)), key: `complete-${teamId}` });
        return true;
      },
    };
  }, [store, toast, fanfare, teamId, override]);
}
