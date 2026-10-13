"use client";
// Commissioner fix for a team's drink window / round status (round.set_state).
import { useState } from "react";
import { useClientState } from "@/lib/client/react";
import type { RoundStatus, Team, TeamRoundState } from "@/lib/types";
import { BottomSheet, Button, SegmentedControl, Stepper, TeamPill, useConfirm, useToast } from "@/components/ui";
import { normalizeRoundFix, roundStateLabel, sameRound } from "./commishModel";
import { useCommishDispatch } from "./shared";

const STATUS_LABEL: Record<RoundStatus, string> = { not_started: "Not started", playing: "Playing", complete: "Complete" };

export function RoundsPanel() {
  const derived = useClientState((s) => s.derived);
  const view = useClientState((s) => s.view);
  const [fixing, setFixing] = useState<string | null>(null);
  if (!derived || !view) return null;
  const team = fixing ? (derived.teamById[fixing] ?? null) : null;

  return (
    <div className="space-y-2" data-testid="commish-rounds">
      <p className="text-sm font-bold text-muted">
        Fix a team&apos;s open hole when someone fat-fingered &quot;On the tee&quot;. New drinks land on the open hole.
      </p>
      <ul className="space-y-2">
        {derived.teams.map((t) => {
          const rs = view.team_round_state.find((r) => r.team_id === t.id) ?? null;
          const st = derived.standings.find((s) => s.team_id === t.id);
          return (
            <li key={t.id} className="flex items-center gap-3 rounded-2xl border-2 border-line bg-paper p-3">
              <div className="min-w-0 flex-1 space-y-1">
                <TeamPill team={t} />
                <p className="text-lg leading-tight font-black">{roundStateLabel(rs)}</p>
                <p className="text-sm font-bold text-muted">Thru {st?.thru_label ?? "–"}</p>
              </div>
              <Button variant="secondary" onClick={() => setFixing(t.id)} aria-label={`Fix ${t.name}'s round state`}>
                Fix
              </Button>
            </li>
          );
        })}
      </ul>
      {team && (
        <RoundFixSheet
          key={team.id}
          team={team}
          rs={view.team_round_state.find((r) => r.team_id === team.id) ?? null}
          onClose={() => setFixing(null)}
        />
      )}
    </div>
  );
}

function RoundFixSheet({ team, rs, onClose }: { team: Team; rs: TeamRoundState | null; onClose: () => void }) {
  const dispatch = useCommishDispatch();
  const confirm = useConfirm();
  const toast = useToast();
  const [status, setStatus] = useState<RoundStatus>(rs?.status ?? "not_started");
  const [hole, setHole] = useState<number>(rs?.open_hole ?? 1);
  const fix = normalizeRoundFix({ status, open_hole: hole });
  const unchanged = sameRound(rs, fix);

  const save = async () => {
    const what =
      fix.status === "not_started"
        ? `Reset ${team.name} to not started?`
        : fix.status === "complete"
          ? `Mark ${team.name}'s round complete?`
          : `Put ${team.name} on hole ${fix.open_hole}?`;
    const ok = await confirm({
      title: what,
      body:
        fix.status === "playing"
          ? `New drinks land on hole ${fix.open_hole}. Drinks already logged stay where they are (move them in Drinks if needed).`
          : fix.status === "complete"
            ? "Their drink window closes. No more drinks count."
            : "Their drink window closes until they tap On the tee for hole 1 again. Scores and drinks stay.",
      emoji: "🛠️",
      confirmLabel: "Do it",
      tone: "hazard",
    });
    if (!ok) return;
    if (dispatch({ type: "round.set_state", team_id: team.id, open_hole: fix.open_hole, status: fix.status })) {
      toast.success(`${team.name}: ${roundStateLabel(fix)}.`, { emoji: "🛠️" });
      onClose();
    }
  };

  return (
    <BottomSheet
      open
      onClose={onClose}
      title={`Fix ${team.name}`}
      footer={
        <Button variant="primary" size="xl" full disabled={unchanged} onClick={() => void save()}>
          {unchanged ? "No changes" : "Override it"}
        </Button>
      }
    >
      <div className="space-y-5 pt-1 pb-2">
        <p className="text-base font-bold">Now: {roundStateLabel(rs)}</p>
        <SegmentedControl
          ariaLabel="Round status"
          value={status}
          onChange={setStatus}
          options={(["not_started", "playing", "complete"] as const).map((s) => ({ value: s, label: STATUS_LABEL[s] }))}
        />
        {status !== "not_started" && (
          <Stepper
            size="lg"
            label={status === "complete" ? "Last hole" : "Open hole"}
            hint={status === "complete" ? "Window closed" : "New drinks land here"}
            value={hole}
            min={1}
            max={18}
            onChange={setHole}
            decrementLabel="Previous hole"
            incrementLabel="Next hole"
          />
        )}
      </div>
    </BottomSheet>
  );
}
