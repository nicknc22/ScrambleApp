"use client";
// Play tab (the default tab): the team hole screen. Picks the team context, then hands off to
// TeamHoleScreen. Setup -> WaitingForStart; not on a team (or commissioner) -> team picker.
import { useState } from "react";
import { useClientState } from "@/lib/client/react";
import { Card } from "@/components/ui";
import { Screen } from "@/components/shell/Screen";
import { WaitingForStart } from "@/components/shell/WaitingForStart";
import { resolvePlayTeam } from "@/components/play/model";
import { TeamHoleScreen } from "@/components/play/TeamHoleScreen";
import { TeamPicker, readTeamChoice, writeTeamChoice } from "@/components/play/TeamPicker";

export function PlayScreen() {
  const code = useClientState((s) => s.code);
  const view = useClientState((s) => s.view);
  const derived = useClientState((s) => s.derived);
  const meId = useClientState((s) => s.meId);
  const isCommissioner = useClientState((s) => s.isCommissioner);
  const [chosen, setChosen] = useState<string | null>(() => readTeamChoice(code));
  const [picking, setPicking] = useState(false);

  if (!view) return null;
  if (view.trip.status === "setup") return <WaitingForStart />;
  if (!derived) {
    return (
      <Screen>
        <Card tone="hazard" className="text-lg font-bold">
          The scorecard is recalculating. Everything you logged is safe on this phone. Give it a second.
        </Card>
      </Screen>
    );
  }

  const myTeamId = meId ? (derived.teamOfPlayer[meId] ?? null) : null;
  const ctx = resolvePlayTeam({ myTeamId, isCommissioner, chosenTeamId: chosen, teamIds: derived.teams.map((t) => t.id) });

  if (ctx.teamId === null || picking) {
    return (
      <TeamPicker
        derived={derived}
        myTeamId={myTeamId}
        isCommissioner={isCommissioner}
        onPick={(teamId) => {
          // Picking your own team clears the override choice.
          const next = teamId === myTeamId ? null : teamId;
          writeTeamChoice(code, next);
          setChosen(next);
          setPicking(false);
          try {
            window.scrollTo({ top: 0 });
          } catch {
            /* ignore */
          }
        }}
      />
    );
  }

  return (
    <TeamHoleScreen
      key={ctx.teamId}
      view={view}
      derived={derived}
      teamId={ctx.teamId}
      meId={meId}
      isCommissioner={isCommissioner}
      canSwitch={ctx.canSwitch}
      onSwitchTeam={() => setPicking(true)}
    />
  );
}
