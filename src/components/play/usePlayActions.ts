"use client";
// Every Play-tab write goes through here: store.dispatch (never the sync API), plus the toast /
// undo / fanfare that goes with it. Reads fresh state from the store inside each action so a
// callback created on an older render never stamps a stale hole. Drink logs and mulligans show no
// toast: their 10-second Undo is an inline chip (drinkUndo.ts, mulliganUndo.ts), so nothing
// actionable ever floats over the stepper, Save / On the tee or the tab bar. The informational
// toasts left (saved, on the tee, errors, roasts) show at the top on Play (TeamHoleScreen).
import { useMemo } from "react";
import type { DrinkType, MulliganSource, UUID } from "@/lib/types";
import type { DispatchOptions, DispatchResult } from "@/lib/client/store";
import type { OpInput } from "@/lib/ops";
import { useTripStore } from "@/lib/client/react";
import { newId } from "@/lib/ids";
import { formatToPar } from "@/lib/engine/format";
import { displayName, useFanfare, useToast } from "@/components/ui";
import { drinkBursts, drinkPhotosSaving } from "./drinkUndo";
import { mulliganUndos } from "./mulliganUndo";
import {
  GROOM_FANFARE,
  burstAfterLog,
  burstAfterUndo,
  canUndoMulligan,
  drinkFeedback,
  ghostFanfareCopy,
  noWindowMessage,
  roundCompleteFanfare,
  savedScoreLine,
  teeOffFanfare,
} from "./model";

export interface PlayActions {
  /** "On the tee" for a hole. Hole 1 gets the hype fanfare. */
  teeOff(hole: number): boolean;
  /** `ifEmpty`: an untouched par default that must never replace a score already on the hole. */
  saveScore(hole: number, strokes: number, opts?: { announce?: boolean; ifEmpty?: boolean }): boolean;
  setTeeShot(hole: number, playerId: UUID | null): boolean;
  /** Log a drink on the team's open window (optionally with a photo of the empty). */
  logDrink(playerId: UUID, type: DrinkType, photo?: Blob | null): Promise<boolean>;
  /** The drinks panel's Undo chip: take back the newest drink of this phone's burst. */
  undoLastDrink(): Promise<void>;
  spendMulligan(source: MulliganSource, hole: number): boolean;
  /** The Mulligans card's Undo chip: put the mulligan this phone just used back in the bank. */
  undoMulligan(): Promise<void>;
  completeRound(): boolean;
}

type FailResult = Extract<DispatchResult, { ok: false }>;

export function usePlayActions({ teamId, override }: { teamId: UUID; override: boolean }): PlayActions {
  const store = useTripStore();
  const toast = useToast();
  const fanfare = useFanfare();

  return useMemo<PlayActions>(() => {
    const extra = override ? { as_commissioner: true } : {};
    const dispatch = (input: OpInput, opts?: DispatchOptions) => store.dispatch({ ...input, ...extra } as OpInput, opts);
    const fail = (r: FailResult) => {
      toast.error(r.reason || "That didn't work.", { title: "That didn't save", id: `play-fail-${r.code}` });
    };
    const teamName = () => store.getState().derived?.teamById[teamId]?.name ?? "Your team";
    const playerName = (id: UUID) => displayName(store.getState().derived?.playerById[id]);
    const roundStatus = () => store.getState().view?.team_round_state.find((r) => r.team_id === teamId)?.status ?? null;
    const roastNoWindow = (playerId: UUID) => {
      toast.roast(noWindowMessage(roundStatus(), `${playerId}:${Date.now()}`), { title: "That one doesn't count", emoji: "🚫" });
    };

    /** Undo the burst's newest drink (cancel it if it never left the phone, else delete it). */
    const undoLastDrink = async () => {
      const popped = burstAfterUndo(drinkBursts.get(teamId), Date.now());
      if (!popped) return;
      drinkBursts.set(teamId, popped.burst);
      let cancelled = false;
      try {
        cancelled = await store.cancelPending(popped.removed.opId);
      } catch {
        cancelled = false;
      }
      if (!cancelled) {
        const r = dispatch({ type: "drink.delete", drink_id: popped.removed.drinkId });
        if (!r.ok) fail(r);
      }
    };

    /** Undo the mulligan this phone just used (cancel it if it never left the phone, else undo it). */
    const undoMulligan = async () => {
      const used = mulliganUndos.get(teamId);
      const now = Date.now();
      if (!canUndoMulligan(used, now)) return;
      mulliganUndos.set(teamId, { ...used, undoneAt: now });
      let cancelled = false;
      try {
        cancelled = await store.cancelPending(used.opId);
      } catch {
        cancelled = false;
      }
      if (!cancelled) {
        const r = dispatch({ type: "mulligan.undo", mulligan_id: used.mulliganId });
        if (!r.ok) fail(r);
      }
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
        const r = dispatch({ type: "score.set", team_id: teamId, hole, strokes, ...(opts?.ifEmpty ? { if_empty: true } : {}) });
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
        // The tap decides the hole and the time. Compressing a photo takes a moment, and a tee-off
        // or Round complete tapped meanwhile must neither move the drink to the next hole nor drop it.
        const hole = store.getState().derived?.openWindow[teamId] ?? null;
        if (hole === null) {
          roastNoWindow(playerId);
          return false;
        }
        const tappedAt = store.serverNow();
        let photoPath: string | null = null;
        if (photo) {
          drinkPhotosSaving.add(teamId, playerId); // "Saving photo…" on the player's row
          try {
            photoPath = await store.addPhoto(photo, "drinks");
          } catch (e) {
            console.warn("[play] drink photo failed", e);
            toast.error("The photo didn't take, so the drink is logged without it.", { title: "Photo fail", emoji: "📷" });
          } finally {
            drinkPhotosSaving.remove(teamId, playerId);
          }
        }
        const drinkId = newId();
        const r = dispatch(
          { type: "drink.log", drink_id: drinkId, team_id: teamId, player_id: playerId, hole, drink_type: type, photo_path: photoPath },
          photo ? { at: tappedAt } : undefined,
        );
        if (!r.ok) {
          if (r.code === "no_window") roastNoWindow(playerId);
          else fail(r);
          return false;
        }
        // The engine's view of the drink: its value and the hole it is credited to.
        const credited = store.getState().derived?.drinkValues[drinkId];
        const value = credited?.value;
        const name = playerName(playerId);
        const fb = drinkFeedback(type, value, name, credited?.hole ?? hole);
        if (fb.ghost) fanfare.show({ tone: "ghost", emoji: "👻", ...ghostFanfareCopy(name, value ?? 2), key: `ghost-${drinkId}` });
        // Feedback + Undo live inline in the drinks panel (the chip on this player's row).
        const drink = { opId: r.op.id, drinkId, playerId, name, type, value, hole: credited?.hole ?? hole };
        drinkBursts.set(teamId, burstAfterLog(drinkBursts.get(teamId), drink, Date.now()));
        return true;
      },

      undoLastDrink,

      spendMulligan(source, hole) {
        const mulliganId = newId();
        const r = dispatch({ type: "mulligan.use", mulligan_id: mulliganId, team_id: teamId, hole, source });
        if (!r.ok) {
          fail(r);
          return false;
        }
        if (source === "groom") fanfare.show({ tone: "groom", ...GROOM_FANFARE, key: `groom-${mulliganId}` });
        // No toast: the 10-second Undo is the chip in the Mulligans card.
        mulliganUndos.set(teamId, { opId: r.op.id, mulliganId, source, hole, at: Date.now(), undoneAt: null });
        return true;
      },

      undoMulligan,

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
