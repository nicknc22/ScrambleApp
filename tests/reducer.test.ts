import { describe, expect, it } from "vitest";
import { applyOp, applyOps, PLAY_OPS, type ApplyCtx, type ApplyResult, type Write } from "@/lib/reducer";
import { COMMISSIONER_ONLY_OPS, type Op, type OpType, type RejectCode } from "@/lib/ops";
import { deriveId } from "@/lib/ids";
import { openWindowHole } from "@/lib/engine/windows";
import { ROW_TABLES, type AnyRow, type RowTable, type TripState } from "@/lib/types";
import { at, makeTrip, type TripFixture } from "./fixtures";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const NOW = "2026-10-24T23:59:00.000Z";
const LATER = "2026-10-25T03:00:00.000Z";

const server = (o: Partial<ApplyCtx> = {}): ApplyCtx => ({ now: NOW, is_commissioner: false, side: "server", ...o });
const client = (o: Partial<ApplyCtx> = {}): ApplyCtx => server({ side: "client", ...o });
const commish = (o: Partial<ApplyCtx> = {}): ApplyCtx => server({ is_commissioner: true, ...o });

type OpOf<T extends OpType> = Extract<Op, { type: T }>;
type Fields<T extends OpType> = Omit<OpOf<T>, "type" | "id" | "at" | "by"> & {
  id?: string;
  at?: string;
  by?: string | null;
  as_commissioner?: boolean;
};

