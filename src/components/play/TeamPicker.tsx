"use client";
// "Score for which team?" — for anyone not on a team, and for the commissioner (any team).
import type { UUID } from "@/lib/types";
import type { Derived } from "@/lib/engine/types";
import { Badge, Card, EmptyState, IconChevronRight, PlayerName, TeamPill, cardClasses, teamColor } from "@/components/ui";
import { Screen } from "@/components/shell/Screen";
import { toParWords } from "@/components/leaderboard/model";

const KEY = (code: string) => `scramble:play-team:${code}`;

/** Team picked for this session (sessionStorage; null when none or storage is blocked). */
export function readTeamChoice(code: string): UUID | null {
  try {
    if (typeof window === "undefined") return null;
    return window.sessionStorage.getItem(KEY(code)) || null;
  } catch {
    return null;
  }
}

export function writeTeamChoice(code: string, teamId: UUID | null): void {
  try {
    if (typeof window === "undefined") return;
    if (teamId) window.sessionStorage.setItem(KEY(code), teamId);
    else window.sessionStorage.removeItem(KEY(code));
  } catch {
    /* best effort */
  }
}

export function TeamPicker({
  derived,
  myTeamId,
  isCommissioner,
  onPick,
}: {
  derived: Derived;
  myTeamId: UUID | null;
  isCommissioner: boolean;
  onPick: (teamId: UUID) => void;
}) {
  const teams = derived.teams;
  return (
    <Screen>
      <div className="pt-1">
        <h1 className="loud text-[clamp(2.2rem,11vw,3.4rem)]">Score for which team?</h1>
        <p className="mt-2 text-base font-bold text-muted">
          {isCommissioner
            ? "Commissioner powers: you can score any team. Edits on other teams post to the feed as overrides."
            : "You're not on a team, so pick the group you're keeping score for. This phone remembers it until you close the app."}
        </p>
      </div>
      {teams.length === 0 && (
        <EmptyState emoji="🦗" title="No teams yet">
          The commissioner hasn&apos;t set up teams. Go yell at him.
        </EmptyState>
      )}
      <ul className="space-y-3" data-testid="team-picker">
        {teams.map((t) => {
          const members = derived.membersOfTeam[t.id] ?? [];
          const row = derived.standings.find((r) => r.team_id === t.id);
          const c = teamColor(t.sort_order);
          const status =
            row?.status === "complete"
              ? "Finished"
              : row?.status === "playing"
                ? `Hole ${derived.currentHole[t.id] ?? 1}`
                : "Not started";
          return (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => onPick(t.id)}
                className={cardClasses({ padded: false, className: "w-full overflow-hidden text-left active:scale-[0.99]" })}
                style={{ borderColor: "#0b0f0c" }}
              >
                <span className="flex min-h-14 items-center gap-2 px-4 py-3" style={{ backgroundColor: c.soft }}>
                  <TeamPill team={t} size="lg" you={t.id === myTeamId} />
                  <span className="min-w-0 flex-1" />
                  <Badge tone={row?.status === "playing" ? "fairway" : "outline"} size="md">
                    {status}
                  </Badge>
                  <IconChevronRight size={26} strokeWidth={3} className="shrink-0" />
                </span>
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-base font-bold">
                  {members.map((p, i) => (
                    <span key={p.id} className="min-w-0">
                      <PlayerName player={p} />
                      {i < members.length - 1 && <span className="text-muted"> ·</span>}
                    </span>
                  ))}
                  {members.length === 0 && <span className="text-muted">Nobody on this team</span>}
                </span>
                {row && row.thru > 0 && (
                  <span className="block border-t-2 border-line px-4 py-2 text-sm font-extrabold text-muted">
                    Pos {row.pos_label} · {toParWords(row.net_to_par)} · thru {row.thru_label}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {teams.length > 0 && (
        <Card tone="sand" className="text-sm font-bold text-muted">
          Wrong phone? Use the menu to switch player.
        </Card>
      )}
    </Screen>
  );
}
