// The authoritative server apply pipeline (src/lib/server/apply.ts) against in-memory PGlite, and
// its concurrency guarantees against a real Postgres 16 when one is available (see postgres.test.ts).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { connectPostgres, createTestDb, type Db, type DbConnection } from "@/lib/server/db";
import { runMigrations } from "@/lib/server/migrate";
import {
  applyOpsToTrip,
  MAX_CLOCK_SKEW_MS,
  MAX_OPS_PER_SYNC,
  sortLikeDb,
  TooManyOpsError,
  type ApplyOpsResult,
} from "@/lib/server/apply";
import { getAppliedOps, loadTripState, TripNotFoundError } from "@/lib/server/repo";
import { createTrip } from "@/lib/server/trips";
import { derive } from "@/lib/engine";
import { newId } from "@/lib/ids";
import type { Op, OpType } from "@/lib/ops";
import type { FeedEvent, FeedEventType, Trip } from "@/lib/types";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const PIN_HASH = "scrypt$c2FsdA$aGFzaA"; // stored only; nobody verifies it here
const SERVER0 = Date.parse("2026-10-24T17:00:00.000Z");
/** Server clock `sec` seconds into the round. */
const srv = (sec: number) => new Date(SERVER0 + sec * 1000);
/** Client timestamp `sec` seconds into the round. */
const cli = (sec: number) => new Date(SERVER0 + sec * 1000).toISOString();

type OpOf<T extends OpType> = Extract<Op, { type: T }>;
type Fields<T extends OpType> = Omit<OpOf<T>, "type" | "id" | "at" | "by"> & {
  id?: string;
  at?: string;
  by?: string | null;
  as_commissioner?: boolean;
};

// Default client times are well in the past (never clamped), one second apart, so every op has a
// distinct time (ghost-beer order is by (logged_at, id)).
let clientSec = -6 * 3600;
function mk<T extends OpType>(type: T, fields: Fields<T>): OpOf<T> {
  return { id: newId(), at: cli(clientSec++), by: null, ...fields, type } as OpOf<T>;
}

interface LiveTrip {
  db: Db;
  trip: Trip;
  /** Team ids by letter. */
  team: Record<string, string>;
  /** Player ids by label "A1", "B3", ... */
  player: Record<string, string>;
}

/** A trip set up entirely through commissioner ops (and started unless start: false). */
async function liveTrip(db: Db, teams: number[], opts: { start?: boolean; groom?: string } = {}): Promise<LiveTrip> {
  const trip = await createTrip(db, { name: "Sync Trip", app_name: "Scramble", pin_hash: PIN_HASH, now: srv(-7200) });
  const team: Record<string, string> = {};
  const player: Record<string, string> = {};
  const ops: Op[] = [];
  teams.forEach((size, ti) => {
    const letter = String.fromCharCode(65 + ti);
    team[letter] = newId();
    ops.push(mk("team.upsert", { team: { id: team[letter], name: `Team ${letter}` } }));
    for (let i = 1; i <= size; i++) {
      const label = `${letter}${i}`;
      player[label] = newId();
      ops.push(mk("player.upsert", { player: { id: player[label], name: `Player ${label}`, is_groom: label === (opts.groom ?? "A1") } }));
      ops.push(mk("team.assign", { player_id: player[label], team_id: team[letter] }));
    }
  });
  if (opts.start !== false) ops.push(mk("trip.start", {}));
  const out = await applyOpsToTrip({ db, trip, ops, isCommissioner: true, now: srv(-3600) });
  expect(out.results.filter((r) => r.status !== "applied")).toEqual([]);
  return { db, trip: out.snapshot.state.trip, team, player };
}

function sync(
  lt: LiveTrip,
  ops: readonly unknown[],
  opts: { now?: number; commish?: boolean } = {},
): Promise<ApplyOpsResult> {
  return applyOpsToTrip({
    db: lt.db,
    trip: lt.trip,
    ops,
    isCommissioner: opts.commish ?? false,
    now: srv(opts.now ?? 0),
  });
}

/** The response snapshot is exactly what a reload from the database gives (rows, values, order). */
async function expectMatchesDb(lt: LiveTrip, out: ApplyOpsResult): Promise<void> {
  expect(out.snapshot.state).toEqual(await loadTripState(lt.db, lt.trip.id));
}

async function count(db: Db, table: string, tripId: string, where = "true"): Promise<number> {
  const [row] = await db.query<{ n: number }>(`select count(*)::int as n from ${table} where trip_id = $1 and ${where}`, [tripId]);
  return row.n;
}

const statuses = (out: ApplyOpsResult) => out.results.map((r) => r.status);
const feedOf = (out: ApplyOpsResult, type: FeedEventType): FeedEvent[] =>
  out.snapshot.state.feed_events.filter((e) => e.type === type && e.deleted_at === null);

const drinkOp = (lt: LiveTrip, teamLetter: string, label: string, hole: number, type: "drink" | "shotgun" | "shot" = "drink", x: Partial<Fields<"drink.log">> = {}) =>
  mk("drink.log", {
    drink_id: newId(),
    team_id: lt.team[teamLetter],
    player_id: lt.player[label],
    hole,
    drink_type: type,
    photo_path: null,
    by: lt.player[label],
    ...x,
  });

let db: DbConnection;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db?.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe("applyOpsToTrip: setup and snapshots", () => {
  it("sets a trip up through commissioner ops; the snapshot equals a database reload", async () => {
    const lt = await liveTrip(db, [4, 3]);
    const state = await loadTripState(db, lt.trip.id);
    expect(state.trip.status).toBe("live");
    expect(state.players).toHaveLength(7);
    expect(state.team_members).toHaveLength(7);
    expect(state.team_round_state).toHaveLength(2);
    // Setup edits are not "overrides"; starting posts the round_started event.
    expect(state.feed_events.map((e) => e.type)).toEqual(["round_started"]);
    // applied_ops has every setup op
    expect(await count(db, "applied_ops", lt.trip.id)).toBe(2 + 7 * 2 + 1);

    const out = await sync(lt, [mk("tee.open", { team_id: lt.team.A, hole: 1 })]);
    await expectMatchesDb(lt, out);
    expect(out.snapshot.meta).toMatchObject({ server_time: expect.stringMatching(/Z$/), realtime: null, ai_enabled: false });
    expect(JSON.stringify(out.snapshot)).not.toContain("scrypt$");
  });

  it("an empty batch just returns the snapshot (no lock, no writes)", async () => {
    const lt = await liveTrip(db, [2, 2]);
    const before = await count(db, "applied_ops", lt.trip.id);
    const out = await sync(lt, []);
    expect(out.results).toEqual([]);
    expect(out.applied).toEqual([]);
    expect(out.events).toEqual({ feed: [], roast_triggers: [], push_triggers: [] });
    await expectMatchesDb(lt, out);
    expect(await count(db, "applied_ops", lt.trip.id)).toBe(before);
  });

  it("throws TripNotFoundError for a missing trip and TooManyOpsError past the limit", async () => {
    const ghost = { id: newId() };
    await expect(applyOpsToTrip({ db, trip: ghost, ops: [mk("trip.start", {})], isCommissioner: true })).rejects.toBeInstanceOf(TripNotFoundError);
    await expect(applyOpsToTrip({ db, trip: ghost, ops: [], isCommissioner: true })).rejects.toBeInstanceOf(TripNotFoundError);
    const lt = await liveTrip(db, [2, 2]);
    const tooMany = Array.from({ length: MAX_OPS_PER_SYNC + 1 }, () => mk("tee.open", { team_id: lt.team.A, hole: 1 }));
    await expect(sync(lt, tooMany)).rejects.toBeInstanceOf(TooManyOpsError);
    expect(await count(db, "applied_ops", lt.trip.id, "op_type = 'tee.open'")).toBe(0);
  });

  it("handles a full 200-op batch in one request", async () => {
    const lt = await liveTrip(db, [4, 4]);
    const ops: Op[] = [];
    for (let i = 0; i < MAX_OPS_PER_SYNC; i++) {
      const hole = 1 + (i % 18);
      if (i % 4 === 0) ops.push(mk("post.create", { event_id: newId(), text: `post ${i} 🍺`, photo_path: null, by: lt.player.A1 }));
      else if (i % 4 === 1) ops.push(mk("score.set", { team_id: lt.team.B, hole, strokes: 3 + (i % 3), by: lt.player.B1 }));
      else ops.push(drinkOp(lt, i % 2 ? "A" : "B", i % 2 ? `A${1 + (i % 4)}` : `B${1 + (i % 4)}`, hole));
    }
    const t0 = Date.now();
    const out = await sync(lt, ops, { now: 10 });
    const ms = Date.now() - t0;
    expect(statuses(out).every((s) => s === "applied")).toBe(true);
    expect(await count(db, "drinks", lt.trip.id)).toBe(100);
    expect(await count(db, "applied_ops", lt.trip.id, "op_type in ('post.create', 'score.set', 'drink.log')")).toBe(200);
    await expectMatchesDb(lt, out);
    expect(ms).toBeLessThan(20_000);
  });
});

