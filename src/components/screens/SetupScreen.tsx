"use client";
// PLACEHOLDER: the Setup agent replaces this file. Keep the export name and no-props signature.
import { useClientState, useTripStore } from "@/lib/client/react";
import { Button, Card, SectionHeader, useConfirm, useToast } from "@/components/ui";
import { Screen } from "@/components/shell/Screen";
import { activePlayers, activeTeams } from "@/components/shell/roster";

export function SetupScreen() {
  const store = useTripStore();
  const view = useClientState((s) => s.view);
  const isCommissioner = useClientState((s) => s.isCommissioner);
  const confirm = useConfirm();
  const toast = useToast();
  if (!view) return null;
  if (!isCommissioner) {
    return (
      <Screen>
        <Card tone="hazard">Commissioner only. Unlock in Settings.</Card>
      </Screen>
    );
  }
  const start = async () => {
    const ok = await confirm({ title: "Start the round?", body: "Scoring unlocks for everyone.", emoji: "⛳", confirmLabel: "Start it" });
    if (!ok) return;
    const r = store.dispatch({ type: "trip.start" });
    if (!r.ok) toast.error(r.reason);
    else toast.success("Round started. God help us all.");
  };
  return (
    <Screen>
      <SectionHeader title="Setup" subtitle="Roster, teams, course, pots." />
      <Card>
        {activePlayers(view).length} players · {activeTeams(view).length} teams · status {view.trip.status}
      </Card>
      {view.trip.status === "setup" && (
        <Button size="xl" full onClick={start}>
          Start round
        </Button>
      )}
    </Screen>
  );
}
