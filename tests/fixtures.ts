// Shared test fixtures: build TripStates without a database.
// Usage:
//   const f = makeTrip({ teams: [4, 3, 3] });           // 10 players, teams A/B/C, live, Jack Frost holes
//   f.teeOff("A", 1); f.drink("A", "A1", 1); f.score("A", 1, 4);
//   const d = derive(f.state);
import { JACK_FROST_HOLES } from "@/lib/course";
import {
  DEFAULT_SETTINGS,
  type Drink,
  type DrinkType,
  type HoleScore,
  type Mulligan,
  type ContestEntry,
  type Player,
  type Team,
  type TeamMember,
  type TeamRoundState,
  type TripSettings,
  type TripState,
  type TripStatus,
  type PotOptout,
  type PotKey,
  type Hole,
} from "@/lib/types";

export const T0 = Date.parse("2026-10-24T16:50:00.000Z");
/** ISO time `min` minutes after the first tee time. */
export const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

export interface TripFixture {
  state: TripState;
  /** Team ids by letter: "A", "B", ... */
  team: Record<string, string>;
  /** Player ids by label: "A1".."A4", "B1".. */
  player: Record<string, string>;
  /** Monotonic clock for generated rows (minutes after T0). */
  clock: { min: number };
  teeOff(team: string, hole: number, min?: number): TripFixture;
  complete(team: string, min?: number): TripFixture;
  score(team: string, hole: number, strokes: number, teeShot?: string | null): TripFixture;
  drink(team: string, player: string, hole: number, type?: DrinkType, opts?: { id?: string; min?: number; photo?: string }): string;
  deleteDrink(id: string): TripFixture;
  mulligan(team: string, hole: number, source: "earned" | "groom"): string;
  entry(e: Partial<ContestEntry> & Pick<ContestEntry, "hole" | "player_id" | "type" | "distance_value">): string;
  optOut(player: string, pot: PotKey): TripFixture;
}

let seq = 0;
const id = (prefix: string) => `${prefix}-${String(++seq).padStart(6, "0")}`;