describe("exactly once", () => {
  it("Airplane mode: log 10 mixed actions, reconnect, and every action syncs exactly once", async () => {
    const lt = await liveTrip(db, [4, 3]);
    const { team, player } = lt;
    const A = team.A;
    const postId = newId();
    const firstDrink = drinkOp(lt, "A", "A1", 1);
    // Ten actions taken with no signal, queued in the outbox in this order.
    const offline: Op[] = [
      mk("tee.open", { team_id: A, hole: 1, by: player.A1 }),
      mk("teeshot.set", { team_id: A, hole: 1, player_id: player.A2, by: player.A1 }),
      firstDrink,
      drinkOp(lt, "A", "A2", 1, "shotgun"),
      mk("mulligan.use", { mulligan_id: newId(), team_id: A, hole: 1, source: "earned", by: player.A2 }),
      mk("score.set", { team_id: A, hole: 1, strokes: 4, by: player.A1 }),
      mk("post.create", { event_id: postId, text: "Cart path only? In THIS economy?", photo_path: null, by: player.A3 }),
      mk("reaction.set", { feed_event_id: postId, player_id: player.A4, kind: "lol", on: true, by: player.A4 }),
      mk("contest.submit", {
        entry_id: newId(),
        hole: 3,
        player_id: player.A1,
        contest_type: "ctp",
        distance_value: 12.5,
        angle_deg: 45,
        lat: null,
        lng: null,
        gps_accuracy_m: null,
        low_accuracy: false,
        photo_path: null,
        by: player.A1,
      }),
      drinkOp(lt, "A", "A3", 3, "shot"),
    ];
    const opsBefore = await count(db, "applied_ops", lt.trip.id);

    // Reconnect: the outbox flushes.
    const first = await sync(lt, offline, { now: 100 });
    expect(first.results).toEqual(offline.map((op) => ({ id: op.id, status: "applied" })));
    expect(first.applied.map((o) => o.id)).toEqual(offline.map((o) => o.id));
    await expectMatchesDb(lt, first);
    const counts = async () => ({
      drinks: await count(db, "drinks", lt.trip.id),
      mulligans: await count(db, "mulligans", lt.trip.id),
      scores: await count(db, "hole_scores", lt.trip.id),
      entries: await count(db, "contest_entries", lt.trip.id),
      reactions: await count(db, "reactions", lt.trip.id),
      feed: await count(db, "feed_events", lt.trip.id),
      applied: await count(db, "applied_ops", lt.trip.id),
    });
    const afterFirst = await counts();
    expect(afterFirst).toMatchObject({ drinks: 3, mulligans: 1, scores: 1, entries: 1, reactions: 1, applied: opsBefore + 10 });
    const types = new Set(first.events.feed.map((e) => e.type));
    for (const t of ["tee_off", "drinks", "shotgun", "mulligan_used", "contest_entry", "shot"] as const) expect(types, t).toContain(t);
    expect(first.snapshot.state.feed_events.some((e) => e.id === postId && e.type === "post")).toBe(true);
    const stateAfterFirst = await loadTripState(db, lt.trip.id);

    // The response was lost (tunnel under the clubhouse): the phone sends the same batch again.
    const again = await sync(lt, offline, { now: 130 });
    expect(again.results).toEqual(offline.map((op) => ({ id: op.id, status: "duplicate" })));
    expect(again.applied).toEqual([]);
    expect(again.events.feed).toEqual([]);
    expect(await counts()).toEqual(afterFirst);
    expect(await loadTripState(db, lt.trip.id)).toEqual(stateAfterFirst);
    await expectMatchesDb(lt, again);

    // Half old, half new, interleaved (a phone that queued more while the first flush was in flight).
    const fresh: Op[] = [
      mk("tee.open", { team_id: A, hole: 2, by: player.A1 }),
      mk("score.set", { team_id: A, hole: 2, strokes: 5, by: player.A1 }),
      drinkOp(lt, "A", "A4", 2),
      mk("drink.delete", { drink_id: firstDrink.drink_id, by: player.A1 }),
      mk("reaction.set", { feed_event_id: postId, player_id: player.A1, kind: "fire", on: true, by: player.A1 }),
    ];
    const mixed: Op[] = [];
    for (let i = 0; i < 5; i++) mixed.push(offline[i * 2], fresh[i]);
    const third = await sync(lt, mixed, { now: 200 });
    expect(third.results).toEqual(mixed.map((op) => ({ id: op.id, status: fresh.includes(op) ? "applied" : "duplicate" })));
    expect(third.applied.map((o) => o.id)).toEqual(fresh.map((o) => o.id));
    const afterThird = await counts();
    expect(afterThird).toMatchObject({
      drinks: 4, // +1 (the undo is a soft delete)
      mulligans: 1,
      scores: 2,
      entries: 1,
      reactions: 2,
      applied: opsBefore + 15,
    });
    expect(await count(db, "drinks", lt.trip.id, "deleted_at is not null")).toBe(1);
    // Exactly one applied_ops row per op id.
    const ids = [...offline, ...fresh].map((o) => o.id);
    const [{ n }] = await db.query<{ n: number }>("select count(*)::int as n from applied_ops where id = any($1::uuid[])", [ids]);
    expect(n).toBe(15);
    await expectMatchesDb(lt, third);

    // And once more, everything: all duplicates, nothing changes.
    const last = await sync(lt, [...offline, ...fresh], { now: 300 });
    expect(statuses(last).every((s) => s === "duplicate")).toBe(true);
    expect(await counts()).toEqual(afterThird);
  });

  it("the same op twice in one batch (any id case) applies once", async () => {
    const lt = await liveTrip(db, [2, 2]);
    const d = drinkOp(lt, "A", "A1", 1);
    const upper = { ...d, id: d.id.toUpperCase() };
    const out = await sync(lt, [d, d, upper]);
    expect(out.results).toEqual([
      { id: d.id, status: "applied" },
      { id: d.id, status: "duplicate" },
      { id: upper.id, status: "duplicate" },
    ]);
    expect(await count(db, "drinks", lt.trip.id)).toBe(1);
    const resend = await sync(lt, [upper]);
    expect(resend.results).toEqual([{ id: upper.id, status: "duplicate" }]);
  });
});

describe("last write wins (by client time)", () => {
  it("Two phones edit the same hole score: last write wins and the feed shows the edit", async () => {
    const lt = await liveTrip(db, [2, 2]);
    const A = lt.team.A;
    const { A1, A2 } = lt.player;
    await sync(lt, [mk("tee.open", { team_id: A, hole: 1, at: cli(10), by: A1 })], { now: 20 });

    // Phone 1 enters a 5.
    const p1 = mk("score.set", { team_id: A, hole: 1, strokes: 5, at: cli(30), by: A1 });
    const r1 = await sync(lt, [p1], { now: 40 });
    expect(r1.results).toEqual([{ id: p1.id, status: "applied" }]);
    expect(feedOf(r1, "score_edit")).toEqual([]);

    // Phone 2 corrects it to a 4.
    const p2 = mk("score.set", { team_id: A, hole: 1, strokes: 4, at: cli(50), by: A2 });
    const r2 = await sync(lt, [p2], { now: 60 });
    expect(r2.results).toEqual([{ id: p2.id, status: "applied" }]);
    const row = r2.snapshot.state.hole_scores.find((h) => h.team_id === A && h.hole === 1)!;
    expect(row).toMatchObject({ strokes: 4, edit_count: 1, updated_by: A2, strokes_at: cli(50) });
    const edits = feedOf(r2, "score_edit");
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ team_id: A, actor_id: A2, payload: { hole: 1, from: 5, to: 4, edit_count: 1 } });
    expect(r2.events.feed.map((e) => e.id)).toContain(edits[0].id);
    await expectMatchesDb(lt, r2);

    // A third phone was offline and entered a 6 BEFORE phone 2's correction; it syncs last. It
    // loses, and is told so (the phone toasts the reason); the feed records the dispute.
    const feedBefore = await count(db, "feed_events", lt.trip.id);
    const stale = mk("score.set", { team_id: A, hole: 1, strokes: 6, at: cli(45), by: A1 });
    const r3 = await sync(lt, [stale], { now: 600 });
    expect(r3.results).toEqual([{ id: stale.id, status: "rejected", code: "conflict", reason: expect.stringMatching(/Hole 1 already got a newer edit: 4/) }]);
    expect(r3.snapshot.state.hole_scores.find((h) => h.team_id === A && h.hole === 1)).toMatchObject({
      strokes: 4,
      edit_count: 1,
      strokes_at: cli(50),
      updated_by: A2,
    });
    expect(r3.events.feed).toEqual([
      expect.objectContaining({
        type: "score_edit",
        team_id: A,
        actor_id: A1,
        dedupe_key: `overruled:${stale.id}`,
        payload: { kind: "overruled", hole: 1, from: 6, to: 4, par: 4, edit_count: 1, overruled_by: A2 },
      }),
    ]);
    expect(r3.events.push_triggers).toEqual([]);
    expect(r3.events.roast_triggers).toEqual([]);
    expect(feedOf(r3, "score_edit")).toHaveLength(2);
    expect(await count(db, "feed_events", lt.trip.id)).toBe(feedBefore + 1);
    await expectMatchesDb(lt, r3);
    // A resend gets the recorded rejection and posts nothing new.
    const again = await sync(lt, [stale], { now: 700 });
    expect(again.results).toEqual(r3.results);
    expect(again.events.feed).toEqual([]);
    expect(await count(db, "feed_events", lt.trip.id)).toBe(feedBefore + 1);
  });

  it("offline review repro: the dispute reaches the feed in either sync order (the later entry syncing first included)", async () => {
    for (const order of ["earlier first", "later first"] as const) {
      const lt = await liveTrip(db, [2, 2]);
      const A = lt.team.A;
      const { A1, A2 } = lt.player;
      await sync(lt, [mk("tee.open", { team_id: A, hole: 1, at: cli(10), by: A1 })], { now: 20 });
      const dave = mk("score.set", { team_id: A, hole: 1, strokes: 5, at: cli(30), by: A1 });
      const mike = mk("score.set", { team_id: A, hole: 1, strokes: 3, at: cli(50), by: A2 });
      const [first, second] = order === "earlier first" ? [dave, mike] : [mike, dave];
      await sync(lt, [first], { now: 60 });
      const out = await sync(lt, [second], { now: 70 });
      expect(out.snapshot.state.hole_scores.find((h) => h.team_id === A && h.hole === 1)!.strokes, order).toBe(3);
      const edits = feedOf(out, "score_edit");
      expect(edits, order).toHaveLength(1);
      // Either way the feed names both values: Dave's 5 and Mike's 3.
      const p = edits[0].payload;
      expect([p.from, p.to], order).toEqual([5, 3]);
      expect(p.kind, order).toBe(order === "later first" ? "overruled" : undefined);
      await expectMatchesDb(lt, out);
    }
  });

  it("orders by client time within one batch too (the later edit wins regardless of position)", async () => {
    const lt = await liveTrip(db, [2, 2]);
    const A = lt.team.A;
    const later = mk("score.set", { team_id: A, hole: 1, strokes: 3, at: cli(70) });
    const earlier = mk("score.set", { team_id: A, hole: 1, strokes: 7, at: cli(60) });
    const out = await sync(lt, [later, earlier], { now: 100 });
    expect(statuses(out)).toEqual(["applied", "rejected"]);
    expect(out.snapshot.state.hole_scores.find((h) => h.team_id === A && h.hole === 1)).toMatchObject({ strokes: 3, edit_count: 0 });
    // The losing 7 is on the feed as overruled (not as an edit of the scorecard).
    expect(feedOf(out, "score_edit").map((e) => e.payload)).toEqual([
      { kind: "overruled", hole: 1, from: 7, to: 3, par: 4, edit_count: 0, overruled_by: null },
    ]);
    await expectMatchesDb(lt, out);
  });
});

