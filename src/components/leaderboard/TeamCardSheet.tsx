"use client";
// Hole-by-hole card for one team (bottom sheet): strokes, drinks, credit, net and whose tee shot,
// with OUT / IN / TOT rows, plus the headline numbers and ghost beers.
import type { UUID } from "@/lib/types";
import type { Derived, TeamHoleLine } from "@/lib/engine/types";
import { formatToPar } from "@/lib/engine/format";
import { BottomSheet, PlayerName, StatTile, cx, displayName, teamColor } from "@/components/ui";
import { DASH, scoreShape, scorecardSections, shortInitials, toParTone, type CardSum, type ScoreShape } from "./model";

const GRID = "grid grid-cols-[2.6rem_2rem_minmax(0,1fr)_2.2rem_2.4rem_2.6rem_2.9rem] items-center gap-x-1";

const SHAPE_CLASS: Record<ScoreShape, string> = {
  albatross: "rounded-full bg-fairway text-white ring-2 ring-fairway ring-offset-2",
  eagle: "rounded-full bg-fairway text-white ring-2 ring-fairway ring-offset-2",
  birdie: "rounded-full bg-fairway text-white",
  par: "rounded-md text-ink",
  bogey: "rounded-md border-2 border-ink text-ink",
  double: "rounded-md bg-flag text-white",
  none: "text-muted",
};

export function TeamCardSheet({
  teamId,
  derived,
  myTeamId,
  onClose,
}: {
  teamId: UUID | null;
  derived: Derived;
  myTeamId: UUID | null;
  onClose: () => void;
}) {
  const team = teamId ? derived.teamById[teamId] : undefined;
  const open = !!teamId && !!team;
  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      size="tall"
      title={team ? <span className="line-clamp-2 break-words">{team.name || "Unnamed team"}</span> : undefined}
    >
      {open && teamId && <TeamCard teamId={teamId} derived={derived} mine={teamId === myTeamId} />}
    </BottomSheet>
  );
}

function TeamCard({ teamId, derived, mine }: { teamId: UUID; derived: Derived; mine: boolean }) {
  const team = derived.teamById[teamId];
  const row = derived.standings.find((r) => r.team_id === teamId);
  const lines = derived.teamHoles[teamId] ?? [];
  const members = derived.membersOfTeam[teamId] ?? [];
  const { front, back, total } = scorecardSections(lines);
  const openHole = derived.openWindow[teamId] ?? null;
  const toPar = row && row.thru > 0 ? row.net_to_par : null;
  const tone = toParTone(toPar);
  const color = teamColor(team?.sort_order ?? null);

  return (
    <div className="space-y-4 pb-2" data-testid="team-card" data-team-id={teamId}>
      <div className="flex flex-wrap items-center gap-2">
        {mine && <span className="rounded-full border-2 border-ink bg-hazard px-2.5 py-1 text-sm font-black">★ Your team</span>}
        {row && (
          <span className="num rounded-full border-2 border-ink bg-paper px-2.5 py-1 text-sm font-black">
            {row.thru > 0 ? `Pos ${row.pos_label}` : "Not started"}
          </span>
        )}
        {row && row.thru > 0 && (
          <span className="num rounded-full border-2 border-ink bg-paper px-2.5 py-1 text-sm font-black">
            Thru {row.thru_label}
          </span>
        )}
        {openHole !== null && (
          <span className="num rounded-full border-2 border-beer-dark bg-beer-soft px-2.5 py-1 text-sm font-black">🍺 Window: hole {openHole}</span>
        )}
      </div>

      <div className="grid grid-cols-4 gap-2">
        <StatTile label="Gross" value={row && row.thru > 0 ? row.gross : DASH} />
        <StatTile label="Credit" value={row ? (row.credit > 0 ? `-${row.credit}` : 0) : 0} tone={row && row.credit > 0 ? "ghost" : "default"} />
        <StatTile label="Net" value={row && row.thru > 0 ? row.net : DASH} />
        <StatTile
          label="To par"
          value={toPar === null ? DASH : formatToPar(toPar)}
          tone={tone === "under" ? "fairway" : tone === "over" ? "flag" : tone === "even" ? "ink" : "default"}
        />
      </div>

      <div className="flex flex-wrap gap-2 text-sm font-extrabold">
        <span className="rounded-full bg-beer-soft px-3 py-1.5" data-testid="card-drinks">
          🍺 {row?.drinks ?? 0} {row?.drinks === 1 ? "drink" : "drinks"}
        </span>
        <span className="rounded-full bg-ghost-soft px-3 py-1.5 text-ghost-dark" data-testid="card-ghosts">
          👻 {row?.ghost_beers ?? 0} ghost {row?.ghost_beers === 1 ? "beer" : "beers"}
        </span>
        {row?.status === "complete" && <span className="rounded-full bg-fairway-soft px-3 py-1.5 text-fairway-dark">🏁 Done</span>}
      </div>

      {members.length > 0 && (
        <ul className="flex flex-wrap gap-x-3 gap-y-1.5 text-[15px] font-bold" aria-label="Tee shot initials">
          {members.map((p) => (
            <li key={p.id} className="flex items-center gap-1.5">
              <span
                className="num inline-flex h-7 min-w-7 items-center justify-center rounded-full border-2 border-ink px-1 text-[11px] font-black"
                style={{ backgroundColor: color.bg, color: color.fg }}
                aria-hidden="true"
              >
                {shortInitials(displayName(p))}
              </span>
              <PlayerName player={p} />
            </li>
          ))}
        </ul>
      )}

      <div className="overflow-hidden rounded-2xl border-2 border-ink" role="table" aria-label="Hole-by-hole scorecard">
        <div role="rowgroup">
          <div role="row" className={cx(GRID, "bg-ink px-2 py-2 text-[10px] leading-none font-black tracking-tight text-white uppercase")}>
            <span role="columnheader">Hole</span>
            <span role="columnheader" className="text-center">
              Par
            </span>
            <span role="columnheader" className="text-center">
              Score
            </span>
            <span role="columnheader" className="text-right">
              Drk
            </span>
            <span role="columnheader" className="text-right">
              Cred
            </span>
            <span role="columnheader" className="text-right">
              Net
            </span>
            <span role="columnheader" className="text-right">
              Tee
            </span>
          </div>
        </div>
        <div role="rowgroup">
          {front.lines.map((l) => (
            <HoleRow key={l.hole} line={l} derived={derived} open={openHole === l.hole} />
          ))}
          <SumRow sum={front.sum} />
          {back.lines.map((l) => (
            <HoleRow key={l.hole} line={l} derived={derived} open={openHole === l.hole} />
          ))}
          <SumRow sum={back.sum} />
          <SumRow sum={total} />
        </div>
      </div>
      <p className="text-sm font-semibold text-muted">
        Net = strokes − drink credit. Drinks count on the hole whose window was open. Purple nets are zero or better. Yes, really.
      </p>
    </div>
  );
}

