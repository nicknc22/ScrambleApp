"use client";
// PLACEHOLDER: the Leaderboard agent replaces this file. Keep the export name and no-props signature.
import { useClientState } from "@/lib/client/react";
import { EmptyState, SectionHeader, TeamPill, cx } from "@/components/ui";
import { formatToPar } from "@/lib/engine/format";
import { Screen } from "@/components/shell/Screen";

export function LeaderboardScreen() {
  const derived = useClientState((s) => s.derived);
  if (!derived) return null;
  if (derived.standings.length === 0) {
    return (
      <Screen>
        <EmptyState emoji="🏌️" title="No teams yet">
          The leaderboard fills up once teams exist and start scoring.
        </EmptyState>
      </Screen>
    );
  }
  return (
    <Screen>
      <SectionHeader title="Leaderboard" subtitle="Sorted by net. Drinks are strokes. Science." />
      <div className="overflow-hidden rounded-2xl border-2 border-ink">
        <table className="w-full text-left">
          <thead className="bg-ink text-xs font-black tracking-wider text-white uppercase">
            <tr>
              <th className="px-2 py-2">Pos</th>
              <th className="px-2 py-2">Team</th>
              <th className="px-2 py-2 text-right">Thru</th>
              <th className="px-2 py-2 text-right">Net</th>
            </tr>
          </thead>
          <tbody>
            {derived.standings.map((r, i) => {
              const team = derived.teamById[r.team_id];
              return (
                <tr key={r.team_id} className={cx("border-t-2 border-line", i === 0 && r.thru > 0 && "bg-hazard-soft")}>
                  <td className="num px-2 py-3 text-lg font-black">{r.pos_label}</td>
                  <td className="max-w-0 px-2 py-3">
                    <TeamPill team={team ?? null} size="sm" />
                  </td>
                  <td className="num px-2 py-3 text-right font-bold">{r.thru_label}</td>
                  <td className="num px-2 py-3 text-right text-lg font-black">{formatToPar(r.net_to_par)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Screen>
  );
}
