"use client";
// One row per teammate: drinks on the open hole, big Drink / Shotgun / Shot buttons and a camera
// for an optional photo of the empty. Drinks always land on the team's open window.
import { useState } from "react";
import type { DrinkType, Player, UUID } from "@/lib/types";
import { Avatar, BottomSheet, Card, IconCamera, PlayerName, cx } from "@/components/ui";
import { DRINK_EMOJI, DRINK_LABEL, type PlayerDrinkCount } from "./model";

const TYPES: DrinkType[] = ["drink", "shotgun", "shot"];

const BTN: Record<DrinkType, string> = {
  drink: "border-ink bg-beer text-ink active:bg-beer-dark",
  shotgun: "border-flag-dark bg-flag text-white active:bg-flag-dark",
  shot: "border-sky-dark bg-sky text-white active:bg-sky-dark",
};

export function DrinksPanel({
  members,
  teamSortOrder,
  meId,
  targetHole,
  viewingHole,
  windowOpen,
  roundComplete,
  onHole,
  forRound,
  disabled,
  onLog,
}: {
  members: Player[];
  teamSortOrder: number;
  meId: UUID | null;
  /** Hole drinks are counted on right now (the open window, else the viewing hole). */
  targetHole: number;
  viewingHole: number;
  windowOpen: boolean;
  roundComplete: boolean;
  onHole: Record<UUID, PlayerDrinkCount>;
  forRound: Record<UUID, number>;
  disabled: boolean;
  onLog: (playerId: UUID, type: DrinkType, photo?: Blob | null) => void;
}) {
  const [photoFor, setPhotoFor] = useState<Player | null>(null);
  const holeCredit = Object.values(onHole).reduce((s, c) => s + c.credit, 0);

  let note: string | null = null;
  if (!windowOpen) {
    note = roundComplete
      ? "Round's over. Drinks are just for fun now (and they still count against your liver)."
      : "Drinks only count once you're on the tee for hole 1.";
  } else if (targetHole !== viewingHole) {
    note = `Drinks go to hole ${targetHole} (open).`;
  }

  return (
    <Card padded={false} className="overflow-hidden border-ink" data-testid="drinks-panel">
      <div className="flex items-center justify-between gap-2 border-b-2 border-line bg-beer-soft px-4 py-2">
        <h2 className="text-lg font-black uppercase">Drinks</h2>
        <span className="num text-sm font-black">
          {windowOpen ? `Hole ${targetHole}: −${holeCredit} 🍺` : "No window open"}
        </span>
      </div>
      {note && (
        <p
          className={cx(
            "border-b-2 px-4 py-2 text-[15px] font-extrabold",
            windowOpen ? "border-ink bg-hazard text-ink" : "border-line bg-sand text-muted",
          )}
          data-testid="drinks-note"
        >
          {note}
        </p>
      )}
      <ul className="divide-y-2 divide-line">
        {members.map((p) => {
          const c = onHole[p.id];
          const total = forRound[p.id] ?? 0;
          return (
            <li key={p.id} className="px-3 py-3" data-testid="drink-row" data-player={p.id}>
              <div className="flex items-center gap-2.5">
                <Avatar player={p} teamSortOrder={teamSortOrder} size="md" showCrown={false} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-lg leading-tight font-black">
                    <PlayerName player={p} you={p.id === meId} />
                  </div>
                  <div className="text-sm font-bold text-muted">
                    {total} {total === 1 ? "drink" : "drinks"} today
                    {c && c.ghosts > 0 ? ` · 👻×${c.ghosts}` : ""}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-center leading-none" aria-label={`${c?.count ?? 0} on hole ${targetHole}`}>
                  <span className="num text-3xl font-black" data-testid="drink-count">
                    {c?.count ?? 0}
                  </span>
                  <span className="text-[10px] font-black tracking-wider text-muted uppercase">hole {targetHole}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setPhotoFor(p)}
                  disabled={disabled}
                  aria-label={`Log a drink for ${p.name} with a photo of the empty`}
                  className="btn h-12 w-12 shrink-0 border-ink bg-paper p-0! text-ink active:bg-sand"
                >
                  <IconCamera size={24} strokeWidth={2.5} />
                </button>
              </div>
              <div className="mt-2.5 grid grid-cols-3 gap-2">
                {TYPES.map((t) => (
                  <button
                    key={t}
                    type="button"
                    disabled={disabled}
                    onClick={() => onLog(p.id, t)}
                    aria-label={`${DRINK_LABEL[t]} for ${p.name}`}
                    className={cx("btn min-h-14 flex-col gap-0 px-1 py-1 shadow-hard-sm", BTN[t])}
                  >
                    <span className="text-xl leading-none" aria-hidden="true">
                      {DRINK_EMOJI[t]}
                    </span>
                    <span className="text-[13px] leading-tight font-black tracking-wide uppercase">{DRINK_LABEL[t]}</span>
                  </button>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
      <DrinkPhotoSheet
        player={photoFor}
        windowOpen={windowOpen}
        onClose={() => setPhotoFor(null)}
        onPick={(type, file) => {
          const p = photoFor;
          setPhotoFor(null);
          if (p) onLog(p.id, type, file);
        }}
      />
    </Card>
  );
}

/** Pick the drink type, then the camera opens (the file input must be tapped directly on iOS). */
function DrinkPhotoSheet({
  player,
  windowOpen,
  onClose,
  onPick,
}: {
  player: Player | null;
  windowOpen: boolean;
  onClose: () => void;
  onPick: (type: DrinkType, file: Blob | null) => void;
}) {
  return (
    <BottomSheet open={player !== null} onClose={onClose} title={player ? `Photo of ${player.name}'s empty` : "Photo"}>
      <p className="pb-3 text-base font-bold text-muted">What did they finish? The camera opens next. The photo goes to the feed.</p>
      <div className="grid gap-3 pb-2">
        {TYPES.map((t) =>
          windowOpen ? (
            <label key={t} className={cx("btn btn-xl w-full shadow-hard-sm", BTN[t])}>
              <span aria-hidden="true">{DRINK_EMOJI[t]}</span>
              {DRINK_LABEL[t]} + photo
              <input
                type="file"
                accept="image/*"
                capture="environment"
                className="sr-only"
                onChange={(e) => {
                  const file = e.currentTarget.files?.[0] ?? null;
                  e.currentTarget.value = "";
                  if (file) onPick(t, file);
                }}
              />
            </label>
          ) : (
            // No window: don't open the camera for a drink that won't count; the log roasts instead.
            <button key={t} type="button" className={cx("btn btn-xl w-full shadow-hard-sm", BTN[t])} onClick={() => onPick(t, null)}>
              <span aria-hidden="true">{DRINK_EMOJI[t]}</span>
              {DRINK_LABEL[t]} + photo
            </button>
          ),
        )}
      </div>
    </BottomSheet>
  );
}
