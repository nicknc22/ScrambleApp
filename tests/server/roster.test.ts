// Trip creation with a pre-loaded roster: createTripWithRoster (one transaction, the reducer's
// player rows, no feed posts) and POST /api/trips {roster} (validation, response ids, order).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, setDbForTests, type Db, type DbConnection } from "@/lib/server/db";
import { resetPinThrottle } from "@/lib/server/auth";
import { applyOpsToTrip } from "@/lib/server/apply";
import { loadTripState } from "@/lib/server/repo";
import { createTrip, createTripWithRoster, TripInputError } from "@/lib/server/trips";
import { DEFAULT_ROSTER, MAX_ROSTER_SIZE } from "@/lib/roster";
import { newId } from "@/lib/ids";
import type { Op } from "@/lib/ops";
import type { Snapshot } from "@/lib/types";
import { POST as createTripRoute } from "@/app/api/trips/route";
import { GET as stateRoute } from "@/app/api/t/[code]/state/route";

let db: DbConnection;
const PIN_HASH = "scrypt$c2FsdA$aGFzaA"; // stored only; createTrip never verifies it
const BASE = "http://localhost:3000";
const params = <T>(p: T) => ({ params: Promise.resolve(p) });
const BOYS = DEFAULT_ROSTER.map((p) => p.name);

function post(body: unknown): Promise<Response> {
  return createTripRoute(
    new Request(`${BASE}/api/trips`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  );
}

async function snapshot(code: string): Promise<Snapshot> {
  return (await (await stateRoute(new Request(`${BASE}/api/t/${code}/state`), params({ code }))).json()) as Snapshot;
}

async function tripCount(): Promise<number> {
  return (await db.query<{ n: number }>("select count(*)::int as n from trips"))[0].n;
}

/** `inner`, except any statement matching `pattern` fails (inside transactions too). */
function failingOn(inner: Db, pattern: RegExp): Db {
  return {
    query<T = Record<string, unknown>>(sql: string, p?: unknown[]): Promise<T[]> {
      return pattern.test(sql) ? Promise.reject(new Error(`injected failure: ${sql.slice(0, 40)}`)) : inner.query<T>(sql, p);
    },
    tx<T>(fn: (t: Db) => Promise<T>, opts?: Parameters<Db["tx"]>[1]): Promise<T> {
      return inner.tx((t) => fn(failingOn(t, pattern)), opts);
    },
  };
}

beforeAll(async () => {
  db = await createTestDb();
  setDbForTests(db);
});

afterAll(async () => {
  setDbForTests(null);
  await db?.close();
});

beforeEach(async () => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "APP_SECRET", "ANTHROPIC_API_KEY", "VERCEL"]) {
    vi.stubEnv(k, "");
  }
  vi.stubEnv("PUSH_DISABLED", "1");
  vi.stubEnv("COMMISSIONER_PIN_HASH", "");
  vi.stubEnv("COMMISSIONER_PIN", "2468");
  await resetPinThrottle();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createTripWithRoster", () => {
  it("creates the players with the reducer's row semantics, in roster order, one groom", async () => {
    const now = new Date("2026-10-13T18:00:00.000Z");
    const { trip, players } = await createTripWithRoster(db, {
      name: "Roster Trip",
      app_name: "Scramble",
      pin_hash: PIN_HASH,
      roster: DEFAULT_ROSTER,
      now,
    });
    expect(players.map((p) => p.name)).toEqual(BOYS);

    const state = await loadTripState(db, trip.id);
    expect(state.trip.status).toBe("setup");
    expect(state.holes).toHaveLength(18);
    // Raw row order (created_at, id) is roster order too: each player is 1 ms after the previous.
    expect(state.players.map((p) => p.name)).toEqual(BOYS);
    expect(state.players.map((p) => p.id)).toEqual(players.map((p) => p.id));
    state.players.forEach((p, i) => {
      expect(p).toEqual({
        id: players[i].id,
        trip_id: trip.id,
        name: BOYS[i],
        nickname: null,
        venmo_handle: null,
        is_groom: i === 0,
        muted_push: false,
        sort_order: i,
        created_at: new Date(now.getTime() + i).toISOString(),
        deleted_at: null,
      });
    });
    // Setup-time roster adds post nothing; no teams, memberships or applied ops either.
    expect(state.feed_events).toEqual([]);
    expect(state.teams).toEqual([]);
    expect(state.team_members).toEqual([]);
    expect((await db.query("select id from applied_ops where trip_id = $1", [trip.id])).length).toBe(0);
  });

  it("matches what adding the same players in Setup produces (rows and feed)", async () => {
    const seeded = await createTripWithRoster(db, { name: "Seeded", app_name: "Scramble", pin_hash: PIN_HASH, roster: [{ name: "Caster", is_groom: true }, "Joe"] });
    const manual = await createTrip(db, { name: "Manual", app_name: "Scramble", pin_hash: PIN_HASH });
    const at = new Date().toISOString();
    const ops: Op[] = ["Caster", "Joe"].map((name, i) => ({
      id: newId(),
      at,
      by: null,
      type: "player.upsert",
      player: { id: newId(), name, is_groom: i === 0 },
    }));
    const out = await applyOpsToTrip({ db, trip: manual, ops, isCommissioner: true });
    expect(out.results.map((r) => r.status)).toEqual(["applied", "applied"]);
    expect(out.events.feed).toEqual([]);

    // (Compared in sort_order: the manual ops share one timestamp, so their raw row order is by id.)
    const strip = (rows: { name: string; is_groom: boolean; sort_order: number; nickname: string | null; muted_push: boolean }[]) =>
      [...rows]
        .sort((x, y) => x.sort_order - y.sort_order)
        .map(({ name, is_groom, sort_order, nickname, muted_push }) => ({ name, is_groom, sort_order, nickname, muted_push }));
    const a = await loadTripState(db, seeded.trip.id);
    const b = await loadTripState(db, manual.id);
    expect(strip(a.players)).toEqual(strip(b.players));
    expect(a.feed_events).toEqual(b.feed_events);
  });

  it("no roster (or an empty one) still creates an empty trip", async () => {
    for (const roster of [undefined, []]) {
      const { trip, players } = await createTripWithRoster(db, { name: "Empty", app_name: "Scramble", pin_hash: PIN_HASH, roster });
      expect(players).toEqual([]);
      expect((await loadTripState(db, trip.id)).players).toEqual([]);
    }
  });

  it("rejects a bad roster before writing anything", async () => {
    const before = await tripCount();
    for (const roster of [["Joe", "joe"], [{ name: "A", is_groom: true }, { name: "B", is_groom: true }], [""]]) {
      await expect(createTripWithRoster(db, { name: "Bad", app_name: "Scramble", pin_hash: PIN_HASH, roster })).rejects.toBeInstanceOf(TripInputError);
    }
    expect(await tripCount()).toBe(before);
  });

  it("is atomic: a failing player insert leaves no trip (and no holes) behind", async () => {
    const before = await tripCount();
    const flaky = failingOn(db, /insert into "players"/);
    await expect(
      createTripWithRoster(flaky, { name: "Doomed", app_name: "Scramble", pin_hash: PIN_HASH, roster: DEFAULT_ROSTER, code: "doomedtrip" }),
    ).rejects.toThrow(/injected failure/);
    expect(await tripCount()).toBe(before);
    expect(await db.query("select id from trips where code = 'doomedtrip'")).toEqual([]);
    // ...and the same code works once the database behaves.
    const ok = await createTripWithRoster(db, { name: "Fine", app_name: "Scramble", pin_hash: PIN_HASH, roster: DEFAULT_ROSTER, code: "doomedtrip" });
    expect(ok.players).toHaveLength(BOYS.length);
  });
});

