// Champions hero + one card per award. Presentational (props only).
import type { UUID } from "@/lib/types";
import type { Award, Derived } from "@/lib/engine/types";
import { formatToPar } from "@/lib/engine/format";
import { Avatar, PlayerName, StatTile, TeamPill, cx, teamColor } from "@/components/ui";
import { toParWords } from "@/components/leaderboard/model";

export type AwardPeople = Pick<Derived, "playerById" | "teamById" | "teamOfPlayer" | "membersOfTeam" | "standings">;

function sortOf(people: AwardPeople, playerId: UUID): number | null {
  const t = people.teamById[people.teamOfPlayer[playerId]];
  return t ? t.sort_order : null;
}

/** The big gold card: champion team(s), net to par in words ("39 under · net 33"), members. */
export function ChampionsHero({ award, people, meId }: { award: Award | undefined; people: AwardPeople; meId: UUID | null }) {
  const rows = (award?.team_ids ?? [])
    .map((id) => people.standings.find((r) => r.team_id === id))
    .filter((r): r is NonNullable<typeof r> => !!r);
  if (!award?.awarded || rows.length === 0) {
    return (
      <section className="rounded-3xl border-2 border-ink bg-sand p-5 text-center" data-testid="champions">
        <div className="text-6xl" aria-hidden="true">
          🫠
        </div>
        <h2 className="loud mt-2 text-4xl">No champions</h2>
        <p className="mt-1 text-base font-bold text-muted">Nobody posted a score. Truly a historic failure.</p>
      </section>
    );
  }
  return (
    <section
      className="relative overflow-hidden rounded-3xl border-2 border-ink bg-gold p-4 text-ink shadow-hard"
      data-testid="champions"
      aria-label="Champions"
    >
      <div className="fanfare-rays opacity-60" aria-hidden="true" />
      <div className="relative">
        <div className="flex items-center gap-3">
          <span className="animate-bounce-in text-6xl leading-none" aria-hidden="true">
            🏆
          </span>
          <div className="min-w-0">
            <p className="loud text-xl tracking-wide">{rows.length > 1 ? "Co-champions" : "Champions"}</p>
            {/* Co-champions share the same net, so the first row speaks for all of them. */}
            <p className="num text-sm font-bold" data-testid="champions-score">
              {toParWords(rows[0].net_to_par)} · net {rows[0].net}
            </p>
          </div>
        </div>
        {rows.map((r) => {
          const team = people.teamById[r.team_id];
          const members = people.membersOfTeam[r.team_id] ?? [];
          return (
            <div key={r.team_id} className="mt-3 rounded-2xl border-2 border-ink bg-paper p-3">
              <h2
                className="loud text-[clamp(2rem,11vw,3rem)] break-words"
                style={{ color: teamColor(team?.sort_order).bg }}
                data-testid="champion-team"
              >
                {team?.name ?? "Unknown team"}
              </h2>
              <div className="mt-2 grid grid-cols-3 gap-2">
                <StatTile label="Net to par" value={formatToPar(r.net_to_par)} tone="fairway" />
                <StatTile label="Net" value={r.net} tone="ink" />
                <StatTile label="Gross" value={r.gross} />
              </div>
              <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
                {members.map((p) => (
                  <li key={p.id} className="flex min-w-0 items-center gap-2 text-base font-black">
                    <Avatar player={p} teamSortOrder={team?.sort_order} size="sm" showCrown={false} />
                    <PlayerName player={p} you={p.id === meId} />
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        {award.detail && <p className="mt-3 text-base leading-snug font-bold italic">{award.detail}</p>}
      </div>
    </section>
  );
}

function Winners({ award, people, meId }: { award: Award; people: AwardPeople; meId: UUID | null }) {
  if (award.player_ids.length > 0) {
    return (
      <ul className="mt-2 flex flex-wrap gap-2">
        {award.player_ids.map((id) => (
          <li
            key={id}
            className={cx(
              "flex min-h-10 max-w-full min-w-0 items-center gap-2 rounded-full border-2 py-1 pr-3 pl-1 text-base font-black",
              id === meId ? "border-ink bg-hazard" : "border-ink bg-paper",
            )}
          >
            <Avatar player={people.playerById[id]} teamSortOrder={sortOf(people, id)} size="sm" showCrown={false} />
            <PlayerName player={people.playerById[id]} you={id === meId} className="truncate" />
          </li>
        ))}
      </ul>
    );
  }
  if (award.team_ids.length > 0) {
    const myTeam = meId ? people.teamOfPlayer[meId] : undefined;
    return (
      <div className="mt-2 flex flex-wrap gap-2">
        {award.team_ids.map((id) => (
          <TeamPill key={id} team={people.teamById[id]} size="lg" you={id === myTeam} />
        ))}
      </div>
    );
  }
  return null;
}

export function AwardCard({
  award,
  people,
  meId,
  photoUrl,
  onPhoto,
}: {
  award: Award;
  people: AwardPeople;
  meId: UUID | null;
  photoUrl: string | null;
  onPhoto?: () => void;
}) {
  return (
    <li
      data-testid="award"
      data-award={award.key}
      data-awarded={award.awarded || undefined}
      className={cx("rounded-2xl border-2 p-4", award.awarded ? "border-ink bg-paper shadow-hard-sm" : "border-line bg-sand")}
    >
      <div className="flex items-center gap-3">
        <span className={cx("shrink-0 text-[2.6rem] leading-none", !award.awarded && "opacity-50 grayscale")} aria-hidden="true">
          {award.emoji}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className={cx("loud text-[1.6rem] break-words", !award.awarded && "text-muted")}>{award.title}</h3>
          {!award.awarded && <p className="mt-1 text-lg leading-tight font-black text-muted">Nobody. Boring.</p>}
        </div>
      </div>
      {award.awarded && (
        <div className="mt-1">
          <Winners award={award} people={people} meId={meId} />
          {award.value_label && <p className="num mt-2 text-xl leading-tight font-black text-ink">{award.value_label}</p>}
          {award.detail && <p className="mt-1 text-[15px] leading-snug font-semibold text-muted italic">{award.detail}</p>}
        </div>
      )}
      {award.awarded && award.photo_path && photoUrl && (
        <button
          type="button"
          onClick={onPhoto}
          className="relative mt-3 block aspect-[4/3] w-full overflow-hidden rounded-xl border-2 border-ink bg-sand"
          aria-label={`Open the ${award.title} photo`}
        >
          <span className="absolute inset-0 flex items-center justify-center text-4xl" aria-hidden="true">
            📷
          </span>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={photoUrl}
            alt=""
            loading="lazy"
            decoding="async"
            className="absolute inset-0 h-full w-full object-cover"
            onError={(e) => {
              e.currentTarget.style.visibility = "hidden";
            }}
          />
        </button>
      )}
    </li>
  );
}
