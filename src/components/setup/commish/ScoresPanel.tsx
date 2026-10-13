"use client";
// Commissioner score fixes: pick a team, tap any hole, set strokes and whose tee shot.
import { useState } from "react";
import { useClientState } from "@/lib/client/react";
import { formatToPar } from "@/lib/engine/format";
import type { TeamHoleLine } from "@/lib/engine/types";
import type { Player, Team } from "@/lib/types";
import { BottomSheet, Button, Chip, EmptyState, PlayerName, StatTile, Stepper, cx, displayName, useToast } from "@/components/ui";
import { holesLabel, scoreGaps } from "../model";
import { TeamChips, useCommishDispatch } from "./shared";

export function ScoresPanel({ focusTeamId, focusHole }: { focusTeamId?: string; focusHole?: number } = {}) {
  const derived = useClientState((s) => s.derived);
  const view = useClientState((s) => s.view);
  const [teamId, setTeamId] = useState<string | null>(focusTeamId ?? null);
  const [hole, setHole] = useState<number | null>(focusHole ?? null);

  if (!derived || !view) return null;
  const teams = derived.teams;
  if (teams.length === 0) return <EmptyState emoji="🫥" title="No teams" />;
  const team = teams.find((t) => t.id === teamId) ?? teams[0];
  const lines = derived.teamHoles[team.id] ?? [];
  const standing = derived.standings.find((s) => s.team_id === team.id);
  const rs = view.team_round_state.find((r) => r.team_id === team.id) ?? null;
  const members = derived.membersOfTeam[team.id] ?? [];
  const line = hole !== null ? (lines.find((l) => l.hole === hole) ?? null) : null;
  const gap = scoreGaps(view).find((g) => g.team.id === team.id) ?? null;

  return (
    <div className="space-y-3" data-testid="commish-scores">
      <TeamChips teams={teams} value={team.id} onChange={(id) => setTeamId(id)} />
      {standing && (
        <div className="grid grid-cols-4 gap-2">
          <StatTile label="Thru" value={standing.thru_label} />
          <StatTile label="Gross" value={standing.thru > 0 ? standing.gross : "–"} />
          <StatTile label="Net" value={standing.thru > 0 ? standing.net : "–"} tone="fairway" />
          <StatTile label="To par" value={standing.thru > 0 ? formatToPar(standing.net_to_par) : "–"} tone="ink" />
        </div>
      )}
      {gap && (
        <p className="rounded-xl border-2 border-flag bg-flag-soft px-3 py-2 text-[15px] font-extrabold" role="status" data-testid="commish-score-gap">
          ⚠️ {team.name} played past {holesLabel(gap.holes)} with no score. A blank hole plays as even par and its drinks don&apos;t
          count.
        </p>
      )}
      <p className="text-sm font-bold text-muted">Tap a hole to fix it. Big number = strokes, small = net after drink credit.</p>
      <div className="grid grid-cols-6 gap-1.5" role="list" aria-label={`${team.name} scorecard`}>
        {lines.map((l) => (
          <ScoreCell key={l.hole} line={l} open={rs?.status === "playing" && rs.open_hole === l.hole} onTap={() => setHole(l.hole)} />
        ))}
      </div>
      {line && (
        <ScoreEditSheet
          key={`${team.id}:${line.hole}`}
          team={team}
          line={line}
          members={members}
          openHole={rs?.open_hole ?? null}
          complete={rs?.status === "complete"}
          onClose={() => setHole(null)}
        />
      )}
    </div>
  );
}

function ScoreCell({ line, open, onTap }: { line: TeamHoleLine; open: boolean; onTap: () => void }) {
  const toPar = line.gross_to_par;
  const tone =
    line.strokes === null
      ? "border-line bg-paper"
      : toPar !== null && toPar <= -1
        ? "border-fairway-dark bg-fairway text-white"
        : toPar !== null && toPar >= 2
          ? "border-flag-dark bg-flag-soft"
          : "border-ink bg-paper";
  return (
    <button
      type="button"
      role="listitem"
      onClick={onTap}
      data-testid={`commish-score-${line.hole}`}
      aria-label={`Hole ${line.hole}, par ${line.par}: ${line.strokes === null ? "no score" : `${line.strokes} strokes, net ${line.net}`}. Edit.`}
      className={cx(
        "relative flex min-h-[68px] min-w-0 flex-col items-center justify-between rounded-xl border-2 px-0.5 py-1 active:scale-[0.96]",
        tone,
        open && "ring-4 ring-hazard",
      )}
    >
      <span className="num text-[11px] leading-none font-black">
        {line.hole}
        <span className="font-bold opacity-75"> P{line.par}</span>
      </span>
      <span className="num text-2xl leading-none font-black">{line.strokes ?? "–"}</span>
      <span className="num text-[11px] leading-none font-bold">{line.net === null ? (line.drinks > 0 ? `🍺${line.drinks}` : " ") : `net ${line.net}`}</span>
      {line.edit_count > 0 && <span className="absolute top-0.5 right-0.5 h-2 w-2 rounded-full bg-ghost" aria-label="edited" />}
    </button>
  );
}

