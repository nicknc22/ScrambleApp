// Repository: round trips for every table, write folding/ordering, validation, unique constraints,
// applied-op bookkeeping, and an end-to-end reducer → persistWrites → loadTripState check.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, pgErrorCode, type Db, type DbConnection } from "@/lib/server/db";
import {
  columnsOf,
  findTripByCode,
  findTripById,
  getAppliedOpIds,
  getAppliedOps,
  insertFeedEvents,
  InvalidWriteError,
  loadTripState,
  lockTrip,
  persistWrites,
  readTripState,
  recordAppliedOps,
  ROW_SPECS,
  setTripPinHash,
  deleteTrip,
  validateWrite,
  type ColDef,
} from "@/lib/server/repo";
import { createTrip, seedHoles } from "@/lib/server/trips";
import { applyOp, type Write } from "@/lib/reducer";
import { newId } from "@/lib/ids";
import type { Op, OpInput } from "@/lib/ops";
import { DEFAULT_SETTINGS, ROW_TABLES, type AnyRow, type FeedEvent, type RowTable, type Trip, type TripState } from "@/lib/types";

let db: DbConnection;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db?.close();
});

const PIN_HASH = "scrypt$c2FsdA$aGFzaA";

async function newTrip(name = "Repo Trip"): Promise<Trip> {
  return createTrip(db, { name, app_name: "Scramble", pin_hash: PIN_HASH });
}

// ---------------------------------------------------------------------------
// Generic sample rows from the column specs (exercises every column of every table)
// ---------------------------------------------------------------------------

let tick = 0;
function iso(): string {
  tick++;
  return new Date(Date.UTC(2026, 9, 24, 16, 50, 0, 0) + tick * 1_001 + (tick % 7)).toISOString();
}

function sampleValue(table: RowTable, col: string, def: ColDef, filled: boolean, i: number): unknown {
  const nullable = typeof def === "object" ? !!def.nullable : def.endsWith("?");
  if (nullable && !filled) return null;
  if (typeof def === "object") return def.enum[i % def.enum.length];
  const base = def.replace("?", "");
  switch (base) {
    case "uuid":
      return newId();
    case "text":
      return col === "pot_key" ? `contest:${3 + i}` : `${table}.${col} #${i} — "quoted" it's ✓ 🍺`;
    case "int":
      return col === "number" || col === "hole" ? 1 + i : 3 + i;
    case "float":
      return 41.0948123 + i / 1000;
    case "bool":
      return i % 2 === 0;
    case "ts":
      return iso();
    case "jsonb":
      return { "1": iso(), nested: { list: [1, "two", null, true, { deep: 2.5 }] }, empty: {}, i };
    case "int[]":
      return [1, 2, 18].slice(0, 1 + (i % 3));
  }
  throw new Error(`no sample for ${def}`);
}

function sampleRow(table: RowTable, tripId: string, filled: boolean, i: number): AnyRow {
  const row: Record<string, unknown> = {};
  for (const [col, def] of Object.entries(ROW_SPECS[table].columns as Record<string, ColDef>)) {
    row[col] = sampleValue(table, col, def, filled, i);
  }
  row.trip_id = tripId;
  return row as unknown as AnyRow;
}

const byId = <T extends { id: string }>(rows: readonly T[]) => [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));

function stateById(s: TripState): Record<string, unknown> {
  const out: Record<string, unknown> = { trip: s.trip };
  for (const t of ROW_TABLES) out[t] = byId(s[t] as { id: string }[]);
  return out;
}

// ---------------------------------------------------------------------------

