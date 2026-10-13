"use client";
// Commissioner drink fixes: filter by team/hole, move a drink to another hole, delete one.
import { useState } from "react";
import { useClientState, useTripStore } from "@/lib/client/react";
import { BottomSheet, Badge, Button, EmptyState, PlayerName, TeamPill, cx, useConfirm, useToast } from "@/components/ui";
import { DRINK_EMOJI, DRINK_LABEL, drinkRows, type DrinkRow } from "./commishModel";
import { HoleSelect, TeamChips, timeOf, useCommishDispatch } from "./shared";

export function DrinksPanel() {
  const derived = useClientState((s) => s.derived);
  const view = useClientState((s) => s.view);
  const store = useTripStore();
  const dispatch = useCommishDispatch();
  const toast = useToast();
  const confirm = useConfirm();
  const [teamId, setTeamId] = useState<string | null>(null);
  const [hole, setHole] = useState<number | null>(null);
  const [moving, setMoving] = useState<DrinkRow | null>(null);

  if (!derived || !view) return null;
  const rows = drinkRows(view, derived, { teamId, hole });
  const ghosts = rows.filter((r) => r.ghost).length;

  const del = async (r: DrinkRow) => {
    const ok = await confirm({
      title: "Delete this drink?",
      body: (
        <>
          <PlayerName player={r.player} />&apos;s {DRINK_LABEL[r.drink.type].toLowerCase()} on hole {r.drink.hole}. Every ghost beer and net
          for {r.team?.name ?? "the team"} recomputes{r.drink.type !== "drink" ? ", and its mulligan goes with it" : ""}.
        </>
      ),
      emoji: "🗑️",
      confirmLabel: "Delete it",
      tone: "danger",
    });
    if (!ok) return;
    if (dispatch({ type: "drink.delete", drink_id: r.drink.id, as_commissioner: true })) {
      toast.success("Drink deleted. Math redone. Feed told.", { emoji: "🧮" });
    }
  };

  const move = (r: DrinkRow, to: number) => {
    const from = r.drink.hole;
    setMoving(null);
    if (to === from) return;
    if (dispatch({ type: "drink.move", drink_id: r.drink.id, hole: to })) {
      toast.show({
        tone: "success",
        emoji: "🍺",
        title: `Moved to hole ${to}`,
        message: `${DRINK_LABEL[r.drink.type]} from hole ${from}. Credit follows it.`,
        id: `move-${r.drink.id}`,
        action: {
          label: "Undo",
          onAction: () => {
            if (dispatch({ type: "drink.move", drink_id: r.drink.id, hole: from })) toast.info(`Back on hole ${from}.`);
          },
        },
      });
    }
  };

  return (
    <div className="space-y-3" data-testid="commish-drinks">
      <TeamChips teams={derived.teams} value={teamId} onChange={setTeamId} allLabel="All teams" />
      <HoleSelect value={hole} onChange={setHole} />
      <p className="text-sm font-extrabold text-muted" aria-live="polite">
        {rows.length} drink{rows.length === 1 ? "" : "s"}
        {ghosts > 0 ? ` · ${ghosts} ghost beer${ghosts === 1 ? "" : "s"}` : ""}
      </p>
      {rows.length === 0 ? (
        <EmptyState emoji="🏜️" title="Bone dry" className="py-6">
          No drinks match. Somebody check on these guys.
        </EmptyState>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => {
            const photo = store.photoUrl(r.drink.photo_path);
            return (
              <li
                key={r.drink.id}
                className={cx("rounded-2xl border-2 p-2.5", r.ghost ? "border-ghost bg-ghost-soft" : "border-line bg-paper")}
                data-testid="commish-drink-row"
                data-drink-id={r.drink.id}
              >
                <div className="flex items-start gap-2.5">
                  {photo ? (
                    <a href={photo} target="_blank" rel="noreferrer" className="shrink-0" aria-label="Open the photo of the empty">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={photo} alt="" className="h-14 w-14 rounded-xl border-2 border-ink object-cover" loading="lazy" />
                    </a>
                  ) : (
                    <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border-2 border-line bg-sand text-3xl" aria-hidden="true">
                      {DRINK_EMOJI[r.drink.type]}
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-lg leading-tight font-black">
                        <PlayerName player={r.player} />
                      </span>
                      <Badge tone={r.drink.type === "drink" ? "beer" : "ink"}>{DRINK_LABEL[r.drink.type]}</Badge>
                      {r.ghost ? <Badge tone="ghost">👻 Ghost −{r.value}</Badge> : <Badge tone="neutral">−{r.value}</Badge>}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-bold text-muted">
                      <TeamPill team={r.team} size="sm" />
                      <span className="text-ink">Hole {r.drink.hole}</span>
                      {r.drink.moved_from_hole !== null && <span>(was {r.drink.moved_from_hole})</span>}
                      <span>{timeOf(r.drink.logged_at)}</span>
                      {r.loggedBy && r.loggedBy.id !== r.drink.player_id && (
                        <span>
                          by <PlayerName player={r.loggedBy} />
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <Button variant="secondary" onClick={() => setMoving(r)} aria-label={`Move drink on hole ${r.drink.hole}`}>
                    Move hole
                  </Button>
                  <Button variant="danger" onClick={() => void del(r)} aria-label={`Delete drink on hole ${r.drink.hole}`}>
                    Delete
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {moving && <MoveSheet row={moving} onClose={() => setMoving(null)} onMove={(to) => move(moving, to)} />}
    </div>
  );
}

function MoveSheet({ row, onClose, onMove }: { row: DrinkRow; onClose: () => void; onMove: (hole: number) => void }) {
  return (
    <BottomSheet open onClose={onClose} title="Move to which hole?">
      <div className="space-y-3 pb-2">
        <p className="text-base font-bold">
          <PlayerName player={row.player} />
          &apos;s {DRINK_LABEL[row.drink.type].toLowerCase()} is on hole {row.drink.hole}. The credit moves with it and every ghost beer
          recomputes.
        </p>
        <div className="grid grid-cols-6 gap-2" role="group" aria-label="Holes">
          {Array.from({ length: 18 }, (_, i) => i + 1).map((n) => (
            <button
              key={n}
              type="button"
              disabled={n === row.drink.hole}
              onClick={() => onMove(n)}
              aria-label={`Hole ${n}`}
              className={cx(
                "num min-h-12 rounded-xl border-2 text-xl font-black active:scale-[0.95]",
                n === row.drink.hole ? "border-ink bg-ink text-white opacity-60" : "border-ink bg-paper text-ink",
              )}
            >
              {n}
            </button>
          ))}
        </div>
      </div>
    </BottomSheet>
  );
}
