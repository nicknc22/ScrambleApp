// Award cards for the Awards tab. Computed from current data on every derive(); the UI only shows
// them once the trip is final. Ties share an award; nobody qualifying -> awarded: false.
import type { ContestKind, TripState, UUID } from "../types";
import type { Award, AwardKey, ContestEntryView, Derived, StandingRow } from "./types";
import { contestScore } from "./contests";
import { formatFeetInches, formatToPar } from "./format";

type D = Omit<Derived, "awards" | "computed_at">;

export const AWARD_TITLES: Record<AwardKey, string> = {
  champions: "Champions",
  didnt_need_the_beer: "Didn't Need the Beer",
  most_drinks: "Most Drinks",
  ghost_whisperers: "Ghost Whisperers",
  longest_drive: "Longest Drive",
  closest_pin: "Closest Pin",
  biggest_beer_save: "Biggest Beer Save",
  worst_hole: "Worst Hole",
  mulligan_merchant: "Mulligan Merchant",
  edit_bandit: "Edit Bandit",
  most_suspicious: "Most Suspicious",
};

export const AWARD_EMOJI: Record<AwardKey, string> = {
  champions: "🏆",
  didnt_need_the_beer: "🥛",
  most_drinks: "🍺",
  ghost_whisperers: "👻",
  longest_drive: "💣",
  closest_pin: "🎯",
  biggest_beer_save: "🛟",
  worst_hole: "💀",
  mulligan_merchant: "🔁",
  edit_bandit: "✏️",
  most_suspicious: "🕵️",
};

/** "1 drink", "2 drinks". */
function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Every item with the maximum score (ties share). Empty input -> []. */
function maxBy<T>(items: T[], score: (t: T) => number): T[] {
  let best = -Infinity;
  let out: T[] = [];
  for (const it of items) {
    const s = score(it);
    if (s > best) {
      best = s;
      out = [it];
    } else if (s === best) {
      out.push(it);
    }
  }
  return out;
}

function base(key: AwardKey): Award {
  return {
    key,
    title: AWARD_TITLES[key],
    emoji: AWARD_EMOJI[key],
    team_ids: [],
    player_ids: [],
    value_label: "",
    detail: null,
    photo_path: null,
    awarded: false,
  };
}