export function makeTrip(opts: {
  teams: number[];
  status?: TripStatus;
  settings?: Partial<TripSettings>;
  groom?: string; // player label, default "A1"
  base_team_size?: number;
}): TripFixture {
  const tripId = id("trip");
  const now = at(-60);
  const players: Player[] = [];
  const teams: Team[] = [];
  const members: TeamMember[] = [];
  const team: Record<string, string> = {};
  const player: Record<string, string> = {};
  const groom = opts.groom ?? "A1";
  opts.teams.forEach((size, ti) => {
    const letter = String.fromCharCode(65 + ti);
    const teamId = id(`team${letter}`);
    team[letter] = teamId;
    teams.push({ id: teamId, trip_id: tripId, name: `Team ${letter}`, tee_time: null, sort_order: ti, created_at: now, deleted_at: null });
    for (let i = 1; i <= size; i++) {
      const label = `${letter}${i}`;
      const pid = id(`p${label}`);
      player[label] = pid;
      players.push({
        id: pid,
        trip_id: tripId,
        name: `Player ${label}`,
        nickname: null,
        venmo_handle: null,
        is_groom: label === groom,
        muted_push: false,
        sort_order: players.length,
        created_at: now,
        deleted_at: null,
      });
      members.push({ id: id("tm"), trip_id: tripId, team_id: teamId, player_id: pid, created_at: now });
    }
  });
  const holes: Hole[] = JACK_FROST_HOLES.map((h) => ({
    id: id(`hole${h.number}`),
    trip_id: tripId,
    number: h.number,
    par: h.par,
    stroke_index: h.stroke_index,
    yardage: { ...h.yardage },
    tee_lat: null,
    tee_lng: null,
    green_lat: null,
    green_lng: null,
    contest: h.contest,
    updated_at: now,
  }));
  const status = opts.status ?? "live";
  const roundStates: TeamRoundState[] =
    status === "setup"
      ? []
      : teams.map((t) => ({
          id: id("rs"),
          trip_id: tripId,
          team_id: t.id,
          open_hole: null,
          started_holes: [],
          hole_opened_at: {},
          status: "not_started",
          completed_at: null,
          updated_at: now,
        }));

  const state: TripState = {
    trip: {
      id: tripId,
      code: "testcode42",
      name: "Test Trip",
      app_name: "Scramble",
      status,
      base_team_size: opts.base_team_size ?? 4,
      settings: { ...DEFAULT_SETTINGS, ...opts.settings },
      is_demo: false,
      created_at: now,
      started_at: status === "setup" ? null : now,
      finalized_at: status === "final" ? now : null,
      updated_at: now,
    },
    players,
    teams,
    team_members: members,
    holes,
    team_round_state: roundStates,
    hole_scores: [],
    drinks: [],
    mulligans: [],
    contest_entries: [],
    pot_optouts: [],
    feed_events: [],
    reactions: [],
  };

  const clock = { min: 0 };
  const tick = (min?: number) => at(min ?? ++clock.min);

  const f: TripFixture = {
    state,
    team,
    player,
    clock,
    teeOff(t, hole, min) {
      const teamId = team[t];
      const time = tick(min);
      f.state = {
        ...f.state,
        team_round_state: f.state.team_round_state.map((rs) =>
          rs.team_id !== teamId
            ? rs
            : {
                ...rs,
                open_hole: Math.max(rs.open_hole ?? 0, hole),
                started_holes: Array.from(new Set([...rs.started_holes, hole])).sort((a, b) => a - b),
                hole_opened_at: { [String(hole)]: time, ...rs.hole_opened_at },
                status: "playing",
              },
        ),
      };
      return f;
    },
    complete(t, min) {
      const teamId = team[t];
      const time = tick(min);
      f.state = {
        ...f.state,
        team_round_state: f.state.team_round_state.map((rs) =>
          rs.team_id !== teamId ? rs : { ...rs, status: "complete", completed_at: time },
        ),
      };
      return f;
    },
    score(t, hole, strokes, teeShot) {
      const teamId = team[t];
      const time = tick();
      const existing = f.state.hole_scores.find((s) => s.team_id === teamId && s.hole === hole);
      const row: HoleScore = {
        id: existing?.id ?? id("hs"),
        trip_id: tripId,
        team_id: teamId,
        hole,
        strokes,
        tee_shot_player_id: teeShot === undefined ? (existing?.tee_shot_player_id ?? null) : teeShot ? player[teeShot] : null,
        strokes_at: time,
        tee_shot_at: teeShot === undefined ? (existing?.tee_shot_at ?? null) : time,
        edit_count: existing && existing.strokes !== null && existing.strokes !== strokes ? existing.edit_count + 1 : (existing?.edit_count ?? 0),
        updated_by: null,
        updated_at: time,
      };
      f.state = { ...f.state, hole_scores: [...f.state.hole_scores.filter((s) => s.id !== row.id), row] };
      return f;
    },
    drink(t, p, hole, type = "drink", o = {}) {
      const time = tick(o.min);
      const row: Drink = {
        id: o.id ?? id("drink"),
        trip_id: tripId,
        team_id: team[t],
        player_id: player[p],
        hole,
        type,
        photo_path: o.photo ?? null,
        logged_by: player[p],
        logged_at: time,
        created_at: time,
        deleted_at: null,
        deleted_by: null,
        moved_from_hole: null,
      };
      f.state = { ...f.state, drinks: [...f.state.drinks, row] };
      return row.id;
    },
    deleteDrink(drinkId) {
      const time = tick();
      f.state = { ...f.state, drinks: f.state.drinks.map((d) => (d.id === drinkId ? { ...d, deleted_at: time } : d)) };
      return f;
    },
    mulligan(t, hole, source) {
      const time = tick();
      const row: Mulligan = {
        id: id("mull"),
        trip_id: tripId,
        team_id: team[t],
        source,
        used_on_hole: hole,
        used_by: null,
        used_at: time,
        created_at: time,
        deleted_at: null,
      };
      f.state = { ...f.state, mulligans: [...f.state.mulligans, row] };
      return row.id;
    },
    entry(e) {
      const time = tick();
      const teamId = f.state.team_members.find((m) => m.player_id === e.player_id)?.team_id ?? "";
      const row: ContestEntry = {
        id: id("entry"),
        trip_id: tripId,
        team_id: teamId,
        unit: e.type === "ctp" ? "ft" : "yd",
        distance_override: null,
        angle_deg: null,
        lat: null,
        lng: null,
        gps_accuracy_m: null,
        low_accuracy: false,
        photo_path: null,
        ai_estimate_ft: null,
        ai_confidence: null,
        ai_suspicious: null,
        ai_roast: null,
        status: "ok",
        flag_reason: null,
        created_at: time,
        updated_at: time,
        deleted_at: null,
        ...e,
      };
      f.state = { ...f.state, contest_entries: [...f.state.contest_entries, row] };
      return row.id;
    },
    optOut(p, pot) {
      const time = tick();
      const row: PotOptout = { id: id("opt"), trip_id: tripId, pot_key: pot, player_id: player[p], created_at: time, deleted_at: null };
      f.state = { ...f.state, pot_optouts: [...f.state.pot_optouts, row] };
      return f;
    },
  };
  return f;
}
