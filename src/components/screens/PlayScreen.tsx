"use client";
// PLACEHOLDER: the Play agent replaces this file. Keep the export name and no-props signature.
import { useClientState } from "@/lib/client/react";
import { Badge, Button, Card, EmptyState, StatTile } from "@/components/ui";
import { formatToPar } from "@/lib/engine/format";
import { Screen } from "@/components/shell/Screen";
import { WaitingForStart } from "@/components/shell/WaitingForStart";
import { useShellNav } from "@/components/shell/nav";
import { teamOfPlayer } from "@/components/shell/roster";

export function PlayScreen() {
  const view = useClientState((s) => s.view);
  const derived = useClientState((s) => s.derived);
  const meId = useClientState((s) => s.meId);
  const nav = useShellNav();
  if (!view) return null;
  if (view.trip.status === "setup") return <WaitingForStart />;

  const team = teamOfPlayer(view, meId);
  if (!meId || !team) {
    return (
      <Screen>
        <EmptyState
          emoji="🤷"
          title={meId ? "You're not on a team" : "Who are you?"}
          action={
            <Button size="lg" full onClick={nav.switchPlayer}>
              Pick your name
            </Button>
          }
        >
          {meId ? "Ask the commissioner to put you on a team." : "Pick your name to start scoring."}
        </EmptyState>
      </Screen>
    );
  }

  const hole = derived?.currentHole[team.id] ?? 1;
  const h = derived?.holeByNumber[hole];
  const row = derived?.standings.find((r) => r.team_id === team.id);
  return (
    <Screen>
      <Card tone="ink" className="space-y-1">
        <div className="text-sm font-black tracking-widest uppercase opacity-90">{team.name}</div>
        <div className="loud text-6xl">Hole {hole}</div>
        <div className="flex flex-wrap gap-2 pt-1">
          {h && <Badge tone="hazard">Par {h.par}</Badge>}
          {h?.contest === "ctp" && <Badge tone="sky">Closest to pin</Badge>}
          {h?.contest === "ld" && <Badge tone="beer">Long drive</Badge>}
        </div>
      </Card>
      {row && (
        <div className="grid grid-cols-3 gap-2">
          <StatTile label="Pos" value={row.pos_label} />
          <StatTile label="Net" value={formatToPar(row.net_to_par)} tone="fairway" />
          <StatTile label="Drinks" value={row.drinks} tone="beer" />
        </div>
      )}
      <p className="text-base font-bold text-muted">The full Play screen (score, tee shot, drinks, mulligans) is on its way.</p>
    </Screen>
  );
}