let opSeq = 0;
let clockMin = 100; // after every fixture timestamp
/** Build an op with a fresh id and a monotonically increasing client time. */
function mk<T extends OpType>(type: T, fields: Fields<T>): OpOf<T> {
  opSeq++;
  return { id: `op-${String(opSeq).padStart(5, "0")}`, at: at(++clockMin), by: null, ...fields, type } as OpOf<T>;
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

const ROW_KEYS: Record<RowTable, string[]> = {
  players: ["id", "trip_id", "name", "nickname", "venmo_handle", "is_groom", "muted_push", "sort_order", "created_at", "deleted_at"],
  teams: ["id", "trip_id", "name", "tee_time", "sort_order", "created_at", "deleted_at"],
  team_members: ["id", "trip_id", "team_id", "player_id", "created_at"],
  holes: ["id", "trip_id", "number", "par", "stroke_index", "yardage", "tee_lat", "tee_lng", "green_lat", "green_lng", "contest", "updated_at"],
  team_round_state: ["id", "trip_id", "team_id", "open_hole", "started_holes", "hole_opened_at", "status", "completed_at", "updated_at"],
  hole_scores: ["id", "trip_id", "team_id", "hole", "strokes", "tee_shot_player_id", "strokes_at", "tee_shot_at", "edit_count", "updated_by", "updated_at"],
  drinks: ["id", "trip_id", "team_id", "player_id", "hole", "type", "photo_path", "logged_by", "logged_at", "created_at", "deleted_at", "deleted_by", "moved_from_hole"],
  mulligans: ["id", "trip_id", "team_id", "source", "used_on_hole", "used_by", "used_at", "created_at", "deleted_at"],
  contest_entries: [
    "id", "trip_id", "hole", "player_id", "team_id", "type", "distance_value", "unit", "distance_override", "angle_deg", "lat", "lng",
    "gps_accuracy_m", "low_accuracy", "photo_path", "ai_estimate_ft", "ai_confidence", "ai_suspicious", "ai_roast", "status",
    "flag_reason", "created_at", "updated_at", "deleted_at",
  ],
  pot_optouts: ["id", "trip_id", "pot_key", "player_id", "created_at", "deleted_at"],
  feed_events: ["id", "trip_id", "type", "team_id", "player_id", "actor_id", "payload", "photo_path", "text", "dedupe_key", "created_at", "updated_at", "deleted_at"],
  reactions: ["id", "trip_id", "feed_event_id", "player_id", "kind", "created_at", "deleted_at"],
};
const TRIP_KEYS = ["id", "code", "name", "app_name", "status", "base_team_size", "settings", "is_demo", "created_at", "started_at", "finalized_at", "updated_at"];

function expectCompleteRow(row: object, keys: string[]) {
  expect(Object.keys(row).sort()).toEqual([...keys].sort());
  for (const [k, v] of Object.entries(row)) expect(v, `${k} must not be undefined`).not.toBeUndefined();
}

const writeKey = (w: Write) => (w.kind === "trip" ? "trip" : `${w.table}:${w.kind === "upsert" ? w.row.id : w.id}`);

/**
 * Invariants for every successful op: writes describe exactly the changed rows (complete rows),
 * untouched tables and rows keep reference identity, and no-ops return the input state itself.
 */
function checkInvariants(before: TripState, r: { state: TripState; writes: Write[] }) {
  const { state: after, writes } = r;
  if (writes.length === 0) expect(after).toBe(before);
  const keys = new Set<string>();
  for (const w of writes) {
    expect(keys.has(writeKey(w)), `duplicate write ${writeKey(w)}`).toBe(false);
    keys.add(writeKey(w));
  }
  const tripWrite = writes.find((w) => w.kind === "trip");
  if (tripWrite) {
    expect(after.trip).not.toBe(before.trip);
    expect(after.trip).toEqual(tripWrite.row);
    expect(after.trip).not.toEqual(before.trip);
    expectCompleteRow(after.trip, TRIP_KEYS);
  } else {
    expect(after.trip).toBe(before.trip);
  }
  for (const table of ROW_TABLES) {
    const beforeRows = before[table] as AnyRow[];
    const afterRows = after[table] as AnyRow[];
    const tableWrites = writes.filter((w) => w.kind !== "trip" && w.table === table);
    if (tableWrites.length === 0) {
      expect(afterRows, `${table} must keep identity`).toBe(beforeRows);
      continue;
    }
    expect(afterRows, `${table} must be a new array`).not.toBe(beforeRows);
    const beforeById = new Map(beforeRows.map((x) => [x.id, x]));
    const afterById = new Map(afterRows.map((x) => [x.id, x]));
    expect(afterById.size, `${table} ids unique`).toBe(afterRows.length);
    for (const w of tableWrites) {
      if (w.kind === "upsert") {
        expect(afterById.get(w.row.id)).toEqual(w.row);
        expect(w.row).not.toEqual(beforeById.get(w.row.id));
        expectCompleteRow(w.row, ROW_KEYS[table]);
        expect(w.row.trip_id).toBe(before.trip.id);
      } else if (w.kind === "delete") {
        expect(table, "only team_members are hard-deleted").toBe("team_members");
        expect(beforeById.has(w.id)).toBe(true);
        expect(afterById.has(w.id)).toBe(false);
      }
    }
    for (const row of afterRows) {
      if (keys.has(`${table}:${row.id}`)) continue;
      expect(row, `${table}:${row.id} changed without a write`).toBe(beforeById.get(row.id));
    }
    for (const row of beforeRows) {
      if (!afterById.has(row.id)) expect(keys.has(`${table}:${row.id}`), `${table}:${row.id} removed without a write`).toBe(true);
    }
  }
}

const exercised = new Set<OpType>();
const CATCH_ALL = /didn't compute/;

function run(state: TripState, op: Op, ctx: ApplyCtx): ApplyResult {
  deepFreeze(state);
  const r = applyOp(state, op, ctx);
  if (r.ok) checkInvariants(state, r);
  return r;
}

/** Applies successfully; re-applying the same op (later, either side) is a no-op with no writes. */
function ok(state: TripState, op: Op, ctx: ApplyCtx = server()): { state: TripState; writes: Write[] } {
  const r = run(state, op, ctx);
  if (!r.ok) throw new Error(`${op.type} rejected: ${r.code} - ${r.reason}`);
  if (r.writes.length > 0) exercised.add(op.type);
  for (const side of ["server", "client"] as const) {
    const again = run(r.state, op, { ...ctx, now: LATER, side });
    if (!again.ok) throw new Error(`re-applying ${op.type} rejected: ${again.code} - ${again.reason}`);
    expect(again.writes, `re-applying ${op.type} must not write`).toEqual([]);
    expect(again.state).toBe(r.state);
  }
  return r;
}

/** Applies with no effect: ok, no writes, same state object. */
function noop(state: TripState, op: Op, ctx: ApplyCtx = server()) {
  const r = run(state, op, ctx);
  if (!r.ok) throw new Error(`${op.type} rejected: ${r.code} - ${r.reason}`);
  expect(r.writes).toEqual([]);
  expect(r.state).toBe(state);
}

function rejected(state: TripState, op: Op, code: RejectCode, ctx: ApplyCtx = server()): string {
  const r = run(state, op, ctx);
  if (r.ok) throw new Error(`${op.type} unexpectedly applied`);
  expect(r.code).toBe(code);
  expect(r.reason.length).toBeGreaterThan(5);
  expect(r.reason).not.toMatch(CATCH_ALL); // a real rule, not a crash (e.g. a frozen-object mutation)
  return r.reason;
}

const rsOf = (s: TripState, teamId: string) => s.team_round_state.find((r) => r.team_id === teamId);
const scoreOf = (s: TripState, teamId: string, hole: number) => s.hole_scores.find((r) => r.team_id === teamId && r.hole === hole);
const drinkOf = (s: TripState, id: string) => s.drinks.find((d) => d.id === id);

function live(teams: number[] = [4, 3, 3], opts: Omit<Parameters<typeof makeTrip>[0], "teams"> = {}): TripFixture {
  return makeTrip({ teams, ...opts });
}

/** Apply a chain of ops (each must succeed) and return the final state. */
function chain(state: TripState, ops: Op[], ctx: ApplyCtx = server()): TripState {
  let s = state;
  for (const o of ops) s = ok(s, o, ctx).state;
  return s;
}

function drinkOp(f: TripFixture, team: string, player: string, hole: number, extra: Partial<Fields<"drink.log">> = {}) {
  return mk("drink.log", {
    drink_id: `drink-${++opSeq}`,
    team_id: f.team[team],
    player_id: f.player[player],
    hole,
    drink_type: "drink",
    photo_path: null,
    by: f.player[player],
    ...extra,
  });
}

/** Remove a team's round state row (e.g. a team added after the round started). */
function withoutRoundState(s: TripState, teamId: string): TripState {
  return { ...s, team_round_state: s.team_round_state.filter((r) => r.team_id !== teamId) };
}

// ---------------------------------------------------------------------------
// General rules
// ---------------------------------------------------------------------------

const OP_TYPES: Record<OpType, true> = {
  "tee.open": true, "round.complete": true, "score.set": true, "teeshot.set": true, "drink.log": true, "drink.delete": true,
  "drink.move": true, "mulligan.use": true, "mulligan.undo": true, "contest.submit": true, "contest.delete": true,
  "contest.review": true, "post.create": true, "feed.delete": true, "reaction.set": true, "pot.optout": true,
  "player.mute": true, "player.upsert": true, "player.delete": true, "team.upsert": true, "team.delete": true,
  "team.assign": true, "hole.update": true, "trip.update": true, "trip.start": true, "trip.finalize": true,
  "trip.reopen": true, "round.set_state": true,
};
const ALL_OP_TYPES = Object.keys(OP_TYPES) as OpType[];

/** A bare op of any type: gating runs before payload validation. */
const bare = (type: OpType, extra: Record<string, unknown> = {}) => ({ id: `bare-${++opSeq}`, at: at(++clockMin), by: null, type, ...extra }) as unknown as Op;

describe("general rules", () => {
  it("commissioner-only ops are forbidden without the commissioner cookie", () => {
    const f = live();
    for (const type of COMMISSIONER_ONLY_OPS) {
      rejected(f.state, bare(type), "forbidden", server());
      rejected(f.state, bare(type), "forbidden", client());
    }
  });

  it("any op with as_commissioner needs the cookie", () => {
    const f = live();
    f.teeOff("A", 1);
    for (const type of ALL_OP_TYPES) rejected(f.state, bare(type, { as_commissioner: true }), "forbidden");
    rejected(f.state, mk("score.set", { team_id: f.team.A, hole: 1, strokes: 4, as_commissioner: true }), "forbidden");
  });

  it("play ops need a live round (setup)", () => {
    const f = makeTrip({ teams: [4, 3, 3], status: "setup" });
    for (const type of PLAY_OPS) {
      const reason = rejected(f.state, bare(type), "not_live");
      expect(reason).toMatch(/hasn't started/);
      // Even the commissioner can't play before the start.
      rejected(f.state, bare(type, { as_commissioner: true }), "not_live", commish());
    }
  });

  it("play ops need a live round (final), unless the commissioner overrides", () => {
    const f = makeTrip({ teams: [4, 3, 3], status: "final" });
    for (const type of PLAY_OPS) {
      expect(rejected(f.state, bare(type), "not_live")).toMatch(/final/);
      // The cookie alone isn't an override.
      rejected(f.state, bare(type), "not_live", commish());
    }
    const r = ok(f.state, mk("score.set", { team_id: f.team.A, hole: 6, strokes: 5, as_commissioner: true }), commish());
    expect(scoreOf(r.state, f.team.A, 6)?.strokes).toBe(5);
  });

  it("the play-op list matches the documented semantics", () => {
    expect([...PLAY_OPS].sort()).toEqual(
      ["tee.open", "round.complete", "score.set", "teeshot.set", "drink.log", "drink.delete", "mulligan.use", "mulligan.undo", "contest.submit", "contest.delete"].sort(),
    );
  });

  it("feed ops and mute work in any status", () => {
    for (const status of ["setup", "live", "final"] as const) {
      const f = makeTrip({ teams: [4, 3, 3], status });
      const post = mk("post.create", { event_id: `post-${status}`, text: "who brought the ranch", photo_path: null, by: f.player.B1 });
      let s = ok(f.state, post).state;
      s = ok(s, mk("reaction.set", { feed_event_id: post.event_id, player_id: f.player.C1, kind: "lol", on: true })).state;
      s = ok(s, mk("player.mute", { player_id: f.player.C1, muted: true })).state;
      ok(s, mk("feed.delete", { event_id: post.event_id, by: f.player.B1 }));
    }
  });

  it("rejects malformed envelopes without throwing", () => {
    const f = live();
    const cases: unknown[] = [
      null,
      42,
      { type: "nope", id: "x", at: at(1), by: null },
      { type: "__proto__", id: "x", at: at(1), by: null },
      { type: "tee.open", at: at(1), by: null, team_id: f.team.A, hole: 1 },
      { type: "tee.open", id: "", at: at(1), by: null, team_id: f.team.A, hole: 1 },
      { type: "tee.open", id: "x", at: "yesterday-ish", by: null, team_id: f.team.A, hole: 1 },
      { type: "tee.open", id: "x", by: null, team_id: f.team.A, hole: 1 },
    ];
    for (const c of cases) {
      const r = applyOp(deepFreeze(f.state), c as Op, server());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("invalid");
    }
  });

  it("never throws on garbage payloads of any type", () => {
    const f = live();
    f.teeOff("A", 1);
    const junk = [undefined, null, "", 0, -1, 99, 2.5, "x", {}, [], NaN];
    for (const type of ALL_OP_TYPES) {
      for (const v of junk) {
        const o = {
          id: `junk-${++opSeq}`, at: at(1), by: v, type, team_id: v, hole: v, strokes: v, player_id: v, drink_id: v,
          drink_type: v, photo_path: v, mulligan_id: v, source: v, entry_id: v, contest_type: v, distance_value: v,
          event_id: v, text: v, feed_event_id: v, kind: v, on: v, pot_key: v, out: v, muted: v, player: v, team: v,
          patch: v, open_hole: v, status: v, low_accuracy: v,
        } as unknown as Op;
        for (const ctx of [server(), client(), commish()]) {
          expect(() => applyOp(deepFreeze(f.state), o, ctx)).not.toThrow();
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Windows: tee.open / round.complete / round.set_state
// ---------------------------------------------------------------------------

describe("tee.open", () => {
  it("opens hole 1 on the existing round state row", () => {
    const f = live();
    const A = f.team.A;
    const before = rsOf(f.state, A)!;
    const o = mk("tee.open", { team_id: A, hole: 1, by: f.player.A2 });
    const r = ok(f.state, o);
    const rs = rsOf(r.state, A)!;
    expect(rs).toEqual({ ...before, open_hole: 1, started_holes: [1], hole_opened_at: { "1": o.at }, status: "playing", updated_at: NOW });
    expect(openWindowHole(rs)).toBe(1);
    expect(r.writes).toEqual([{ kind: "upsert", table: "team_round_state", row: rs }]);
    // Other teams untouched.
    expect(rsOf(r.state, f.team.B)).toBe(rsOf(f.state, f.team.B));
  });

  it("opening N+1 closes N", () => {
    const f = live();
    const A = f.team.A;
    const o1 = mk("tee.open", { team_id: A, hole: 1 });
    const o2 = mk("tee.open", { team_id: A, hole: 2 });
    const s = chain(f.state, [o1, o2]);
    const rs = rsOf(s, A)!;
    expect(openWindowHole(rs)).toBe(2);
    expect(rs.started_holes).toEqual([1, 2]);
    expect(rs.hole_opened_at).toEqual({ "1": o1.at, "2": o2.at });
  });

  it("only moves forward: repeated taps and earlier holes are no-ops", () => {
    const f = live();
    const A = f.team.A;
    const s = chain(f.state, [mk("tee.open", { team_id: A, hole: 1 }), mk("tee.open", { team_id: A, hole: 4 })]);
    noop(s, mk("tee.open", { team_id: A, hole: 4 }));
    noop(s, mk("tee.open", { team_id: A, hole: 2 }));
    noop(s, mk("tee.open", { team_id: A, hole: 1 }));
    expect(openWindowHole(rsOf(s, A))).toBe(4);
  });

  it("can skip ahead (offline phone tapped through several holes)", () => {
    const f = live();
    const s = chain(f.state, [mk("tee.open", { team_id: f.team.A, hole: 1 }), mk("tee.open", { team_id: f.team.A, hole: 3 })]);
    expect(rsOf(s, f.team.A)).toMatchObject({ open_hole: 3, started_holes: [1, 3] });
  });

  it("creates the round state row when missing, with the op id", () => {
    const f = live();
    const state = withoutRoundState(f.state, f.team.C);
    const o = mk("tee.open", { team_id: f.team.C, hole: 1 });
    const r = ok(state, o);
    expect(rsOf(r.state, f.team.C)).toEqual({
      id: o.id,
      trip_id: f.state.trip.id,
      team_id: f.team.C,
      open_hole: 1,
      started_holes: [1],
      hole_opened_at: { "1": o.at },
      status: "playing",
      completed_at: null,
      updated_at: NOW,
    });
  });

  it("a complete round can't be reopened by a player", () => {
    const f = live();
    f.teeOff("A", 18).complete("A");
    const reason = rejected(f.state, mk("tee.open", { team_id: f.team.A, hole: 18 }), "conflict");
    expect(reason).toContain("Team A");
    // The cookie without an explicit override doesn't bypass the rule either.
    rejected(f.state, mk("tee.open", { team_id: f.team.A, hole: 18 }), "conflict", commish());
  });

  it("the commissioner can reopen a complete round", () => {
    const f = live();
    f.teeOff("A", 17).complete("A");
    const r = ok(f.state, mk("tee.open", { team_id: f.team.A, hole: 18, as_commissioner: true }), commish());
    expect(rsOf(r.state, f.team.A)).toMatchObject({ open_hole: 18, status: "playing", completed_at: null });
  });

  it("validates the team and the hole", () => {
    const f = live();
    for (const hole of [0, 19, -1, 2.5, NaN]) rejected(f.state, mk("tee.open", { team_id: f.team.A, hole }), "invalid");
    rejected(f.state, mk("tee.open", { team_id: f.team.A, hole: "3" as unknown as number }), "invalid");
    rejected(f.state, mk("tee.open", { team_id: "nope", hole: 1 }), "not_found");
    rejected(f.state, mk("tee.open", { team_id: "", hole: 1 }), "invalid");
    const g = live([4, 3, 3, 2]);
    const s = ok(g.state, mk("team.delete", { team_id: g.team.D }), commish()).state;
    rejected(s, mk("tee.open", { team_id: g.team.D, hole: 1 }), "not_found");
  });
});

describe("round.complete", () => {
  it("closes hole 18's window and leaves open_hole", () => {
    const f = live();
    f.teeOff("A", 18);
    const o = mk("round.complete", { team_id: f.team.A });
    const r = ok(f.state, o);
    const rs = rsOf(r.state, f.team.A)!;
    expect(rs).toMatchObject({ status: "complete", completed_at: o.at, open_hole: 18, updated_at: NOW });
    expect(openWindowHole(rs)).toBeNull();
  });

  it("is a no-op when already complete (keeps the first completed_at)", () => {
    const f = live();
    f.teeOff("A", 18).complete("A");
    noop(f.state, mk("round.complete", { team_id: f.team.A }));
  });

  it("creates the round state row when missing", () => {
    const f = live();
    const o = mk("round.complete", { team_id: f.team.B });
    const r = ok(withoutRoundState(f.state, f.team.B), o);
    expect(rsOf(r.state, f.team.B)).toMatchObject({ id: o.id, status: "complete", open_hole: null, completed_at: o.at });
  });

  it("validates the team", () => {
    const f = live();
    rejected(f.state, mk("round.complete", { team_id: "ghost-team" }), "not_found");
  });
});

describe("round.set_state (commissioner)", () => {
  it("moves the window back and trims later started holes", () => {
    const f = live();
    const A = f.team.A;
    const s = chain(f.state, [1, 2, 3, 4, 5, 6].map((hole) => mk("tee.open", { team_id: A, hole })));
    const r = ok(s, mk("round.set_state", { team_id: A, open_hole: 5, status: "playing" }), commish());
    const rs = rsOf(r.state, A)!;
    expect(rs.open_hole).toBe(5);
    expect(rs.started_holes).toEqual([1, 2, 3, 4, 5]);
    expect(Object.keys(rs.hole_opened_at).sort()).toEqual(["1", "2", "3", "4", "5"]);
    expect(rs.hole_opened_at["5"]).toBe(rsOf(s, A)!.hole_opened_at["5"]);
    // Re-opening 6 records a fresh time.
    const o6 = mk("tee.open", { team_id: A, hole: 6 });
    expect(rsOf(ok(r.state, o6).state, A)!.hole_opened_at["6"]).toBe(o6.at);
  });

  it("completes, un-completes and resets", () => {
    const f = live();
    const A = f.team.A;
    f.teeOff("A", 18);
    const done = mk("round.set_state", { team_id: A, open_hole: 18, status: "complete" });
    let s = ok(f.state, done, commish()).state;
    expect(rsOf(s, A)).toMatchObject({ status: "complete", completed_at: done.at });
    s = ok(s, mk("round.set_state", { team_id: A, open_hole: 18, status: "playing" }), commish()).state;
    expect(rsOf(s, A)).toMatchObject({ status: "playing", completed_at: null });
    s = ok(s, mk("round.set_state", { team_id: A, open_hole: null, status: "not_started" }), commish()).state;
    expect(rsOf(s, A)).toMatchObject({ status: "not_started", open_hole: null, started_holes: [], hole_opened_at: {} });
  });

  it("creates the row when missing", () => {
    const f = live();
    const o = mk("round.set_state", { team_id: f.team.C, open_hole: 3, status: "playing" });
    const r = ok(withoutRoundState(f.state, f.team.C), o, commish());
    expect(rsOf(r.state, f.team.C)).toMatchObject({ id: o.id, open_hole: 3, started_holes: [3], hole_opened_at: { "3": o.at } });
  });

  it("rejects inconsistent states and non-commissioners", () => {
    const f = live();
    const A = f.team.A;
    rejected(f.state, mk("round.set_state", { team_id: A, open_hole: null, status: "playing" }), "invalid", commish());
    rejected(f.state, mk("round.set_state", { team_id: A, open_hole: 3, status: "not_started" }), "invalid", commish());
    rejected(f.state, mk("round.set_state", { team_id: A, open_hole: 19, status: "playing" }), "invalid", commish());
    rejected(f.state, mk("round.set_state", { team_id: A, open_hole: 3, status: "bogus" as never }), "invalid", commish());
    rejected(f.state, mk("round.set_state", { team_id: "nope", open_hole: 3, status: "playing" }), "not_found", commish());
    rejected(f.state, mk("round.set_state", { team_id: A, open_hole: 3, status: "playing" }), "forbidden");
    noop(f.state, mk("round.set_state", { team_id: A, open_hole: null, status: "not_started" }), commish());
  });
});

// ---------------------------------------------------------------------------
// Scores
// ---------------------------------------------------------------------------

describe("score.set", () => {
  it("creates the (team, hole) row with a derived id", () => {
    const f = live();
    f.teeOff("A", 3);
    const o = mk("score.set", { team_id: f.team.A, hole: 3, strokes: 4, by: f.player.A2 });
    const r = ok(f.state, o);
    expect(scoreOf(r.state, f.team.A, 3)).toEqual({
      id: deriveId(f.team.A, "3"),
      trip_id: f.state.trip.id,
      team_id: f.team.A,
      hole: 3,
      strokes: 4,
      tee_shot_player_id: null,
      strokes_at: o.at,
      tee_shot_at: null,
      edit_count: 0,
      updated_by: f.player.A2,
      updated_at: NOW,
    });
    expect(r.writes).toHaveLength(1); // hole 3 is already open: no window change
  });

  it("client and server derive the same row id", () => {
    const f = live();
    f.teeOff("A", 3);
    const o = mk("score.set", { team_id: f.team.A, hole: 3, strokes: 4 });
    const a = ok(f.state, o, client()).state;
    const b = ok(f.state, o, server()).state;
    expect(scoreOf(a, f.team.A, 3)!.id).toBe(scoreOf(b, f.team.A, 3)!.id);
  });

  it("reuses the existing row id and keeps the tee shot", () => {
    const f = live();
    f.teeOff("A", 2).score("A", 2, 5, "A3");
    const existing = scoreOf(f.state, f.team.A, 2)!;
    const r = ok(f.state, mk("score.set", { team_id: f.team.A, hole: 2, strokes: 4 }));
    const row = scoreOf(r.state, f.team.A, 2)!;
    expect(row.id).toBe(existing.id);
    expect(row.tee_shot_player_id).toBe(f.player.A3);
    expect(row.tee_shot_at).toBe(existing.tee_shot_at);
    expect(r.state.hole_scores).toHaveLength(1);
  });

  it("LWW by client time: a stale edit loses, a newer one wins, edit_count counts changes", () => {
    const f = live();
    f.teeOff("A", 6);
    const A = f.team.A;
    let s = ok(f.state, mk("score.set", { team_id: A, hole: 6, strokes: 5, at: at(200) })).state;
    expect(scoreOf(s, A, 6)).toMatchObject({ strokes: 5, strokes_at: at(200), edit_count: 0 });

    // Offline phone syncs an edit made earlier: ignored.
    noop(s, mk("score.set", { team_id: A, hole: 6, strokes: 7, at: at(150) }));

    // Newer edit wins and counts as an edit.
    s = ok(s, mk("score.set", { team_id: A, hole: 6, strokes: 4, at: at(210) })).state;
    expect(scoreOf(s, A, 6)).toMatchObject({ strokes: 4, strokes_at: at(210), edit_count: 1 });

    // Same value, newer time: bumps the LWW clock but isn't an edit.
    s = ok(s, mk("score.set", { team_id: A, hole: 6, strokes: 4, at: at(220) })).state;
    expect(scoreOf(s, A, 6)).toMatchObject({ strokes: 4, strokes_at: at(220), edit_count: 1 });
    noop(s, mk("score.set", { team_id: A, hole: 6, strokes: 9, at: at(215) }));

    // Equal timestamp: the later-arriving op applies.
    s = ok(s, mk("score.set", { team_id: A, hole: 6, strokes: 6, at: at(220) })).state;
    expect(scoreOf(s, A, 6)).toMatchObject({ strokes: 6, edit_count: 2 });
  });

  it("a commissioner override beats LWW (e.g. a phone whose clock is in the future)", () => {
    const f = live();
    f.teeOff("A", 6);
    const A = f.team.A;
    const s = ok(f.state, mk("score.set", { team_id: A, hole: 6, strokes: 9, at: "2027-01-01T00:00:00.000Z" })).state;
    noop(s, mk("score.set", { team_id: A, hole: 6, strokes: 5, at: at(400) }));
    noop(s, mk("score.set", { team_id: A, hole: 6, strokes: 5, at: at(400) }), commish());
    const fixed = ok(s, mk("score.set", { team_id: A, hole: 6, strokes: 5, at: at(401), as_commissioner: true }), commish()).state;
    expect(scoreOf(fixed, A, 6)).toMatchObject({ strokes: 5, strokes_at: at(401), edit_count: 1 });
    // Normal edits work again afterwards.
    const after = ok(fixed, mk("score.set", { team_id: A, hole: 6, strokes: 4, at: at(402) })).state;
    expect(scoreOf(after, A, 6)!.strokes).toBe(4);
    // Same for the tee shot.
    const t = ok(f.state, mk("teeshot.set", { team_id: A, hole: 6, player_id: f.player.A1, at: "2027-01-01T00:00:00.000Z" })).state;
    noop(t, mk("teeshot.set", { team_id: A, hole: 6, player_id: f.player.A2, at: at(400) }));
    const t2 = ok(t, mk("teeshot.set", { team_id: A, hole: 6, player_id: f.player.A2, at: at(401), as_commissioner: true }), commish()).state;
    expect(scoreOf(t2, A, 6)!.tee_shot_player_id).toBe(f.player.A2);
  });

  it("LWW compares instants, not strings", () => {
    const f = live();
    f.teeOff("A", 6);
    const A = f.team.A;
    // "...:00Z" (no millis) sorts after "...:00.500Z" as a string but is earlier in time.
    const s = ok(f.state, mk("score.set", { team_id: A, hole: 6, strokes: 5, at: "2026-10-24T18:00:00.500Z" })).state;
    noop(s, mk("score.set", { team_id: A, hole: 6, strokes: 7, at: "2026-10-24T18:00:00Z" }));
  });

  it("first strokes on a row created by a tee shot isn't an edit", () => {
    const f = live();
    f.teeOff("A", 2);
    let s = ok(f.state, mk("teeshot.set", { team_id: f.team.A, hole: 2, player_id: f.player.A1 })).state;
    s = ok(s, mk("score.set", { team_id: f.team.A, hole: 2, strokes: 3 })).state;
    expect(scoreOf(s, f.team.A, 2)).toMatchObject({ strokes: 3, edit_count: 0, tee_shot_player_id: f.player.A1 });
  });

  it("validates strokes, hole and team", () => {
    const f = live();
    f.teeOff("A", 1);
    for (const strokes of [0, 21, -3, 3.5, NaN, Infinity]) {
      rejected(f.state, mk("score.set", { team_id: f.team.A, hole: 1, strokes }), "invalid");
    }
    rejected(f.state, mk("score.set", { team_id: f.team.A, hole: 1, strokes: "4" as unknown as number }), "invalid");
    ok(f.state, mk("score.set", { team_id: f.team.A, hole: 1, strokes: 1 }));
    ok(f.state, mk("score.set", { team_id: f.team.A, hole: 1, strokes: 20 }));
    rejected(f.state, mk("score.set", { team_id: f.team.A, hole: 19, strokes: 4 }), "invalid");
    rejected(f.state, mk("score.set", { team_id: "nope", hole: 1, strokes: 4 }), "not_found");
  });

  it("unknown actors are recorded as null (FK-safe)", () => {
    const f = live();
    f.teeOff("A", 1);
    const r = ok(f.state, mk("score.set", { team_id: f.team.A, hole: 1, strokes: 4, by: "not-a-player" }));
    expect(scoreOf(r.state, f.team.A, 1)!.updated_by).toBeNull();
  });

  describe("implicit window", () => {
    it("scoring hole 1 before tapping On the tee opens hole 1", () => {
      const f = live();
      const o = mk("score.set", { team_id: f.team.A, hole: 1, strokes: 4 });
      const r = ok(f.state, o);
      expect(rsOf(r.state, f.team.A)).toMatchObject({ open_hole: 1, status: "playing", started_holes: [1], hole_opened_at: { "1": o.at } });
      expect(r.writes.map((w) => w.kind === "upsert" && w.table).sort()).toEqual(["hole_scores", "team_round_state"]);
    });

    it("entering data for open_hole + 1 opens it (closing the previous hole)", () => {
      const f = live();
      f.teeOff("A", 4);
      const r = ok(f.state, mk("score.set", { team_id: f.team.A, hole: 5, strokes: 4 }));
      expect(openWindowHole(rsOf(r.state, f.team.A))).toBe(5);
    });

    it("does not open any other hole", () => {
      const f = live();
      f.teeOff("A", 4);
      for (const hole of [1, 3, 4, 6, 18]) {
        const r = ok(f.state, mk("score.set", { team_id: f.team.A, hole, strokes: 4 }));
        expect(rsOf(r.state, f.team.A)).toBe(rsOf(f.state, f.team.A));
      }
      // Not started: only hole 1 opens.
      const g = live();
      const r = ok(g.state, mk("score.set", { team_id: g.team.A, hole: 2, strokes: 4 }));
      expect(rsOf(r.state, g.team.A)!.status).toBe("not_started");
    });

    it("never reopens a complete round", () => {
      const f = live();
      f.teeOff("A", 17).complete("A");
      const r = ok(f.state, mk("score.set", { team_id: f.team.A, hole: 18, strokes: 5 }));
      expect(rsOf(r.state, f.team.A)).toBe(rsOf(f.state, f.team.A));
    });

    it("creates the round state for hole 1 when missing", () => {
      const f = live();
      const o = mk("score.set", { team_id: f.team.C, hole: 1, strokes: 5 });
      const r = ok(withoutRoundState(f.state, f.team.C), o);
      expect(rsOf(r.state, f.team.C)).toMatchObject({ id: o.id, open_hole: 1, status: "playing" });
    });

    it("a stale (losing) score doesn't touch the window", () => {
      const f = live();
      f.teeOff("A", 4);
      const s = ok(f.state, mk("score.set", { team_id: f.team.A, hole: 5, strokes: 4, at: at(300) }), commish()).state;
      const back = ok(s, mk("round.set_state", { team_id: f.team.A, open_hole: 4, status: "playing" }), commish()).state;
      noop(back, mk("score.set", { team_id: f.team.A, hole: 5, strokes: 6, at: at(250) }));
    });
  });
});

describe("teeshot.set", () => {
  it("creates the row (no strokes) with the derived id", () => {
    const f = live();
    f.teeOff("B", 2);
    const o = mk("teeshot.set", { team_id: f.team.B, hole: 2, player_id: f.player.B3, by: f.player.B1 });
    const r = ok(f.state, o);
    expect(scoreOf(r.state, f.team.B, 2)).toEqual({
      id: deriveId(f.team.B, "2"),
      trip_id: f.state.trip.id,
      team_id: f.team.B,
      hole: 2,
      strokes: null,
      tee_shot_player_id: f.player.B3,
      strokes_at: null,
      tee_shot_at: o.at,
      edit_count: 0,
      updated_by: f.player.B1,
      updated_at: NOW,
    });
  });

  it("updates and clears the tee shot, keeping strokes and edit_count", () => {
    const f = live();
    f.teeOff("A", 2).score("A", 2, 4, "A1");
    const existing = scoreOf(f.state, f.team.A, 2)!;
    let s = ok(f.state, mk("teeshot.set", { team_id: f.team.A, hole: 2, player_id: f.player.A4 })).state;
    expect(scoreOf(s, f.team.A, 2)).toMatchObject({ id: existing.id, strokes: 4, strokes_at: existing.strokes_at, tee_shot_player_id: f.player.A4, edit_count: existing.edit_count });
    s = ok(s, mk("teeshot.set", { team_id: f.team.A, hole: 2, player_id: null })).state;
    expect(scoreOf(s, f.team.A, 2)!.tee_shot_player_id).toBeNull();
  });

  it("LWW on tee_shot_at, independent of strokes_at", () => {
    const f = live();
    f.teeOff("A", 2);
    const A = f.team.A;
    let s = ok(f.state, mk("teeshot.set", { team_id: A, hole: 2, player_id: f.player.A1, at: at(300) })).state;
    s = ok(s, mk("score.set", { team_id: A, hole: 2, strokes: 4, at: at(400) })).state;
    noop(s, mk("teeshot.set", { team_id: A, hole: 2, player_id: f.player.A2, at: at(250) }));
    // Older than strokes_at but newer than tee_shot_at: still applies.
    s = ok(s, mk("teeshot.set", { team_id: A, hole: 2, player_id: f.player.A2, at: at(350) })).state;
    expect(scoreOf(s, A, 2)).toMatchObject({ tee_shot_player_id: f.player.A2, strokes: 4, strokes_at: at(400) });
    // And a stale score doesn't lose the tee shot either.
    noop(s, mk("score.set", { team_id: A, hole: 2, strokes: 6, at: at(360) }));
  });

  it("player must be a current member of the team", () => {
    const f = live();
    f.teeOff("A", 1);
    expect(rejected(f.state, mk("teeshot.set", { team_id: f.team.A, hole: 1, player_id: f.player.B1 }), "invalid")).toContain("Player B1");
    rejected(f.state, mk("teeshot.set", { team_id: f.team.A, hole: 1, player_id: "who" }), "not_found");
    const s = ok(f.state, mk("player.delete", { player_id: f.player.A4 }), commish()).state;
    rejected(s, mk("teeshot.set", { team_id: f.team.A, hole: 1, player_id: f.player.A4 }), "not_found");
    rejected(f.state, mk("teeshot.set", { team_id: f.team.A, hole: 0, player_id: f.player.A1 }), "invalid");
  });

  it("opens open_hole + 1 like score.set, and nothing else", () => {
    const f = live();
    let r = ok(f.state, mk("teeshot.set", { team_id: f.team.A, hole: 1, player_id: f.player.A1 }));
    expect(openWindowHole(rsOf(r.state, f.team.A))).toBe(1);
    r = ok(r.state, mk("teeshot.set", { team_id: f.team.A, hole: 2, player_id: f.player.A2 }));
    expect(openWindowHole(rsOf(r.state, f.team.A))).toBe(2);
    const before = rsOf(r.state, f.team.A);
    r = ok(r.state, mk("teeshot.set", { team_id: f.team.A, hole: 7, player_id: f.player.A2 }));
    expect(rsOf(r.state, f.team.A)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Drinks
// ---------------------------------------------------------------------------

describe("drink.log", () => {
  it("creates a complete drink row (server)", () => {
    const f = live();
    f.teeOff("B", 3);
    const o = drinkOp(f, "B", "B2", 3, { drink_type: "shotgun", photo_path: "trips/x/drinks/1.jpg", by: f.player.B1 });
    const r = ok(f.state, o);
    expect(drinkOf(r.state, o.drink_id)).toEqual({
      id: o.drink_id,
      trip_id: f.state.trip.id,
      team_id: f.team.B,
      player_id: f.player.B2,
      hole: 3,
      type: "shotgun",
      photo_path: "trips/x/drinks/1.jpg",
      logged_by: f.player.B1,
      logged_at: o.at,
      created_at: NOW,
      deleted_at: null,
      deleted_by: null,
      moved_from_hole: null,
    });
  });

  it("client: works while the window is open", () => {
    const f = live();
    f.teeOff("A", 2);
    const o = drinkOp(f, "A", "A1", openWindowHole(rsOf(f.state, f.team.A))!);
    expect(drinkOf(ok(f.state, o, client()).state, o.drink_id)!.hole).toBe(2);
  });

  it("client: no window before hole 1 or after the round is complete", () => {
    const f = live();
    expect(rejected(f.state, drinkOp(f, "A", "A1", 1), "no_window", client())).toMatch(/tee/i);
    rejected(withoutRoundState(f.state, f.team.A), drinkOp(f, "A", "A1", 1), "no_window", client());
    f.teeOff("A", 18).complete("A");
    expect(rejected(f.state, drinkOp(f, "A", "A1", 18), "no_window", client())).toMatch(/over/i);
  });

  it("server trusts the client-stamped hole (offline phones never lose drinks)", () => {
    const f = live();
    // Not started yet on the server, complete, or a different hole: all accepted as stamped.
    const o1 = drinkOp(f, "A", "A2", 1);
    expect(drinkOf(ok(f.state, o1).state, o1.drink_id)!.hole).toBe(1);
    f.teeOff("A", 18).complete("A");
    const o2 = drinkOp(f, "A", "A3", 17);
    expect(drinkOf(ok(f.state, o2).state, o2.drink_id)!.hole).toBe(17);
  });

  it("is idempotent by drink_id, even after the drink was deleted", () => {
    const f = live();
    f.teeOff("A", 1);
    const o = drinkOp(f, "A", "A1", 1);
    let s = ok(f.state, o).state;
    s = ok(s, mk("drink.delete", { drink_id: o.drink_id })).state;
    noop(s, o);
    noop(s, o, client());
  });

  it("validates team, player, membership, hole and type", () => {
    const f = live();
    f.teeOff("A", 1);
    expect(rejected(f.state, drinkOp(f, "A", "B1", 1), "invalid")).toContain("Player B1");
    rejected(f.state, { ...drinkOp(f, "A", "A1", 1), team_id: "nope" }, "not_found");
    rejected(f.state, { ...drinkOp(f, "A", "A1", 1), player_id: "nope" }, "not_found");
    rejected(f.state, drinkOp(f, "A", "A1", 0), "invalid");
    rejected(f.state, drinkOp(f, "A", "A1", 19), "invalid");
    rejected(f.state, drinkOp(f, "A", "A1", 1, { drink_type: "wine" as never }), "invalid");
    rejected(f.state, drinkOp(f, "A", "A1", 1, { drink_id: "" }), "invalid");
    rejected(f.state, drinkOp(f, "A", "A1", 1, { photo_path: 42 as never }), "invalid");
  });

  it("drink_cap (per player) blocks the next drink; deleted drinks don't count; override bypasses", () => {
    const f = live([4, 3, 3], { settings: { drink_cap: 2 } });
    f.teeOff("A", 1);
    f.drink("A", "A1", 1);
    const second = f.drink("A", "A1", 1);
    expect(rejected(f.state, drinkOp(f, "A", "A1", 1), "conflict")).toContain("2");
    // Teammates have their own cap.
    ok(f.state, drinkOp(f, "A", "A2", 1));
    f.deleteDrink(second);
    ok(f.state, drinkOp(f, "A", "A1", 1));
    f.drink("A", "A1", 1);
    ok(f.state, drinkOp(f, "A", "A1", 1, { as_commissioner: true }), commish());
  });

  it("a commissioner override can add a drink with no window (fixing a final round)", () => {
    const f = makeTrip({ teams: [4, 3, 3], status: "final" });
    f.teeOff("A", 18).complete("A");
    const o = drinkOp(f, "A", "A1", 9, { as_commissioner: true });
    expect(drinkOf(ok(f.state, o, commish({ side: "client" })).state, o.drink_id)!.hole).toBe(9);
  });
});

describe("drink.delete", () => {
  it("soft deletes with deleted_by", () => {
    const f = live();
    f.teeOff("A", 1);
    const id = f.drink("A", "A1", 1);
    const r = ok(f.state, mk("drink.delete", { drink_id: id, by: f.player.A2 }));
    expect(drinkOf(r.state, id)).toMatchObject({ deleted_at: NOW, deleted_by: f.player.A2 });
  });

  it("is a no-op when already deleted; not_found when missing", () => {
    const f = live();
    const id = f.drink("A", "A1", 1);
    f.deleteDrink(id);
    noop(f.state, mk("drink.delete", { drink_id: id }));
    rejected(f.state, mk("drink.delete", { drink_id: "nope" }), "not_found");
  });
});

describe("drink.move (commissioner)", () => {
  it("moves a drink and remembers the original hole once", () => {
    const f = live();
    const id = f.drink("A", "A1", 4);
    let s = ok(f.state, mk("drink.move", { drink_id: id, hole: 5 }), commish()).state;
    expect(drinkOf(s, id)).toMatchObject({ hole: 5, moved_from_hole: 4 });
    s = ok(s, mk("drink.move", { drink_id: id, hole: 6 }), commish()).state;
    expect(drinkOf(s, id)).toMatchObject({ hole: 6, moved_from_hole: 4 });
    s = ok(s, mk("drink.move", { drink_id: id, hole: 4 }), commish()).state;
    expect(drinkOf(s, id)).toMatchObject({ hole: 4, moved_from_hole: 4 });
    noop(s, mk("drink.move", { drink_id: id, hole: 4 }), commish());
  });

  it("works in any status (fixing a final round)", () => {
    const f = makeTrip({ teams: [4, 3, 3], status: "final" });
    const id = f.drink("A", "A1", 4);
    ok(f.state, mk("drink.move", { drink_id: id, hole: 3 }), commish());
  });

  it("validates", () => {
    const f = live();
    const id = f.drink("A", "A1", 4);
    rejected(f.state, mk("drink.move", { drink_id: id, hole: 5 }), "forbidden");
    rejected(f.state, mk("drink.move", { drink_id: id, hole: 19 }), "invalid", commish());
    rejected(f.state, mk("drink.move", { drink_id: "nope", hole: 5 }), "not_found", commish());
    f.deleteDrink(id);
    rejected(f.state, mk("drink.move", { drink_id: id, hole: 5 }), "not_found", commish());
  });
});

// ---------------------------------------------------------------------------
// Mulligans
// ---------------------------------------------------------------------------

const mulliganOp = (f: TripFixture, team: string, source: "earned" | "groom", hole = 5, extra: Record<string, unknown> = {}) =>
  mk("mulligan.use", { mulligan_id: `mull-${++opSeq}`, team_id: f.team[team], hole, source, ...extra });

describe("mulligan.use", () => {
  it("records a complete use", () => {
    const f = live();
    f.drink("B", "B1", 2, "shot");
    const o = mulliganOp(f, "B", "earned", 3, { by: f.player.B2 });
    const r = ok(f.state, o);
    expect(r.state.mulligans.find((m) => m.id === o.mulligan_id)).toEqual({
      id: o.mulligan_id,
      trip_id: f.state.trip.id,
      team_id: f.team.B,
      source: "earned",
      used_on_hole: 3,
      used_by: f.player.B2,
      used_at: o.at,
      created_at: NOW,
      deleted_at: null,
    });
  });

  it("earned needs an active shotgun/shot in the team's bank", () => {
    const f = live();
    expect(rejected(f.state, mulliganOp(f, "A", "earned"), "conflict")).toMatch(/bank/);
    f.drink("A", "A1", 1, "drink"); // plain drinks don't earn
    rejected(f.state, mulliganOp(f, "A", "earned"), "conflict");
    f.drink("B", "B1", 1, "shotgun"); // other teams' shotguns don't count
    rejected(f.state, mulliganOp(f, "A", "earned"), "conflict");
    const sg = f.drink("A", "A2", 1, "shotgun");
    const s = ok(f.state, mulliganOp(f, "A", "earned")).state;
    rejected(s, mulliganOp(f, "A", "earned"), "conflict");
    // Deleting the shotgun voids the bank.
    f.deleteDrink(sg);
    rejected(f.state, mulliganOp(f, "A", "earned"), "conflict");
  });

  it("an undo returns the mulligan to the bank", () => {
    const f = live();
    f.drink("A", "A2", 1, "shot");
    const use = mulliganOp(f, "A", "earned");
    let s = ok(f.state, use).state;
    rejected(s, mulliganOp(f, "A", "earned"), "conflict");
    s = ok(s, mk("mulligan.undo", { mulligan_id: use.mulligan_id })).state;
    ok(s, mulliganOp(f, "A", "earned"));
  });

  it("groom: only on the groom's team, only once per trip, separate from the earned bank", () => {
    const f = live(); // groom = A1
    expect(rejected(f.state, mulliganOp(f, "B", "groom"), "conflict")).toMatch(/groom/i);
    f.drink("A", "A1", 1, "shotgun");
    let s = ok(f.state, mulliganOp(f, "A", "groom")).state;
    expect(rejected(s, mulliganOp(f, "A", "groom", 9), "conflict")).toMatch(/already/);
    // The earned bank is untouched by the groom's use.
    s = ok(s, mulliganOp(f, "A", "earned")).state;
    rejected(s, mulliganOp(f, "A", "earned"), "conflict");
  });

  it("groom: undo makes it available again; no groom = no groom mulligan", () => {
    const f = live();
    const use = mulliganOp(f, "A", "groom");
    let s = ok(f.state, use).state;
    s = ok(s, mk("mulligan.undo", { mulligan_id: use.mulligan_id })).state;
    ok(s, mulliganOp(f, "A", "groom"));
    const noGroom = ok(f.state, mk("player.delete", { player_id: f.player.A1 }), commish()).state;
    rejected(noGroom, mulliganOp(f, "A", "groom"), "conflict");
    // Groom moved to team B: B gets it, A doesn't.
    const moved = ok(f.state, mk("team.assign", { player_id: f.player.A1, team_id: f.team.B }), commish()).state;
    rejected(moved, mulliganOp(f, "A", "groom"), "conflict");
    ok(moved, mulliganOp(f, "B", "groom"));
  });

  it("is idempotent by mulligan_id and validates", () => {
    const f = live();
    f.drink("A", "A1", 1, "shot");
    const o = mulliganOp(f, "A", "earned");
    const s = ok(f.state, o).state;
    noop(s, o);
    rejected(f.state, mulliganOp(f, "A", "earned", 0), "invalid");
    rejected(f.state, mulliganOp(f, "A", "bogus" as never), "invalid");
    rejected(f.state, { ...mulliganOp(f, "A", "earned"), team_id: "nope" }, "not_found");
  });
});

describe("mulligan.undo", () => {
  it("soft deletes; no-op when already undone; not_found when missing", () => {
    const f = live();
    const id = f.mulligan("A", 3, "groom");
    const s = ok(f.state, mk("mulligan.undo", { mulligan_id: id })).state;
    expect(s.mulligans.find((m) => m.id === id)!.deleted_at).toBe(NOW);
    noop(s, mk("mulligan.undo", { mulligan_id: id }));
    rejected(f.state, mk("mulligan.undo", { mulligan_id: "nope" }), "not_found");
  });
});

// ---------------------------------------------------------------------------
// Contests
// ---------------------------------------------------------------------------

function submit(f: TripFixture, player: string, hole: number, type: "ctp" | "ld", distance: number, extra: Partial<Fields<"contest.submit">> = {}) {
  return mk("contest.submit", {
    entry_id: `entry-${++opSeq}`,
    hole,
    player_id: f.player[player],
    contest_type: type,
    distance_value: distance,
    angle_deg: type === "ctp" ? 45 : null,
    lat: type === "ld" ? 41.0951 : null,
    lng: type === "ld" ? -75.6712 : null,
    gps_accuracy_m: type === "ld" ? 4 : null,
    low_accuracy: false,
    photo_path: "trips/t/contest/1.jpg",
    ...extra,
  });
}
const entryOf = (s: TripState, id: string) => s.contest_entries.find((e) => e.id === id);

describe("contest.submit", () => {
  it("closest to pin: a complete ok entry in feet, on the player's team", () => {
    const f = live();
    const o = submit(f, "B2", 3, "ctp", 7.25);
    const r = ok(f.state, o);
    expect(entryOf(r.state, o.entry_id)).toEqual({
      id: o.entry_id,
      trip_id: f.state.trip.id,
      hole: 3,
      player_id: f.player.B2,
      team_id: f.team.B,
      type: "ctp",
      distance_value: 7.25,
      unit: "ft",
      distance_override: null,
      angle_deg: 45,
      lat: null,
      lng: null,
      gps_accuracy_m: null,
      low_accuracy: false,
      photo_path: "trips/t/contest/1.jpg",
      ai_estimate_ft: null,
      ai_confidence: null,
      ai_suspicious: null,
      ai_roast: null,
      status: "ok",
      flag_reason: null,
      created_at: NOW,
      updated_at: NOW,
      deleted_at: null,
    });
  });

  it("closest to pin allows 0 (ace) to 200 ft", () => {
    const f = live();
    ok(f.state, submit(f, "A1", 8, "ctp", 0));
    ok(f.state, submit(f, "A1", 8, "ctp", 200));
    rejected(f.state, submit(f, "A1", 8, "ctp", 200.5), "invalid");
    rejected(f.state, submit(f, "A1", 8, "ctp", -1), "invalid");
    rejected(f.state, submit(f, "A1", 8, "ctp", NaN), "invalid");
  });

  it("long drive: ok in range, yards", () => {
    const f = live();
    const o = submit(f, "C1", 4, "ld", 287);
    expect(entryOf(ok(f.state, o).state, o.entry_id)).toMatchObject({ unit: "yd", status: "ok", flag_reason: null, lat: 41.0951, gps_accuracy_m: 4 });
  });

  it("long drive: weak GPS and out-of-range distances are flagged for the commissioner", () => {
    const f = live();
    const weak = submit(f, "C1", 4, "ld", 287, { low_accuracy: true, gps_accuracy_m: 25 });
    expect(entryOf(ok(f.state, weak).state, weak.entry_id)).toMatchObject({ status: "flagged", flag_reason: "GPS was weak", low_accuracy: true });
    const short = submit(f, "C1", 4, "ld", 50);
    expect(entryOf(ok(f.state, short).state, short.entry_id)).toMatchObject({ status: "flagged", flag_reason: "Out of range: 50 yd" });
    const long = submit(f, "C1", 4, "ld", 412.4);
    expect(entryOf(ok(f.state, long).state, long.entry_id)).toMatchObject({ status: "flagged", flag_reason: "Out of range: 412 yd" });
    // Boundaries are inclusive.
    for (const d of [100, 400]) {
      const o = submit(f, "C1", 4, "ld", d);
      expect(entryOf(ok(f.state, o).state, o.entry_id)!.status).toBe("ok");
    }
    // Weak GPS wins over the range message.
    const both = submit(f, "C1", 4, "ld", 20, { low_accuracy: true });
    expect(entryOf(ok(f.state, both).state, both.entry_id)!.flag_reason).toBe("GPS was weak");
    rejected(f.state, submit(f, "C1", 4, "ld", 701), "invalid");
  });

  it("long drive: the sanity range comes from settings", () => {
    const f = live([4, 3, 3], { settings: { ld_min_yd: 150, ld_max_yd: 350 } });
    const o = submit(f, "A2", 9, "ld", 360);
    expect(entryOf(ok(f.state, o).state, o.entry_id)!.flag_reason).toBe("Out of range: 360 yd");
    const o2 = submit(f, "A2", 9, "ld", 140);
    expect(entryOf(ok(f.state, o2).state, o2.entry_id)!.status).toBe("flagged");
  });

  it("re-measuring replaces the player's earlier entry on that hole only", () => {
    const f = live();
    const mine = f.entry({ hole: 3, player_id: f.player.A1, type: "ctp", distance_value: 20 });
    const mineOther = f.entry({ hole: 8, player_id: f.player.A1, type: "ctp", distance_value: 9 });
    const theirs = f.entry({ hole: 3, player_id: f.player.B1, type: "ctp", distance_value: 15 });
    const o = submit(f, "A1", 3, "ctp", 12);
    const r = ok(f.state, o);
    expect(entryOf(r.state, mine)).toMatchObject({ deleted_at: NOW, updated_at: NOW });
    expect(entryOf(r.state, mineOther)).toBe(entryOf(f.state, mineOther));
    expect(entryOf(r.state, theirs)).toBe(entryOf(f.state, theirs));
    expect(r.state.contest_entries.filter((e) => e.player_id === f.player.A1 && e.hole === 3 && e.deleted_at === null).map((e) => e.id)).toEqual([o.entry_id]);
  });

  it("the hole must be that kind of contest hole", () => {
    const f = live();
    expect(rejected(f.state, submit(f, "A1", 4, "ctp", 10), "invalid")).toMatch(/long drive/);
    expect(rejected(f.state, submit(f, "A1", 3, "ld", 250), "invalid")).toMatch(/closest to pin/);
    rejected(f.state, submit(f, "A1", 1, "ctp", 10), "invalid");
    rejected(f.state, submit(f, "A1", 1, "bogus" as never, 10), "invalid");
    rejected(f.state, submit(f, "A1", 19, "ctp", 10), "invalid");
    const noHoles = { ...f.state, holes: f.state.holes.filter((h) => h.number !== 3) };
    rejected(noHoles, submit(f, "A1", 3, "ctp", 10), "not_found");
  });

  it("the player must be on a team", () => {
    const f = live();
    const s = ok(f.state, mk("team.assign", { player_id: f.player.A4, team_id: null }), commish()).state;
    expect(rejected(s, submit(f, "A4", 3, "ctp", 10), "conflict")).toContain("Player A4");
    rejected(f.state, { ...submit(f, "A1", 3, "ctp", 10), player_id: "nope" }, "not_found");
  });

  it("validates optional numbers", () => {
    const f = live();
    rejected(f.state, submit(f, "C1", 4, "ld", 250, { lat: 91 }), "invalid");
    rejected(f.state, submit(f, "C1", 4, "ld", 250, { lng: NaN }), "invalid");
    rejected(f.state, submit(f, "C1", 4, "ld", 250, { gps_accuracy_m: -1 }), "invalid");
    rejected(f.state, submit(f, "A1", 3, "ctp", 5, { angle_deg: "north" as never }), "invalid");
  });

  it("is idempotent by entry_id", () => {
    const f = live();
    const o = submit(f, "A1", 3, "ctp", 12);
    const s = ok(f.state, o).state;
    // Even after a re-measure replaced it, the old op stays a no-op.
    const s2 = ok(s, submit(f, "A1", 3, "ctp", 9)).state;
    noop(s2, o);
  });
});

describe("contest.delete", () => {
  it("soft deletes; no-op twice; not_found when missing", () => {
    const f = live();
    const id = f.entry({ hole: 3, player_id: f.player.A1, type: "ctp", distance_value: 20 });
    const s = ok(f.state, mk("contest.delete", { entry_id: id })).state;
    expect(entryOf(s, id)).toMatchObject({ deleted_at: NOW, updated_at: NOW });
    noop(s, mk("contest.delete", { entry_id: id }));
    rejected(f.state, mk("contest.delete", { entry_id: "nope" }), "not_found");
  });
});

describe("contest.review (commissioner)", () => {
  it("sets status and, if present, the official distance", () => {
    const f = live();
    const id = f.entry({ hole: 4, player_id: f.player.A1, type: "ld", distance_value: 420, status: "flagged", flag_reason: "Out of range: 420 yd" });
    let s = ok(f.state, mk("contest.review", { entry_id: id, status: "overridden", distance_override: 312 }), commish()).state;
    expect(entryOf(s, id)).toMatchObject({ status: "overridden", distance_override: 312, flag_reason: "Out of range: 420 yd", updated_at: NOW });
    s = ok(s, mk("contest.review", { entry_id: id, status: "flagged" }), commish()).state;
    expect(entryOf(s, id)).toMatchObject({ status: "flagged", distance_override: 312 });
    s = ok(s, mk("contest.review", { entry_id: id, status: "flagged", distance_override: null }), commish()).state;
    expect(entryOf(s, id)!.distance_override).toBeNull();
    noop(s, mk("contest.review", { entry_id: id, status: "flagged", distance_override: null }), commish());
  });

  it("validates", () => {
    const f = live();
    const id = f.entry({ hole: 3, player_id: f.player.A1, type: "ctp", distance_value: 20 });
    rejected(f.state, mk("contest.review", { entry_id: id, status: "overridden" }), "forbidden");
    rejected(f.state, mk("contest.review", { entry_id: id, status: "meh" as never }), "invalid", commish());
    rejected(f.state, mk("contest.review", { entry_id: id, status: "ok", distance_override: 201 }), "invalid", commish());
    rejected(f.state, mk("contest.review", { entry_id: id, status: "ok", distance_override: -2 }), "invalid", commish());
    rejected(f.state, mk("contest.review", { entry_id: "nope", status: "ok" }), "not_found", commish());
  });
});

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------

describe("post.create", () => {
  it("inserts a post feed event authored by op.by (trimmed text)", () => {
    const f = live();
    const o = mk("post.create", { event_id: "post-1", text: "  B1 is choking  ", photo_path: null, by: f.player.C2 });
    const r = ok(f.state, o);
    expect(r.state.feed_events.find((e) => e.id === "post-1")).toEqual({
      id: "post-1",
      trip_id: f.state.trip.id,
      type: "post",
      team_id: f.team.C,
      player_id: f.player.C2,
      actor_id: f.player.C2,
      payload: {},
      photo_path: null,
      text: "B1 is choking",
      dedupe_key: null,
      created_at: NOW,
      updated_at: NOW,
      deleted_at: null,
    });
  });

  it("a photo alone is enough; blank text becomes null", () => {
    const f = live();
    const r = ok(f.state, mk("post.create", { event_id: "post-2", text: "   ", photo_path: "trips/t/posts/x.jpg", by: f.player.A1 }));
    expect(r.state.feed_events[0]).toMatchObject({ text: null, photo_path: "trips/t/posts/x.jpg" });
  });

  it("needs text or a photo; max 1000 chars", () => {
    const f = live();
    rejected(f.state, mk("post.create", { event_id: "p", text: "  ", photo_path: null }), "invalid");
    rejected(f.state, mk("post.create", { event_id: "p", text: null, photo_path: null }), "invalid");
    rejected(f.state, mk("post.create", { event_id: "p", text: "x".repeat(1001), photo_path: null }), "invalid");
    ok(f.state, mk("post.create", { event_id: "p", text: ` ${"x".repeat(1000)} `, photo_path: null }));
    rejected(f.state, mk("post.create", { event_id: "p", text: 5 as never, photo_path: null }), "invalid");
  });

  it("no author (commissioner device before joining) is allowed", () => {
    const f = live();
    const r = ok(f.state, mk("post.create", { event_id: "p0", text: "Round starts in 10", photo_path: null, by: null }));
    expect(r.state.feed_events[0]).toMatchObject({ player_id: null, actor_id: null, team_id: null });
  });

  it("is idempotent by event_id", () => {
    const f = live();
    const o = mk("post.create", { event_id: "p1", text: "hi", photo_path: null });
    const s = ok(f.state, o).state;
    noop(s, { ...o, id: "another-op-same-event" });
  });
});

describe("feed.delete", () => {
  function withPost(f: TripFixture, by: string) {
    return ok(f.state, mk("post.create", { event_id: `post-${++opSeq}`, text: "sup", photo_path: null, by })).state;
  }

  it("the author can delete their own post", () => {
    const f = live();
    const s = withPost(f, f.player.B1);
    const id = s.feed_events[0].id;
    const r = ok(s, mk("feed.delete", { event_id: id, by: f.player.B1 }));
    expect(r.state.feed_events[0]).toMatchObject({ deleted_at: NOW, updated_at: NOW });
  });

  it("others can't; the commissioner can delete anything", () => {
    const f = live();
    const s = withPost(f, f.player.B1);
    const id = s.feed_events[0].id;
    rejected(s, mk("feed.delete", { event_id: id, by: f.player.B2 }), "forbidden");
    ok(s, mk("feed.delete", { event_id: id, by: f.player.B2 }), commish());
    // An automatic event: even the "player" on it can't delete it.
    const auto = {
      ...s.feed_events[0],
      id: "auto-1",
      type: "ghost_beer" as const,
      player_id: f.player.B2,
    };
    const s2 = { ...s, feed_events: [...s.feed_events, auto] };
    rejected(s2, mk("feed.delete", { event_id: "auto-1", by: f.player.B2 }), "forbidden");
    ok(s2, mk("feed.delete", { event_id: "auto-1", as_commissioner: true }), commish());
  });

  it("no-op when already deleted; not_found when missing", () => {
    const f = live();
    let s = withPost(f, f.player.B1);
    const id = s.feed_events[0].id;
    s = ok(s, mk("feed.delete", { event_id: id, by: f.player.B1 })).state;
    noop(s, mk("feed.delete", { event_id: id, by: f.player.B1 }));
    rejected(s, mk("feed.delete", { event_id: "nope" }), "not_found", commish());
  });
});

describe("reaction.set", () => {
  it("on inserts, off soft-deletes, on again reuses the same row", () => {
    const f = live();
    let s = ok(f.state, mk("post.create", { event_id: "post-r", text: "ace!", photo_path: null })).state;
    const on = mk("reaction.set", { feed_event_id: "post-r", player_id: f.player.A3, kind: "fire", on: true });
    s = ok(s, on).state;
    expect(s.reactions).toEqual([
      { id: on.id, trip_id: f.state.trip.id, feed_event_id: "post-r", player_id: f.player.A3, kind: "fire", created_at: NOW, deleted_at: null },
    ]);
    s = ok(s, mk("reaction.set", { feed_event_id: "post-r", player_id: f.player.A3, kind: "fire", on: false })).state;
    expect(s.reactions[0]).toMatchObject({ id: on.id, deleted_at: NOW });
    noop(s, mk("reaction.set", { feed_event_id: "post-r", player_id: f.player.A3, kind: "fire", on: false }));
    s = ok(s, mk("reaction.set", { feed_event_id: "post-r", player_id: f.player.A3, kind: "fire", on: true })).state;
    expect(s.reactions).toHaveLength(1);
    expect(s.reactions[0]).toMatchObject({ id: on.id, deleted_at: null });
    noop(s, mk("reaction.set", { feed_event_id: "post-r", player_id: f.player.A3, kind: "fire", on: true }));
    // A different kind (or player) is a separate row.
    s = ok(s, mk("reaction.set", { feed_event_id: "post-r", player_id: f.player.A3, kind: "clown", on: true })).state;
    s = ok(s, mk("reaction.set", { feed_event_id: "post-r", player_id: f.player.B3, kind: "fire", on: true })).state;
    expect(s.reactions).toHaveLength(3);
  });

  it("validates", () => {
    const f = live();
    const s = ok(f.state, mk("post.create", { event_id: "post-v", text: "x", photo_path: null })).state;
    noop(s, mk("reaction.set", { feed_event_id: "post-v", player_id: f.player.A1, kind: "fire", on: false }));
    rejected(s, mk("reaction.set", { feed_event_id: "post-v", player_id: f.player.A1, kind: "heart" as never, on: true }), "invalid");
    rejected(s, mk("reaction.set", { feed_event_id: "nope", player_id: f.player.A1, kind: "fire", on: true }), "not_found");
    rejected(s, mk("reaction.set", { feed_event_id: "post-v", player_id: "nope", kind: "fire", on: true }), "not_found");
    rejected(s, mk("reaction.set", { feed_event_id: "post-v", player_id: f.player.A1, kind: "fire", on: "yes" as never }), "invalid");
    const deleted = ok(s, mk("feed.delete", { event_id: "post-v" }), commish()).state;
    rejected(deleted, mk("reaction.set", { feed_event_id: "post-v", player_id: f.player.A1, kind: "fire", on: true }), "not_found");
  });
});

// ---------------------------------------------------------------------------
// Pots & mute
// ---------------------------------------------------------------------------

describe("pot.optout", () => {
  it("players can opt out and back in during setup (row reused)", () => {
    const f = makeTrip({ teams: [4, 3, 3], status: "setup" });
    const out = mk("pot.optout", { pot_key: "contest:3", player_id: f.player.C1, out: true });
    let s = ok(f.state, out).state;
    expect(s.pot_optouts).toEqual([{ id: out.id, trip_id: f.state.trip.id, pot_key: "contest:3", player_id: f.player.C1, created_at: NOW, deleted_at: null }]);
    noop(s, mk("pot.optout", { pot_key: "contest:3", player_id: f.player.C1, out: true }));
    s = ok(s, mk("pot.optout", { pot_key: "contest:3", player_id: f.player.C1, out: false })).state;
    expect(s.pot_optouts[0]).toMatchObject({ id: out.id, deleted_at: NOW });
    noop(s, mk("pot.optout", { pot_key: "contest:3", player_id: f.player.C1, out: false }));
    s = ok(s, mk("pot.optout", { pot_key: "contest:3", player_id: f.player.C1, out: true })).state;
    expect(s.pot_optouts).toHaveLength(1);
    expect(s.pot_optouts[0]).toMatchObject({ id: out.id, deleted_at: null });
    s = ok(s, mk("pot.optout", { pot_key: "team_match", player_id: f.player.C1, out: true })).state;
    expect(s.pot_optouts).toHaveLength(2);
  });

  it("players are locked in once live; the commissioner can change it any time", () => {
    for (const status of ["live", "final"] as const) {
      const f = makeTrip({ teams: [4, 3, 3], status });
      rejected(f.state, mk("pot.optout", { pot_key: "team_match", player_id: f.player.A1, out: true }), "conflict");
      ok(f.state, mk("pot.optout", { pot_key: "team_match", player_id: f.player.A1, out: true }), commish());
    }
  });

  it("pot keys must name a real pot", () => {
    const f = makeTrip({ teams: [4, 3, 3], status: "setup" });
    for (const key of ["contest:1", "contest:19", "contest:03", "contest:", "bogus", "contest:3x", ""]) {
      rejected(f.state, mk("pot.optout", { pot_key: key as never, player_id: f.player.A1, out: true }), "invalid");
    }
    for (const key of ["contest:3", "contest:4", "contest:18", "team_match"] as const) {
      ok(f.state, mk("pot.optout", { pot_key: key, player_id: f.player.A1, out: true }));
    }
    rejected(f.state, mk("pot.optout", { pot_key: "team_match", player_id: "nope", out: true }), "not_found");
  });
});

describe("player.mute", () => {
  it("sets muted_push", () => {
    const f = live();
    const s = ok(f.state, mk("player.mute", { player_id: f.player.B2, muted: true })).state;
    expect(s.players.find((p) => p.id === f.player.B2)!.muted_push).toBe(true);
    noop(s, mk("player.mute", { player_id: f.player.B2, muted: true }));
    rejected(f.state, mk("player.mute", { player_id: "nope", muted: true }), "not_found");
    rejected(f.state, mk("player.mute", { player_id: f.player.B2, muted: 1 as never }), "invalid");
  });
});

// ---------------------------------------------------------------------------
// Roster, teams, course, trip (commissioner)
// ---------------------------------------------------------------------------

const playerOf = (s: TripState, id: string) => s.players.find((p) => p.id === id);
const membersOf = (s: TripState, teamId: string) => s.team_members.filter((m) => m.team_id === teamId).map((m) => m.player_id);

describe("player.upsert", () => {
  it("creates a complete player (trimmed name, next sort order)", () => {
    const f = makeTrip({ teams: [4, 3, 3], status: "setup" });
    const o = mk("player.upsert", { player: { id: "p-new", name: "  Big Dave ", venmo_handle: " @Dave-V ", nickname: "  " } });
    const r = ok(f.state, o, commish());
    expect(playerOf(r.state, "p-new")).toEqual({
      id: "p-new",
      trip_id: f.state.trip.id,
      name: "Big Dave",
      nickname: null,
      venmo_handle: "Dave-V",
      is_groom: false,
      muted_push: false,
      sort_order: 10,
      created_at: NOW,
      deleted_at: null,
    });
  });

  it("creating needs a non-empty name", () => {
    const f = live();
    rejected(f.state, mk("player.upsert", { player: { id: "p-x" } }), "invalid", commish());
    rejected(f.state, mk("player.upsert", { player: { id: "p-x", name: "   " } }), "invalid", commish());
    rejected(f.state, mk("player.upsert", { player: { id: "p-x", name: "x".repeat(81) } }), "invalid", commish());
    rejected(f.state, mk("player.upsert", { player: { id: "", name: "X" } }), "invalid", commish());
    rejected(f.state, mk("player.upsert", { player: { id: "p-x", name: "X" } }), "forbidden");
  });

  it("patches only the given fields", () => {
    const f = live();
    const id = f.player.B1;
    const before = playerOf(f.state, id)!;
    const r = ok(f.state, mk("player.upsert", { player: { id, nickname: "Shanks", sort_order: 99 } }), commish());
    expect(playerOf(r.state, id)).toEqual({ ...before, nickname: "Shanks", sort_order: 99 });
    rejected(f.state, mk("player.upsert", { player: { id, name: "" } }), "invalid", commish());
    noop(r.state, mk("player.upsert", { player: { id, nickname: "Shanks" } }), commish());
  });

  it("is_groom: true clears every other groom", () => {
    const f = live(); // groom A1
    const r = ok(f.state, mk("player.upsert", { player: { id: f.player.C3, is_groom: true } }), commish());
    expect(r.state.players.filter((p) => p.is_groom).map((p) => p.id)).toEqual([f.player.C3]);
    expect(r.writes.map((w) => w.kind === "upsert" && w.row.id).sort()).toEqual([f.player.A1, f.player.C3].sort());
    // A brand-new groom too.
    const r2 = ok(f.state, mk("player.upsert", { player: { id: "p-groom", name: "Nick", is_groom: true } }), commish());
    expect(r2.state.players.filter((p) => p.is_groom).map((p) => p.id)).toEqual(["p-groom"]);
    // is_groom false only touches that player.
    const r3 = ok(f.state, mk("player.upsert", { player: { id: f.player.A1, is_groom: false } }), commish());
    expect(r3.state.players.some((p) => p.is_groom)).toBe(false);
  });

  it("a deleted player can't be edited", () => {
    const f = live();
    const s = ok(f.state, mk("player.delete", { player_id: f.player.C3 }), commish()).state;
    rejected(s, mk("player.upsert", { player: { id: f.player.C3, name: "Back" } }), "not_found", commish());
  });
});

describe("player.delete", () => {
  it("soft deletes and hard-deletes the membership", () => {
    const f = live();
    const membership = f.state.team_members.find((m) => m.player_id === f.player.C3)!;
    const r = ok(f.state, mk("player.delete", { player_id: f.player.C3 }), commish());
    expect(playerOf(r.state, f.player.C3)!.deleted_at).toBe(NOW);
    expect(r.writes).toContainEqual({ kind: "delete", table: "team_members", id: membership.id });
    expect(membersOf(r.state, f.team.C)).toEqual([f.player.C1, f.player.C2]);
    noop(r.state, mk("player.delete", { player_id: f.player.C3 }), commish());
    rejected(f.state, mk("player.delete", { player_id: "nope" }), "not_found", commish());
  });
});

describe("team.upsert", () => {
  it("creates a team with defaults", () => {
    const f = makeTrip({ teams: [4, 3, 3], status: "setup" });
    const r = ok(f.state, mk("team.upsert", { team: { id: "t-new", tee_time: "9:05" } }), commish());
    expect(r.state.teams.find((t) => t.id === "t-new")).toEqual({
      id: "t-new",
      trip_id: f.state.trip.id,
      name: "Team 4",
      tee_time: "09:05",
      sort_order: 3,
      created_at: NOW,
      deleted_at: null,
    });
  });

  it("patches name, tee time, order", () => {
    const f = live();
    const id = f.team.B;
    let s = ok(f.state, mk("team.upsert", { team: { id, name: "  Grip It & Sip It ", tee_time: "12:58", sort_order: 7 } }), commish()).state;
    expect(s.teams.find((t) => t.id === id)).toMatchObject({ name: "Grip It & Sip It", tee_time: "12:58", sort_order: 7 });
    s = ok(s, mk("team.upsert", { team: { id, tee_time: null } }), commish()).state;
    expect(s.teams.find((t) => t.id === id)!.tee_time).toBeNull();
  });

  it("validates", () => {
    const f = live();
    for (const tee_time of ["25:00", "12:60", "noon", "1250"]) {
      rejected(f.state, mk("team.upsert", { team: { id: f.team.A, tee_time } }), "invalid", commish());
    }
    rejected(f.state, mk("team.upsert", { team: { id: f.team.A, name: " " } }), "invalid", commish());
    rejected(f.state, mk("team.upsert", { team: { id: f.team.A, sort_order: 1.5 } }), "invalid", commish());
    const s = ok(makeTrip({ teams: [4, 3, 3], status: "setup" }).state, mk("team.upsert", { team: { id: "t-x", name: "X" } }), commish()).state;
    const gone = ok(s, mk("team.delete", { team_id: "t-x" }), commish()).state;
    rejected(gone, mk("team.upsert", { team: { id: "t-x", name: "Y" } }), "not_found", commish());
  });
});

describe("team.delete", () => {
  it("soft deletes and removes memberships", () => {
    const f = makeTrip({ teams: [4, 3, 3], status: "setup" });
    const r = ok(f.state, mk("team.delete", { team_id: f.team.C }), commish());
    expect(r.state.teams.find((t) => t.id === f.team.C)!.deleted_at).toBe(NOW);
    expect(membersOf(r.state, f.team.C)).toEqual([]);
    expect(r.writes.filter((w) => w.kind === "delete")).toHaveLength(3);
    rejected(f.state, mk("team.delete", { team_id: "nope" }), "not_found", commish());
  });

  it("conflict while live if the team has scores or drinks", () => {
    const f = live();
    f.teeOff("C", 1).score("C", 1, 5);
    expect(rejected(f.state, mk("team.delete", { team_id: f.team.C }), "conflict", commish())).toContain("Team C");
    const g = live();
    const d = g.drink("B", "B1", 1);
    rejected(g.state, mk("team.delete", { team_id: g.team.B }), "conflict", commish());
    g.deleteDrink(d);
    ok(g.state, mk("team.delete", { team_id: g.team.B }), commish());
  });
});

describe("team.assign", () => {
  it("moves a player: old membership hard-deleted, new one with the op id", () => {
    const f = makeTrip({ teams: [4, 3, 3], status: "setup" });
    const old = f.state.team_members.find((m) => m.player_id === f.player.A4)!;
    const o = mk("team.assign", { player_id: f.player.A4, team_id: f.team.B });
    const r = ok(f.state, o, commish());
    expect(r.writes).toEqual([
      { kind: "delete", table: "team_members", id: old.id },
      { kind: "upsert", table: "team_members", row: { id: o.id, trip_id: f.state.trip.id, team_id: f.team.B, player_id: f.player.A4, created_at: NOW } },
    ]);
    expect(membersOf(r.state, f.team.B)).toContain(f.player.A4);
    expect(membersOf(r.state, f.team.A)).not.toContain(f.player.A4);
  });

  it("unassigns with null; no-op when already there", () => {
    const f = makeTrip({ teams: [4, 3, 3], status: "setup" });
    const s = ok(f.state, mk("team.assign", { player_id: f.player.A4, team_id: null }), commish()).state;
    expect(s.team_members.some((m) => m.player_id === f.player.A4)).toBe(false);
    noop(s, mk("team.assign", { player_id: f.player.A4, team_id: null }), commish());
    noop(f.state, mk("team.assign", { player_id: f.player.A4, team_id: f.team.A }), commish());
  });

  it("a 5th member is a conflict", () => {
    const f = makeTrip({ teams: [4, 3, 3], status: "setup" });
    expect(rejected(f.state, mk("team.assign", { player_id: f.player.B1, team_id: f.team.A }), "conflict", commish())).toContain("Team A");
  });

  it("validates", () => {
    const f = live();
    rejected(f.state, mk("team.assign", { player_id: "nope", team_id: f.team.A }), "not_found", commish());
    rejected(f.state, mk("team.assign", { player_id: f.player.B1, team_id: "nope" }), "not_found", commish());
    rejected(f.state, mk("team.assign", { player_id: f.player.B1, team_id: f.team.C }), "forbidden");
  });
});

const holeOf = (s: TripState, n: number) => s.holes.find((h) => h.number === n)!;

describe("hole.update", () => {
  it("changing par re-derives the contest", () => {
    const f = live();
    let s = ok(f.state, mk("hole.update", { hole: 1, patch: { par: 3 } }), commish()).state;
    expect(holeOf(s, 1)).toMatchObject({ par: 3, contest: "ctp", updated_at: NOW });
    s = ok(s, mk("hole.update", { hole: 1, patch: { par: 5 } }), commish()).state;
    expect(holeOf(s, 1).contest).toBe("ld");
    s = ok(s, mk("hole.update", { hole: 1, patch: { par: 4 } }), commish()).state;
    expect(holeOf(s, 1).contest).toBe("none");
    s = ok(s, mk("hole.update", { hole: 1, patch: { par: 6 } }), commish()).state;
    expect(holeOf(s, 1).contest).toBe("none");
  });

  it("an explicit contest wins; the same par leaves a manual contest alone", () => {
    const f = live();
    let s = ok(f.state, mk("hole.update", { hole: 1, patch: { par: 3, contest: "none" } }), commish()).state;
    expect(holeOf(s, 1)).toMatchObject({ par: 3, contest: "none" });
    s = ok(s, mk("hole.update", { hole: 1, patch: { par: 3, stroke_index: 2 } }), commish()).state;
    expect(holeOf(s, 1)).toMatchObject({ par: 3, contest: "none", stroke_index: 2 });
    s = ok(s, mk("hole.update", { hole: 2, patch: { contest: "ctp" } }), commish()).state;
    expect(holeOf(s, 2)).toMatchObject({ par: 4, contest: "ctp" });
  });

  it("edits tee/green points (null clears) and merges yardage", () => {
    const f = live();
    let s = ok(f.state, mk("hole.update", { hole: 4, patch: { tee_lat: 41.09, tee_lng: -75.67, green_lat: 41.1, green_lng: -75.66 } }), commish()).state;
    expect(holeOf(s, 4)).toMatchObject({ tee_lat: 41.09, tee_lng: -75.67, green_lat: 41.1, green_lng: -75.66, contest: "ld" });
    s = ok(s, mk("hole.update", { hole: 4, patch: { green_lat: null, green_lng: null } }), commish()).state;
    expect(holeOf(s, 4)).toMatchObject({ tee_lat: 41.09, green_lat: null, green_lng: null });
    s = ok(s, mk("hole.update", { hole: 4, patch: { yardage: { membership: 500 } as never } }), commish()).state;
    expect(holeOf(s, 4).yardage).toEqual({ advanced: 527, membership: 500, forward: 463 });
  });

  it("works while live and in final", () => {
    const f = makeTrip({ teams: [4, 3, 3], status: "final" });
    ok(f.state, mk("hole.update", { hole: 9, patch: { tee_lat: 41.0, tee_lng: -75.0 } }), commish());
  });

  it("validates", () => {
    const f = live();
    for (const par of [2, 7, 3.5]) rejected(f.state, mk("hole.update", { hole: 1, patch: { par } }), "invalid", commish());
    rejected(f.state, mk("hole.update", { hole: 1, patch: { stroke_index: 19 } }), "invalid", commish());
    rejected(f.state, mk("hole.update", { hole: 1, patch: { tee_lat: 95 } }), "invalid", commish());
    rejected(f.state, mk("hole.update", { hole: 1, patch: { tee_lng: -181 } }), "invalid", commish());
    rejected(f.state, mk("hole.update", { hole: 1, patch: { contest: "putting" as never } }), "invalid", commish());
    rejected(f.state, mk("hole.update", { hole: 1, patch: { yardage: { forward: -1 } as never } }), "invalid", commish());
    rejected(f.state, mk("hole.update", { hole: 19, patch: { par: 4 } }), "invalid", commish());
    rejected(f.state, mk("hole.update", { hole: 1, patch: null as never }), "invalid", commish());
    rejected(f.state, mk("hole.update", { hole: 1, patch: { par: 3 } }), "forbidden");
    noop(f.state, mk("hole.update", { hole: 1, patch: { par: 4 } }), commish());
    noop(f.state, mk("hole.update", { hole: 1, patch: {} }), commish());
  });
});

describe("trip.update", () => {
  it("merges settings and fields; writes the trip row", () => {
    const f = live();
    const before = f.state.trip;
    const r = ok(
      f.state,
      mk("trip.update", {
        patch: {
          name: "  Nick's Last Stand ",
          base_team_size: 3,
          settings: { team_match_ante_cents: 2000, team_match_payout: [70, 30], drink_cap: 12, bogus: 1 } as never,
        },
      }),
      commish(),
    );
    expect(r.writes).toEqual([{ kind: "trip", row: r.state.trip }]);
    expect(r.state.trip).toEqual({
      ...before,
      name: "Nick's Last Stand",
      base_team_size: 3,
      settings: { ...before.settings, team_match_ante_cents: 2000, team_match_payout: [70, 30], drink_cap: 12 },
      updated_at: NOW,
    });
    const s = ok(r.state, mk("trip.update", { patch: { settings: { drink_cap: null } } }), commish()).state;
    expect(s.trip.settings.drink_cap).toBeNull();
  });

  it("validates", () => {
    const f = live();
    const bad = (patch: Fields<"trip.update">["patch"]) => rejected(f.state, mk("trip.update", { patch }), "invalid", commish());
    bad({ base_team_size: 5 });
    bad({ base_team_size: 1 });
    bad({ name: "  " });
    bad({ settings: { team_match_payout: [70, 20] } });
    bad({ settings: { team_match_payout: [] } });
    bad({ settings: { team_match_payout: [110, -10] } });
    bad({ settings: { drink_cap: 0 } });
    bad({ settings: { team_match_ante_cents: 12.5 } });
    bad({ settings: { contest_ante_cents: -100 } });
    bad({ settings: { ld_min_yd: 450 } });
    bad({ settings: { tee_set: "tips" as never } });
    bad({ settings: { roasts_enabled: "yes" as never } });
    rejected(f.state, mk("trip.update", { patch: { name: "x" } }), "forbidden");
    ok(f.state, mk("trip.update", { patch: { settings: { ld_min_yd: 120, ld_max_yd: 380 } } }), commish());
    noop(f.state, mk("trip.update", { patch: { settings: { team_match_payout: [100] } } }), commish());
  });
});

describe("trip.start", () => {
  it("setup -> live, creating not_started round states with derived ids", () => {
    const f = makeTrip({ teams: [4, 3, 3], status: "setup" });
    const o = mk("trip.start", {});
    const r = ok(f.state, o, commish());
    expect(r.state.trip).toMatchObject({ status: "live", started_at: NOW, updated_at: NOW });
    expect(r.state.team_round_state).toHaveLength(3);
    for (const letter of ["A", "B", "C"]) {
      expect(rsOf(r.state, f.team[letter])).toEqual({
        id: deriveId(o.id, f.team[letter]),
        trip_id: f.state.trip.id,
        team_id: f.team[letter],
        open_hole: null,
        started_holes: [],
        hole_opened_at: {},
        status: "not_started",
        completed_at: null,
        updated_at: NOW,
      });
    }
    // Client and server agree on the round state ids.
    expect(ok(f.state, o, commish({ side: "client" })).state.team_round_state.map((x) => x.id)).toEqual(r.state.team_round_state.map((x) => x.id));
  });

  it("is a no-op when already live; conflict when final", () => {
    noop(live().state, mk("trip.start", {}), commish());
    rejected(makeTrip({ teams: [4, 3, 3], status: "final" }).state, mk("trip.start", {}), "conflict", commish());
  });

  it("needs at least one team", () => {
    const f = makeTrip({ teams: [], status: "setup" });
    rejected(f.state, mk("trip.start", {}), "conflict", commish());
  });

  it("names unassigned players", () => {
    const f = makeTrip({ teams: [4, 3, 3], status: "setup" });
    let s = ok(f.state, mk("team.assign", { player_id: f.player.B3, team_id: null }), commish()).state;
    s = ok(s, mk("player.upsert", { player: { id: "p-late", name: "Late Larry" } }), commish()).state;
    const reason = rejected(s, mk("trip.start", {}), "conflict", commish());
    expect(reason).toContain("Player B3");
    expect(reason).toContain("Late Larry");
    expect(reason).not.toContain("Player A1");
  });

  it("names teams outside 2..4", () => {
    const f = makeTrip({ teams: [4, 3, 1], status: "setup" });
    const reason = rejected(f.state, mk("trip.start", {}), "conflict", commish());
    expect(reason).toContain("Team C has 1");
    expect(reason).not.toContain("Team A");
    // An empty team counts too.
    const g = makeTrip({ teams: [4, 3, 3], status: "setup" });
    const s = ok(g.state, mk("team.upsert", { team: { id: "t-empty", name: "Ghosts" } }), commish()).state;
    expect(rejected(s, mk("trip.start", {}), "conflict", commish())).toContain("Ghosts has 0");
    // Five (only reachable by hand-edited data) too.
    const five = makeTrip({ teams: [5, 3], status: "setup" });
    expect(rejected(five.state, mk("trip.start", {}), "conflict", commish())).toContain("Team A has 5");
  });

  it("ignores deleted teams and players, and keeps existing round states", () => {
    const f = makeTrip({ teams: [4, 3, 3, 2], status: "setup" });
    let s = ok(f.state, mk("team.delete", { team_id: f.team.D }), commish()).state;
    s = ok(s, mk("player.delete", { player_id: f.player.D1 }), commish()).state;
    s = ok(s, mk("player.delete", { player_id: f.player.D2 }), commish()).state;
    s = ok(s, mk("round.set_state", { team_id: f.team.A, open_hole: null, status: "not_started" }), commish()).state;
    const existing = rsOf(s, f.team.A)!;
    const r = ok(s, mk("trip.start", {}), commish());
    expect(r.state.team_round_state).toHaveLength(3);
    expect(rsOf(r.state, f.team.A)).toBe(existing);
    expect(rsOf(r.state, f.team.D)).toBeUndefined();
  });
});

describe("trip.finalize / trip.reopen", () => {
  it("live -> final -> live", () => {
    const f = live();
    let s = ok(f.state, mk("trip.finalize", {}), commish()).state;
    expect(s.trip).toMatchObject({ status: "final", finalized_at: NOW });
    noop(s, mk("trip.finalize", {}), commish());
    s = ok(s, mk("trip.reopen", {}), commish()).state;
    expect(s.trip).toMatchObject({ status: "live", finalized_at: null });
    noop(s, mk("trip.reopen", {}), commish());
  });

  it("can't finalize or reopen from setup; forbidden for players", () => {
    const f = makeTrip({ teams: [4, 3, 3], status: "setup" });
    rejected(f.state, mk("trip.finalize", {}), "conflict", commish());
    rejected(f.state, mk("trip.reopen", {}), "conflict", commish());
    rejected(live().state, mk("trip.finalize", {}), "forbidden");
  });
});

// ---------------------------------------------------------------------------
// Spec checks
// ---------------------------------------------------------------------------

describe("spec: drink windows", () => {
  it("A drink logged after the team taps On the tee for hole 5 lands on hole 5, not hole 4", () => {
    const f = live();
    const A = f.team.A;
    let s = chain(f.state, [1, 2, 3, 4].map((hole) => mk("tee.open", { team_id: A, hole })), client());
    // Drink during hole 4 (the store stamps the open window hole).
    const d4 = drinkOp(f, "A", "A1", openWindowHole(rsOf(s, A))!);
    s = ok(s, d4, client()).state;
    s = ok(s, mk("tee.open", { team_id: A, hole: 5 }), client()).state;
    expect(openWindowHole(rsOf(s, A))).toBe(5);
    const d5 = drinkOp(f, "A", "A2", openWindowHole(rsOf(s, A))!);
    s = ok(s, d5, client()).state;
    expect(drinkOf(s, d4.drink_id)!.hole).toBe(4);
    expect(drinkOf(s, d5.drink_id)!.hole).toBe(5);
    // The server applies the same ops to the same result.
    const serverOps: Op[] = [...[1, 2, 3, 4].map((hole) => mk("tee.open", { team_id: A, hole })), d4, mk("tee.open", { team_id: A, hole: 5 }), d5];
    const onServer = chain(f.state, serverOps);
    expect(drinkOf(onServer, d5.drink_id)!.hole).toBe(5);
  });

  it("entering a score for hole 5 while on hole 4 also moves drinks to hole 5", () => {
    const f = live();
    f.teeOff("A", 4);
    const s = ok(f.state, mk("score.set", { team_id: f.team.A, hole: 5, strokes: 4 }), client()).state;
    const d = drinkOp(f, "A", "A3", openWindowHole(rsOf(s, f.team.A))!);
    expect(drinkOf(ok(s, d, client()).state, d.drink_id)!.hole).toBe(5);
  });

  it("A drink logged before hole 1 opens is rejected (client); the server accepts a client-stamped hole", () => {
    const f = live();
    expect(openWindowHole(rsOf(f.state, f.team.A))).toBeNull();
    rejected(f.state, drinkOp(f, "A", "A1", 1), "no_window", client());
    // An offline phone that had hole 1 open stamped hole 1; the server (which hasn't seen the
    // tee.open yet, e.g. it was rejected/dropped) must not lose it.
    const o = drinkOp(f, "A", "A1", 1);
    expect(drinkOf(ok(f.state, o, server()).state, o.drink_id)!.hole).toBe(1);
    // After teeing off, the client accepts it.
    const s = ok(f.state, mk("tee.open", { team_id: f.team.A, hole: 1 }), client()).state;
    ok(s, drinkOp(f, "A", "A1", 1), client());
  });

  it("Hole 18's window stays open until Round complete", () => {
    const f = live();
    const A = f.team.A;
    f.teeOff("A", 17);
    let s = ok(f.state, mk("tee.open", { team_id: A, hole: 18 }), client()).state;
    expect(openWindowHole(rsOf(s, A))).toBe(18);
    s = ok(s, mk("score.set", { team_id: A, hole: 18, strokes: 5 }), client()).state;
    s = ok(s, mk("teeshot.set", { team_id: A, hole: 18, player_id: f.player.A2 }), client()).state;
    expect(openWindowHole(rsOf(s, A))).toBe(18);
    const last = drinkOp(f, "A", "A4", 18, { drink_type: "shotgun" });
    s = ok(s, last, client()).state;
    expect(drinkOf(s, last.drink_id)!.hole).toBe(18);
    s = ok(s, mk("round.complete", { team_id: A }), client()).state;
    expect(openWindowHole(rsOf(s, A))).toBeNull();
    rejected(s, drinkOp(f, "A", "A4", 18), "no_window", client());
    // Server still trusts a drink stamped while 18 was open on an offline phone.
    ok(s, drinkOp(f, "A", "A4", 18), server());
  });
});

describe("spec: mulligans", () => {
  it("Shotgun and Shot each add one mulligan; plain drinks don't", () => {
    const f = live();
    f.teeOff("B", 1);
    let s = f.state;
    rejected(s, mulliganOp(f, "B", "earned"), "conflict");
    s = ok(s, drinkOp(f, "B", "B1", 1, { drink_type: "drink" })).state;
    rejected(s, mulliganOp(f, "B", "earned"), "conflict");
    s = ok(s, drinkOp(f, "B", "B2", 1, { drink_type: "shotgun" })).state;
    s = ok(s, drinkOp(f, "B", "B3", 1, { drink_type: "shot" })).state;
    s = ok(s, mulliganOp(f, "B", "earned", 1)).state;
    s = ok(s, mulliganOp(f, "B", "earned", 2)).state;
    rejected(s, mulliganOp(f, "B", "earned", 3), "conflict");
    // Mulligans never touch score math rows.
    expect(s.hole_scores).toBe(f.state.hole_scores);
  });

  it("the groom's mulligan is once per round, groom's team only", () => {
    const f = live([4, 3, 3], { groom: "C2" });
    rejected(f.state, mulliganOp(f, "A", "groom"), "conflict");
    const s = ok(f.state, mulliganOp(f, "C", "groom")).state;
    rejected(s, mulliganOp(f, "C", "groom"), "conflict");
  });
});

// ---------------------------------------------------------------------------
// applyOps, immutability, determinism
// ---------------------------------------------------------------------------

describe("applyOps", () => {
  it("applies in order, skipping rejected ops, with per-op results", () => {
    const f = live();
    const ops: Op[] = [
      drinkOp(f, "A", "A1", 1), // client: no window yet -> rejected
      mk("tee.open", { team_id: f.team.A, hole: 1 }),
      drinkOp(f, "A", "A1", 1),
      mk("score.set", { team_id: f.team.A, hole: 1, strokes: 0 }), // invalid
      mk("score.set", { team_id: f.team.A, hole: 1, strokes: 4 }),
    ];
    const { state, results } = applyOps(deepFreeze(f.state), ops, client());
    expect(results.map((r) => [r.id, r.ok, r.code])).toEqual([
      [ops[0].id, false, "no_window"],
      [ops[1].id, true, undefined],
      [ops[2].id, true, undefined],
      [ops[3].id, false, "invalid"],
      [ops[4].id, true, undefined],
    ]);
    expect(results[0].reason).toBeTruthy();
    expect(state.drinks).toHaveLength(1);
    expect(scoreOf(state, f.team.A, 1)!.strokes).toBe(4);
    expect(openWindowHole(rsOf(state, f.team.A))).toBe(1);
  });

  it("returns the same state for an empty or all-rejected batch", () => {
    const f = live();
    expect(applyOps(f.state, [], server()).state).toBe(f.state);
    expect(applyOps(f.state, [mk("score.set", { team_id: "x", hole: 1, strokes: 4 })], server()).state).toBe(f.state);
  });
});

describe("purity", () => {
  it("a full round of mixed ops never mutates any input and is deterministic", () => {
    const f = live();
    const A = f.team.A;
    const B = f.team.B;
    const ops: Op[] = [];
    for (let hole = 1; hole <= 18; hole++) {
      ops.push(mk("tee.open", { team_id: A, hole }));
      ops.push(mk("score.set", { team_id: B, hole, strokes: 4 })); // B opens holes implicitly
      ops.push(drinkOp(f, "A", `A${(hole % 4) + 1}`, hole, { drink_type: hole % 6 === 0 ? "shotgun" : "drink" }));
      ops.push(mk("teeshot.set", { team_id: A, hole, player_id: f.player[`A${(hole % 4) + 1}`] }));
      ops.push(mk("score.set", { team_id: A, hole, strokes: 3 + (hole % 3) }));
      if (hole === 6) ops.push(mulliganOp(f, "A", "earned", 6));
      if (hole === 7) ops.push(mulliganOp(f, "A", "groom", 7));
      if (hole === 3) ops.push(submit(f, "A2", 3, "ctp", 14.5));
      if (hole === 4) ops.push(submit(f, "B1", 4, "ld", 301));
    }
    ops.push(mk("round.complete", { team_id: A }), mk("post.create", { event_id: "post-end", text: "GG", photo_path: null, by: f.player.A1 }));

    const snapshot = JSON.stringify(f.state);
    const run1 = applyOps(deepFreeze(f.state), ops, client());
    const run2 = applyOps(f.state, ops, client());
    expect(JSON.stringify(f.state)).toBe(snapshot);
    expect(run1.results.every((r) => r.ok)).toBe(true);
    expect(run2.state).toEqual(run1.state);
    expect(run1.state.hole_scores).toHaveLength(36);
    expect(run1.state.drinks).toHaveLength(18);
    expect(rsOf(run1.state, A)).toMatchObject({ status: "complete", open_hole: 18 });
    expect(rsOf(run1.state, B)).toMatchObject({ status: "playing", open_hole: 18 });
    expect(rsOf(run1.state, B)!.started_holes).toHaveLength(18);
    // Untouched table keeps identity through the whole batch.
    expect(run1.state.pot_optouts).toBe(f.state.pot_optouts);
    expect(run1.state.reactions).toBe(f.state.reactions);
  });
});

describe("coverage", () => {
  it("every op type was exercised with a successful, writing application", () => {
    expect(ALL_OP_TYPES.filter((t) => !exercised.has(t))).toEqual([]);
  });
});
