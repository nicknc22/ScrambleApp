"use client";
// Drive-minimum status for every player: tee shots used per nine, who still needs one, who missed.
import type { UUID } from "@/lib/types";
import type { Derived } from "@/lib/engine/types";
import { EmptyState, PlayerName, TeamPill, cx } from "@/components/ui";
import { driveViews, type DriveCellState, type DriveTeamView } from "./model";

const CELL: Record<DriveCellState, string> = {
  ok: "bg-fairway text-white border-fairway-dark",
  needs: "bg-paper text-ink border-ink border-dashed",
  needs_soft: "bg-hazard text-ink border-ink",
  needs_hard: "bg-flag text-white border-flag-dark animate-pulse",
  missed: "bg-ink text-white border-ink",
  idle: "bg-sand text-muted border-line",
};

const CELL_HINT: Record<DriveCellState, string> = {
  ok: "used",
  needs: "needs a drive",
  needs_soft: "needs a drive soon",
  needs_hard: "needs a drive NOW",
  missed: "missed",
  idle: "not yet",
};

export function DrivesBoard({ derived, meId }: { derived: Derived; meId: UUID | null }) {
  const teams = driveViews(derived);
  if (teams.length === 0) {
    return (
      <EmptyState emoji="🏌️" title="No teams yet">
        Drive minimums show up once teams exist.
      </EmptyState>
    );
  }
  const myTeam = meId ? (derived.teamOfPlayer[meId] ?? null) : null;
  return (
    <div className="space-y-3">
      <p className="text-[15px] font-semibold text-muted">
        Everyone&apos;s tee shot gets used at least once per nine. Par 3s count. No excuses.
      </p>
      {teams.map((t) => (
        <DriveTeamCard key={t.team_id} view={t} derived={derived} meId={meId} mine={t.team_id === myTeam} />
      ))}
      <ul className="flex flex-wrap gap-x-3 gap-y-1.5 text-[12px] font-bold text-muted" aria-label="Legend">
        {(["ok", "needs_soft", "needs_hard", "missed"] as const).map((k) => (
          <li key={k} className="flex items-center gap-1">
            <span className={cx("inline-block h-4 w-4 rounded border-2", CELL[k].replace("animate-pulse", ""))} aria-hidden="true" />
            {k === "ok" ? "Used" : k === "needs_soft" ? "Needs one (≤3 left)" : k === "needs_hard" ? "Now or never" : "Missed"}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DriveTeamCard({ view: t, derived, meId, mine }: { view: DriveTeamView; derived: Derived; meId: UUID | null; mine: boolean }) {
  const team = derived.teamById[t.team_id];
  const hard = t.level === "hard" || t.level === "impossible";
  const soft = t.level === "soft";
  const done = derived.standings.find((r) => r.team_id === t.team_id)?.status === "complete";
  const where = done ? "Finished" : t.current_nine === 2 ? "On back 9" : "On front 9";
  return (
    <section
      data-testid="drive-team"
      data-team-id={t.team_id}
      data-level={t.level}
      className={cx("overflow-hidden rounded-2xl border-2", hard ? "border-flag" : "border-ink", mine && "shadow-hard-sm")}
    >
      <header className="flex items-center justify-between gap-2 bg-sand px-3 py-2">
        <span className="min-w-0">
          <TeamPill team={team} size="sm" you={mine} />
        </span>
        <span className="shrink-0 text-[12px] font-black tracking-wide whitespace-nowrap text-muted uppercase">{where}</span>
      </header>
      {(hard || soft) && t.needing.length > 0 && (
        <p className={cx("px-3 py-2 text-[15px] leading-tight font-extrabold", hard ? "bg-flag text-white" : "bg-hazard text-ink")}>
          {hard ? "🚨 " : "⚠️ "}
          {t.level === "impossible"
            ? `${t.needing.length} need a drive, only ${t.remaining} ${t.remaining === 1 ? "hole" : "holes"} left. Math says no.`
            : `${t.remaining} ${t.remaining === 1 ? "hole" : "holes"} left, ${t.needing.length} still ${t.needing.length === 1 ? "needs" : "need"} a drive.`}
        </p>
      )}
      {t.missed_any && (
        <p className="bg-ink px-3 py-2 text-[14px] leading-tight font-bold text-white">🚩 Somebody went a whole nine without a drive. Commissioner has been notified.</p>
      )}
      <div className="grid grid-cols-[minmax(0,1fr)_4.25rem_4.25rem] items-center gap-x-2 px-3 pt-2 pb-1 text-[10px] font-black tracking-wide text-muted uppercase">
        <span>Player</span>
        <span className="text-center">Front 9</span>
        <span className="text-center">Back 9</span>
      </div>
      <ul>
        {t.players.map((p) => {
          const player = derived.playerById[p.player_id];
          return (
            <li
              key={p.player_id}
              data-testid="drive-player"
              data-player-id={p.player_id}
              data-front={p.front_state}
              data-back={p.back_state}
              className="grid min-h-13 grid-cols-[minmax(0,1fr)_4.25rem_4.25rem] items-center gap-x-2 border-t border-line px-3 py-1.5"
            >
              <span className="truncate text-[16px] font-extrabold">
                <PlayerName player={player} you={p.player_id === meId} />
              </span>
              <DriveCell count={p.front} state={p.front_state} label={`front nine: ${p.front}, ${CELL_HINT[p.front_state]}`} />
              <DriveCell count={p.back} state={p.back_state} label={`back nine: ${p.back}, ${CELL_HINT[p.back_state]}`} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function DriveCell({ count, state, label }: { count: number; state: DriveCellState; label: string }) {
  return (
    <span
      className={cx("num flex h-10 items-center justify-center gap-1 rounded-xl border-2 text-[17px] font-black", CELL[state])}
      aria-label={label}
      title={label}
    >
      {state === "missed" ? "✗ 0" : count}
      {state === "ok" && <span className="text-[12px]">✓</span>}
    </span>
  );
}
