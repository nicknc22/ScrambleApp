import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyOp } from "@/lib/reducer";
import type { Op, OpType } from "@/lib/ops";
import { deriveId } from "@/lib/ids";
import { derive } from "@/lib/engine";
import type { FeedEvent, FeedEventType, TripState } from "@/lib/types";
import {
  deriveFeedEvents,
  DRINK_BATCH_WINDOW_MS,
  pushTriggerFor,
  roastTriggerFor,
  type DeriveEventsResult,
  type OpStep,
} from "@/lib/events/derive";
import { renderFeedEvent } from "@/lib/events/templates";
import { at, makeTrip, type TripFixture } from "../fixtures";

// ---------------------------------------------------------------------------
// Harness: run ops through the real reducer like the server does, derive events, persist them.
// ---------------------------------------------------------------------------

const SERVER0 = Date.parse("2026-10-24T17:00:00.000Z");
/** Server time `sec` seconds into the round. */
const srv = (sec: number) => new Date(SERVER0 + sec * 1000).toISOString();

type OpOf<T extends OpType> = Extract<Op, { type: T }>;
type Fields<T extends OpType> = Omit<OpOf<T>, "type" | "id" | "at" | "by"> & {
  id?: string;
  at?: string;
  by?: string | null;
  as_commissioner?: boolean;
};

let opSeq = 0;
let clientMin = 0;
function mk<T extends OpType>(type: T, fields: Fields<T>): OpOf<T> {
  opSeq++;
  return { id: `op-${String(opSeq).padStart(5, "0")}`, at: at(++clientMin), by: null, ...fields, type } as OpOf<T>;
}

let drinkSeq = 0;
const tee = (team: string, hole: number, x: Partial<Fields<"tee.open">> = {}) => mk("tee.open", { team_id: team, hole, ...x });
const score = (team: string, hole: number, strokes: number, x: Partial<Fields<"score.set">> = {}) =>
  mk("score.set", { team_id: team, hole, strokes, ...x });
const teeshot = (team: string, hole: number, player: string | null) => mk("teeshot.set", { team_id: team, hole, player_id: player });
const drink = (team: string, player: string, hole: number, type: "drink" | "shotgun" | "shot" = "drink", x: Partial<Fields<"drink.log">> = {}) =>
  mk("drink.log", { drink_id: `drink-${++drinkSeq}`, team_id: team, player_id: player, hole, drink_type: type, photo_path: null, by: player, ...x });
const ctp = (player: string, hole: number, ft: number, x: Partial<Fields<"contest.submit">> = {}) =>
  mk("contest.submit", {
    entry_id: `entry-${++drinkSeq}`,
    hole,
    player_id: player,
    contest_type: "ctp",
    distance_value: ft,
    angle_deg: 90,
    lat: null,
    lng: null,
    gps_accuracy_m: null,
    low_accuracy: false,
    photo_path: `trips/t/contest/${drinkSeq}.jpg`,
    by: player,
    ...x,
  });
const ld = (player: string, hole: number, yd: number, x: Partial<Fields<"contest.submit">> = {}) =>
  ctp(player, hole, yd, { contest_type: "ld", ...x });

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

class Sim {
  state: TripState;
  nowSec = 0;
  constructor(readonly f: TripFixture) {
    this.state = f.state;
  }

  /** Apply ops (server side), derive events from the applied steps, upsert them into the feed. */
  run(ops: Op[], o: { now?: number; commish?: boolean } = {}): DeriveEventsResult {
    const nowSec = o.now ?? this.nowSec + 600;
    this.nowSec = Math.max(this.nowSec, nowSec);
    const now = srv(nowSec);
    const is_commissioner = o.commish ?? false;
    const steps: OpStep[] = [];
    let s = this.state;
    for (const op of ops) {
      const r = applyOp(s, op, { now, is_commissioner, side: "server" });
      if (!r.ok) throw new Error(`${op.type} rejected: ${r.code} ${r.reason}`);
      steps.push({ op, before: s, after: r.state, is_commissioner });
      s = r.state;
    }
    // derive must not mutate its inputs.
    deepFreeze(steps);
    const existingFeed = deepFreeze(this.state.feed_events);
    const res = deriveFeedEvents({ steps, existingFeed, now });
    const rows = new Map(s.feed_events.map((e) => [e.id, e]));
    for (const ev of res.feed) rows.set(ev.id, ev);
    this.state = { ...s, feed_events: [...rows.values()] };
    return res;
  }

  active(type?: FeedEventType): FeedEvent[] {
    return this.state.feed_events.filter((e) => e.deleted_at === null && (!type || e.type === type));
  }

  render(ev: FeedEvent) {
    return renderFeedEvent(ev, this.state, derive(this.state));
  }
}

const types = (r: DeriveEventsResult) => r.feed.map((e) => e.type);
const ofType = (r: DeriveEventsResult, t: FeedEventType) => r.feed.filter((e) => e.type === t);
const one = (r: DeriveEventsResult, t: FeedEventType) => {
  const evs = ofType(r, t);
  expect(evs, `exactly one ${t} in ${JSON.stringify(types(r))}`).toHaveLength(1);
  return evs[0];
};

const FEED_KEYS = ["id", "trip_id", "type", "team_id", "player_id", "actor_id", "payload", "photo_path", "text", "dedupe_key", "created_at", "updated_at", "deleted_at"];
function expectCompleteRow(ev: FeedEvent, tripId: string) {
  expect(Object.keys(ev).sort()).toEqual([...FEED_KEYS].sort());
  for (const [k, v] of Object.entries(ev)) expect(v, `${k} must not be undefined`).not.toBeUndefined();
  expect(ev.trip_id).toBe(tripId);
  expect(ev.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
}

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorSpy = vi.spyOn(console, "error");
});
afterEach(() => {
  // derive swallows errors so a batch always commits; in tests nothing may fail silently.
  expect(errorSpy).not.toHaveBeenCalled();
  errorSpy.mockRestore();
});

function live(teams: number[] = [4, 3, 3]) {
  const f = makeTrip({ teams });
  return { f, sim: new Sim(f), A: f.team.A, B: f.team.B, C: f.team.C, p: f.player, tripId: f.state.trip.id };
}

// ---------------------------------------------------------------------------
// Basics
// ---------------------------------------------------------------------------