describe("validation and rejections", () => {
  it("records rejections (a resend gets the same rejection, never re-evaluated); commissioner-only ops need the cookie", async () => {
    const lt = await liveTrip(db, [2, 2]);
    const A = lt.team.A;
    const { A1 } = lt.player;
    const wrongTeam = drinkOp(lt, "A", "B1", 1); // B1 isn't on team A
    const noBank = mk("mulligan.use", { mulligan_id: newId(), team_id: A, hole: 1, source: "earned", by: A1 });
    const holeEdit = mk("hole.update", { hole: 1, patch: { par: 5 } });
    const override = mk("score.set", { team_id: A, hole: 1, strokes: 3, as_commissioner: true });
    const ok = mk("tee.open", { team_id: A, hole: 1, by: A1 });
    const batch = [wrongTeam, noBank, holeEdit, override, ok];

    const out = await sync(lt, batch, { now: 10 });
    expect(out.results).toEqual([
      { id: wrongTeam.id, status: "rejected", code: "invalid", reason: expect.stringMatching(/./) },
      { id: noBank.id, status: "rejected", code: "conflict", reason: expect.stringMatching(/./) },
      { id: holeEdit.id, status: "rejected", code: "forbidden", reason: expect.stringMatching(/./) },
      { id: override.id, status: "rejected", code: "forbidden", reason: expect.stringMatching(/./) },
      { id: ok.id, status: "applied" },
    ]);
    const rows = await getAppliedOps(db, lt.trip.id, batch.map((o) => o.id));
    expect(rows.get(holeEdit.id)).toMatchObject({ status: "rejected", code: "forbidden", op_type: "hole.update", reason: out.results[2].reason });
    expect(rows.get(wrongTeam.id)).toMatchObject({ status: "rejected", code: "invalid", op_type: "drink.log" });
    expect(rows.get(ok.id)).toMatchObject({ status: "applied", code: null, reason: null });
    expect(await count(db, "drinks", lt.trip.id)).toBe(0);
    expect(out.snapshot.state.holes.find((h) => h.number === 1)?.par).toBe(4);

    // Resent (even with the cookie now): the recorded answers, never re-evaluated.
    const again = await sync(lt, batch, { now: 20, commish: true });
    expect(again.results).toEqual([...out.results.slice(0, 4), { id: ok.id, status: "duplicate" }]);
    expect(again.applied).toEqual([]);
    expect((await loadTripState(db, lt.trip.id)).holes.find((h) => h.number === 1)?.par).toBe(4);

    // With the cookie, a fresh override applies and posts a commissioner_override event (live).
    const fix = mk("score.set", { team_id: A, hole: 1, strokes: 3, as_commissioner: true });
    const r = await sync(lt, [fix], { now: 30, commish: true });
    expect(r.results).toEqual([{ id: fix.id, status: "applied" }]);
    const ev = r.events.feed.find((e) => e.type === "commissioner_override");
    expect(ev).toBeDefined();
    expect(ev!.payload).toMatchObject({ op_type: "score.set", summary: expect.stringContaining("hole 1") });
    expect(r.snapshot.state.feed_events.map((e) => e.id)).toContain(ev!.id);
    await expectMatchesDb(lt, r);

    // A commissioner-only op with the cookie: applied, also an override while live.
    const par = mk("hole.update", { hole: 2, patch: { par: 5 } });
    const r2 = await sync(lt, [par], { now: 40, commish: true });
    expect(r2.results).toEqual([{ id: par.id, status: "applied" }]);
    expect(r2.snapshot.state.holes.find((h) => h.number === 2)).toMatchObject({ par: 5, contest: "ld" });
    expect(r2.events.feed.map((e) => e.type)).toContain("commissioner_override");
  });

  it("rejects malformed ops one by one; only uuid-identified ones are recorded", async () => {
    const lt = await liveTrip(db, [2, 2]);
    const A = lt.team.A;
    const tee = (x: Record<string, unknown> = {}) => ({ ...mk("tee.open", { team_id: A, hole: 1 }), ...x });
    const badType = { id: newId(), type: "drink.chug", at: cli(1), by: null };
    const badAt = tee({ at: "yesterday" });
    const zoneless = tee({ at: "2026-10-24T12:00:00" });
    const badBy = tee({ by: "bob" });
    const notUuid = tee({ id: "op-1" });
    const noId = tee({ id: undefined });
    const good = mk("tee.open", { team_id: A, hole: 1 });
    const batch: unknown[] = [null, 42, "tee.open", [good], badType, badAt, zoneless, badBy, notUuid, noId, good];

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await sync(lt, batch, { now: 10 });
    expect(out.results).toHaveLength(batch.length);
    const invalid = (id: string) => ({ id, status: "rejected", code: "invalid", reason: expect.stringMatching(/./) });
    expect(out.results).toEqual([
      invalid(""),
      invalid(""),
      invalid(""),
      invalid(""),
      invalid(badType.id),
      invalid(badAt.id),
      invalid(zoneless.id),
      invalid(badBy.id),
      invalid("op-1"),
      invalid(""),
      { id: good.id, status: "applied" },
    ]);
    expect(out.results[4].reason).toMatch(/Unknown op/);
    expect(out.results[5].reason).toMatch(/timestamp/);
    const recorded = await getAppliedOps(db, lt.trip.id, [badType.id, badAt.id, zoneless.id, badBy.id]);
    expect(recorded.get(badType.id)).toMatchObject({ status: "rejected", op_type: "drink.chug", code: "invalid" });
    expect(recorded.size).toBe(4);

    const again = await sync(lt, batch, { now: 20 });
    // Recorded rejections come back as they were; ops with no uuid are simply re-checked.
    expect(again.results).toEqual([...out.results.slice(0, 10), { id: good.id, status: "duplicate" }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("rejects an op whose rows the database can't store, and keeps the rest of the batch", async () => {
    const lt = await liveTrip(db, [2, 2]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bad = drinkOp(lt, "A", "A1", 1, "drink", { drink_id: "drink-1" }); // the reducer accepts it, Postgres wouldn't
    const good = drinkOp(lt, "A", "A2", 1);
    const out = await sync(lt, [bad, good], { now: 10 });
    expect(out.results).toEqual([
      { id: bad.id, status: "rejected", code: "invalid", reason: expect.stringMatching(/./) },
      { id: good.id, status: "applied" },
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unsavable writes"));
    expect(out.snapshot.state.drinks.map((d) => d.id)).toEqual([good.drink_id]);
    await expectMatchesDb(lt, out);
  });

  it("clamps client times more than 2 minutes ahead and stores canonical timestamps", async () => {
    const lt = await liveTrip(db, [2, 2]);
    const A = lt.team.A;
    const now = srv(1000);
    const clamped = new Date(now.getTime() + MAX_CLOCK_SKEW_MS).toISOString();
    // A phone whose clock is an hour fast.
    const fast = mk("score.set", { team_id: A, hole: 1, strokes: 5, at: new Date(now.getTime() + 3600_000).toISOString() });
    // A timestamp with a zone offset: 13:10 EDT = 17:10Z.
    const offset = drinkOp(lt, "A", "A1", 1, "drink", { at: "2026-10-24T13:10:00-04:00" });
    const out = await applyOpsToTrip({ db, trip: lt.trip, ops: [fast, offset], isCommissioner: false, now });
    expect(statuses(out)).toEqual(["applied", "applied"]);
    expect(out.applied.map((o) => o.at)).toEqual([clamped, "2026-10-24T17:10:00.000Z"]);
    expect(out.snapshot.state.hole_scores[0].strokes_at).toBe(clamped);
    expect(out.snapshot.state.drinks[0].logged_at).toBe("2026-10-24T17:10:00.000Z");
    await expectMatchesDb(lt, out);

    // A correction made after the clamped time wins (the fast clock can't win forever).
    const fix = mk("score.set", { team_id: A, hole: 1, strokes: 4, at: srv(1200).toISOString() });
    const r = await sync(lt, [fix], { now: 1210 });
    expect(r.snapshot.state.hole_scores[0]).toMatchObject({ strokes: 4, strokes_at: srv(1200).toISOString() });
  });
});

describe("feed events", () => {
  it("posts a ghost beer for a threesome's 3rd drink and batches plain drinks across syncs within 60 s", async () => {
    const lt = await liveTrip(db, [4, 3]); // base team size 4
    const B = lt.team.B;

    // Three phones on the threesome each log a drink on hole 1, syncing separately.
    const b1 = drinkOp(lt, "B", "B1", 1);
    const r1 = await sync(lt, [b1], { now: 0 });
    const batch = feedOf(r1, "drinks").filter((e) => e.team_id === B);
    expect(batch).toHaveLength(1);
    expect(batch[0].payload).toMatchObject({ hole: 1, count: 1, drink_ids: [b1.drink_id] });

    const b2 = drinkOp(lt, "B", "B2", 1);
    const r2 = await sync(lt, [b2], { now: 30 });
    // Joined the same post (30 s later): updated, not a new event.
    expect(r2.events.feed.map((e) => e.id)).toEqual([batch[0].id]);
    const joined = feedOf(r2, "drinks").filter((e) => e.team_id === B);
    expect(joined).toHaveLength(1);
    expect(joined[0]).toMatchObject({
      id: batch[0].id,
      created_at: srv(0).toISOString(),
      updated_at: srv(30).toISOString(),
      payload: { count: 2, drink_ids: [b1.drink_id, b2.drink_id] },
    });
    await expectMatchesDb(lt, r2);

    const b3 = drinkOp(lt, "B", "B3", 1);
    const r3 = await sync(lt, [b3], { now: 50 });
    const ghosts = feedOf(r3, "ghost_beer");
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0]).toMatchObject({
      team_id: B,
      player_id: lt.player.B3,
      payload: { drink_id: b3.drink_id, value: 2, seq: 3, team_size: 3, base_team_size: 4, ghost_count: 1 },
    });
    expect(r3.events.feed.map((e) => e.id)).toContain(ghosts[0].id);
    // The ghost gets its own post, not a slot in the plain-drinks batch.
    expect(feedOf(r3, "drinks").find((e) => e.team_id === B)?.payload).toMatchObject({ count: 2 });
    // Roast trigger for the hooks.
    expect(r3.events.roast_triggers.map((t) => t.feed_event_id)).toContain(ghosts[0].id);
    expect(derive(r3.snapshot.state).drinkValues[b3.drink_id]).toMatchObject({ value: 2, ghost: true });
    await expectMatchesDb(lt, r3);

    // Team A (four players): two syncs 50 s apart share a post; one 3 minutes later starts a new one.
    const a1 = drinkOp(lt, "A", "A1", 2);
    const ra1 = await sync(lt, [a1], { now: 100 });
    const a2 = drinkOp(lt, "A", "A2", 2);
    const ra2 = await sync(lt, [a2], { now: 150 });
    const aPosts = feedOf(ra2, "drinks").filter((e) => e.team_id === lt.team.A);
    expect(aPosts).toHaveLength(1);
    expect(aPosts[0].payload).toMatchObject({ count: 2, drink_ids: [a1.drink_id, a2.drink_id] });
    expect(ra1.events.feed[0].id).toBe(aPosts[0].id);
    const a3 = drinkOp(lt, "A", "A3", 2);
    const ra3 = await sync(lt, [a3], { now: 330 });
    const aPosts3 = feedOf(ra3, "drinks").filter((e) => e.team_id === lt.team.A);
    expect(aPosts3).toHaveLength(2);
    expect(aPosts3.find((e) => e.id !== aPosts[0].id)?.payload).toMatchObject({ count: 1, drink_ids: [a3.drink_id] });
    await expectMatchesDb(lt, ra3);
  });

  it("derives events from the reducer's own feed changes in the same batch (post + reactions)", async () => {
    const lt = await liveTrip(db, [2, 2]);
    const post = mk("post.create", { event_id: newId(), text: "  Grip it and sip it  ", photo_path: null, by: lt.player.B2 });
    const react = mk("reaction.set", { feed_event_id: post.event_id, player_id: lt.player.A1, kind: "beer", on: true, by: lt.player.A1 });
    const out = await sync(lt, [post, react], { now: 5 });
    expect(statuses(out)).toEqual(["applied", "applied"]);
    expect(out.snapshot.state.feed_events.find((e) => e.id === post.event_id)).toMatchObject({
      type: "post",
      text: "Grip it and sip it",
      team_id: lt.team.B,
      player_id: lt.player.B2,
    });
    expect(out.snapshot.state.reactions).toHaveLength(1);
    await expectMatchesDb(lt, out);
  });
});

// ---------------------------------------------------------------------------
// Failure isolation (fast path → op-by-op slow path)
// ---------------------------------------------------------------------------

type FailWhen = (sql: string, params: unknown[]) => boolean;

/** A Db that throws a Postgres-like error (SQLSTATE `code`, null = none) for matching statements. */
function faultyDb(inner: Db, failWhen: FailWhen, code: string | null = "23514"): Db {
  const wrap = (d: Db): Db => ({
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      if (failWhen(sql, params)) {
        throw Object.assign(new Error(`injected failure (${code ?? "no code"})`), code ? { code } : {});
      }
      return d.query<T>(sql, params);
    },
    tx: (fn, opts) => d.tx((t) => fn(wrap(t)), opts),
  });
  return wrap(inner);
}

const touches = (table: string, needle?: string): FailWhen => (sql, params) =>
  sql.includes(`into "${table}"`) && (needle === undefined || JSON.stringify(params).includes(needle));

describe("offline phones vs the end of the round", () => {
  /** Both teams play 18 holes of 4s online and tap Round complete at client second `completeAt`. */
  async function playedOut(lt: LiveTrip, completeAt: number): Promise<void> {
    const ops: Op[] = [];
    for (const letter of ["A", "B"]) {
      for (let hole = 1; hole <= 18; hole++) {
        ops.push(mk("tee.open", { team_id: lt.team[letter], hole, at: cli(hole * 40) }));
        ops.push(mk("score.set", { team_id: lt.team[letter], hole, strokes: 4, at: cli(hole * 40 + 30) }));
      }
      ops.push(mk("round.complete", { team_id: lt.team[letter], at: cli(completeAt) }));
    }
    expect(statuses(await sync(lt, ops, { now: completeAt + 5 })).every((st) => st === "applied")).toBe(true);
  }

  it("ops queued offline before the commissioner finalized still land (late sync); fresh ones after don't", async () => {
    const lt = await liveTrip(db, [2, 2]);
    await playedOut(lt, 900);
    // B2's phone logged a shotgun on 18 and a re-count in a dead zone, then was pocketed.
    const shotgun = drinkOp(lt, "B", "B2", 18, "shotgun", { at: cli(880) });
    const recount = mk("score.set", { team_id: lt.team.B, hole: 18, strokes: 3, at: cli(895), by: lt.player.B2 });
    const fin = await sync(lt, [mk("trip.finalize", {})], { now: 1000, commish: true });
    expect(fin.snapshot.state.trip).toMatchObject({ status: "final", finalized_at: srv(1000).toISOString() });

    // The phone comes back at the bar.
    const late = await sync(lt, [shotgun, recount], { now: 1500 });
    expect(late.results).toEqual([
      { id: shotgun.id, status: "applied" },
      { id: recount.id, status: "applied" },
    ]);
    const state = late.snapshot.state;
    expect(state.trip.status).toBe("final");
    expect(state.drinks.map((d) => d.id)).toEqual([shotgun.drink_id]);
    const b = derive(state).standings.find((r) => r.team_id === lt.team.B)!;
    expect(b.gross).toBe(71);
    await expectMatchesDb(lt, late);

    // Fresh play after the final whistle (+ 2 min grace) is refused...
    const afterFinal = drinkOp(lt, "A", "A1", 18, "drink", { at: cli(1000 + 121) });
    const r = await sync(lt, [afterFinal], { now: 1600 });
    expect(r.results).toEqual([{ id: afterFinal.id, status: "rejected", code: "not_live", reason: expect.stringMatching(/final/) }]);
    // ...and stays refused after a reopen: the resend gets the same rejection (not "duplicate").
    await sync(lt, [mk("trip.reopen", {})], { now: 1700, commish: true });
    expect((await sync(lt, [afterFinal], { now: 1800 })).results).toEqual(r.results);
    expect(await count(db, "drinks", lt.trip.id)).toBe(1);
  });

  it("a drink logged on a stale phone after the team's Round complete doesn't count", async () => {
    const lt = await liveTrip(db, [2, 2]);
    await playedOut(lt, 900);
    // B2's phone still showed 18 open; the beer was at the clubhouse 15 minutes later.
    const late = drinkOp(lt, "B", "B2", 18, "drink", { at: cli(900 + 15 * 60) });
    // B1's phone logged one on 18 just before the tap, and syncs after it: that one counts.
    const onTime = drinkOp(lt, "B", "B1", 18, "drink", { at: cli(890) });
    const out = await sync(lt, [late, onTime], { now: 2000 });
    expect(out.results).toEqual([
      { id: late.id, status: "rejected", code: "no_window", reason: expect.stringMatching(/over/i) },
      { id: onTime.id, status: "applied" },
    ]);
    expect(out.snapshot.state.drinks.map((d) => d.id)).toEqual([onTime.drink_id]);
    // The commissioner can still add one by hand (Day-of fallback).
    const fix = drinkOp(lt, "B", "B2", 18, "drink", { at: cli(3000), by: null, as_commissioner: true });
    expect((await sync(lt, [fix], { now: 3000, commish: true })).results).toEqual([{ id: fix.id, status: "applied" }]);
  });

  /** $20 team match; A plays 18 fours, B the same but a 5 on 18; both tap Round complete at 900. */
  async function closeMatch(lt: LiveTrip): Promise<void> {
    await sync(lt, [mk("trip.update", { patch: { settings: { team_match_ante_cents: 2000 } } })], { now: 1, commish: true });
    const ops: Op[] = [];
    for (const letter of ["A", "B"]) {
      for (let hole = 1; hole <= 18; hole++) {
        ops.push(mk("tee.open", { team_id: lt.team[letter], hole, at: cli(hole * 40) }));
        ops.push(mk("score.set", { team_id: lt.team[letter], hole, strokes: letter === "B" && hole === 18 ? 5 : 4, at: cli(hole * 40 + 30) }));
      }
      ops.push(mk("round.complete", { team_id: lt.team[letter], at: cli(900) }));
    }
    expect(statuses(await sync(lt, ops, { now: 905 })).every((st) => st === "applied")).toBe(true);
  }
  const payments = (out: ApplyOpsResult) =>
    derive(out.snapshot.state).money.payments.map((p) => `${p.from_player_id}>${p.to_player_id} ${p.amount_cents}`).sort();

  it("rules/money review repro: a late sync that flips the champion and reverses the settle-up is LOUD, never a NEW LEADER", async () => {
    const lt = await liveTrip(db, [2, 2]);
    const { A1, A2, B1, B2 } = lt.player;
    await closeMatch(lt);
    // B2's phone logged a shotgun on 18 at 880 in a dead zone; the commissioner finalizes at 1000.
    const shotgun = drinkOp(lt, "B", "B2", 18, "shotgun", { at: cli(880) });
    const fin = await sync(lt, [mk("trip.finalize", {})], { now: 1000, commish: true });
    expect(payments(fin)).toEqual([`${B1}>${A1} 2000`, `${B2}>${A2} 2000`].sort());
    const finalPost = feedOf(fin, "final_results")[0];
    expect(finalPost.payload.champion_team_ids).toEqual([lt.team.A]);

    // The phone is opened two hours later.
    const late = await sync(lt, [shotgun], { now: 1000 + 2 * 3600 });
    expect(late.results).toEqual([{ id: shotgun.id, status: "applied" }]);
    expect(late.snapshot.state.trip.status).toBe("final");
    expect(payments(late)).toEqual([`${A1}>${B1} 2000`, `${A2}>${B2} 2000`].sort());
    expect(late.events.feed.map((e) => e.type)).not.toContain("lead_change");
    const changed = late.events.feed.filter((e) => e.type === "results_changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({
      actor_id: B2,
      payload: { champion_before: [lt.team.A], champion_after: [lt.team.B], late_op_ids: [shotgun.id] },
    });
    expect(late.events.push_triggers).toEqual([
      expect.objectContaining({ feed_event_id: changed[0].id, audience: { kind: "all" }, collapse_key: "results_changed" }),
    ]);
    expect(late.events.roast_triggers).toEqual([]);
    // The FINAL RESULTS post stays as history; the new event supersedes it.
    expect(feedOf(late, "final_results")).toEqual([finalPost]);
    await expectMatchesDb(lt, late);
  });

  it("security review repro: late sync is bounded by arrival (12 h after the finalize), so a backdated op can't rewrite the final card days later", async () => {
    const lt = await liveTrip(db, [2, 2]);
    await closeMatch(lt);
    await sync(lt, [mk("trip.finalize", {})], { now: 1000, commish: true });
    const H = 3600;
    const queued = drinkOp(lt, "B", "B2", 18, "drink", { at: cli(880) });
    const tooLate = await sync(lt, [queued], { now: 1000 + 12 * H + 60 });
    expect(tooLate.results).toEqual([{ id: queued.id, status: "rejected", code: "not_live", reason: expect.stringMatching(/final/) }]);
    const forged = mk("score.set", { team_id: lt.team.B, hole: 16, strokes: 1, at: cli(999), by: lt.player.B1 });
    expect((await sync(lt, [forged], { now: 1000 + 48 * H })).results[0]).toMatchObject({ status: "rejected", code: "not_live" });
    // Within the window it still lands (the Oct 13 decision), loudly.
    const inTime = drinkOp(lt, "B", "B1", 18, "shotgun", { at: cli(870) });
    const ok = await sync(lt, [inTime], { now: 1000 + 11 * H });
    expect(statuses(ok)).toEqual(["applied"]);
    expect(ok.events.feed.map((e) => e.type)).toContain("results_changed");
    expect(await count(db, "drinks", lt.trip.id)).toBe(1);
  });

  it("rules review repro: clubhouse beers that reach the server before the scorer's Round complete stop counting once it lands", async () => {
    const lt = await liveTrip(db, [3, 3]);
    await sync(lt, [mk("trip.update", { patch: { settings: { team_match_ante_cents: 2000 } } })], { now: 1, commish: true });
    const ops: Op[] = [];
    for (const letter of ["A", "B"]) {
      for (let hole = 1; hole <= 18; hole++) {
        ops.push(mk("tee.open", { team_id: lt.team[letter], hole, at: cli(hole * 40) }));
        ops.push(mk("score.set", { team_id: lt.team[letter], hole, strokes: letter === "B" && hole === 18 ? 5 : 4, at: cli(hole * 40 + 30) }));
      }
    }
    ops.push(mk("round.complete", { team_id: lt.team.A, at: cli(900) }));
    await sync(lt, ops, { now: 905 });
    // B1 taps Round complete on the 18th green with no signal (queued). B2's phone is online and
    // still shows 18 open: two bar beers 10 and 12 minutes later sync right away.
    const complete = mk("round.complete", { team_id: lt.team.B, at: cli(1000), by: lt.player.B1 });
    const beers = [drinkOp(lt, "B", "B2", 18, "drink", { at: cli(1600) }), drinkOp(lt, "B", "B2", 18, "drink", { at: cli(1720) })];
    const early = await sync(lt, beers, { now: 1725 });
    expect(statuses(early)).toEqual(["applied", "applied"]);
    // B1's phone finds signal.
    const out = await sync(lt, [complete], { now: 1900 });
    expect(statuses(out)).toEqual(["applied"]);
    const d = derive(out.snapshot.state);
    expect(d.standings.map((r) => [r.team_id, r.net])).toEqual([
      [lt.team.A, 72],
      [lt.team.B, 73],
    ]);
    expect(d.money.payments.every((p) => [lt.player.A1, lt.player.A2, lt.player.A3].includes(p.to_player_id))).toBe(true);
    // Same result as if the Round complete had synced first (the beers would have been refused).
    expect(d.drinkers.find((r) => r.player_id === lt.player.B2)!.total).toBe(0);
  });

  it("security review repro: a teammate pulling a drink and a closest-to-pin entry 40 minutes later leaves a 'removed' post", async () => {
    const lt = await liveTrip(db, [2, 2]);
    const { A1, A2 } = lt.player;
    await sync(lt, [mk("tee.open", { team_id: lt.team.A, hole: 3, at: cli(100), by: A1 })], { now: 100 });
    const d = drinkOp(lt, "A", "A1", 3, "shotgun", { at: cli(110) });
    const e = mk("contest.submit", {
      entry_id: newId(),
      hole: 3,
      player_id: A1,
      contest_type: "ctp",
      distance_value: 3,
      angle_deg: 45,
      lat: null,
      lng: null,
      gps_accuracy_m: null,
      low_accuracy: false,
      photo_path: null,
      at: cli(120),
      by: A1,
    });
    await sync(lt, [d, e], { now: 125 });
    const pull = [
      mk("drink.delete", { drink_id: d.drink_id, at: cli(110 + 2400), by: A2 }),
      mk("contest.delete", { entry_id: e.entry_id, at: cli(120 + 2400), by: A2 }),
    ];
    const out = await sync(lt, pull, { now: 125 + 2400 });
    expect(statuses(out)).toEqual(["applied", "applied"]);
    const removed = feedOf(out, "removed").map((x) => [x.actor_id, x.player_id, x.payload.kind]);
    expect(removed.sort((a, b) => String(a[2]).localeCompare(String(b[2])))).toEqual([
      [A2, A1, "contest_entry"],
      [A2, A1, "drink"],
    ]);
    await expectMatchesDb(lt, out);
  });

  it("a lost response doesn't hide a rejection: the resend answers with the recorded rejection", async () => {
    const lt = await liveTrip(db, [2, 2]);
    await sync(lt, [mk("tee.open", { team_id: lt.team.A, hole: 1 }), drinkOp(lt, "A", "A1", 1, "shotgun")], { now: 10 });
    // Two phones spend team A's only mulligan; phone B's response is lost in the tunnel.
    const phoneA = mk("mulligan.use", { mulligan_id: newId(), team_id: lt.team.A, hole: 2, source: "earned", by: lt.player.A1 });
    const phoneB = mk("mulligan.use", { mulligan_id: newId(), team_id: lt.team.A, hole: 2, source: "earned", by: lt.player.A2 });
    expect(statuses(await sync(lt, [phoneA], { now: 20 }))).toEqual(["applied"]);
    const lost = await sync(lt, [phoneB], { now: 30 });
    expect(lost.results).toEqual([{ id: phoneB.id, status: "rejected", code: "conflict", reason: expect.stringMatching(/bank/) }]);
    // Resent, alone or twice in a batch (any id case), it gets the same rejection.
    const again = await sync(lt, [phoneB, { ...phoneB, id: phoneB.id.toUpperCase() }], { now: 40 });
    expect(again.results).toEqual([lost.results[0], { ...lost.results[0], id: phoneB.id.toUpperCase() }]);
    // Within one batch, a repeated rejected op mirrors its first answer.
    const twice = mk("mulligan.use", { mulligan_id: newId(), team_id: lt.team.A, hole: 3, source: "earned", by: lt.player.A2 });
    const both = await sync(lt, [twice, twice], { now: 50 });
    expect(both.results[1]).toEqual(both.results[0]);
    expect(both.results[0]).toMatchObject({ status: "rejected", code: "conflict" });
    expect(await count(db, "mulligans", lt.trip.id)).toBe(1);
  });

  it("two phones edit the same hole in either sync order: the later edit wins and the loser is told", async () => {
    const lt = await liveTrip(db, [2, 2]);
    const A = lt.team.A;
    await sync(lt, [mk("tee.open", { team_id: A, hole: 1, at: cli(10) })], { now: 20 });
    const dave = mk("score.set", { team_id: A, hole: 1, strokes: 5, at: cli(30), by: lt.player.A1 });
    const mike = mk("score.set", { team_id: A, hole: 1, strokes: 3, at: cli(50), by: lt.player.A2 });
    // Mike's later 3 gets signal first.
    expect(statuses(await sync(lt, [mike], { now: 60 }))).toEqual(["applied"]);
    const r = await sync(lt, [dave], { now: 70 });
    expect(r.results).toEqual([{ id: dave.id, status: "rejected", code: "conflict", reason: expect.stringMatching(/Hole 1 already got a newer edit: 3/) }]);
    expect(r.snapshot.state.hole_scores.find((h) => h.team_id === A && h.hole === 1)).toMatchObject({ strokes: 3, edit_count: 0 });
    // An earlier entry that agrees is no conflict at all.
    const agree = mk("score.set", { team_id: A, hole: 1, strokes: 3, at: cli(40), by: lt.player.A1 });
    expect(statuses(await sync(lt, [agree], { now: 80 }))).toEqual(["applied"]);
  });

  it("cross-team deletes need the commissioner; a player's own team may undo", async () => {
    const lt = await liveTrip(db, [2, 2]);
    await sync(lt, [mk("tee.open", { team_id: lt.team.A, hole: 1 })], { now: 5 });
    const d = drinkOp(lt, "A", "A1", 1, "shotgun");
    await sync(lt, [d], { now: 10 });
    const rival = mk("drink.delete", { drink_id: d.drink_id, by: lt.player.B1 });
    expect((await sync(lt, [rival], { now: 20 })).results[0]).toMatchObject({ status: "rejected", code: "forbidden" });
    expect(await count(db, "drinks", lt.trip.id, "deleted_at is null")).toBe(1);
    const undo = mk("drink.delete", { drink_id: d.drink_id, by: lt.player.A2 });
    expect(statuses(await sync(lt, [undo], { now: 30 }))).toEqual(["applied"]);
    expect(await count(db, "drinks", lt.trip.id, "deleted_at is null")).toBe(0);
  });

  it("photo_path is validated: only this trip's trips/<id>/<kind>/<uuid>.jpg (no megabyte strings, no URLs)", async () => {
    const lt = await liveTrip(db, [2, 2], { start: false });
    const huge = mk("post.create", { event_id: newId(), text: null, photo_path: "x".repeat(1_000_000), by: null });
    const url = mk("post.create", { event_id: newId(), text: "pixel", photo_path: "https://attacker.example/p.jpg", by: null });
    const good = mk("post.create", { event_id: newId(), text: null, photo_path: `trips/${lt.trip.id}/posts/${newId()}.jpg`, by: null });
    const out = await sync(lt, [huge, url, good], { now: 10 });
    expect(out.results.map((r) => r.code ?? r.status)).toEqual(["invalid", "invalid", "applied"]);
    expect(out.snapshot.state.feed_events.filter((e) => e.type === "post").map((e) => e.id)).toEqual([good.event_id]);
  });

  it("editing a closest-to-pin claim on the same photo keeps the AI judge's estimate and re-judges the claim", async () => {
    const lt = await liveTrip(db, [2, 2]);
    const photo = `trips/${lt.trip.id}/ctp/${newId()}.jpg`;
    const ctp = (feet: number, photo_path: string | null) =>
      mk("contest.submit", {
        entry_id: newId(),
        hole: 3,
        player_id: lt.player.A1,
        contest_type: "ctp",
        distance_value: feet,
        angle_deg: 45,
        lat: null,
        lng: null,
        gps_accuracy_m: null,
        low_accuracy: false,
        photo_path,
        by: lt.player.A1,
      });
    const first = ctp(2, photo);
    await sync(lt, [first], { now: 10 });
    // The judge (post-commit) read the photo as ~20 ft and flagged the 2-footer.
    await db.query(
      "update contest_entries set ai_estimate_ft = 20, ai_confidence = 'high', ai_suspicious = true, ai_roast = 'Liar.' where id = $1",
      [first.entry_id],
    );
    const nudge = ctp(2.5, photo);
    const out = await sync(lt, [nudge], { now: 20 });
    const entry = out.snapshot.state.contest_entries.find((e) => e.id === nudge.entry_id)!;
    expect(entry).toMatchObject({ ai_estimate_ft: 20, ai_confidence: "high", ai_suspicious: true, ai_roast: "Liar.", deleted_at: null });
    expect(derive(out.snapshot.state).awards.find((a) => a.key === "most_suspicious")).toMatchObject({ awarded: true, player_ids: [lt.player.A1] });
    await expectMatchesDb(lt, out);
    // An honest correction on the same photo clears the flag but keeps the estimate.
    const honest = ctp(14, photo);
    const r2 = await sync(lt, [honest], { now: 30 });
    expect(r2.snapshot.state.contest_entries.find((e) => e.id === honest.entry_id)).toMatchObject({ ai_estimate_ft: 20, ai_suspicious: false });
  });
});

describe("failure isolation", () => {
  it("a data error on one op's rows rejects that op only; the rest commit with their events", async () => {
    const lt = await liveTrip(db, [4, 3]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const d1 = drinkOp(lt, "A", "A1", 4);
    const poison = drinkOp(lt, "A", "A2", 4);
    const d3 = drinkOp(lt, "A", "A3", 4);
    const faulty = { ...lt, db: faultyDb(db, touches("drinks", poison.drink_id)) };
    const out = await sync(faulty, [d1, poison, d3], { now: 10 });
    expect(out.results).toEqual([
      { id: d1.id, status: "applied" },
      { id: poison.id, status: "rejected", code: "invalid", reason: expect.stringMatching(/./) },
      { id: d3.id, status: "applied" },
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("splitting to isolate the bad one"));
    expect(out.applied.map((o) => o.id)).toEqual([d1.id, d3.id]);
    const post = feedOf(out, "drinks").find((e) => e.team_id === lt.team.A);
    expect(post?.payload).toMatchObject({ count: 2, drink_ids: [d1.drink_id, d3.drink_id] });
    await expectMatchesDb(lt, out);
    expect((await getAppliedOps(db, lt.trip.id, [poison.id])).get(poison.id)).toMatchObject({ status: "rejected", code: "invalid" });
    // The resend gets the recorded rejection (the phone drops it: no endless retry of a poison op).
    expect((await sync(lt, [poison], { now: 20 })).results).toEqual([out.results[1]]);
  });

  it("isolates several poison ops in a big batch, in order, with duplicates spanning the split", async () => {
    const lt = await liveTrip(db, [4, 4]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const goods = Array.from({ length: 9 }, (_, i) => drinkOp(lt, i % 2 ? "A" : "B", i % 2 ? "A1" : "B1", 7));
    const p1 = drinkOp(lt, "A", "A2", 7);
    const p2 = drinkOp(lt, "B", "B2", 7);
    const poisonIds = [p1.drink_id, p2.drink_id];
    const faulty = { ...lt, db: faultyDb(db, (sql, params) => sql.includes('into "drinks"') && poisonIds.some((id) => JSON.stringify(params).includes(id))) };
    // goods[0] appears twice, far apart; p1 appears twice too.
    const batch: Op[] = [goods[0], goods[1], p1, goods[2], goods[3], goods[4], goods[0], goods[5], p2, goods[6], p1, goods[7], goods[8]];
    const out = await sync(faulty, batch, { now: 10 });
    expect(out.results.map((r) => r.code ?? r.status)).toEqual([
      "applied",
      "applied",
      "invalid",
      "applied",
      "applied",
      "applied",
      "duplicate",
      "applied",
      "invalid",
      "applied",
      "invalid", // p1 again: its recorded rejection, not "duplicate"
      "applied",
      "applied",
    ]);
    expect(out.results.map((r) => r.id)).toEqual(batch.map((o) => o.id));
    expect(out.applied.map((o) => o.id)).toEqual(goods.map((o) => o.id));
    expect((await loadTripState(db, lt.trip.id)).drinks.map((d) => d.id).sort()).toEqual(goods.map((g) => g.drink_id).sort());
    // One plain-drinks post per team for hole 7, holding exactly that team's good drinks.
    for (const letter of ["A", "B"]) {
      const posts = feedOf(out, "drinks").filter((e) => e.team_id === lt.team[letter]);
      expect(posts).toHaveLength(1);
      const mine = goods.filter((g) => g.team_id === lt.team[letter]).map((g) => g.drink_id);
      expect([...(posts[0].payload.drink_ids as string[])].sort()).toEqual(mine.sort());
      // The merged events carry the latest version of the post.
      expect(out.events.feed.find((e) => e.id === posts[0].id)).toEqual(posts[0]);
    }
    await expectMatchesDb(lt, out);
    const resent = await sync(lt, batch, { now: 20 });
    expect(resent.results.map((r) => r.code ?? r.status)).toEqual(batch.map((o) => (o === p1 || o === p2 ? "invalid" : "duplicate")));
  });

  it("a timestamp JS accepts but Postgres refuses (year 0) is isolated as a real data error", async () => {
    const lt = await liveTrip(db, [2, 2]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const before = drinkOp(lt, "A", "A1", 1);
    const broken = drinkOp(lt, "A", "A2", 1, "drink", { at: "0000-06-01T12:00:00Z" });
    const after = drinkOp(lt, "B", "B1", 1);
    const out = await sync(lt, [before, broken, after], { now: 10 });
    expect(out.results.map((r) => r.code ?? r.status)).toEqual(["applied", "invalid", "applied"]);
    expect((await getAppliedOps(db, lt.trip.id, [broken.id])).get(broken.id)).toMatchObject({ status: "rejected" });
    await expectMatchesDb(lt, out);
  });

  it("a lone poison op still gets a snapshot (read after recording the rejection)", async () => {
    const lt = await liveTrip(db, [2, 2]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = drinkOp(lt, "A", "A1", 1);
    const out = await sync({ ...lt, db: faultyDb(db, touches("drinks")) }, [p], { now: 10 });
    expect(out.results).toEqual([{ id: p.id, status: "rejected", code: "invalid", reason: expect.stringMatching(/./) }]);
    await expectMatchesDb(lt, out);
  });

  it("if the feed rows can't be saved, the ops still commit (without events)", async () => {
    const lt = await liveTrip(db, [4, 3]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const feedBefore = await count(db, "feed_events", lt.trip.id);
    const d = drinkOp(lt, "A", "A1", 5);
    const faulty = { ...lt, db: faultyDb(db, touches("feed_events"), "23505") };
    const out = await sync(faulty, [d], { now: 10 });
    expect(out.results).toEqual([{ id: d.id, status: "applied" }]);
    expect(out.events).toEqual({ feed: [], roast_triggers: [], push_triggers: [] });
    expect(err).toHaveBeenCalled();
    expect(await count(db, "drinks", lt.trip.id)).toBe(1);
    expect(await count(db, "feed_events", lt.trip.id)).toBe(feedBefore);
    await expectMatchesDb(lt, out);
  });

  it("an infrastructure error fails the whole request and commits nothing (the phone retries)", async () => {
    const lt = await liveTrip(db, [2, 2]);
    const before = await loadTripState(db, lt.trip.id);
    const appliedBefore = await count(db, "applied_ops", lt.trip.id);
    const d = drinkOp(lt, "A", "A1", 1);
    for (const code of [null, "08006", "57014", "40001"]) {
      const faulty = { ...lt, db: faultyDb(db, touches("drinks"), code) };
      await expect(sync(faulty, [d, mk("tee.open", { team_id: lt.team.A, hole: 1 })])).rejects.toThrow(/injected failure/);
    }
    expect(await loadTripState(db, lt.trip.id)).toEqual(before);
    expect(await count(db, "applied_ops", lt.trip.id)).toBe(appliedBefore);
    // Once the database is healthy again the same batch goes through.
    expect(statuses(await sync(lt, [d], { now: 5 }))).toEqual(["applied"]);
  });

  it("an id owned by another trip is a conflict, and the other trip is untouched (real constraint violation)", async () => {
    const one = await liveTrip(db, [2, 2]);
    const two = await createTrip(db, { name: "Copycat", app_name: "Scramble", pin_hash: PIN_HASH });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stolen = one.player.A1;
    const teamId = newId();
    const up = mk("player.upsert", { player: { id: stolen, name: "Imposter" } });
    const team = mk("team.upsert", { team: { id: teamId, name: "Copy" } });
    const assign = mk("team.assign", { player_id: stolen, team_id: teamId });
    const legit = mk("player.upsert", { player: { id: newId(), name: "Legit" } });
    const out = await applyOpsToTrip({ db, trip: two, ops: [up, team, assign, legit], isCommissioner: true });
    expect(out.results).toEqual([
      { id: up.id, status: "rejected", code: "conflict", reason: expect.stringMatching(/./) },
      { id: team.id, status: "applied" },
      { id: assign.id, status: "rejected", code: "not_found", reason: expect.stringMatching(/./) },
      { id: legit.id, status: "applied" },
    ]);
    expect(warn).toHaveBeenCalled();
    expect(out.snapshot.state.players.map((p) => p.name)).toEqual(["Legit"]);
    expect(out.snapshot.state).toEqual(await loadTripState(db, two.id));
    const original = await loadTripState(db, one.trip.id);
    expect(original.players.find((p) => p.id === stolen)).toMatchObject({ name: "Player A1", trip_id: one.trip.id });
    expect(original.team_members.find((m) => m.player_id === stolen)?.team_id).toBe(one.team.A);
  });
});

describe("sortLikeDb", () => {
  it("orders rows like loadTripState's ORDER BY (numbers numerically, times chronologically, nulls last)", () => {
    const holes = [10, 2, 1].map((number) => ({ id: newId(), number }));
    const scores = [
      { id: "b", team_id: "x", hole: 10 },
      { id: "a", team_id: "x", hole: 9 },
      { id: "c", team_id: "W", hole: 1 },
    ];
    const drinks = [
      { id: "2", created_at: "2026-10-24T17:00:01.000Z" },
      { id: "1", created_at: "2026-10-24T17:00:01.000Z" },
      { id: "0", created_at: "2026-10-24T13:00:02-04:00" },
    ];
    const empty = { players: [], teams: [], team_members: [], team_round_state: [], mulligans: [], contest_entries: [], pot_optouts: [], feed_events: [], reactions: [] };
    const sorted = sortLikeDb({ trip: {}, ...empty, holes, hole_scores: scores, drinks } as never);
    expect(sorted.holes.map((h) => h.number)).toEqual([1, 2, 10]);
    expect(sorted.hole_scores.map((h) => h.id)).toEqual(["c", "a", "b"]);
    expect(sorted.drinks.map((d) => d.id)).toEqual(["1", "2", "0"]);
    expect(holes.map((h) => h.number)).toEqual([10, 2, 1]); // input untouched
  });
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

/** Concurrency checks shared by PGlite and real Postgres. */
function concurrencyTests(getDb: () => Db) {
  it("parallel syncs from two phones: each op once, dedupe-keyed events once, no deadlock", async () => {
    const lt = await liveTrip(getDb(), [4, 3]);
    const { A1, A2 } = lt.player;
    const A = lt.team.A;
    // Both phones on team A tap "On the tee" for hole 1 and both enter the birdie; both outboxes
    // also carry the same shared op (one phone relayed it to the other... or the user double-sent).
    const shared = drinkOp(lt, "A", "A3", 1);
    const phone1 = [mk("tee.open", { team_id: A, hole: 1, by: A1 }), mk("score.set", { team_id: A, hole: 1, strokes: 3, by: A1 }), shared];
    const phone2 = [mk("tee.open", { team_id: A, hole: 1, by: A2 }), mk("score.set", { team_id: A, hole: 1, strokes: 3, by: A2 }), shared];
    const [r1, r2] = await Promise.all([sync(lt, phone1, { now: 10 }), sync(lt, phone2, { now: 10 })]);
    expect(statuses(r1).slice(0, 2)).toEqual(["applied", "applied"]);
    expect(statuses(r2).slice(0, 2)).toEqual(["applied", "applied"]);
    expect([r1.results[2].status, r2.results[2].status].sort()).toEqual(["applied", "duplicate"]);
    const state = await loadTripState(lt.db, lt.trip.id);
    const evs = (t: FeedEventType) => state.feed_events.filter((e) => e.type === t);
    expect(evs("tee_off")).toHaveLength(1);
    expect(evs("score_notable").filter((e) => e.payload.kind === "birdie")).toHaveLength(1);
    expect(state.drinks).toHaveLength(1);
    expect(await count(lt.db, "applied_ops", lt.trip.id, `id = any(array['${[...phone1, ...phone2].map((o) => o.id).join("','")}']::uuid[])`)).toBe(5);
  });

  it("many overlapping parallel syncs: every op applied exactly once across all responses", async () => {
    const lt = await liveTrip(getDb(), [4, 3]);
    const N = 8;
    // The same 6 time-ordered drinks for the threesome in every request, plus one op of its own.
    const sharedOps = Array.from({ length: 6 }, (_, i) => drinkOp(lt, "B", `B${1 + (i % 3)}`, 2));
    const own = Array.from({ length: N }, (_, i) => mk("post.create", { event_id: newId(), text: `phone ${i}`, photo_path: null, by: lt.player.A1 }));
    const outs = await Promise.all(own.map((p, i) => sync(lt, [...sharedOps, p], { now: 20 + i })));
    for (const op of [...sharedOps, ...own]) {
      const applied = outs.filter((o) => o.results.some((r) => r.id === op.id && r.status === "applied"));
      expect(applied, op.id).toHaveLength(1);
    }
    const state = await loadTripState(lt.db, lt.trip.id);
    expect(state.drinks).toHaveLength(6);
    expect(state.feed_events.filter((e) => e.type === "post")).toHaveLength(N);
    // Drinks 3 and 6 of the threesome are ghosts, each posted once.
    const ghosts = state.feed_events.filter((e) => e.type === "ghost_beer");
    expect(ghosts.map((g) => g.payload.drink_id).sort()).toEqual([sharedOps[2].drink_id, sharedOps[5].drink_id].sort());
    expect(await count(lt.db, "applied_ops", lt.trip.id, "op_type in ('drink.log', 'post.create')")).toBe(6 + N);
  });

  it("parallel single drinks from different phones join ONE drinks post (the batch reads the latest feed)", async () => {
    const lt = await liveTrip(getDb(), [4, 4]);
    const labels = ["A1", "A2", "A3", "A4"];
    const drinks = labels.map((l) => drinkOp(lt, "A", l, 6));
    const outs = await Promise.all(drinks.map((d) => sync(lt, [d], { now: 40 })));
    expect(outs.flatMap(statuses)).toEqual(["applied", "applied", "applied", "applied"]);
    const state = await loadTripState(lt.db, lt.trip.id);
    const posts = state.feed_events.filter((e) => e.type === "drinks" && e.team_id === lt.team.A);
    expect(posts).toHaveLength(1);
    expect(posts[0].payload.count).toBe(4);
    expect([...(posts[0].payload.drink_ids as string[])].sort()).toEqual(drinks.map((d) => d.drink_id).sort());
  });
}

describe("concurrency (PGlite)", () => {
  concurrencyTests(() => db);
});

// Real Postgres 16 (postgres.js pool, true parallel transactions): same harness as postgres.test.ts.
const PG_BIN = "/usr/lib/postgresql/16/bin";
function findRunuser(): string | null {
  for (const p of ["/usr/sbin/runuser", "/sbin/runuser", "/usr/bin/runuser", "/bin/runuser"]) if (fs.existsSync(p)) return p;
  return null;
}
function postgresIds(): { uid: number; gid: number } | null {
  const u = spawnSync("id", ["-u", "postgres"], { encoding: "utf8" });
  const g = spawnSync("id", ["-g", "postgres"], { encoding: "utf8" });
  if (u.status !== 0 || g.status !== 0) return null;
  return { uid: Number(u.stdout.trim()), gid: Number(g.stdout.trim()) };
}
const RUNUSER = findRunuser();
const PG_IDS = postgresIds();
const PG_AVAILABLE =
  process.platform === "linux" &&
  typeof process.getuid === "function" &&
  process.getuid() === 0 &&
  !!RUNUSER &&
  !!PG_IDS &&
  fs.existsSync(path.join(PG_BIN, "initdb")) &&
  fs.existsSync(path.join(PG_BIN, "pg_ctl"));

function asPostgres(args: string[]): void {
  const r = spawnSync(RUNUSER!, ["-u", "postgres", "--", ...args], { encoding: "utf8", timeout: 120_000 });
  if (r.status !== 0) throw new Error(`${args[0]} failed (${r.status}): ${r.stderr || r.stdout}`);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srvr = net.createServer();
    srvr.unref();
    srvr.on("error", reject);
    srvr.listen(0, "127.0.0.1", () => {
      const addr = srvr.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srvr.close(() => resolve(port));
    });
  });
}

describe.skipIf(!PG_AVAILABLE)("concurrency (real Postgres 16)", () => {
  let dir = "";
  let pg: DbConnection;
  let started = false;

  beforeAll(async () => {
    dir = fs.mkdtempSync("/tmp/scramble-apply-pg-");
    fs.chownSync(dir, PG_IDS!.uid, PG_IDS!.gid);
    asPostgres([path.join(PG_BIN, "initdb"), "-D", path.join(dir, "data"), "-U", "postgres", "--auth=trust", "--encoding=UTF8", "--no-locale", "--no-sync"]);
    const port = await freePort();
    asPostgres([
      path.join(PG_BIN, "pg_ctl"),
      "-D",
      path.join(dir, "data"),
      "-l",
      path.join(dir, "postgres.log"),
      "-w",
      "-t",
      "60",
      "-o",
      `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off`,
      "start",
    ]);
    started = true;
    pg = await connectPostgres(`postgres://postgres@127.0.0.1:${port}/postgres`);
    await runMigrations(pg);
  }, 180_000);

  afterAll(async () => {
    await pg?.close().catch(() => {});
    if (started) {
      try {
        asPostgres([path.join(PG_BIN, "pg_ctl"), "-D", path.join(dir, "data"), "-m", "immediate", "-w", "stop"]);
      } catch (e) {
        console.warn(String(e));
      }
    }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  it("is a postgres.js pool", () => {
    expect(pg.driver).toBe("postgres");
  });

  concurrencyTests(() => pg);

  it("isolates a real constraint violation (cross-trip id) by splitting the batch; the snapshot matches", async () => {
    const one = await liveTrip(pg, [2, 2]);
    const two = await createTrip(pg, { name: "Copycat", app_name: "Scramble", pin_hash: PIN_HASH });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const teamId = newId();
    const ops = [
      mk("team.upsert", { team: { id: teamId, name: "Copy" } }),
      mk("player.upsert", { player: { id: one.player.B2, name: "Imposter" } }),
      mk("team.assign", { player_id: one.player.B2, team_id: teamId }),
    ];
    const out = await applyOpsToTrip({ db: pg, trip: two, ops, isCommissioner: true });
    expect(out.results.map((r) => r.code ?? r.status)).toEqual(["applied", "conflict", "not_found"]);
    expect(out.snapshot.state).toEqual(await loadTripState(pg, two.id));
    expect((await loadTripState(pg, one.trip.id)).players.find((p) => p.id === one.player.B2)?.name).toBe("Player B2");
  });
});
