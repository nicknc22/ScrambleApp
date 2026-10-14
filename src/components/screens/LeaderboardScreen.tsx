"use client";
// Leaderboard tab: live team standings (tap for the hole-by-hole card) plus Drinkers, Contests and
// Drives sub-tabs. Everything comes from derived (engine output); nothing here writes.
import { useState } from "react";
import type { UUID } from "@/lib/types";
import type { Derived } from "@/lib/engine/types";
import { useClientState } from "@/lib/client/react";
import { readPref, writePref } from "@/lib/client/ui-prefs";
import { EmptyState, SegmentedControl, cx, type SegmentOption } from "@/components/ui";
import { Screen } from "@/components/shell/Screen";
import { useShellNav } from "@/components/shell/nav";
import { StandingsTable } from "@/components/leaderboard/StandingsTable";
import { TeamCardSheet } from "@/components/leaderboard/TeamCardSheet";
import { DrinkersBoard } from "@/components/leaderboard/DrinkersBoard";
import { ContestsBoard } from "@/components/leaderboard/ContestsBoard";
import { DrivesBoard } from "@/components/leaderboard/DrivesBoard";
import { leaderBannerLine, leaderHeadline, myChaseLine } from "@/components/leaderboard/model";

type Sub = "teams" | "drinkers" | "contests" | "drives";
const SUBS: readonly Sub[] = ["teams", "drinkers", "contests", "drives"];
const SUB_PREF = "scramble:board-sub";

function initialSub(): Sub {
  const v = readPref(SUB_PREF);
  return SUBS.includes(v as Sub) ? (v as Sub) : "teams";
}

export function LeaderboardScreen() {
  const derived = useClientState((s) => s.derived);
  const meId = useClientState((s) => s.meId);
  const status = useClientState((s) => s.view?.trip.status ?? "setup");
  const nav = useShellNav();
  const [sub, setSubState] = useState<Sub>(initialSub);
  const [openTeam, setOpenTeam] = useState<UUID | null>(null);

  if (!derived) return null;
  const setSub = (v: Sub) => {
    setSubState(v);
    writePref(SUB_PREF, v);
  };
  const myTeamId = meId ? (derived.teamOfPlayer[meId] ?? null) : null;
  const flagged = derived.contests.some((c) => c.entries.some((e) => e.suspicious));
  const driveAlert = Object.values(derived.driveMin).some((t) => {
    const nine = t.nines[t.current_nine - 1];
    return !nine.closed && (nine.level === "hard" || nine.level === "impossible");
  });

  const options: SegmentOption<Sub>[] = [
    { value: "teams", label: "Teams" },
    { value: "drinkers", label: "Drinkers" },
    { value: "contests", label: "Contests", badge: flagged ? "!" : undefined },
    { value: "drives", label: "Drives", badge: driveAlert ? "!" : undefined },
  ];

  return (
    <Screen>
      <SegmentedControl options={options} value={sub} onChange={setSub} ariaLabel="Leaderboard views" />
      {sub === "teams" &&
        (derived.standings.length === 0 ? (
          <EmptyState emoji="🏌️" title="No teams yet">
            The leaderboard fills up once the commissioner builds teams and people start scoring.
          </EmptyState>
        ) : (
          <div className="space-y-3">
            <LeaderBanner derived={derived} final={status === "final"} myTeamId={myTeamId} />
            <StandingsTable standings={derived.standings} teamById={derived.teamById} myTeamId={myTeamId} onOpenTeam={setOpenTeam} />
            <BoardLegend />
          </div>
        ))}
      {sub === "drinkers" && <DrinkersBoard derived={derived} meId={meId} />}
      {sub === "contests" && <ContestsBoard derived={derived} meId={meId} onOpenContests={() => nav.setTab("contests")} />}
      {sub === "drives" && <DrivesBoard derived={derived} meId={meId} />}
      <TeamCardSheet teamId={openTeam} derived={derived} myTeamId={myTeamId} onClose={() => setOpenTeam(null)} />
    </Screen>
  );
}

/** Plain-words key under the table: what every column means, one line each. */
const LEGEND: readonly { term: string; text: string }[] = [
  { term: "To par", text: "your net vs par so far. Lowest wins; ties share a spot (T2)." },
  { term: "Thru", text: "holes scored." },
  { term: "Drk / Cred", text: "drinks and the strokes they took off (👻 ghost beers count 2)." },
  { term: "Net", text: "strokes (Grs) − Cred." },
  { term: "🍺 banked", text: "drinks on a hole with no score yet; they count once it's scored." },
];

export function BoardLegend() {
  return (
    <ul className="space-y-0.5 text-[13px] leading-snug font-semibold text-muted" data-testid="board-legend" aria-label="What the columns mean">
      {LEGEND.map((l) => (
        <li key={l.term}>
          <b className="text-ink">{l.term}</b> = {l.text}
        </li>
      ))}
      <li>Tap a team for its card.</li>
    </ul>
  );
}

export function LeaderBanner({ derived, final, myTeamId }: { derived: Derived; final: boolean; myTeamId: UUID | null }) {
  const h = leaderHeadline(derived);
  const chase = myChaseLine(derived.standings, myTeamId);
  if (h.kind === "none") {
    return (
      <div className="rounded-2xl border-2 border-ink bg-sand px-4 py-3" data-testid="leader-banner" data-kind="none">
        <p className="loud text-2xl">Everybody&apos;s tied for first</p>
        <p className="text-[15px] font-semibold text-muted">Nobody&apos;s posted a score yet. Enjoy the peace while it lasts.</p>
      </div>
    );
  }
  const names = h.names.join(" & ");
  return (
    <div
      className={cx("relative overflow-hidden rounded-2xl border-2 border-ink px-4 py-3 shadow-hard", final ? "bg-gold" : "bg-hazard")}
      data-testid="leader-banner"
      data-kind={h.kind}
    >
      <span className="pointer-events-none absolute -top-3 -right-1 rotate-12 text-6xl opacity-90" aria-hidden="true">
        {final ? "🏆" : h.kind === "tie" ? "🤝" : "👑"}
      </span>
      <p className="text-[12px] font-black tracking-widest uppercase">
        {final ? "Champions" : h.kind === "tie" ? "Dead heat at the top" : "Leading the pack"}
      </p>
      {h.kind === "tie" ? (
        <ul className="pr-12">
          {h.names.map((n, i) => (
            <li key={i} className="loud truncate text-[22px] leading-tight">
              {n}
            </li>
          ))}
        </ul>
      ) : (
        <p className="loud line-clamp-2 pr-14 text-[28px] break-words">{names}</p>
      )}
      <p className="num text-[17px] font-black" data-testid="leader-score">
        {leaderBannerLine(h)}
      </p>
      {chase && (
        <p className="num mt-1 text-[15px] leading-tight font-extrabold" data-testid="leader-chase">
          {chase}
        </p>
      )}
    </div>
  );
}