function HoleRow({ line: l, derived, open }: { line: TeamHoleLine; derived: Derived; open: boolean }) {
  const shape = scoreShape(l.strokes, l.par);
  const tee = l.tee_shot_player_id ? derived.playerById[l.tee_shot_player_id] : undefined;
  const contest = l.contest === "ctp" ? "CTP" : l.contest === "ld" ? "LD" : null;
  return (
    <div
      role="row"
      data-testid="card-hole"
      data-hole={l.hole}
      className={cx(GRID, "min-h-11 border-t border-line px-2 py-1 text-[15px] font-bold", open && "bg-beer-soft")}
    >
      <span role="cell" className="flex items-center gap-1">
        <span className="num font-black">{l.hole}</span>
        {contest && <span className="rounded bg-sky px-0.5 text-[8px] leading-tight font-black text-white">{contest}</span>}
      </span>
      <span role="cell" className="num text-center text-muted">
        {l.par}
      </span>
      <span role="cell" className="flex justify-center">
        <span className={cx("num relative inline-flex h-7 min-w-7 items-center justify-center px-1 font-black", SHAPE_CLASS[shape])}>
          {l.strokes ?? DASH}
          {l.edit_count > 0 && (
            <span
              className="absolute -top-2 -right-3 text-[10px] leading-none"
              title={`Edited ${l.edit_count}×`}
              aria-label={`edited ${l.edit_count} ${l.edit_count === 1 ? "time" : "times"}`}
            >
              ✏️
            </span>
          )}
        </span>
      </span>
      <span role="cell" className="num text-right">
        {l.drinks > 0 ? l.drinks : <span className="text-line-strong">0</span>}
      </span>
      <span role="cell" className={cx("num text-right", l.credit > 0 ? "text-ghost" : "text-line-strong")}>
        {l.credit > 0 ? `-${l.credit}` : 0}
      </span>
      <span role="cell" className="flex justify-end">
        {l.net === null ? (
          <span className="num text-muted">{DASH}</span>
        ) : (
          <span className={cx("num rounded-md px-1 font-black", l.net <= 0 ? "bg-ghost text-white" : "")}>{l.net}</span>
        )}
      </span>
      <span role="cell" className="num text-right text-[12px] font-black">
        {tee ? (
          <span className="rounded-full border-2 border-ink px-1 py-0.5" title={displayName(tee)}>
            {shortInitials(displayName(tee))}
          </span>
        ) : (
          <span className="text-muted">{DASH}</span>
        )}
      </span>
    </div>
  );
}

function SumRow({ sum }: { sum: CardSum }) {
  const tot = sum.label === "TOT";
  return (
    <div
      role="row"
      data-testid={`card-sum-${sum.label.toLowerCase()}`}
      className={cx(GRID, "min-h-11 border-t-2 border-ink px-2 py-1 text-[15px] font-black", tot ? "bg-ink text-white" : "bg-sand")}
    >
      <span role="cell" className="text-[12px] tracking-wide">
        {sum.label}
      </span>
      <span role="cell" className={cx("num text-center", tot ? "text-white/80" : "text-muted")}>
        {sum.par}
      </span>
      <span role="cell" className="num text-center">
        {sum.strokes ?? DASH}
      </span>
      <span role="cell" className="num text-right">
        {sum.drinks}
      </span>
      <span role="cell" className={cx("num text-right", !tot && sum.credit > 0 && "text-ghost")}>
        {sum.credit > 0 ? `-${sum.credit}` : 0}
      </span>
      <span role="cell" className="num text-right">
        {sum.net ?? DASH}
      </span>
      <span role="cell" />
    </div>
  );
}
