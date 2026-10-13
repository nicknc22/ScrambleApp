// Scorecards, leaderboard standings and the individual drinkers board.
import type { Hole, HoleContest, HoleScore, Player, RoundStatus, Team, TripState, UUID } from "../types";
import type { DrinkValue, DrinkerRow, StandingRow, TeamHoleLine } from "./types";
import { countedDrinks } from "./drinks";

/** Not-started placeholder for pos/thru labels (en dash). */
export const DASH = "–";

/** Deterministic name order (explicit locale so client and server agree). */
export function compareNames(a: string, b: string): number {
  return a.localeCompare(b, "en", { sensitivity: "base" });
}

/** Roster order for players and teams: sort_order, then name, then id (total order). */
export function compareSortOrderName(a: Pick<Player | Team, "id" | "name" | "sort_order">, b: Pick<Player | Team, "id" | "name" | "sort_order">): number {
  if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
  const byName = compareNames(a.name, b.name);
  if (byName !== 0) return byName;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Active (not deleted) teams in roster order. */
export function activeTeamsSorted(state: TripState): Team[] {
  return state.teams.filter((t) => t.deleted_at === null).sort(compareSortOrderName);
}

const HOLE_NUMBERS = Array.from({ length: 18 }, (_, i) => i + 1);

/**
 * Hole rows by number. Holes are always seeded 1..18; a missing row falls back to a par-4
 * non-contest hole so a scorecard still has 18 lines.
 */
function holeTable(state: TripState): { par: number; contest: HoleContest }[] {
  const byNumber: (Hole | undefined)[] = [];
  for (const h of state.holes) byNumber[h.number] = h;
  const table: { par: number; contest: HoleContest }[] = [];
  for (const n of HOLE_NUMBERS) {
    const h = byNumber[n];
    table[n] = { par: h?.par ?? 4, contest: h?.contest ?? "none" };
  }
  return table;
}

/** Later updated_at wins when a (team, hole) somehow has two rows. */
function pickScore(a: HoleScore | undefined, b: HoleScore): HoleScore {
  if (!a) return b;
  return b.updated_at >= a.updated_at ? b : a;
}

/** team_id -> 18 scorecard lines (hole 1..18) for every active team. */
export function computeTeamHoles(state: TripState, drinkValues: Record<UUID, DrinkValue>): Record<UUID, TeamHoleLine[]> {
  const teams = state.teams.filter((t) => t.deleted_at === null);
  const holes = holeTable(state);

  // team_id -> hole -> score row
  const scores = new Map<UUID, (HoleScore | undefined)[]>();
  for (const t of teams) scores.set(t.id, []);
  for (const s of state.hole_scores) {
    const row = scores.get(s.team_id);
    if (!row || s.hole < 1 || s.hole > 18) continue;
    row[s.hole] = pickScore(row[s.hole], s);
  }

  // team_id -> hole -> [drinks, credit]
  const drinkSums = new Map<UUID, { drinks: number; credit: number }[]>();
  for (const v of Object.values(drinkValues)) {
    if (v.hole < 1 || v.hole > 18) continue;
    let row = drinkSums.get(v.team_id);
    if (!row) drinkSums.set(v.team_id, (row = []));
    const cell = row[v.hole] ?? (row[v.hole] = { drinks: 0, credit: 0 });
    cell.drinks += 1;
    cell.credit += v.value;
  }

  const out: Record<UUID, TeamHoleLine[]> = {};
  for (const t of teams) {
    const teamScores = scores.get(t.id)!;
    const teamDrinks = drinkSums.get(t.id);
    out[t.id] = HOLE_NUMBERS.map((hole) => {
      const { par, contest } = holes[hole];
      const s = teamScores[hole];
      const strokes = s?.strokes ?? null;
      const cell = teamDrinks?.[hole];
      const drinks = cell?.drinks ?? 0;
      const credit = cell?.credit ?? 0;
      const net = strokes === null ? null : strokes - credit;
      return {
        hole,
        par,
        contest,
        strokes,
        tee_shot_player_id: s?.tee_shot_player_id ?? null,
        drinks,
        credit,
        net,
        gross_to_par: strokes === null ? null : strokes - par,
        net_to_par: net === null ? null : net - par,
        edit_count: s?.edit_count ?? 0,
      };
    });
  }
  return out;
}

/** Leaderboard rows, sorted, with tie-aware positions. See StandingRow docs. */
export function computeStandings(
  state: TripState,
  teamHoles: Record<UUID, TeamHoleLine[]>,
  drinkValues: Record<UUID, DrinkValue>,
): StandingRow[] {
  const teams = activeTeamsSorted(state);
  const order = new Map<UUID, number>();
  teams.forEach((t, i) => order.set(t.id, i));

  const roundState = new Map<UUID, { status: RoundStatus; open_hole: number | null }>();
  for (const rs of state.team_round_state) roundState.set(rs.team_id, rs);

  // Totals over ALL of a team's active drinks (any hole, scored or not).
  const drinkTotals = new Map<UUID, { drinks: number; credit: number; ghosts: number }>();
  for (const v of Object.values(drinkValues)) {
    let tot = drinkTotals.get(v.team_id);
    if (!tot) drinkTotals.set(v.team_id, (tot = { drinks: 0, credit: 0, ghosts: 0 }));
    tot.drinks += 1;
    tot.credit += v.value;
    if (v.ghost) tot.ghosts += 1;
  }

  const rows: StandingRow[] = teams.map((t) => {
    // Spec: round net = sum of hole nets, so only SCORED holes count. Credit on a hole without a
    // score yet (normally the open hole) is "banked" and joins the net when the hole is scored.
    let thru = 0;
    let gross = 0;
    let parPlayed = 0;
    let drinks = 0;
    let credit = 0;
    for (const line of teamHoles[t.id] ?? []) {
      if (line.strokes === null) continue;
      thru += 1;
      gross += line.strokes;
      parPlayed += line.par;
      drinks += line.drinks;
      credit += line.credit;
    }
    const tot = drinkTotals.get(t.id) ?? { drinks: 0, credit: 0, ghosts: 0 };
    const rs = roundState.get(t.id);
    const status: RoundStatus = rs?.status ?? "not_started";
    const net = gross - credit;
    return {
      team_id: t.id,
      pos: 0, // filled below
      pos_label: DASH,
      thru,
      thru_label: thru === 0 ? DASH : status === "complete" && thru === 18 ? "F" : String(thru),
      gross,
      drinks,
      credit,
      net,
      pending_drinks: tot.drinks - drinks,
      pending_credit: tot.credit - credit,
      par_played: parPlayed,
      net_to_par: net - parPlayed,
      gross_to_par: gross - parPlayed,
      ghost_beers: tot.ghosts,
      status,
      open_hole: rs?.open_hole ?? null,
    };
  });

  const started = rows.filter((r) => r.thru > 0);
  const notStarted = rows.filter((r) => r.thru === 0);
  started.sort(
    (a, b) => a.net_to_par - b.net_to_par || a.net - b.net || order.get(a.team_id)! - order.get(b.team_id)!,
  );
  notStarted.sort((a, b) => order.get(a.team_id)! - order.get(b.team_id)!);

  // Standard competition ranking on net_to_par: 1, T2, T2, 4.
  const tieCount = new Map<number, number>();
  for (const r of started) tieCount.set(r.net_to_par, (tieCount.get(r.net_to_par) ?? 0) + 1);
  started.forEach((r, i) => {
    const prev = started[i - 1];
    r.pos = prev && prev.net_to_par === r.net_to_par ? prev.pos : i + 1;
    r.pos_label = tieCount.get(r.net_to_par)! > 1 ? `T${r.pos}` : String(r.pos);
  });
  // Teams that haven't scored share the position after every started team.
  for (const r of notStarted) {
    r.pos = started.length + 1;
    r.pos_label = DASH;
  }
  return [...started, ...notStarted];
}

/** Individual drinking leaderboard for every active player on a team. Sorted by total desc, then name. */
export function computeDrinkers(state: TripState, teamOfPlayer: Record<UUID, UUID>): DrinkerRow[] {
  const rows = new Map<UUID, DrinkerRow>();
  const players: Player[] = [];
  for (const p of state.players) {
    if (p.deleted_at !== null) continue;
    const teamId = teamOfPlayer[p.id];
    if (teamId === undefined) continue;
    players.push(p);
    rows.set(p.id, { player_id: p.id, team_id: teamId, drinks: 0, shotguns: 0, shots: 0, total: 0, photos: 0 });
  }

  // A player's drinks count wherever they were logged, as long as that team still exists (and not
  // after the team's Round complete: countedDrinks).
  for (const d of countedDrinks(state)) {
    const row = rows.get(d.player_id);
    if (!row) continue;
    if (d.type === "shotgun") row.shotguns += 1;
    else if (d.type === "shot") row.shots += 1;
    else row.drinks += 1;
    row.total += 1;
    if (d.photo_path) row.photos += 1;
  }

  players.sort(
    (a, b) => rows.get(b.id)!.total - rows.get(a.id)!.total || compareNames(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return players.map((p) => rows.get(p.id)!);
}