/** All award cards (computed from current data; UI shows them when the trip is final). */
export function computeAwards(state: TripState, d: D): Award[] {
  const teamName = (id: UUID) => d.teamById[id]?.name ?? "Unknown team";
  const playerName = (id: UUID) => d.playerById[id]?.name ?? "Somebody";
  const playerOrder = new Map(d.players.map((p, i) => [p.id, i]));
  const teamOrder = new Map(d.teams.map((t, i) => [t.id, i]));
  const byPlayerOrder = (a: UUID, b: UUID) => (playerOrder.get(a) ?? 1e9) - (playerOrder.get(b) ?? 1e9) || (a < b ? -1 : a > b ? 1 : 0);
  const uniq = <T,>(xs: T[]) => [...new Set(xs)];
  const names = (ids: UUID[], nameOf: (id: UUID) => string) => ids.map(nameOf).join(" & ");

  /** Team award on a standings metric: lowest wins; compare *_to_par when teams are thru different holes. */
  const lowestTeam = (key: AwardKey, raw: (r: StandingRow) => number, toPar: (r: StandingRow) => number): { award: Award; winners: StandingRow[] } => {
    const award = base(key);
    const started = d.standings.filter((r) => r.thru > 0);
    if (started.length === 0) return { award, winners: [] };
    const sameThru = started.every((r) => r.thru === started[0].thru);
    const winners = maxBy(started, (r) => -(sameThru ? raw(r) : toPar(r)));
    award.awarded = true;
    award.team_ids = winners.map((r) => r.team_id);
    return { award, winners };
  };

  const awards: Award[] = [];

  // Champions: lowest net.
  {
    const { award, winners } = lowestTeam("champions", (r) => r.net, (r) => r.net_to_par);
    if (winners.length > 0) {
      const w = winners[0];
      award.value_label = `${formatToPar(w.net_to_par)} net`;
      award.detail =
        winners.length > 1
          ? `Dead heat at ${w.net} net. Split the trophy with a hacksaw.`
          : `${w.net} net: ${w.gross} gross minus ${plural(w.credit, "stroke")} of beer. Liver-assisted glory.`;
    }
    awards.push(award);
  }

  // Didn't Need the Beer: lowest gross.
  {
    const { award, winners } = lowestTeam("didnt_need_the_beer", (r) => r.gross, (r) => r.gross_to_par);
    if (winners.length > 0) {
      const w = winners[0];
      award.value_label = `${formatToPar(w.gross_to_par)} gross`;
      award.detail = `${w.gross} gross. The beer was purely recreational.`;
    }
    awards.push(award);
  }

  // Most Drinks: individual total, shotguns and shots broken out.
  {
    const award = base("most_drinks");
    const top = maxBy(d.drinkers.filter((r) => r.total > 0), (r) => r.total);
    if (top.length > 0) {
      const ids = top.map((r) => r.player_id).sort(byPlayerOrder);
      const n = top[0].total;
      award.awarded = true;
      award.player_ids = ids;
      if (top.length === 1) {
        const r = top[0];
        const parts = [
          ...(r.shotguns > 0 ? [plural(r.shotguns, "shotgun")] : []),
          ...(r.shots > 0 ? [plural(r.shots, "shot")] : []),
        ];
        award.value_label = `${plural(n, "drink")}${parts.length ? ` (${parts.join(", ")})` : ""}`;
        award.detail = "Hydration is for quitters.";
      } else {
        award.value_label = `${plural(n, "drink")} each`;
        award.detail = `${names(ids, playerName)} drank in perfect, disgusting harmony.`;
      }
    }
    awards.push(award);
  }

  // Ghost Whisperers: team with the most ghost beers.
  {
    const award = base("ghost_whisperers");
    const top = maxBy(d.standings.filter((r) => r.ghost_beers > 0), (r) => r.ghost_beers);
    if (top.length > 0) {
      award.awarded = true;
      award.team_ids = top.map((r) => r.team_id);
      award.value_label = plural(top[0].ghost_beers, "ghost beer");
      award.detail = "Drinking for a teammate who doesn't exist. Inspirational.";
    }
    awards.push(award);
  }

  // Longest Drive / Closest Pin of the day: best valid entry across every hole of that type.
  const contestAward = (key: AwardKey, type: ContestKind) => {
    const award = base(key);
    const valid: ContestEntryView[] = d.contests.filter((c) => c.type === type).flatMap((c) => c.entries.filter((v) => v.valid));
    const top = maxBy(valid, (v) => -contestScore(type, v.distance));
    if (top.length > 0) {
      const w = top[0];
      award.awarded = true;
      award.player_ids = uniq(top.map((v) => v.player_id)).sort(byPlayerOrder);
      award.team_ids = uniq(top.map((v) => v.team_id));
      award.photo_path = top.find((v) => v.entry.photo_path)?.entry.photo_path ?? null;
      award.value_label = type === "ld" ? `${w.distance} yd` : formatFeetInches(w.distance);
      const holes = uniq(top.map((v) => v.entry.hole)).sort((a, b) => a - b);
      award.detail =
        type === "ld"
          ? `Hole ${holes.join(" & ")}. In the fairway (allegedly).`
          : `Hole ${holes.join(" & ")}. Honor system, baby.`;
    }
    return award;
  };
  awards.push(contestAward("longest_drive", "ld"));
  awards.push(contestAward("closest_pin", "ctp"));

  // Per (team, hole) lines in roster order, for the two single-hole awards.
  const lines = d.teams.flatMap((t) => (d.teamHoles[t.id] ?? []).map((line) => ({ team_id: t.id, line })));
  const teamHoleLabel = (top: typeof lines) => top.map((x) => `${teamName(x.team_id)}, hole ${x.line.hole}`).join("; ");

  // Biggest Beer Save: largest drink credit on a single team hole.
  {
    const award = base("biggest_beer_save");
    const top = maxBy(lines.filter((x) => x.line.credit > 0), (x) => x.line.credit);
    if (top.length > 0) {
      award.awarded = true;
      award.team_ids = uniq(top.map((x) => x.team_id));
      award.value_label = `${teamHoleLabel(top)}: ${plural(top[0].line.credit, "stroke")} of beer`;
      award.detail = "Drank their way out of trouble. Doctors hate them.";
    }
    awards.push(award);
  }

  // Worst Hole: highest gross strokes on a single hole.
  {
    const award = base("worst_hole");
    const top = maxBy(lines.filter((x) => x.line.strokes !== null), (x) => x.line.strokes!);
    if (top.length > 0) {
      const strokes = top[0].line.strokes!;
      const overPars = uniq(top.map((x) => formatToPar(x.line.gross_to_par ?? 0)));
      award.awarded = true;
      award.team_ids = uniq(top.map((x) => x.team_id));
      award.value_label = `${teamHoleLabel(top)}: ${strokes} (${overPars.join(" / ")})`;
      award.detail = "Somebody check on them.";
    }
    awards.push(award);
  }

  // Mulligan Merchant: team with the most mulligan uses.
  {
    const award = base("mulligan_merchant");
    const banks = d.teams.map((t) => d.mulligans[t.id]).filter((b) => b && b.used_total > 0);
    const top = maxBy(banks, (b) => b.used_total);
    if (top.length > 0) {
      award.awarded = true;
      award.team_ids = top.map((b) => b.team_id).sort((a, b) => (teamOrder.get(a) ?? 0) - (teamOrder.get(b) ?? 0));
      award.value_label = plural(top[0].used_total, "mulligan");
      award.detail = "Golf is easy when you get do-overs.";
    }
    awards.push(award);
  }

  // Edit Bandit: the player behind the most score edits (active score_edit feed events; an
  // "overruled" post records an edit that lost last-write-wins, which changed nothing).
  {
    const award = base("edit_bandit");
    const counts = new Map<UUID, number>();
    for (const e of state.feed_events) {
      if (e.type !== "score_edit" || e.deleted_at !== null || !e.actor_id || !d.playerById[e.actor_id]) continue;
      if (e.payload?.kind === "overruled") continue;
      counts.set(e.actor_id, (counts.get(e.actor_id) ?? 0) + 1);
    }
    const top = maxBy([...counts.entries()], ([, n]) => n);
    if (top.length > 0) {
      award.awarded = true;
      award.player_ids = top.map(([id]) => id).sort(byPlayerOrder);
      award.value_label = plural(top[0][1], "score edit");
      award.detail = "The scorecard has been \"corrected.\" Repeatedly.";
    }
    awards.push(award);
  }

  // Most Suspicious: most AI judge flags. A flag raised once still counts after the entry was
  // re-measured, retaken or withdrawn (deleted entries included), and one photo is one flag however
  // many re-measures carried it over.
  {
    const award = base("most_suspicious");
    const flagged = new Map<UUID, Set<string>>(); // player -> flagged photos (entry id when no photo)
    for (const e of state.contest_entries) {
      if (e.ai_suspicious !== true || !d.playerById[e.player_id]) continue;
      const photos = flagged.get(e.player_id) ?? new Set<string>();
      photos.add(e.photo_path ?? e.id);
      flagged.set(e.player_id, photos);
    }
    const counts = new Map<UUID, number>([...flagged].map(([id, photos]) => [id, photos.size]));
    const top = maxBy([...counts.entries()], ([, n]) => n);
    if (top.length > 0) {
      award.awarded = true;
      award.player_ids = top.map(([id]) => id).sort(byPlayerOrder);
      award.value_label = plural(top[0][1], "AI flag");
      award.detail = "The robot has questions. So do we.";
    }
    awards.push(award);
  }

  return awards;
}