describe("deriveFeedEvents basics", () => {
  it("returns nothing for an empty batch", () => {
    const { f } = live();
    expect(deriveFeedEvents({ steps: [], existingFeed: f.state.feed_events, now: srv(0) })).toEqual({
      feed: [],
      roast_triggers: [],
      push_triggers: [],
    });
  });

  it("emits complete rows stamped with server time", () => {
    const { sim, A, p, tripId } = live();
    const r = sim.run([tee(A, 1, { by: p.A1 }), score(A, 1, 3, { by: p.A1 }), drink(A, p.A2, 1, "shotgun")], { now: 42 });
    expect(r.feed.length).toBeGreaterThan(2);
    for (const ev of r.feed) {
      expectCompleteRow(ev, tripId);
      expect(ev.created_at).toBe(srv(42));
      expect(ev.updated_at).toBe(srv(42));
      expect(ev.deleted_at).toBeNull();
      expect(ev.text).toBeNull();
    }
    expect(new Set(r.feed.map((e) => e.id)).size).toBe(r.feed.length);
  });

  it("posts nothing for ops that change nothing", () => {
    const { sim, A, p } = live();
    sim.run([tee(A, 1), score(A, 1, 4, { by: p.A1 })]);
    // Re-opening an opened hole, an identical idempotent drink id, a reaction: no feed events.
    const d = drink(A, p.A1, 1);
    sim.run([d]);
    const r = sim.run([tee(A, 1), { ...d, id: "op-resend" }]);
    expect(r.feed).toEqual([]);
  });

  it("is idempotent: deriving the same steps again with the output as existing feed adds nothing", () => {
    const { f, A, B, p } = live();
    const ops: Op[] = [
      tee(A, 1),
      tee(B, 1),
      drink(A, p.A1, 1),
      drink(A, p.A2, 1),
      drink(B, p.B1, 1),
      drink(B, p.B2, 1),
      drink(B, p.B3, 1, "shotgun"),
      score(A, 1, 3),
      score(B, 1, 6),
      score(A, 1, 4),
      ctp(p.A1, 3, 10),
    ];
    let s = f.state;
    const steps: OpStep[] = [];
    for (const op of ops) {
      const r = applyOp(s, op, { now: srv(1), is_commissioner: false, side: "server" });
      if (!r.ok) throw new Error(r.reason);
      steps.push({ op, before: s, after: r.state, is_commissioner: false });
      s = r.state;
    }
    const first = deriveFeedEvents({ steps, existingFeed: f.state.feed_events, now: srv(1) });
    expect(first.feed.length).toBeGreaterThan(5);
    const again = deriveFeedEvents({ steps, existingFeed: [...f.state.feed_events, ...first.feed], now: srv(2) });
    expect(again.feed).toEqual([]);
    expect(again.push_triggers).toEqual([]);
    expect(again.roast_triggers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tee off, round started, round complete, final results
// ---------------------------------------------------------------------------

describe("tee_off", () => {
  it("posts once when a team opens hole 1 for the first time", () => {
    const { sim, A, p, tripId } = live();
    const r = sim.run([tee(A, 1, { by: p.A2 })]);
    expect(types(r)).toEqual(["tee_off"]);
    const ev = r.feed[0];
    expect(ev.team_id).toBe(A);
    expect(ev.actor_id).toBe(p.A2);
    expect(ev.dedupe_key).toBe(`teeoff:${A}`);
    expect(ev.id).toBe(deriveId(tripId, `teeoff:${A}`));
    expect(ev.payload).toEqual({ hole: 1 });
    // Repeat taps and later holes post nothing.
    expect(types(sim.run([tee(A, 1), tee(A, 2), tee(A, 3)]))).toEqual([]);
  });

  it("fires when entering a hole-1 score opens the window implicitly", () => {
    const { sim, B } = live();
    const r = sim.run([score(B, 1, 4)]);
    expect(one(r, "tee_off").team_id).toBe(B);
  });

  it("each team gets its own, and a commissioner reset does not re-post it", () => {
    const { sim, A, B } = live();
    expect(types(sim.run([tee(A, 1), tee(B, 1)]))).toEqual(["tee_off", "tee_off"]);
    sim.run([mk("round.set_state", { team_id: A, open_hole: null, status: "not_started" })], { commish: true });
    const r = sim.run([tee(A, 1)]);
    expect(ofType(r, "tee_off")).toEqual([]);
  });

  it("does not fire when a team's round state is created without a hole", () => {
    const { sim, A } = live();
    const r = sim.run([mk("round.complete", { team_id: A })]);
    expect(ofType(r, "tee_off")).toEqual([]);
  });
});

describe("round_started / final_results", () => {
  it("trip.start posts round_started (no commissioner override: setup isn't live)", () => {
    const f = makeTrip({ teams: [4, 3, 3], status: "setup" });
    const sim = new Sim(f);
    expect(sim.run([mk("team.upsert", { team: { id: f.team.A, name: "Sandbaggers" } })], { commish: true }).feed).toEqual([]);
    const r = sim.run([mk("trip.start", {})], { commish: true });
    expect(types(r)).toEqual(["round_started"]);
    expect(r.feed[0].payload).toEqual({ team_count: 3, player_count: 10 });
    expect(r.feed[0].dedupe_key).toBe("round_started");
    // Already live: harmless double tap, nothing new.
    expect(sim.run([mk("trip.start", {})], { commish: true }).feed).toEqual([]);
  });

  it("trip.finalize posts final_results with a standings snapshot and champions, pushes to all", () => {
    const { sim, A, B, C, p } = live();
    sim.run([score(A, 1, 3), score(B, 1, 5), score(C, 1, 4)]);
    const r = sim.run([mk("trip.finalize", {})], { now: 9000, commish: true });
    expect(types(r)).toEqual(["final_results"]);
    const ev = r.feed[0];
    expect(ev.dedupe_key).toBe(`final:${srv(9000)}`);
    expect(ev.team_id).toBe(A);
    expect(ev.payload.champion_team_ids).toEqual([A]);
    expect(ev.payload.champion_player_ids).toEqual([p.A1, p.A2, p.A3, p.A4]);
    const standings = ev.payload.standings as { team_id: string; pos_label: string; net_to_par: number }[];
    expect(standings.map((s) => s.team_id)).toEqual([A, C, B]);
    expect(standings[0]).toMatchObject({ pos_label: "1", net_to_par: -1 });
    expect(r.push_triggers).toEqual([
      expect.objectContaining({ feed_event_id: ev.id, audience: { kind: "all" }, collapse_key: "final" }),
    ]);
    expect(r.push_triggers[0].title).toContain("FINAL RESULTS");

    // Reopen is a visible commissioner override; finalizing again posts fresh results.
    const reopen = sim.run([mk("trip.reopen", {})], { now: 9100, commish: true });
    expect(types(reopen)).toEqual(["commissioner_override"]);
    expect(reopen.feed[0].payload).toEqual({ op_type: "trip.reopen", summary: "reopened the round" });
    const again = sim.run([mk("trip.finalize", {})], { now: 9200, commish: true });
    expect(one(again, "final_results").dedupe_key).toBe(`final:${srv(9200)}`);
  });
});

describe("round_complete", () => {
  it("posts once per team with final numbers; last place gets a big roast", () => {
    const { sim, A, B, p } = live();
    sim.run([tee(A, 1), tee(B, 1), score(A, 1, 3), score(B, 1, 6), drink(B, p.B1, 1)]);
    const r = sim.run([mk("round.complete", { team_id: B, by: p.B2 })]);
    const ev = one(r, "round_complete");
    expect(ev.team_id).toBe(B);
    expect(ev.actor_id).toBe(p.B2);
    expect(ev.dedupe_key).toBe(`complete:${B}`);
    expect(ev.payload).toEqual({
      gross: 6,
      net: 5,
      net_to_par: 1,
      gross_to_par: 2,
      pos_label: "2",
      thru: 1,
      drinks: 1,
      ghost_beers: 0,
      last: true,
    });
    const completeRoasts = (r: DeriveEventsResult) => r.roast_triggers.filter((t) => t.type === "round_complete");
    expect(completeRoasts(r)).toEqual([{ feed_event_id: ev.id, type: "round_complete", team_id: B, hole: null, big: true }]);
    // No tee shots were recorded, so both nines close with everyone at zero drives.
    expect(ofType(r, "drive_miss").map((e) => e.payload.nine)).toEqual([1, 2]);

    const ra = sim.run([mk("round.complete", { team_id: A })]);
    expect(one(ra, "round_complete").payload.last).toBe(false);
    expect(completeRoasts(ra)).toEqual([]);
    // Already complete: nothing.
    expect(sim.run([mk("round.complete", { team_id: A })]).feed).toEqual([]);
  });

  it("a lone finisher (or everyone tied) is not last", () => {
    const { sim, A, B } = live();
    sim.run([score(A, 1, 4), score(B, 1, 4)]);
    const r = sim.run([mk("round.complete", { team_id: A })]);
    expect(one(r, "round_complete").payload.last).toBe(false);
    expect(r.roast_triggers.filter((t) => t.type === "round_complete")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Scores
// ---------------------------------------------------------------------------

describe("score_edit", () => {
  it("posts every effective change of an existing score, attributed to op.by", () => {
    const { sim, A, p } = live();
    const first = sim.run([tee(A, 1), score(A, 1, 5, { by: p.A1 })]);
    expect(ofType(first, "score_edit")).toEqual([]);

    const op = score(A, 1, 4, { by: p.A3 });
    const r = sim.run([op]);
    const ev = one(r, "score_edit");
    expect(ev.payload).toEqual({ hole: 1, from: 5, to: 4, par: 4, edit_count: 1 });
    expect(ev.actor_id).toBe(p.A3);
    expect(ev.team_id).toBe(A);
    expect(ev.dedupe_key).toBeNull();
    expect(ev.id).toBe(deriveId(op.id, "score_edit", A, "1"));
    expect(sim.render(ev).body).toContain("changed hole 1 from a 5 to a 4");

    // Not deduped: changing it back posts again.
    expect(one(sim.run([score(A, 1, 5, { by: p.A1 })]), "score_edit").payload).toMatchObject({ from: 4, to: 5, edit_count: 2 });
  });

  it("does not post for the same value, a first score, or a stale offline edit (LWW)", () => {
    const { sim, A } = live();
    sim.run([score(A, 1, 5)]);
    expect(ofType(sim.run([score(A, 1, 5)]), "score_edit")).toEqual([]);
    expect(ofType(sim.run([score(A, 2, 5)]), "score_edit")).toEqual([]);
    expect(sim.run([score(A, 1, 3, { at: at(-500) })]).feed).toEqual([]);
  });

  it("two edits in one batch post two edits", () => {
    const { sim, A } = live();
    sim.run([score(A, 1, 5)]);
    const r = sim.run([score(A, 1, 6), score(A, 1, 4)]);
    expect(ofType(r, "score_edit").map((e) => [e.payload.from, e.payload.to])).toEqual([
      [5, 6],
      [6, 4],
    ]);
  });
});

describe("score_notable (gross)", () => {
  // Jack Frost: hole 1 par 4, hole 3 par 3, hole 4 par 5.
  const cases: [number, number, string | null, boolean][] = [
    [1, 3, "birdie", false],
    [1, 2, "eagle", false],
    [1, 1, "albatross", true],
    [4, 2, "albatross", false],
    [4, 3, "eagle", false],
    [3, 1, "eagle", true],
    [1, 4, null, false],
    [1, 5, null, false],
    [1, 6, "double", false],
    [1, 7, "triple_plus", false],
    [3, 9, "triple_plus", false],
  ];
  it.each(cases)("hole %i in %i strokes -> %s", (hole, strokes, kind, ace) => {
    const { sim, A, p } = live();
    const r = sim.run([score(A, hole, strokes, { by: p.A1 })]);
    const notable = ofType(r, "score_notable").filter((e) => e.payload.kind !== "net_zero");
    if (kind === null) {
      expect(notable).toEqual([]);
      return;
    }
    expect(notable).toHaveLength(1);
    const ev = notable[0];
    expect(ev.payload).toMatchObject({ kind, hole, strokes, ace, to_par: strokes - (hole === 3 ? 3 : hole === 4 ? 5 : 4) });
    expect(ev.dedupe_key).toBe(`notable:${A}:${hole}:${kind}`);
    expect(ev.actor_id).toBe(p.A1);
    const roast = r.roast_triggers.filter((t) => t.feed_event_id === ev.id);
    if (kind === "double" || kind === "triple_plus") {
      expect(roast).toEqual([{ feed_event_id: ev.id, type: "score_notable", team_id: A, hole, big: false }]);
    } else {
      expect(roast).toEqual([]);
    }
  });

  it("an edit that makes a hole newly notable posts; going back and forth does not repeat", () => {
    const { sim, A } = live();
    sim.run([score(A, 1, 4)]);
    expect(ofType(sim.run([score(A, 1, 6)]), "score_notable").map((e) => e.payload.kind)).toEqual(["double"]);
    expect(ofType(sim.run([score(A, 1, 4)]), "score_notable")).toEqual([]);
    expect(ofType(sim.run([score(A, 1, 6)]), "score_notable")).toEqual([]);
    expect(ofType(sim.run([score(A, 1, 7)]), "score_notable").map((e) => e.payload.kind)).toEqual(["triple_plus"]);
    expect(ofType(sim.run([score(A, 1, 3)]), "score_notable").map((e) => e.payload.kind)).toEqual(["birdie"]);
  });
});

describe("score_notable net_zero", () => {
  it("fires when drinks after the score take the hole net to 0, once", () => {
    const { sim, A, p } = live();
    sim.run([tee(A, 1), drink(A, p.A1, 1), drink(A, p.A2, 1), drink(A, p.A3, 1), score(A, 1, 4)]);
    expect(sim.active("score_notable")).toEqual([]); // net 1
    const r = sim.run([drink(A, p.A4, 1)]);
    const ev = one(r, "score_notable");
    expect(ev.payload).toMatchObject({ kind: "net_zero", hole: 1, strokes: 4, credit: 4, net: 0 });
    expect(ev.dedupe_key).toBe(`netzero:${A}:1`);
    expect(ev.actor_id).toBe(p.A4);
    expect(r.roast_triggers).toEqual([]);
    // Deeper below zero, or bouncing back above and below, never repeats.
    expect(ofType(sim.run([drink(A, p.A1, 1)]), "score_notable")).toEqual([]);
    expect(ofType(sim.run([score(A, 1, 9), score(A, 1, 4)]), "score_notable").map((e) => e.payload.kind)).toEqual(["triple_plus"]);
  });

  it("fires when the score lands on a hole that already has the credit; a threesome's ghost beer counts double", () => {
    const { sim, B, p } = live();
    sim.run([tee(B, 1), drink(B, p.B1, 1), drink(B, p.B2, 1), drink(B, p.B3, 1)]); // 1 + 1 + 2
    const r = sim.run([score(B, 1, 4)]);
    expect(one(r, "score_notable").payload).toMatchObject({ kind: "net_zero", credit: 4, net: 0 });
  });

  it("does not fire for unscored holes, however many drinks", () => {
    const { sim, A, p } = live();
    const r = sim.run([tee(A, 1), ...[1, 2, 3, 4, 5, 6].map(() => drink(A, p.A1, 1))]);
    expect(ofType(r, "score_notable")).toEqual([]);
  });
});

describe("last place at the turn", () => {
  it("a team that finishes hole 9 in last place gets a turn callout and a roast", () => {
    const { sim, A, B } = live();
    const front = [4, 4, 3, 5, 4, 4, 4, 3, 5];
    sim.run(front.map((par, i) => score(A, i + 1, par)));
    sim.run(front.slice(0, 8).map((par, i) => score(B, i + 1, par + 1)));
    const r = sim.run([score(B, 9, 5)]);
    const ev = ofType(r, "score_notable").find((e) => e.payload.kind === "last_at_turn")!;
    expect(ev).toBeDefined();
    expect(ev.team_id).toBe(B);
    expect(ev.dedupe_key).toBe(`turn:${B}`);
    expect(ev.payload).toMatchObject({ hole: 9, pos_label: "2", net_to_par: 8 });
    expect(r.roast_triggers).toContainEqual({ feed_event_id: ev.id, type: "score_notable", team_id: B, hole: 9, big: false });
    // Editing hole 9 later doesn't repeat it.
    expect(ofType(sim.run([score(B, 9, 6)]), "score_notable").filter((e) => e.payload.kind === "last_at_turn")).toEqual([]);
  });

  it("the leader finishing hole 9 gets nothing", () => {
    const { sim, A, B } = live();
    sim.run([1, 2, 3, 4, 5, 6, 7, 8, 9].map((h) => score(B, h, 6)));
    const r = sim.run([1, 2, 3, 4, 5, 6, 7, 8, 9].map((h) => score(A, h, 4)));
    expect(ofType(r, "score_notable").filter((e) => e.payload.kind === "last_at_turn")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Drinks
// ---------------------------------------------------------------------------

describe("drinks batching", () => {
  it("batches plain drinks per team and hole within 60 s of the batch post", () => {
    const { sim, A, p } = live();
    sim.run([tee(A, 1)], { now: 0 });
    const d1 = drink(A, p.A1, 1);
    const r1 = sim.run([d1], { now: 100 });
    const ev1 = one(r1, "drinks");
    expect(ev1.id).toBe(deriveId(d1.id, "drinks", d1.drink_id));
    expect(ev1.payload).toEqual({ hole: 1, drink_ids: [d1.drink_id], player_ids: [p.A1], logged_by_ids: [p.A1], count: 1 });
    expect(ev1.team_id).toBe(A);

    const d2 = drink(A, p.A2, 1, "drink", { by: p.A1 });
    const r2 = sim.run([d2], { now: 130 });
    expect(r2.feed).toHaveLength(1);
    const ev2 = r2.feed[0];
    expect(ev2.id).toBe(ev1.id);
    expect(ev2.created_at).toBe(srv(100));
    expect(ev2.updated_at).toBe(srv(130));
    expect(ev2.payload).toEqual({
      hole: 1,
      drink_ids: [d1.drink_id, d2.drink_id],
      player_ids: [p.A1, p.A2],
      logged_by_ids: [p.A1, p.A1],
      count: 2,
    });

    // Exactly 60 s after the batch was created still joins.
    const r3 = sim.run([drink(A, p.A2, 1)], { now: 100 + DRINK_BATCH_WINDOW_MS / 1000 });
    expect(r3.feed.map((e) => e.id)).toEqual([ev1.id]);
    expect(r3.feed[0].payload.count).toBe(3);
    expect(sim.render(r3.feed[0]).body).toContain("3 drinks on hole 1");

    // 61 s: a new post.
    const r4 = sim.run([drink(A, p.A3, 1)], { now: 161 });
    const ev4 = one(r4, "drinks");
    expect(ev4.id).not.toBe(ev1.id);
    expect(ev4.payload.count).toBe(1);
    expect(sim.active("drinks")).toHaveLength(2);
  });

  it("a different hole or team starts its own post even inside the window", () => {
    const { sim, A, B, p } = live();
    sim.run([tee(A, 1), tee(B, 1)], { now: 0 });
    sim.run([drink(A, p.A1, 1)], { now: 10 });
    const r = sim.run([tee(A, 2), drink(A, p.A1, 2), drink(B, p.B1, 1)], { now: 20 });
    const posts = ofType(r, "drinks");
    expect(posts.map((e) => [e.team_id, e.payload.hole, e.payload.count])).toEqual([
      [A, 2, 1],
      [B, 1, 1],
    ]);
  });

  it("several drinks in one sync batch become one post", () => {
    const { sim, A, p } = live();
    const r = sim.run([tee(A, 1), drink(A, p.A1, 1), drink(A, p.A2, 1), drink(A, p.A1, 1)], { now: 5 });
    const ev = one(r, "drinks");
    expect(ev.payload.count).toBe(3);
    expect(ev.payload.player_ids).toEqual([p.A1, p.A2, p.A1]);
    expect(sim.render(ev).body).toContain("3 drinks on hole 1");
    expect(sim.render(ev).body).toContain("Player A1 👑 ×2");
  });

  it("photos ride on the post; a batch never holds two photos", () => {
    const { sim, A, p } = live();
    sim.run([tee(A, 1)], { now: 0 });
    const r1 = sim.run([drink(A, p.A1, 1, "drink", { photo_path: "trips/t/drinks/1.jpg" })], { now: 10 });
    expect(one(r1, "drinks").photo_path).toBe("trips/t/drinks/1.jpg");
    const r2 = sim.run([drink(A, p.A2, 1)], { now: 20 });
    expect(r2.feed[0].photo_path).toBe("trips/t/drinks/1.jpg");
    expect(r2.feed[0].payload.count).toBe(2);
    const r3 = sim.run([drink(A, p.A3, 1, "drink", { photo_path: "trips/t/drinks/2.jpg" })], { now: 30 });
    const ev3 = one(r3, "drinks");
    expect(ev3.payload.count).toBe(1);
    expect(ev3.photo_path).toBe("trips/t/drinks/2.jpg");
    expect(sim.active("drinks")).toHaveLength(2);
  });

  it("a deleted batch post is not reused, and a delete later in the same batch is never undone", () => {
    const { sim, A, p } = live();
    sim.run([tee(A, 1)], { now: 0 });
    const ev = one(sim.run([drink(A, p.A1, 1)], { now: 10 }), "drinks");
    sim.run([mk("feed.delete", { event_id: ev.id })], { now: 15, commish: true });
    const r = sim.run([drink(A, p.A2, 1)], { now: 20 });
    expect(one(r, "drinks").id).not.toBe(ev.id);

    // Join a batch, then the commissioner deletes that post in the same sync: stays deleted.
    const target = one(r, "drinks");
    const r2 = sim.run([drink(A, p.A3, 1), mk("feed.delete", { event_id: target.id })], { now: 25, commish: true });
    const out = r2.feed.find((e) => e.id === target.id)!;
    expect(out.deleted_at).toBe(srv(25));
    expect(out.payload.count).toBe(2);
    expect(sim.active("drinks")).toHaveLength(0);
  });

  it("undoing drinks takes them out of the post; undoing the last one removes the post", () => {
    const { sim, A, p } = live();
    sim.run([tee(A, 1)], { now: 0 });
    const d1 = drink(A, p.A1, 1);
    const d2 = drink(A, p.A2, 1);
    const ev = one(sim.run([d1, d2], { now: 10 }), "drinks");
    const r1 = sim.run([mk("drink.delete", { drink_id: d1.drink_id, by: p.A1 })], { now: 12 });
    expect(r1.feed).toHaveLength(1);
    expect(r1.feed[0]).toMatchObject({ id: ev.id, deleted_at: null, updated_at: srv(12) });
    expect(r1.feed[0].payload).toMatchObject({ drink_ids: [d2.drink_id], player_ids: [p.A2], count: 1 });
    const r2 = sim.run([mk("drink.delete", { drink_id: d2.drink_id, by: p.A2 })], { now: 14 });
    expect(r2.feed[0]).toMatchObject({ id: ev.id, deleted_at: srv(14) });
    expect(sim.active("drinks")).toEqual([]);
  });
});

describe("shotgun / shot", () => {
  it("gets its own post (never batched) that banks a mulligan and shows who logged it", () => {
    const { sim, A, p } = live();
    sim.run([tee(A, 1)], { now: 0 });
    sim.run([drink(A, p.A1, 1)], { now: 5 });
    const op = drink(A, p.A2, 1, "shotgun", { by: p.A3, photo_path: "trips/t/drinks/sg.jpg" });
    const r = sim.run([op], { now: 10 });
    expect(types(r)).toEqual(["shotgun"]);
    const ev = r.feed[0];
    expect(ev.id).toBe(deriveId(op.id, "shotgun", op.drink_id));
    expect(ev.player_id).toBe(p.A2);
    expect(ev.actor_id).toBe(p.A3);
    expect(ev.photo_path).toBe("trips/t/drinks/sg.jpg");
    expect(ev.payload).toEqual({
      drink_id: op.drink_id,
      drink_type: "shotgun",
      hole: 1,
      player_id: p.A2,
      logged_by: p.A3,
      value: 1,
      banked_mulligan: true,
      mulligans_available: 1,
    });
    const body = sim.render(ev).body;
    expect(body).toContain("(logged by Player A3)");
    expect(body.toLowerCase()).toContain("mulligan");

    const shot = one(sim.run([drink(A, p.A1, 1, "shot")], { now: 12 }), "shot");
    expect(shot.payload.mulligans_available).toBe(2);
    expect(sim.render(shot).body).not.toContain("logged by");
    // The plain-drink batch is untouched.
    expect(sim.active("drinks")[0].payload.count).toBe(1);
  });

  it("undoing a shotgun removes its post", () => {
    const { sim, A, p } = live();
    const op = drink(A, p.A1, 1, "shotgun");
    const ev = one(sim.run([tee(A, 1), op]), "shotgun");
    const r = sim.run([mk("drink.delete", { drink_id: op.drink_id, by: p.A1 })], { now: 5000 });
    expect(r.feed).toEqual([expect.objectContaining({ id: ev.id, deleted_at: srv(5000) })]);
  });
});

describe("ghost_beer", () => {
  it("threesome: the 3rd drink posts a ghost beer and stays out of the batch", () => {
    const { sim, B, p, tripId } = live();
    sim.run([tee(B, 1)], { now: 0 });
    sim.run([drink(B, p.B1, 1)], { now: 10 });
    sim.run([drink(B, p.B2, 1)], { now: 20 });
    const d3 = drink(B, p.B3, 1, "drink", { photo_path: "trips/t/drinks/ghost.jpg" });
    const r = sim.run([d3], { now: 30 });
    expect(types(r)).toEqual(["ghost_beer"]);
    const ev = r.feed[0];
    expect(ev.dedupe_key).toBe(`ghost:${d3.drink_id}`);
    expect(ev.id).toBe(deriveId(tripId, `ghost:${d3.drink_id}`));
    expect(ev.player_id).toBe(p.B3);
    expect(ev.team_id).toBe(B);
    expect(ev.photo_path).toBe("trips/t/drinks/ghost.jpg");
    expect(ev.payload).toEqual({
      drink_id: d3.drink_id,
      drink_type: "drink",
      hole: 1,
      player_id: p.B3,
      logged_by: p.B3,
      value: 2,
      seq: 3,
      team_size: 3,
      base_team_size: 4,
      ghost_count: 1,
    });
    expect(r.roast_triggers).toEqual([{ feed_event_id: ev.id, type: "ghost_beer", team_id: B, hole: 1, big: false }]);
    expect(sim.active("drinks")[0].payload.count).toBe(2);
    expect(sim.render(ev).title).toContain("GHOST BEER");
    expect(sim.render(ev).big).toBe(true);

    // 4th and 5th are plain; the 6th is the next ghost.
    expect(types(sim.run([drink(B, p.B1, 1), drink(B, p.B2, 1)], { now: 40 }))).toEqual(["drinks"]);
    const r6 = sim.run([drink(B, p.B3, 1)], { now: 50 });
    expect(one(r6, "ghost_beer").payload).toMatchObject({ seq: 6, ghost_count: 2 });
  });

  it("all three drinks in one sync: batch of 2 plus a ghost", () => {
    const { sim, B, p } = live();
    const r = sim.run([tee(B, 1), drink(B, p.B1, 1), drink(B, p.B2, 1), drink(B, p.B3, 1)]);
    expect(types(r).sort()).toEqual(["drinks", "ghost_beer", "tee_off"]);
    expect(one(r, "drinks").payload.count).toBe(2);
  });

  it("a shotgun that lands on a ghost slot posts both; the photo stays on the shotgun post", () => {
    const { sim, B, p } = live();
    sim.run([tee(B, 1), drink(B, p.B1, 1), drink(B, p.B2, 1)]);
    const r = sim.run([drink(B, p.B3, 1, "shotgun", { photo_path: "trips/t/drinks/x.jpg" })]);
    expect(types(r)).toEqual(["shotgun", "ghost_beer"]);
    expect(one(r, "shotgun").payload.value).toBe(2);
    expect(one(r, "shotgun").photo_path).toBe("trips/t/drinks/x.jpg");
    expect(one(r, "ghost_beer").photo_path).toBeNull();
    expect(one(r, "ghost_beer").payload.drink_type).toBe("shotgun");
  });

  it("foursomes never ghost; twosomes ghost every drink (and never batch)", () => {
    const four = live([4, 2]);
    four.sim.run([tee(four.A, 1)]);
    const r4 = four.sim.run([1, 2, 3, 4, 5, 6, 7, 8].map((i) => drink(four.A, four.p[`A${(i % 4) + 1}`], 1)));
    expect(ofType(r4, "ghost_beer")).toEqual([]);

    const r2 = four.sim.run([tee(four.B, 1), drink(four.B, four.p.B1, 1), drink(four.B, four.p.B2, 1)]);
    expect(ofType(r2, "ghost_beer")).toHaveLength(2);
    expect(ofType(r2, "drinks")).toEqual([]);
  });

  it("an offline drink synced late with an earlier time credits the drink that became the ghost", () => {
    const { sim, B, p } = live();
    sim.run([tee(B, 1, { at: at(1) })]);
    const d1 = drink(B, p.B1, 1, "drink", { at: at(10) });
    const d2 = drink(B, p.B2, 1, "drink", { at: at(30) });
    sim.run([d1], { now: 600 });
    sim.run([d2], { now: 610 });
    // Logged offline at minute 20, arrives after d2: order d1, d0, d2 -> d2 is now drink #3.
    const d0 = drink(B, p.B3, 1, "drink", { at: at(20) });
    const r = sim.run([d0], { now: 620 });
    const ghost = one(r, "ghost_beer");
    expect(ghost.payload).toMatchObject({ drink_id: d2.drink_id, player_id: p.B2, seq: 3 });
    expect(ghost.player_id).toBe(p.B2);
    // The late drink itself was worth 1 and joins the batch.
    expect(one(r, "drinks").payload.drink_ids).toEqual([d1.drink_id, d2.drink_id, d0.drink_id]);
  });

  it("undoing the ghost removes its post; the next drink in that slot posts a fresh one", () => {
    const { sim, B, p } = live();
    sim.run([tee(B, 1), drink(B, p.B1, 1), drink(B, p.B2, 1)]);
    const d3 = drink(B, p.B1, 1);
    const ghost = one(sim.run([d3]), "ghost_beer");
    const r = sim.run([mk("drink.delete", { drink_id: d3.drink_id, by: p.B1 })], { now: 7000 });
    expect(r.feed).toEqual([expect.objectContaining({ id: ghost.id, deleted_at: srv(7000) })]);
    const d4 = drink(B, p.B3, 1);
    const again = one(sim.run([d4]), "ghost_beer");
    expect(again.payload.drink_id).toBe(d4.drink_id);
    expect(sim.active("ghost_beer")).toHaveLength(1);
  });

  it("deleting an earlier drink retires the ghost post only when the team actually lost a ghost", () => {
    const { sim, B, p } = live();
    const d1 = drink(B, p.B1, 1);
    sim.run([tee(B, 1), d1, drink(B, p.B2, 1), drink(B, p.B3, 1), drink(B, p.B1, 1)]);
    expect(sim.active("ghost_beer")).toHaveLength(1);
    // 4 drinks -> delete #1 -> 3 drinks: still exactly one ghost (it moved to the old #4). Keep the post.
    const r = sim.run([mk("drink.delete", { drink_id: d1.drink_id, by: p.B1 })]);
    expect(ofType(r, "ghost_beer")).toEqual([]);
    expect(sim.active("ghost_beer")).toHaveLength(1);
    // 3 -> 2 drinks: the ghost is gone, so is its post.
    const d2id = sim.state.drinks.find((d) => d.deleted_at === null && d.player_id === p.B2)!.id;
    sim.run([mk("drink.delete", { drink_id: d2id, by: p.B2 })]);
    expect(sim.active("ghost_beer")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Mulligans
// ---------------------------------------------------------------------------

describe("mulligans", () => {
  it("earned mulligan use posts mulligan_used; undo removes it", () => {
    const { sim, A, p } = live();
    sim.run([tee(A, 1), drink(A, p.A2, 1, "shotgun")]);
    const op = mk("mulligan.use", { mulligan_id: "mull-1", team_id: A, hole: 1, source: "earned", by: p.A2 });
    const r = sim.run([op]);
    expect(types(r)).toEqual(["mulligan_used"]);
    const ev = r.feed[0];
    expect(ev.id).toBe(deriveId(op.id, "mulligan_used", "mull-1"));
    expect(ev.payload).toEqual({ mulligan_id: "mull-1", hole: 1, source: "earned", used_by: p.A2, available: 0 });
    expect(r.roast_triggers).toEqual([]);
    expect(r.push_triggers).toEqual([]);
    const undo = sim.run([mk("mulligan.undo", { mulligan_id: "mull-1" })], { now: 8000 });
    expect(undo.feed).toEqual([expect.objectContaining({ id: ev.id, deleted_at: srv(8000) })]);
  });

  it("the Groom's Mulligan gets its own big event, a big roast and a push to everyone", () => {
    const { sim, A, p } = live(); // A1 is the groom
    const r = sim.run([tee(A, 4), mk("mulligan.use", { mulligan_id: "g-1", team_id: A, hole: 4, source: "groom", by: p.A1 })]);
    const ev = one(r, "groom_mulligan");
    expect(ev.player_id).toBe(p.A1);
    expect(ev.payload).toEqual({ mulligan_id: "g-1", hole: 4, source: "groom", used_by: p.A1, groom_id: p.A1 });
    expect(ofType(r, "mulligan_used")).toEqual([]);
    expect(r.roast_triggers).toEqual([{ feed_event_id: ev.id, type: "groom_mulligan", team_id: A, hole: 4, big: true }]);
    expect(r.push_triggers).toEqual([expect.objectContaining({ feed_event_id: ev.id, audience: { kind: "all" }, collapse_key: "groom" })]);
    const rendered = sim.render(ev);
    expect(rendered.big).toBe(true);
    expect(rendered.body).toContain("👑");
  });

  it("a groom mulligan used and undone in the same sync leaves no trigger behind", () => {
    const { sim, A, p } = live();
    const r = sim.run([
      mk("mulligan.use", { mulligan_id: "g-2", team_id: A, hole: 1, source: "groom", by: p.A1 }),
      mk("mulligan.undo", { mulligan_id: "g-2" }),
    ]);
    expect(one(r, "groom_mulligan").deleted_at).not.toBeNull();
    expect(r.roast_triggers).toEqual([]);
    expect(r.push_triggers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Contests
// ---------------------------------------------------------------------------

describe("contest_entry / contest_lead", () => {
  it("entries post with distance, rank and photo; lead changes post once per leader set and push", () => {
    const { sim, A, B, p } = live();
    const e1 = ctp(p.A1, 3, 12);
    const r1 = sim.run([e1]);
    const entry1 = one(r1, "contest_entry");
    expect(entry1.payload).toEqual({
      entry_id: e1.entry_id,
      hole: 3,
      contest_type: "ctp",
      distance: 12,
      unit: "ft",
      rank: 1,
      valid: true,
      status: "ok",
      flag_reason: null,
      invalid_reason: null,
      replaced: false,
      valid_count: 1,
    });
    expect(entry1.photo_path).toBe(e1.photo_path);
    expect(entry1.player_id).toBe(p.A1);
    expect(entry1.team_id).toBe(A);
    const lead1 = one(r1, "contest_lead");
    expect(lead1.dedupe_key).toBe(`ctplead:3:${p.A1}`);
    expect(lead1.payload).toEqual({ hole: 3, contest_type: "ctp", leader_ids: [p.A1], previous_leader_ids: [], distance: 12, unit: "ft" });
    expect(lead1.actor_id).toBe(p.A1);
    expect(r1.push_triggers).toEqual([expect.objectContaining({ feed_event_id: lead1.id, audience: { kind: "all" }, collapse_key: "ctplead:3" })]);

    const r2 = sim.run([ctp(p.B1, 3, 8.5)]);
    expect(one(r2, "contest_entry").payload).toMatchObject({ rank: 1, valid_count: 2 });
    expect(one(r2, "contest_lead").payload).toMatchObject({ leader_ids: [p.B1], previous_leader_ids: [p.A1], distance: 8.5 });
    expect(one(r2, "contest_lead").team_id).toBe(B);

    // A worse entry: entry only.
    const r3 = sim.run([ctp(p.C1, 3, 30)]);
    expect(one(r3, "contest_entry").payload).toMatchObject({ rank: 3 });
    expect(ofType(r3, "contest_lead")).toEqual([]);

    // A tie for the lead is a new leader set.
    const r4 = sim.run([ctp(p.A2, 3, 8.5)]);
    expect(one(r4, "contest_lead").payload.leader_ids).toEqual([p.B1, p.A2]);

    // B1 re-measures worse: leader set goes back to [A2]; replaced flag on the entry.
    const r5 = sim.run([ctp(p.B1, 3, 40)]);
    expect(one(r5, "contest_entry").payload).toMatchObject({ replaced: true, rank: 4 });
    expect(one(r5, "contest_lead").payload.leader_ids).toEqual([p.A2]);
    // ...and back to a leader set that was already announced: deduped.
    const r6 = sim.run([ctp(p.B1, 3, 8.5)]);
    expect(ofType(r6, "contest_lead")).toEqual([]);
  });

  it("flagged long drives post as awaiting review and can't lead until approved", () => {
    const { sim, p } = live();
    const e = ld(p.A2, 4, 450);
    const r = sim.run([e]);
    expect(one(r, "contest_entry").payload).toMatchObject({
      contest_type: "ld",
      distance: 450,
      unit: "yd",
      rank: null,
      valid: false,
      status: "flagged",
      flag_reason: "Out of range: 450 yd",
      invalid_reason: "Needs commissioner review: Out of range: 450 yd",
    });
    expect(ofType(r, "contest_lead")).toEqual([]);
    expect(sim.render(one(r, "contest_entry")).body.toLowerCase()).toContain("commissioner");

    const approve = sim.run([mk("contest.review", { entry_id: e.entry_id, status: "overridden", by: p.A1 })], { commish: true });
    expect(types(approve)).toEqual(["commissioner_override", "contest_lead"]);
    expect(one(approve, "commissioner_override").payload.summary).toBe("approved Player A2's long drive entry on hole 4");
    expect(one(approve, "contest_lead").actor_id).toBe(p.A1);
  });

  it("withdrawing an entry removes its post", () => {
    const { sim, p } = live();
    const e = ctp(p.A1, 8, 15);
    const ev = one(sim.run([e]), "contest_entry");
    const r = sim.run([mk("contest.delete", { entry_id: e.entry_id, by: p.A1 })], { now: 9999 });
    expect(r.feed).toEqual([expect.objectContaining({ id: ev.id, deleted_at: srv(9999) })]);
  });
});

// ---------------------------------------------------------------------------
// Leaderboard lead changes
// ---------------------------------------------------------------------------

describe("lead_change", () => {
  it("posts only when the leader set changes, with a push and a big roast", () => {
    const { sim, A, B, C } = live();
    // Tee-offs with nobody scored: no lead.
    expect(ofType(sim.run([tee(A, 1), tee(B, 1)]), "lead_change")).toEqual([]);

    const r1 = sim.run([score(A, 1, 4)]);
    const l1 = one(r1, "lead_change");
    expect(l1.payload).toEqual({ leader_team_ids: [A], previous_leader_team_ids: [], net_to_par: 0, thru: 1 });
    expect(l1.team_id).toBe(A);
    expect(r1.push_triggers).toEqual([expect.objectContaining({ feed_event_id: l1.id, audience: { kind: "all" }, collapse_key: "lead" })]);
    expect(r1.roast_triggers).toEqual([{ feed_event_id: l1.id, type: "lead_change", team_id: A, hole: null, big: true }]);

    const r2 = sim.run([score(B, 1, 3)]);
    expect(one(r2, "lead_change").payload).toEqual({ leader_team_ids: [B], previous_leader_team_ids: [A], net_to_par: -1, thru: 1 });

    // Still leading: nothing.
    expect(ofType(sim.run([score(B, 2, 4)]), "lead_change")).toEqual([]);
    expect(ofType(sim.run([score(A, 2, 5)]), "lead_change")).toEqual([]);

    // A tie is a change (leaders in leaderboard order: equal net to par, lower net first).
    const r3 = sim.run([score(C, 1, 3)]);
    const l3 = one(r3, "lead_change");
    expect(l3.payload.leader_team_ids).toEqual([C, B]);
    expect(l3.team_id).toBeNull();
    expect(sim.render(l3).title).toBe("TIE FOR THE LEAD");
  });

  it("compares against the latest lead_change post, not the batch start (one post per batch)", () => {
    const { sim, A, B } = live();
    // A leads, then B, then A again, all in one sync: one post, for the final leader.
    const r = sim.run([score(A, 1, 3), score(B, 1, 2), score(A, 2, 2)]);
    const l = one(r, "lead_change");
    expect(l.payload.leader_team_ids).toEqual([A]);
    // A flip back to A in a later batch after B led again posts again.
    expect(one(sim.run([score(B, 2, 2)]), "lead_change").payload.leader_team_ids).toEqual([B]);
    expect(one(sim.run([score(A, 3, 1)]), "lead_change").payload.leader_team_ids).toEqual([A]);
  });

  it("drinks can change the lead", () => {
    const { sim, A, B, p } = live();
    sim.run([tee(A, 1), tee(B, 1), score(A, 1, 4), score(B, 1, 5)]);
    expect(sim.active("lead_change").at(-1)!.payload.leader_team_ids).toEqual([A]);
    const r = sim.run([drink(B, p.B1, 1), drink(B, p.B2, 1)]);
    expect(one(r, "lead_change").payload.leader_team_ids).toEqual([B]);
  });
});

// ---------------------------------------------------------------------------
// Drive minimum
// ---------------------------------------------------------------------------

describe("drive minimum", () => {
  /** Team A (foursome) plays holes 1..n using A1's drive on each. */
  function frontNineWithA1(n: number) {
    const ctx = live();
    const { sim, A, p } = ctx;
    sim.run([tee(A, 1)]);
    for (let h = 1; h <= n; h++) sim.run([teeshot(A, h, p.A1), score(A, h, 4)]);
    return ctx;
  }

  it("hard warnings post per remaining count, impossible once, then the miss is flagged", () => {
    const { sim, A, p } = frontNineWithA1(5);
    expect(sim.active("drive_warning")).toEqual([]);

    // Hole 6 to A1: 3 holes left (7, 8, 9), 3 players need a drive -> hard.
    const r6 = sim.run([teeshot(A, 6, p.A1)]);
    const w6 = one(r6, "drive_warning");
    expect(w6.dedupe_key).toBe(`drivehard:${A}:1:3`);
    expect(w6.payload).toEqual({ nine: 1, level: "hard", remaining: 3, needing: [p.A2, p.A3, p.A4] });
    expect(r6.roast_triggers).toEqual([]);
    expect(sim.render(w6).tone).toBe("alert");

    // Hole 7 to A2: 2 left, 2 need -> hard again (new count).
    const r7 = sim.run([teeshot(A, 7, p.A2)]);
    expect(one(r7, "drive_warning").payload).toEqual({ nine: 1, level: "hard", remaining: 2, needing: [p.A3, p.A4] });

    // Hole 8 to A1 (oops): 1 left, 2 need -> impossible.
    const r8 = sim.run([teeshot(A, 8, p.A1)]);
    expect(one(r8, "drive_warning").payload).toMatchObject({ level: "impossible", remaining: 1 });

    // Hole 9 to A1: the nine closes with A3 and A4 at zero.
    const r9 = sim.run([teeshot(A, 9, p.A1)]);
    expect(ofType(r9, "drive_warning")).toEqual([]);
    const miss = one(r9, "drive_miss");
    expect(miss.dedupe_key).toBe(`drivemiss:${A}:1`);
    expect(miss.payload).toEqual({ nine: 1, missed: [p.A3, p.A4], commissioner_flag: true });
    expect(r9.roast_triggers).toEqual([{ feed_event_id: miss.id, type: "drive_miss", team_id: A, hole: null, big: true }]);

    // Moving on posts nothing more for the front nine.
    const r10 = sim.run([tee(A, 10), score(A, 9, 4)]);
    expect(ofType(r10, "drive_miss")).toEqual([]);
    expect(ofType(r10, "drive_warning")).toEqual([]);
  });

  it("impossible -> still impossible does not repeat", () => {
    const { sim, A, p } = frontNineWithA1(6); // hard at 3 posted
    const r7 = sim.run([teeshot(A, 7, p.A1)]); // 2 left, 3 need
    expect(one(r7, "drive_warning").payload).toMatchObject({ level: "impossible", remaining: 2 });
    expect(ofType(sim.run([teeshot(A, 8, p.A1)]), "drive_warning")).toEqual([]); // 1 left, 3 need
  });

  it("no warnings while a team uses everyone's drive", () => {
    const { sim, A, p } = live();
    sim.run([tee(A, 1)]);
    const shooters = [p.A1, p.A2, p.A3, p.A4, p.A1, p.A2, p.A3, p.A4, p.A1];
    for (let h = 1; h <= 9; h++) {
      const r = sim.run([teeshot(A, h, shooters[h - 1]), score(A, h, 4)]);
      expect(ofType(r, "drive_warning")).toEqual([]);
      expect(ofType(r, "drive_miss")).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Commissioner overrides
// ---------------------------------------------------------------------------

describe("commissioner_override", () => {
  it("setup-phase commissioner ops post nothing", () => {
    const f = makeTrip({ teams: [4, 3, 3], status: "setup" });
    const sim = new Sim(f);
    const r = sim.run(
      [
        mk("team.upsert", { team: { id: f.team.A, name: "Bogey Boys" } }),
        mk("player.upsert", { player: { id: f.player.A2, nickname: "Bombs" } }),
        mk("hole.update", { hole: 1, patch: { par: 5 } }),
        mk("trip.update", { patch: { settings: { drink_cap: 6 } } }),
        mk("pot.optout", { pot_key: "team_match", player_id: f.player.B2, out: true }),
      ],
      { commish: true },
    );
    expect(r.feed).toEqual([]);
  });

  it("live: drink.move says what moved where", () => {
    const { sim, A, p } = live();
    const d = drink(A, p.A2, 6);
    sim.run([tee(A, 6), d]);
    const op = mk("drink.move", { drink_id: d.drink_id, hole: 7, by: p.A1 });
    const r = sim.run([op], { commish: true });
    expect(types(r)).toEqual(["commissioner_override"]);
    const ev = r.feed[0];
    expect(ev.id).toBe(deriveId(op.id, "commissioner_override"));
    expect(ev.actor_id).toBe(p.A1);
    expect(ev.team_id).toBe(A);
    expect(ev.player_id).toBe(p.A2);
    expect(ev.payload.op_type).toBe("drink.move");
    expect(ev.payload.summary).toContain("moved a drink from hole 6 to hole 7");
    expect(sim.render(ev).body).toContain("moved a drink from hole 6 to hole 7");
  });

  it("a commissioner score override replaces the score_edit post; playing normally does not count as an override", () => {
    const { sim, A, B, p } = live();
    sim.run([score(B, 6, 5)]);
    const r = sim.run([score(B, 6, 4, { as_commissioner: true, by: p.A1 })], { commish: true });
    expect(types(r)).toEqual(["commissioner_override"]);
    expect(r.feed[0].payload.summary).toBe("changed Team B hole 6 from a 5 to a 4");
    expect(sim.render(r.feed[0]).body).toContain("changed Team B hole 6 from a 5 to a 4");

    // The commissioner entering his own team's score without override powers: a normal edit.
    sim.run([score(A, 1, 6, { by: p.A1 })], { commish: true });
    const own = sim.run([score(A, 1, 5, { by: p.A1 })], { commish: true });
    expect(types(own)).toEqual(["score_edit"]);
  });

  it("final: commissioner fixes still post; no-op overrides post nothing", () => {
    const { sim, A, p } = live();
    sim.run([score(A, 1, 5)]);
    sim.run([mk("trip.finalize", {})], { commish: true });
    const r = sim.run([score(A, 1, 4, { as_commissioner: true, by: p.A1 })], { commish: true });
    expect(one(r, "commissioner_override").payload.summary).toBe("changed Team A hole 1 from a 5 to a 4");
    expect(sim.run([mk("hole.update", { hole: 1, patch: { par: 4 } })], { commish: true }).feed).toEqual([]);
  });

  it("summarizes settings, reviews, roster and window fixes", () => {
    const { sim, A, B, p } = live();
    const e = ctp(p.B1, 3, 2);
    sim.run([e]);
    const cases: [Op, string][] = [
      [mk("trip.update", { patch: { settings: { drink_cap: 6 } } }), "set the drink cap to 6"],
      [mk("trip.update", { patch: { settings: { roasts_enabled: false } } }), "turned AI roasts off"],
      [mk("contest.review", { entry_id: e.entry_id, status: "flagged" }), "flagged Player B1's closest to pin entry on hole 3"],
      [mk("team.assign", { player_id: p.C3, team_id: B }), "moved Player C3 to Team B"],
      [mk("player.upsert", { player: { id: p.A2, nickname: "Bombs" } }), 'nicknamed Player A2 "Bombs"'],
      [mk("round.set_state", { team_id: A, open_hole: 7, status: "playing" }), "put Team A on hole 7"],
      [mk("hole.update", { hole: 2, patch: { par: 5 } }), "changed hole 2 from a par 4 to a par 5 and made hole 2 a long drive hole"],
      [mk("pot.optout", { pot_key: "team_match", player_id: p.C1, out: true }), "opted Player C1 out of the team match pot"],
    ];
    for (const [op, summary] of cases) {
      const r = sim.run([op], { commish: true });
      expect(ofType(r, "commissioner_override").map((e) => e.payload.summary), op.type).toEqual([summary]);
    }
  });

  it("deleting somebody else's feed item is an override; deleting your own post is not", () => {
    const { sim, A, p } = live();
    const shotgun = one(sim.run([tee(A, 1), drink(A, p.A3, 1, "shotgun")]), "shotgun");
    sim.run([mk("post.create", { event_id: "post-9", text: "Nice shot", photo_path: null, by: p.B1 })]);
    sim.run([mk("post.create", { event_id: "post-10", text: "I am the law", photo_path: null, by: p.A1 })]);
    const r1 = sim.run([mk("feed.delete", { event_id: shotgun.id, by: p.A1 })], { commish: true });
    expect(one(r1, "commissioner_override").payload.summary).toBe("deleted Team A's shotgun post");
    const r2 = sim.run([mk("feed.delete", { event_id: "post-9", by: p.A1 })], { commish: true });
    expect(one(r2, "commissioner_override").payload.summary).toBe("deleted a post by Player B1");
    expect(sim.run([mk("feed.delete", { event_id: "post-10", by: p.A1 })], { commish: true }).feed).toEqual([]);
  });

  it("posts and reactions by the commissioner are never overrides", () => {
    const { sim, p } = live();
    const r = sim.run([mk("post.create", { event_id: "post-1", text: "lol", photo_path: null, by: p.A1, as_commissioner: true })], {
      commish: true,
    });
    expect(r.feed).toEqual([]);
    expect(sim.active("post")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Triggers for events made elsewhere, and failure isolation
// ---------------------------------------------------------------------------

describe("triggers and robustness", () => {
  function judgeRow(tripId: string, team: string, suspicious: boolean): FeedEvent {
    return {
      id: `judge-${suspicious}`,
      trip_id: tripId,
      type: "ai_judge",
      team_id: team,
      player_id: null,
      actor_id: null,
      payload: { entry_id: "entry-x", hole: 3, claimed_ft: 2, estimate_ft: 15, confidence: "high", suspicious, roast: "Sure, Jan." },
      photo_path: null,
      text: null,
      dedupe_key: null,
      created_at: srv(0),
      updated_at: srv(0),
      deleted_at: null,
    };
  }

  it("a suspicious ai_judge row that shows up during the batch gets a roast and a push", () => {
    const { f, A, tripId } = live();
    const before = f.state;
    const after: TripState = { ...before, feed_events: [...before.feed_events, judgeRow(tripId, A, true)] };
    const r = deriveFeedEvents({
      steps: [{ op: mk("reaction.set", { feed_event_id: "x", player_id: f.player.A1, kind: "fire", on: true }), before, after, is_commissioner: false }],
      existingFeed: before.feed_events,
      now: srv(5),
    });
    expect(r.feed).toEqual([]);
    expect(r.roast_triggers).toEqual([{ feed_event_id: "judge-true", type: "ai_judge", team_id: A, hole: 3, big: false }]);
    expect(r.push_triggers).toEqual([expect.objectContaining({ feed_event_id: "judge-true", collapse_key: "judge:entry-x", audience: { kind: "all" } })]);
    expect(r.push_triggers[0].title).toContain("SUSPICIOUS");
  });

  it("exported trigger helpers: not-suspicious judges and deleted rows trigger nothing; roasts push to their team", () => {
    const { f, A, tripId } = live();
    const d = derive(f.state);
    expect(roastTriggerFor(judgeRow(tripId, A, false))).toBeNull();
    expect(pushTriggerFor(judgeRow(tripId, A, false), f.state, d)).toBeNull();
    expect(roastTriggerFor({ ...judgeRow(tripId, A, true), deleted_at: srv(1) })).toBeNull();
    const roast: FeedEvent = { ...judgeRow(tripId, A, false), id: "roast-1", type: "roast", payload: { trigger_event_id: "x" }, text: "Brutal." };
    expect(roastTriggerFor(roast)).toBeNull(); // roasts never trigger roasts
    expect(pushTriggerFor(roast, f.state, d)).toEqual({
      feed_event_id: "roast-1",
      title: "🔥 Roast: Team A",
      body: "Brutal.",
      audience: { kind: "team", team_id: A },
      collapse_key: `roast:${A}`,
    });
  });

  it("a step that blows up is skipped and logged; the rest of the batch still posts", () => {
    errorSpy.mockImplementation(() => undefined);
    const { f, A, p } = live();
    const s0 = f.state;
    const t1 = applyOp(s0, tee(A, 1), { now: srv(1), is_commissioner: false, side: "server" });
    if (!t1.ok) throw new Error(t1.reason);
    const bad = { ...t1.state, hole_scores: null } as unknown as TripState;
    const d = applyOp(t1.state, drink(A, p.A1, 1, "shotgun"), { now: srv(1), is_commissioner: false, side: "server" });
    if (!d.ok) throw new Error(d.reason);
    const r = deriveFeedEvents({
      steps: [
        { op: tee(A, 1), before: s0, after: t1.state, is_commissioner: false },
        { op: score(A, 1, 4), before: t1.state, after: bad, is_commissioner: false },
        { op: drink(A, p.A1, 1, "shotgun"), before: t1.state, after: d.state, is_commissioner: false },
      ],
      existingFeed: [],
      now: srv(1),
    });
    expect(types(r)).toEqual(["tee_off", "shotgun"]);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockClear();
  });
});
