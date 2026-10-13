"use client";
// Drive-minimum misses, flagged for the commissioner. No automatic penalty (open item).
import { useClientState } from "@/lib/client/react";
import { Card, PlayerName, TeamPill } from "@/components/ui";
import { driveFlags } from "./commishModel";

export function FlagsPanel() {
  const derived = useClientState((s) => s.derived);
  if (!derived) return null;
  const flags = driveFlags(derived);
  const missed = flags.filter((f) => f.kind === "missed");
  const risk = flags.filter((f) => f.kind === "at_risk");
  const nineName = (n: 1 | 2) => (n === 1 ? "front nine" : "back nine");

  return (
    <div className="space-y-3" data-testid="commish-flags">
      <Card tone="sand" className="text-[15px] font-bold">
        Every player&apos;s drive must be used once per nine. There&apos;s <span className="font-black">no automatic penalty</span> yet
        (still an open item): settle it like gentlemen, at the bar.
      </Card>
      <h3 className="text-lg font-black uppercase">Missed ({missed.length})</h3>
      {missed.length === 0 ? (
        <p className="rounded-2xl bg-fairway-soft px-3 py-3 text-base font-bold">Nobody&apos;s been stiffed on drives. Yet.</p>
      ) : (
        <ul className="space-y-2">
          {missed.map((f) => (
            <li key={`${f.team_id}:${f.nine}`} className="space-y-1.5 rounded-2xl border-2 border-flag bg-flag-soft p-3" data-testid="commish-drive-miss">
              <div className="flex items-center gap-2">
                <TeamPill team={derived.teamById[f.team_id]} size="sm" />
                <span className="text-sm font-extrabold uppercase">{nineName(f.nine)}</span>
              </div>
              <p className="text-base font-black">
                {f.players.map((id, i) => (
                  <span key={id}>
                    {i > 0 ? ", " : ""}
                    <PlayerName player={derived.playerById[id]} />
                  </span>
                ))}{" "}
                never had a drive used. 🚩
              </p>
            </li>
          ))}
        </ul>
      )}
      {risk.length > 0 && (
        <>
          <h3 className="text-lg font-black uppercase">On the clock ({risk.length})</h3>
          <ul className="space-y-2">
            {risk.map((f) => (
              <li key={`${f.team_id}:${f.nine}`} className="space-y-1 rounded-2xl border-2 border-ink bg-hazard-soft p-3">
                <div className="flex items-center gap-2">
                  <TeamPill team={derived.teamById[f.team_id]} size="sm" />
                  <span className="text-sm font-extrabold uppercase">{nineName(f.nine)}</span>
                </div>
                <p className="text-base font-bold">
                  Still need a drive:{" "}
                  {f.players.map((id, i) => (
                    <span key={id} className="font-black">
                      {i > 0 ? ", " : ""}
                      <PlayerName player={derived.playerById[id]} />
                    </span>
                  ))}{" "}
                  · {f.remaining} hole{f.remaining === 1 ? "" : "s"} left
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