describe("POST /api/trips with a roster", () => {
  it("creates the players in order and returns their ids; the groom is set", async () => {
    const res = await post({
      pin: "2468",
      name: "Jack Frost Bachelor",
      roster: DEFAULT_ROSTER.map((p) => ({ name: p.name, is_groom: !!p.is_groom })),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.url).toBe(`/t/${body.code}`);
    expect(body.players.map((p: { name: string }) => p.name)).toEqual(BOYS);
    for (const p of body.players) expect(Object.keys(p).sort()).toEqual(["id", "name"]);

    const snap = await snapshot(body.code);
    const byId = new Map(snap.state.players.map((p) => [p.id, p]));
    body.players.forEach((p: { id: string; name: string }, i: number) => {
      expect(byId.get(p.id)?.name).toBe(p.name);
      expect(byId.get(p.id)?.sort_order).toBe(i);
    });
    expect(snap.state.players.filter((p) => p.is_groom).map((p) => p.name)).toEqual(["Caster"]);
  });

  it("tolerates plain strings (no groom)", async () => {
    const res = await post({ pin: "2468", name: "Strings", roster: ["Joe", "  Greg  ", "Rich"] });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.players.map((p: { name: string }) => p.name)).toEqual(["Joe", "Greg", "Rich"]);
    expect((await snapshot(body.code)).state.players.some((p) => p.is_groom)).toBe(false);
  });

  it("no roster: works exactly as before (players: [])", async () => {
    const res = await post({ pin: "2468", name: "No Roster" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.players).toEqual([]);
    expect((await snapshot(body.code)).state.players).toEqual([]);
  });

  it("400s two grooms, bad types, blank names, duplicates and too many players, creating nothing", async () => {
    const before = await tripCount();
    const cases: Array<[unknown, RegExp]> = [
      [[{ name: "Caster", is_groom: true }, { name: "Joe", is_groom: true }], /Two grooms/],
      ["Caster, Joe", /list of names/],
      [{ Caster: true }, /list of names/],
      [["Joe", 42], /Player 2/],
      [[{ name: null }], /needs a name/],
      [[{ name: "Joe", is_groom: "true" }], /groom flag/],
      [["Joe", "   "], /needs a name/],
      [["Joe", "JOE"], /twice/],
      [Array.from({ length: MAX_ROSTER_SIZE + 1 }, (_, i) => `Guy ${i}`), /max/],
    ];
    for (const [roster, msg] of cases) {
      const res = await post({ pin: "2468", name: "Bad Roster", roster });
      expect(res.status, JSON.stringify(roster).slice(0, 60)).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("invalid");
      expect(body.error).toMatch(msg);
    }
    expect(await tripCount()).toBe(before);
  });

  it("a bad roster is refused before the PIN is checked (no throttle strike)", async () => {
    const res = await post({ pin: "0000", name: "Bad Both", roster: "nope" });
    expect(res.status).toBe(400);
    const rows = await db.query<{ n: number }>("select count(*)::int as n from pin_failures where trip_id is null");
    expect(rows[0].n).toBe(0);
    // The wrong PIN with a good roster is still a 401.
    expect((await post({ pin: "0000", name: "Wrong PIN", roster: ["Joe"] })).status).toBe(401);
  });
});
