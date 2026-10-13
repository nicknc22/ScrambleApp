// Pot cards for the Money tab: the team match and one compact card per contest hole.
// Presentational (props only) so they server-render in tests.
import type { Player, UUID } from "@/lib/types";
import type { ContestHoleSummary, Derived, PotView } from "@/lib/engine/types";
import { formatCents, formatFeetInches, ordinal } from "@/lib/engine/format";
import { Avatar, Badge, Card, PlayerName, TeamPill, cx, displayName, teamColor, type BadgeTone } from "@/components/ui";
import { CONTEST_EMOJI, joinPotNames, payoutRuleLabel, potShortName, potStatus, sittingOut, teamPayoutGroups, type StatusTone } from "./money";

const STATUS_BADGE: Record<StatusTone, BadgeTone> = {
  fairway: "fairway",
  sky: "sky",
  hazard: "hazard",
  ghost: "ghost",
  neutral: "neutral",
};

export type PotPeople = Pick<Derived, "players" | "playerById" | "teamById" | "teamOfPlayer" | "standings">;

function names(players: Player[]): string {
  return players.map((p) => displayName(p)).join(", ");
}

function teamSortOf(people: PotPeople, playerId: UUID): number | null {
  const t = people.teamById[people.teamOfPlayer[playerId]];
  return t ? t.sort_order : null;
}

function PotHeader({ pot, final, emoji, title, sub }: { pot: PotView; final: boolean; emoji: string; title: string; sub: string }) {
  const st = potStatus(pot, final);
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 text-3xl leading-none" aria-hidden="true">
        {emoji}
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="text-lg leading-tight font-black text-ink">{title}</h3>
        <p className="mt-0.5 text-sm leading-snug font-bold text-muted">{sub}</p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className={cx("num text-2xl leading-none font-black", pot.status === "rolled" && "text-muted line-through decoration-2")}>
          {formatCents(pot.total_cents)}
        </span>
        <Badge tone={STATUS_BADGE[st.tone]} data-testid="pot-status">
          {st.label}
        </Badge>
      </div>
    </div>
  );
}

function RolloverIn({ pot }: { pot: PotView }) {
  if (pot.rollover_in_cents <= 0 || pot.rolled_from.length === 0) return null;
  return (
    <p className="mt-2 rounded-xl border-2 border-ghost bg-ghost-soft px-3 py-2 text-[15px] leading-snug font-bold text-ink">
      <span aria-hidden="true">↪ </span>+{formatCents(pot.rollover_in_cents)} rolled from {joinPotNames(pot.rolled_from)}
    </p>
  );
}

function anteLine(pot: PotView): string {
  const n = pot.participants.length;
  if (pot.ante_cents <= 0) return "No ante. Playing for pride.";
  return `${formatCents(pot.ante_cents)} × ${n} ${n === 1 ? "player" : "players"}`;
}

function SittingOut({ pot, people }: { pot: PotView; people: PotPeople }) {
  const out = sittingOut(pot, people);
  if (out.length === 0) return null;
  return (
    <p className="mt-2 text-sm leading-snug font-semibold text-muted">
      <span aria-hidden="true">🐔 </span>Sitting out: {names(out)}
    </p>
  );
}