function ScoreEditSheet({
  team,
  line,
  members,
  openHole,
  complete,
  onClose,
}: {
  team: Team;
  line: TeamHoleLine;
  members: Player[];
  openHole: number | null;
  complete: boolean;
  onClose: () => void;
}) {
  const dispatch = useCommishDispatch();
  const toast = useToast();
  const [strokes, setStrokes] = useState<number>(line.strokes ?? line.par);
  const [teeShot, setTeeShot] = useState<string | null>(line.tee_shot_player_id);
  const strokesChanged = line.strokes === null || strokes !== line.strokes;
  const teeChanged = teeShot !== line.tee_shot_player_id;
  const dirty = strokesChanged || teeChanged;
  const opensHole = !complete && line.hole === (openHole ?? 0) + 1;
  const net = strokes - line.credit;

  const save = () => {
    let ok = true;
    if (strokesChanged) {
      ok = dispatch({ type: "score.set", team_id: team.id, hole: line.hole, strokes, as_commissioner: true });
    }
    if (ok && teeChanged) {
      ok = dispatch({ type: "teeshot.set", team_id: team.id, hole: line.hole, player_id: teeShot, as_commissioner: true });
    }
    if (ok) {
      toast.success(
        line.strokes !== null && strokesChanged ? `Hole ${line.hole}: ${line.strokes} → ${strokes}. The feed has been notified.` : `Hole ${line.hole} fixed. The feed knows.`,
        { emoji: "⚖️", title: team.name },
      );
      onClose();
    }
  };

  return (
    <BottomSheet
      open
      onClose={onClose}
      title={
        <span>
          Hole {line.hole} <span className="text-base font-extrabold text-muted">par {line.par} · {team.name}</span>
        </span>
      }
      footer={
        <Button variant="primary" size="xl" full disabled={!dirty} onClick={save} data-testid="commish-score-save">
          {dirty ? "Override it" : "No changes"}
        </Button>
      }
    >
      <div className="space-y-5 pt-1 pb-2">
        <Stepper
          label="Strokes"
          value={strokes}
          min={1}
          max={20}
          onChange={setStrokes}
          decrementLabel="One fewer stroke"
          incrementLabel="One more stroke"
          hint={
            line.credit > 0
              ? `${line.drinks} drink${line.drinks === 1 ? "" : "s"} (−${line.credit}) → net ${net}`
              : `net ${net}${line.strokes !== null ? ` · was ${line.strokes}` : ""}`
          }
        />
        <section>
          <h3 className="mb-2 text-sm font-extrabold tracking-wider uppercase">Whose tee shot</h3>
          <div className="flex flex-wrap gap-2">
            {members.map((p) => (
              <Chip key={p.id} selected={teeShot === p.id} onClick={() => setTeeShot(p.id)}>
                <PlayerName player={p} />
              </Chip>
            ))}
            <Chip selected={teeShot === null} tone="ink" onClick={() => setTeeShot(null)}>
              Nobody
            </Chip>
          </div>
          {line.tee_shot_player_id && !members.some((m) => m.id === line.tee_shot_player_id) && (
            <p className="mt-2 text-sm font-bold text-muted">Recorded tee shot belongs to someone no longer on the team.</p>
          )}
        </section>
        {opensHole && (
          <p className="rounded-xl border-2 border-ink bg-hazard-soft px-3 py-2 text-sm font-bold">
            Heads up: {team.name} {openHole ? `is on hole ${openHole}` : "hasn't teed off"}. Saving hole {line.hole} opens its drink
            window{openHole ? ` and closes hole ${openHole}` : ""}.
          </p>
        )}
        <p className="text-sm font-semibold text-muted">
          Posts a Commissioner override to the feed. Every net, standing and pot recomputes. Tee shot now:{" "}
          {teeShot ? displayName(members.find((m) => m.id === teeShot)) : "nobody"}.
        </p>
      </div>
    </BottomSheet>
  );
}