describe("trips", () => {
  it("createTrip seeds 18 Jack Frost holes and default settings; lookups hide the PIN hash", async () => {
    const trip = await newTrip("Lookup Trip");
    expect(trip.code).toMatch(/^[a-z2-9]{10}$/);
    expect(trip.status).toBe("setup");
    expect(trip.settings).toEqual(DEFAULT_SETTINGS);
    expect(trip.started_at).toBeNull();
    expect(Object.keys(trip)).not.toContain("commissioner_pin_hash");

    const found = await findTripByCode(db, trip.code);
    expect(found?.trip).toEqual(trip);
    expect(found?.pin_hash).toBe(PIN_HASH);
    expect(Object.keys(found!.trip)).not.toContain("commissioner_pin_hash");
    expect((await findTripById(db, trip.id))?.trip).toEqual(trip);
    expect(await findTripByCode(db, "nosuchcode")).toBeNull();
    expect(await findTripById(db, "not-a-uuid")).toBeNull();

    const state = await loadTripState(db, trip.id);
    expect(state.trip).toEqual(trip);
    expect(state.holes.map((h) => h.number)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
    expect(state.holes.filter((h) => h.contest === "ctp").map((h) => h.number)).toEqual([3, 8, 11, 16]);
    expect(state.holes.filter((h) => h.contest === "ld").map((h) => h.number)).toEqual([4, 9, 12, 18]);
    expect(state.holes[0]).toEqual(seedHoles(trip.id, trip.created_at)[0]);
    expect(state.players).toEqual([]);
  });

  it("honors a fixed code, refuses a taken one, and setTripPinHash/deleteTrip work", async () => {
    const trip = await createTrip(db, { name: "Fixed", app_name: "X", pin_hash: PIN_HASH, code: "DemoCode42", is_demo: true });
    expect(trip.code).toBe("democode42");
    expect(trip.is_demo).toBe(true);
    await expect(createTrip(db, { name: "Dup", app_name: "X", pin_hash: PIN_HASH, code: "democode42" })).rejects.toThrow(/taken/);
    await expect(createTrip(db, { name: "Bad", app_name: "X", pin_hash: PIN_HASH, code: "no" })).rejects.toThrow();

    expect(await setTripPinHash(db, trip.id, "scrypt$new$hash")).toBe(true);
    expect((await findTripByCode(db, trip.code))?.pin_hash).toBe("scrypt$new$hash");

    expect(await deleteTrip(db, trip.id)).toBe(true);
    expect(await findTripByCode(db, trip.code)).toBeNull();
    const holes = await db.query("select id from holes where trip_id = $1", [trip.id]);
    expect(holes).toEqual([]); // cascade
  });

  it("cleans up names", async () => {
    const trip = await createTrip(db, { name: "  Bach\n  Party  ", app_name: "", pin_hash: PIN_HASH });
    expect(trip.name).toBe("Bach Party");
    expect(trip.app_name).toBe("Scramble");
  });
});

describe("persistWrites + loadTripState round trip", () => {
  it("round-trips every column of every table (filled and null variants) deep-equal", async () => {
    const trip = await newTrip();
    const base = await loadTripState(db, trip.id);
    const expected: Record<string, AnyRow[]> = {};
    const writes: Write[] = [];
    for (const table of ROW_TABLES) {
      // holes already has 1..18 for this trip: use numbers that don't collide.
      const rows = [0, 1].map((i) => sampleRow(table, trip.id, i === 0, table === "holes" ? 30 + i : i));
      expected[table] = rows;
      for (const row of rows) writes.push({ kind: "upsert", table, row });
    }
    const res = await persistWrites(db, trip.id, writes);
    expect(res.skipped).toEqual([]);
    expect(res.upserted).toBe(writes.length);

    const loaded = await loadTripState(db, trip.id);
    for (const table of ROW_TABLES) {
      const want = byId(table === "holes" ? [...base.holes, ...expected.holes] : expected[table]);
      expect(byId(loaded[table] as AnyRow[]), table).toEqual(want);
    }
    // Shapes: ISO strings, objects, number arrays.
    const rs = loaded.team_round_state.find((r) => r.completed_at !== null)!;
    expect(rs.completed_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(Array.isArray(rs.started_holes)).toBe(true);
    expect(typeof rs.hole_opened_at).toBe("object");
  });

  it("updates rows by id (every column) and orders rows by created_at then id; holes by number", async () => {
    const trip = await newTrip();
    const a = sampleRow("drinks", trip.id, true, 0) as AnyRow & { created_at: string };
    const b = sampleRow("drinks", trip.id, false, 1) as AnyRow & { created_at: string };
    b.created_at = "2026-10-24T10:00:00.000Z"; // earlier than a
    await persistWrites(db, trip.id, [
      { kind: "upsert", table: "drinks", row: a },
      { kind: "upsert", table: "drinks", row: b },
    ]);
    let state = await loadTripState(db, trip.id);
    expect(state.drinks.map((d) => d.id)).toEqual([b.id, a.id]);

    const changed = { ...a, hole: 9, type: "shot", photo_path: null, deleted_at: iso(), deleted_by: newId(), moved_from_hole: 1 } as AnyRow;
    await persistWrites(db, trip.id, [{ kind: "upsert", table: "drinks", row: changed }]);
    state = await loadTripState(db, trip.id);
    expect(state.drinks.find((d) => d.id === a.id)).toEqual(changed);

    // holes: 18 seeded, in number order regardless of insert order
    expect(state.holes.map((h) => h.number)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
  });

  it("applies deletes, folds repeated writes (last wins) and runs deletes before upserts", async () => {
    const trip = await newTrip();
    const player = newId();
    const teamA = newId();
    const teamB = newId();
    const m1 = { id: newId(), trip_id: trip.id, team_id: teamA, player_id: player, created_at: iso() };
    await persistWrites(db, trip.id, [{ kind: "upsert", table: "team_members", row: m1 }]);

    // Move the player: new membership listed BEFORE the delete of the old one. With unique
    // (player_id) this only works because deletes run first.
    const m2 = { id: newId(), trip_id: trip.id, team_id: teamB, player_id: player, created_at: iso() };
    const res = await persistWrites(db, trip.id, [
      { kind: "upsert", table: "team_members", row: m2 },
      { kind: "delete", table: "team_members", id: m1.id },
    ]);
    expect(res.deleted).toBe(1);
    let state = await loadTripState(db, trip.id);
    expect(state.team_members).toEqual([m2]);

    // upsert then delete of the same row in one batch → deleted; delete then upsert → present
    const temp = { ...m1, id: newId(), player_id: newId() };
    const back = { ...m1, id: newId(), player_id: newId() };
    await persistWrites(db, trip.id, [
      { kind: "upsert", table: "team_members", row: temp },
      { kind: "delete", table: "team_members", id: temp.id },
      { kind: "delete", table: "team_members", id: back.id },
      { kind: "upsert", table: "team_members", row: back },
      { kind: "upsert", table: "team_members", row: { ...back, team_id: teamA } },
    ]);
    state = await loadTripState(db, trip.id);
    expect(byId(state.team_members)).toEqual(byId([m2, { ...back, team_id: teamA }]));
  });

  it("trip writes update only the mutable trip fields (never id, code, created_at, pin hash)", async () => {
    const trip = await newTrip();
    const next: Trip = {
      ...trip,
      code: "hijacked99",
      created_at: "2000-01-01T00:00:00.000Z",
      is_demo: true,
      name: "Renamed",
      app_name: "Bogey Bros",
      status: "live",
      base_team_size: 3,
      settings: { ...trip.settings, team_match_payout: [70, 30], drink_cap: 12, team_match_ante_cents: 2000 },
      started_at: "2026-10-24T16:45:00.000Z",
      updated_at: "2026-10-24T16:45:00.001Z",
    };
    const res = await persistWrites(db, trip.id, [{ kind: "trip", row: next }]);
    expect(res.tripUpdated).toBe(true);
    const found = await findTripByCode(db, trip.code);
    expect(found?.pin_hash).toBe(PIN_HASH);
    expect(found?.trip).toEqual({ ...next, code: trip.code, created_at: trip.created_at, is_demo: trip.is_demo });
  });

  it("never touches another trip's row that shares an id; reports it as skipped", async () => {
    const t1 = await newTrip();
    const t2 = await newTrip();
    const row = sampleRow("players", t1.id, true, 0);
    await persistWrites(db, t1.id, [{ kind: "upsert", table: "players", row }]);
    const hijack = { ...row, trip_id: t2.id, name: "Hijacked" } as AnyRow;
    const res = await persistWrites(db, t2.id, [{ kind: "upsert", table: "players", row: hijack }]);
    expect(res.skipped).toEqual([{ table: "players", id: row.id, reason: "id belongs to another trip" }]);
    expect((await loadTripState(db, t1.id)).players).toEqual([row]);
    expect((await loadTripState(db, t2.id)).players).toEqual([]);
    // deletes are scoped too
    await persistWrites(db, t2.id, [{ kind: "delete", table: "players", id: row.id }]);
    expect((await loadTripState(db, t1.id)).players).toEqual([row]);
  });

  it("validates before writing anything", async () => {
    const trip = await newTrip();
    const good = sampleRow("players", trip.id, true, 0);
    const cases: Array<[string, Write]> = [
      ["id not a uuid", { kind: "upsert", table: "players", row: { ...good, id: "abc" } as AnyRow }],
      ["another trip", { kind: "upsert", table: "players", row: { ...good, id: newId(), trip_id: newId() } as AnyRow }],
      ["name is required", { kind: "upsert", table: "players", row: { ...good, id: newId(), name: null } as unknown as AnyRow }],
      ["not text", { kind: "upsert", table: "players", row: { ...good, id: newId(), name: 42 } as unknown as AnyRow }],
      ["bad value", { kind: "upsert", table: "drinks", row: { ...sampleRow("drinks", trip.id, true, 0), type: "beer" } as unknown as AnyRow }],
      ["not an integer", { kind: "upsert", table: "drinks", row: { ...sampleRow("drinks", trip.id, true, 0), hole: 2.5 } as AnyRow }],
      ["not an ISO timestamp", { kind: "upsert", table: "drinks", row: { ...sampleRow("drinks", trip.id, true, 0), logged_at: "yesterday" } as AnyRow }],
      ["integer array", { kind: "upsert", table: "team_round_state", row: { ...sampleRow("team_round_state", trip.id, true, 0), started_holes: [1, "2"] } as unknown as AnyRow }],
      ["delete id", { kind: "delete", table: "players", id: "nope" }],
      ["wrong trip", { kind: "trip", row: { ...trip, id: newId() } }],
    ];
    for (const [label, w] of cases) {
      expect(validateWrite(trip.id, w), label).not.toBeNull();
      await expect(persistWrites(db, trip.id, [{ kind: "upsert", table: "players", row: good }, w]), label).rejects.toBeInstanceOf(InvalidWriteError);
    }
    expect(validateWrite(trip.id, { kind: "upsert", table: "players", row: good })).toBeNull();
    expect((await loadTripState(db, trip.id)).players).toEqual([]); // the good row wasn't written either
  });

  it("cleans NUL characters and lone surrogates instead of failing the batch", async () => {
    const trip = await newTrip();
    const player = { ...sampleRow("players", trip.id, true, 0), name: "Sam\u0000my \ud83c", nickname: "\udc00ok" } as AnyRow;
    const event = {
      ...sampleRow("feed_events", trip.id, true, 0),
      text: "half an emoji: \ud83c",
      payload: { quote: "nul\u0000here", ["bad\ud800key"]: ["\udfff"] },
    } as AnyRow;
    const res = await persistWrites(db, trip.id, [
      { kind: "upsert", table: "players", row: player },
      { kind: "upsert", table: "feed_events", row: event },
    ]);
    expect(res.upserted).toBe(2);
    const state = await loadTripState(db, trip.id);
    expect(state.players[0].name).toBe("Sammy \ufffd");
    expect(state.players[0].nickname).toBe("\ufffdok");
    expect(state.feed_events[0].text).toBe("half an emoji: \ufffd");
    expect(state.feed_events[0].payload).toEqual({ quote: "nulhere", "bad\ufffdkey": ["\ufffd"] });
  });

  it("drops feed events whose dedupe_key is already taken instead of failing the batch", async () => {
    const trip = await newTrip();
    const ev = (key: string | null): FeedEvent => ({
      id: newId(),
      trip_id: trip.id,
      type: "lead_change",
      team_id: null,
      player_id: null,
      actor_id: null,
      payload: { hole: 4 },
      photo_path: null,
      text: null,
      dedupe_key: key,
      created_at: iso(),
      updated_at: iso(),
      deleted_at: null,
    });
    const first = ev("lead:4");
    await persistWrites(db, trip.id, [{ kind: "upsert", table: "feed_events", row: first }]);
    const dupe = ev("lead:4");
    const dupeInBatchA = ev("lead:5");
    const dupeInBatchB = ev("lead:5");
    const free1 = ev(null);
    const free2 = ev(null);
    const res = await persistWrites(db, trip.id, [
      { kind: "upsert", table: "feed_events", row: dupe },
      { kind: "upsert", table: "feed_events", row: dupeInBatchA },
      { kind: "upsert", table: "feed_events", row: dupeInBatchB },
      { kind: "upsert", table: "feed_events", row: free1 },
      { kind: "upsert", table: "feed_events", row: free2 },
      // updating the owner itself is fine
      { kind: "upsert", table: "feed_events", row: { ...first, deleted_at: iso() } },
    ]);
    expect(res.skipped.map((s) => s.id).sort()).toEqual([dupe.id, dupeInBatchB.id].sort());
    const state = await loadTripState(db, trip.id);
    expect(state.feed_events.map((e) => e.id).sort()).toEqual([first.id, dupeInBatchA.id, free1.id, free2.id].sort());
    expect(state.feed_events.find((e) => e.id === first.id)?.deleted_at).not.toBeNull();

    // insertFeedEvents: skips existing ids and dedupe keys silently
    const roast = { ...ev("roast:1"), type: "roast" as const, text: "Nice shank" };
    const inserted = await insertFeedEvents(db, trip.id, [roast, { ...ev("roast:1") }, first]);
    expect(inserted).toEqual([roast.id]);
  });

  it("readTripState gives the same result in its own read-only transaction, and works nested", async () => {
    const trip = await newTrip();
    const direct = await loadTripState(db, trip.id);
    expect(await readTripState(db, trip.id)).toEqual(direct);
    const nested = await db.tx(async (t) => {
      await lockTrip(t, trip.id);
      return readTripState(t, trip.id);
    });
    expect(nested).toEqual(direct);
    await expect(loadTripState(db, newId())).rejects.toThrow(/not found/);
  });
});

describe("unique constraints", () => {
  async function expectUnique(sql: string, params: unknown[]) {
    let code: string | undefined;
    try {
      await db.query(sql, params);
    } catch (e) {
      code = pgErrorCode(e);
    }
    expect(code, sql).toBe("23505");
  }

  it("enforces the natural keys", async () => {
    const trip = await newTrip();
    const t = trip.id;
    const pid = newId();
    const team = newId();
    const now = iso();

    await db.query("insert into team_members (id, trip_id, team_id, player_id) values ($1, $2, $3, $4)", [newId(), t, team, pid]);
    await expectUnique("insert into team_members (id, trip_id, team_id, player_id) values ($1, $2, $3, $4)", [newId(), t, newId(), pid]);

    await expectUnique("insert into holes (id, trip_id, number, par, stroke_index) values ($1, $2, 1, 4, 1)", [newId(), t]);

    await db.query("insert into team_round_state (id, trip_id, team_id) values ($1, $2, $3)", [newId(), t, team]);
    await expectUnique("insert into team_round_state (id, trip_id, team_id) values ($1, $2, $3)", [newId(), t, team]);

    await db.query("insert into hole_scores (id, trip_id, team_id, hole) values ($1, $2, $3, 1)", [newId(), t, team]);
    await expectUnique("insert into hole_scores (id, trip_id, team_id, hole) values ($1, $2, $3, 1)", [newId(), t, team]);

    await db.query("insert into pot_optouts (id, trip_id, pot_key, player_id) values ($1, $2, 'team_match', $3)", [newId(), t, pid]);
    await expectUnique("insert into pot_optouts (id, trip_id, pot_key, player_id) values ($1, $2, 'team_match', $3)", [newId(), t, pid]);

    const fe = "insert into feed_events (id, trip_id, type, dedupe_key, created_at) values ($1, $2, 'tee_off', $3, $4)";
    await db.query(fe, [newId(), t, null, now]);
    await db.query(fe, [newId(), t, null, now]); // nulls never collide
    await db.query(fe, [newId(), t, "tee:1", now]);
    await expectUnique(fe, [newId(), t, "tee:1", now]);
    const other = await newTrip();
    await db.query(fe, [newId(), other.id, "tee:1", now]); // per trip

    const ev = newId();
    await db.query("insert into reactions (id, trip_id, feed_event_id, player_id, kind) values ($1, $2, $3, $4, 'fire')", [newId(), t, ev, pid]);
    await db.query("insert into reactions (id, trip_id, feed_event_id, player_id, kind) values ($1, $2, $3, $4, 'lol')", [newId(), t, ev, pid]);
    await expectUnique("insert into reactions (id, trip_id, feed_event_id, player_id, kind) values ($1, $2, $3, $4, 'fire')", [newId(), t, ev, pid]);

    await db.query("insert into push_subscriptions (id, trip_id, player_id, endpoint, keys) values ($1, $2, $3, 'https://push/x', $4)", [newId(), t, pid, { p256dh: "a", auth: "b" }]);
    await expectUnique("insert into push_subscriptions (id, trip_id, player_id, endpoint, keys) values ($1, $2, $3, 'https://push/x', $4)", [newId(), t, newId(), { p256dh: "a", auth: "b" }]);

    await expectUnique("insert into trips (id, code, name, app_name, commissioner_pin_hash) values ($1, $2, 'x', 'y', 'h')", [newId(), trip.code]);
  });

  it("rejects bad enum values and child rows for unknown trips", async () => {
    const trip = await newTrip();
    await expect(db.query("insert into drinks (id, trip_id, team_id, player_id, hole, type, logged_at) values ($1, $2, $3, $4, 1, 'beer', now())", [newId(), trip.id, newId(), newId()])).rejects.toThrow();
    await expect(db.query("insert into players (id, trip_id, name) values ($1, $2, 'x')", [newId(), newId()])).rejects.toThrow();
  });

  it("server-only tables have defaults for id and timestamps", async () => {
    const trip = await newTrip();
    const [log] = await db.query<{ id: string; sent_at: string }>(
      "insert into push_log (trip_id, player_id, collapse_key) values ($1, $2, 'k') returning id, sent_at",
      [trip.id, newId()],
    );
    expect(log.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(log.sent_at).toMatch(/Z$/);
    const [ai] = await db.query<{ meta: unknown; n: number }>(
      "insert into ai_log (trip_id, kind, meta) values ($1, 'roast', $2) returning meta",
      [trip.id, { hole: 3 }],
    );
    expect(ai.meta).toEqual({ hole: 3 });
    const [{ n }] = await db.query<{ n: number }>("select count(*) as n from ai_log where trip_id = $1 and kind = 'roast'", [trip.id]);
    expect(n).toBe(1);
  });
});

describe("applied ops", () => {
  it("records once and looks up per trip", async () => {
    const trip = await newTrip();
    const other = await newTrip();
    const a = newId();
    const b = newId();
    const n = await recordAppliedOps(db, [
      { id: a, trip_id: trip.id, op_type: "drink.log", status: "applied" },
      { id: b, trip_id: trip.id, op_type: "score.set", status: "rejected", code: "not_live", reason: "Round hasn't started" },
      { id: a, trip_id: trip.id, op_type: "drink.log", status: "applied" }, // duplicate in batch
      { id: "garbage", trip_id: trip.id, op_type: "x", status: "applied" }, // ignored
    ]);
    expect(n).toBe(2);
    expect(await recordAppliedOps(db, [{ id: a, trip_id: trip.id, op_type: "drink.log", status: "rejected" }])).toBe(0);

    const seen = await getAppliedOps(db, trip.id, [a, b, newId(), "garbage", a.toUpperCase()]);
    expect([...seen.keys()].sort()).toEqual([a, b, a.toUpperCase()].sort());
    expect(seen.get(a)).toMatchObject({ status: "applied", op_type: "drink.log", code: null, reason: null });
    expect(seen.get(b)).toMatchObject({ status: "rejected", code: "not_live", reason: "Round hasn't started" });
    expect(await getAppliedOpIds(db, trip.id, [a, b])).toEqual(new Set([a, b]));
    expect(await getAppliedOpIds(db, other.id, [a, b])).toEqual(new Set());
    expect(await getAppliedOpIds(db, trip.id, [])).toEqual(new Set());
  });
});

// ---------------------------------------------------------------------------
// End to end with the real reducer: every effective op's writes, persisted, reproduce the state.
// ---------------------------------------------------------------------------

describe("reducer writes persist faithfully", () => {
  it("replays a setup + live round and reloads to the reducer's exact state", async () => {
    const trip = await newTrip("Reducer Trip");
    let state = await loadTripState(db, trip.id);
    let clock = Date.parse("2026-10-24T16:00:00.000Z");
    const run = async (input: OpInput, by: string | null = null) => {
      clock += 61_000;
      const at = new Date(clock).toISOString();
      const op = { ...input, id: newId(), at, by } as Op;
      const res = applyOp(state, op, { now: new Date(clock + 500).toISOString(), is_commissioner: true, side: "server" });
      if (!res.ok) throw new Error(`${op.type} rejected: ${res.code} ${res.reason}`);
      await db.tx(async (t) => {
        await lockTrip(t, trip.id);
        await persistWrites(t, trip.id, res.writes);
        await recordAppliedOps(t, [{ id: op.id, trip_id: trip.id, op_type: op.type, status: "applied" }]);
      });
      state = res.state;
      return op;
    };

    const p = Array.from({ length: 4 }, () => newId());
    const teamA = newId();
    const teamB = newId();
    await run({ type: "player.upsert", player: { id: p[0], name: "Nick", is_groom: true, venmo_handle: "@nick" } });
    await run({ type: "player.upsert", player: { id: p[1], name: "Sam", nickname: "Sammy" } });
    await run({ type: "player.upsert", player: { id: p[2], name: "Alex" } });
    await run({ type: "player.upsert", player: { id: p[3], name: "Jordan" } });
    await run({ type: "team.upsert", team: { id: teamA, name: "Team A", tee_time: "08:30" } });
    await run({ type: "team.upsert", team: { id: teamB, name: "Team B" } });
    await run({ type: "team.assign", player_id: p[0], team_id: teamB });
    await run({ type: "team.assign", player_id: p[0], team_id: teamA }); // move: delete + insert
    await run({ type: "team.assign", player_id: p[1], team_id: teamA });
    await run({ type: "team.assign", player_id: p[2], team_id: teamB });
    await run({ type: "team.assign", player_id: p[3], team_id: teamB });
    await run({ type: "pot.optout", pot_key: "team_match", player_id: p[3], out: true }, p[3]);
    await run({ type: "hole.update", hole: 3, patch: { tee_lat: 41.0951, tee_lng: -75.6472, green_lat: 41.0962, green_lng: -75.6449 } });
    await run({ type: "trip.update", patch: { settings: { team_match_ante_cents: 2000, team_match_payout: [70, 30] } } });
    await run({ type: "trip.start" });
    await run({ type: "tee.open", team_id: teamA, hole: 1 }, p[0]);
    await run({ type: "score.set", team_id: teamA, hole: 1, strokes: 4 }, p[0]);
    await run({ type: "teeshot.set", team_id: teamA, hole: 1, player_id: p[1] }, p[1]);
    const shotgun = newId();
    await run(
      { type: "drink.log", drink_id: shotgun, team_id: teamA, player_id: p[0], hole: 1, drink_type: "shotgun", photo_path: `trips/${trip.id}/drinks/${newId()}.jpg` },
      p[0],
    );
    const beer = newId();
    await run({ type: "drink.log", drink_id: beer, team_id: teamA, player_id: p[1], hole: 1, drink_type: "drink", photo_path: null }, p[1]);
    await run({ type: "mulligan.use", mulligan_id: newId(), team_id: teamA, hole: 1, source: "earned" }, p[0]);
    await run({ type: "score.set", team_id: teamA, hole: 2, strokes: 5 }, p[1]); // implicit window → hole 2
    await run({ type: "score.set", team_id: teamA, hole: 1, strokes: 3 }, p[0]); // edit
    await run({ type: "tee.open", team_id: teamA, hole: 3 }, p[0]);
    await run(
      { type: "contest.submit", entry_id: newId(), hole: 3, player_id: p[1], contest_type: "ctp", distance_value: 12.25, angle_deg: 45, lat: null, lng: null, gps_accuracy_m: null, low_accuracy: false, photo_path: null },
      p[1],
    );
    const post = newId();
    await run({ type: "post.create", event_id: post, text: "Sammy just shotgunned a Busch Light on the tee box", photo_path: null }, p[1]);
    await run({ type: "reaction.set", feed_event_id: post, player_id: p[2], kind: "fire", on: true }, p[2]);
    await run({ type: "reaction.set", feed_event_id: post, player_id: p[2], kind: "fire", on: false }, p[2]);
    await run({ type: "drink.delete", drink_id: beer }, p[1]);
    await run({ type: "round.complete", team_id: teamA }, p[0]);
    await run({ type: "trip.finalize" });

    const loaded = await loadTripState(db, trip.id);
    expect(stateById(loaded)).toEqual(stateById(state));
    expect(loaded.trip.status).toBe("final");
    expect(loaded.team_members).toHaveLength(4);
    expect(loaded.team_round_state.find((r) => r.team_id === teamA)?.started_holes).toEqual([1, 2, 3]);

    // Sanity on the bookkeeping: every op recorded.
    const [{ n }] = await db.query<{ n: number }>("select count(*) as n from applied_ops where trip_id = $1", [trip.id]);
    expect(n).toBe(31);
  });

  it("columnsOf lists every column in spec order", () => {
    expect(columnsOf("team_members")).toEqual(["id", "trip_id", "team_id", "player_id", "created_at"]);
  });
});

// Make sure a Db that is only the base interface (query + tx) works with the repo.
describe("minimal Db", () => {
  it("loadTripState accepts any Db", async () => {
    const trip = await newTrip();
    const minimal: Db = { query: (s, p) => db.query(s, p), tx: (fn, o) => db.tx(fn, o) };
    expect((await loadTripState(minimal, trip.id)).trip.id).toBe(trip.id);
  });
});