/** The team match: payout rule, rollover in, projected/final winners grouped by team. */
export function TeamMatchCard({
  pot,
  final,
  payout,
  people,
  meId,
}: {
  pot: PotView;
  final: boolean;
  payout: readonly number[];
  people: PotPeople;
  meId: UUID | null;
}) {
  const groups = pot.status === "won" ? teamPayoutGroups(pot, people.teamOfPlayer, people.standings) : [];
  const multiPlace = payout.filter((p) => p > 0).length > 1;
  return (
    <Card className="border-ink" data-testid="pot-card" data-pot={pot.key}>
      <PotHeader pot={pot} final={final} emoji="🏆" title="Team match" sub={`${payoutRuleLabel(payout)} · ${anteLine(pot)}`} />
      <RolloverIn pot={pot} />
      {pot.status === "pending" && (
        <p className="mt-3 text-[15px] font-bold text-muted">Nobody&apos;s scored yet. The pot just sits there, judging you.</p>
      )}
      {pot.status === "refunded" && (
        <p className="mt-3 text-[15px] font-bold text-ink">Nobody could win it, so everybody gets their ante back.</p>
      )}
      {groups.length > 0 && (
        <ul className="mt-3 space-y-2">
          {groups.map((g) => {
            const team = people.teamById[g.team_id];
            const color = teamColor(team?.sort_order);
            const equal = g.members.every((m) => m.cents === g.members[0].cents);
            return (
              <li
                key={g.team_id}
                className="rounded-2xl border-2 border-ink p-3"
                style={{ backgroundColor: color.soft }}
                data-testid="pot-team-payout"
              >
                <div className="flex items-center gap-2">
                  {multiPlace && <span className="loud shrink-0 text-xl text-ink">{placeLabel(g.pos_label)}</span>}
                  <TeamPill team={team} size="md" className="min-w-0" />
                  <span className="num ml-auto shrink-0 text-xl font-black text-ink">{formatCents(g.total_cents)}</span>
                </div>
                <ul className="mt-2 space-y-1">
                  {g.members.map((m) => (
                    <li key={m.player_id} className="flex min-h-7 items-center gap-2 text-[15px] font-bold text-ink">
                      <span className="min-w-0 truncate">
                        <PlayerName player={people.playerById[m.player_id]} you={m.player_id === meId} />
                      </span>
                      {!equal && <span className="num ml-auto shrink-0">{formatCents(m.cents)}</span>}
                    </li>
                  ))}
                </ul>
                {equal && g.members.length > 0 && (
                  <p className="num mt-1 text-sm font-black text-ink">{formatCents(g.members[0].cents)} each</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <SittingOut pot={pot} people={people} />
    </Card>
  );
}

function distanceLabel(contest: ContestHoleSummary | undefined, playerId: UUID): string | null {
  const v = contest?.entries.find((e) => e.player_id === playerId && e.valid);
  if (!v) return null;
  return v.type === "ctp" ? formatFeetInches(v.distance) : `${v.distance} yd`;
}

/** One contest hole's pot: winner(s) + amount, rolled / pending / refunded states. */
export function ContestPotCard({
  pot,
  final,
  contest,
  people,
  meId,
  quiet = false,
}: {
  pot: PotView;
  final: boolean;
  contest: ContestHoleSummary | undefined;
  people: PotPeople;
  meId: UUID | null;
  /** Skip the "nobody's on the board" line (before the round starts). */
  quiet?: boolean;
}) {
  const type = pot.contest_type ?? "ctp";
  return (
    <Card data-testid="pot-card" data-pot={pot.key}>
      <PotHeader pot={pot} final={final} emoji={CONTEST_EMOJI[type]} title={pot.label} sub={anteLine(pot)} />
      <RolloverIn pot={pot} />
      {pot.status === "won" && (
        <ul className="mt-2 space-y-1.5">
          {pot.winners.map((pid) => {
            const dist = distanceLabel(contest, pid);
            return (
              <li
                key={pid}
                className={cx(
                  "flex min-h-12 items-center gap-2.5 rounded-xl border-2 px-2.5 py-1.5",
                  final ? "border-fairway bg-fairway-soft" : "border-sky bg-sky-soft",
                )}
              >
                <Avatar player={people.playerById[pid]} teamSortOrder={teamSortOf(people, pid)} size="sm" showCrown={false} />
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="block truncate text-base font-black">
                    <PlayerName player={people.playerById[pid]} you={pid === meId} />
                  </span>
                  {dist && <span className="num block text-sm font-bold text-muted">{dist}</span>}
                </span>
                <span className="num shrink-0 text-lg font-black">{formatCents(pot.payouts[pid] ?? 0)}</span>
              </li>
            );
          })}
        </ul>
      )}
      {pot.status === "rolled" && (
        <p className="mt-2 text-[15px] leading-snug font-bold text-ink">
          Nobody made a valid {type === "ctp" ? "shot" : "drive"}. {formatCents(pot.total_cents)} rolled <span aria-hidden="true">→</span>{" "}
          {potShortName(pot.rolled_to ?? "team_match")}.
        </p>
      )}
      {pot.status === "pending" && !quiet && (
        <p className="mt-2 text-[15px] font-bold text-muted">
          {contest && contest.entries.length > 0 ? "Entries waiting on the commissioner." : "Nobody's on the board yet."}
        </p>
      )}
      {pot.status === "refunded" && <p className="mt-2 text-[15px] font-bold text-muted">Refunded. Nobody could win it.</p>}
      <SittingOut pot={pot} people={people} />
    </Card>
  );
}

/** "3rd"-style place label for a standings pos_label ("T2" -> "T2nd"). Exported for tests. */
export function placeLabel(posLabel: string): string {
  const tied = posLabel.startsWith("T");
  const n = Number.parseInt(tied ? posLabel.slice(1) : posLabel, 10);
  if (!Number.isFinite(n)) return posLabel;
  return `${tied ? "T" : ""}${ordinal(n)}`;
}
