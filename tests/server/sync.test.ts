// POST /api/t/[code]/sync called directly with Request objects against in-memory PGlite, and the
// post-commit hook registry (src/lib/server/hooks.ts).
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// next/server's after() only works inside a Next request scope: capture the scheduled tasks.
const afterMock = vi.hoisted(() => ({
  tasks: [] as Array<() => unknown>,
  impl: null as null | ((task: () => unknown) => void),
}));
vi.mock("next/server", () => ({
  after: (task: () => unknown) => {
    if (afterMock.impl) afterMock.impl(task);
    else afterMock.tasks.push(task);
  },
}));

import { createTestDb, setDbForTests, type Db, type DbConnection } from "@/lib/server/db";
import { commissionerCookieName, makeCommissionerToken } from "@/lib/server/auth";
import { createTrip } from "@/lib/server/trips";
import { loadTripState } from "@/lib/server/repo";
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  postCommitHookNames,
  registerPostCommitHook,
  runPostCommit,
  unregisterPostCommitHook,
  type PostCommitContext,
} from "@/lib/server/hooks";
import { MAX_OPS_PER_SYNC } from "@/lib/server/apply";
import { newId } from "@/lib/ids";
import type { Op, OpType, SyncResponse } from "@/lib/ops";
import type { FeedEventType, Trip } from "@/lib/types";
import { POST as syncRoute } from "@/app/api/t/[code]/sync/route";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const BASE = "http://localhost:3000";
const PIN_HASH = "scrypt$c2FsdA$aGFzaA";
const params = (code: string) => ({ params: Promise.resolve({ code }) });

type OpOf<T extends OpType> = Extract<Op, { type: T }>;
type Fields<T extends OpType> = Omit<OpOf<T>, "type" | "id" | "at" | "by"> & {
  id?: string;
  at?: string;
  by?: string | null;
  as_commissioner?: boolean;
};

// Real wall-clock times (the route uses the real server clock), a second apart, in the past.
let clientMs = Date.now() - 3 * 3600_000;
function mk<T extends OpType>(type: T, fields: Fields<T>): OpOf<T> {
  clientMs += 1000;
  return { id: newId(), at: new Date(clientMs).toISOString(), by: null, ...fields, type } as OpOf<T>;
}

function request(code: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}/api/t/${code}/sync`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function post(code: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return syncRoute(request(code, body, headers), params(code));
}

async function syncOk(code: string, ops: unknown[], headers: Record<string, string> = {}): Promise<SyncResponse> {
  const res = await post(code, { ops }, headers);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toMatch(/no-store/);
  return (await res.json()) as SyncResponse;
}

function commishCookie(tripId: string): Record<string, string> {
  return { cookie: `${commissionerCookieName(tripId)}=${makeCommissionerToken(tripId)}` };
}

interface Setup {
  trip: Trip;
  team: Record<string, string>;
  player: Record<string, string>;
  cookie: Record<string, string>;
}

/** Create a trip and set it up through the sync route with a commissioner cookie. */
async function setupTrip(teams: number[], start = true): Promise<Setup> {
  const trip = await createTrip(db, { name: "Route Sync Trip", app_name: "Scramble", pin_hash: PIN_HASH });
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
      ops.push(mk("player.upsert", { player: { id: player[label], name: `Player ${label}`, is_groom: label === "A1" } }));
      ops.push(mk("team.assign", { player_id: player[label], team_id: team[letter] }));
    }
  });
  if (start) ops.push(mk("trip.start", {}));
  const cookie = commishCookie(trip.id);
  const out = await syncOk(trip.code, ops, cookie);
  expect(out.results.filter((r) => r.status !== "applied")).toEqual([]);
  expect(afterMock.tasks).toHaveLength(1);
  afterMock.tasks.length = 0; // the setup batch's post-commit work isn't what the tests look at
  return { trip: out.snapshot.state.trip, team, player, cookie };
}

const drinkOp = (s: Setup, teamLetter: string, label: string, hole: number, type: "drink" | "shotgun" | "shot" = "drink") =>
  mk("drink.log", {
    drink_id: newId(),
    team_id: s.team[teamLetter],
    player_id: s.player[label],
    hole,
    drink_type: type,
    photo_path: null,
    by: s.player[label],
  });

const feedOf = (out: SyncResponse, type: FeedEventType) => out.snapshot.state.feed_events.filter((e) => e.type === type && e.deleted_at === null);

/** Run (and clear) the post-commit tasks the route scheduled with after(). */
async function runScheduled(): Promise<unknown[]> {
  const tasks = afterMock.tasks.splice(0);
  return Promise.all(tasks.map((t) => t()));
}

let db: DbConnection;
const registered: string[] = [];
function hook(name: string, fn: (ctx: PostCommitContext) => unknown, timeoutMs?: number) {
  registered.push(name);
  return registerPostCommitHook(name, fn, timeoutMs === undefined ? {} : { timeoutMs });
}

beforeAll(async () => {
  db = await createTestDb();
  setDbForTests(db);
});

afterAll(async () => {
  setDbForTests(null);
  await db?.close();
});

beforeEach(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "APP_SECRET", "ANTHROPIC_API_KEY", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "COMMISSIONER_PIN_HASH"]) {
    vi.stubEnv(k, "");
  }
  afterMock.tasks.length = 0;
  afterMock.impl = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setDbForTests(db);
  for (const name of registered.splice(0)) unregisterPostCommitHook(name);
});

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

describe("POST /api/t/[code]/sync: request handling", () => {
  it("404s unknown and malformed trip codes with JSON (and no-store)", async () => {
    for (const code of ["nosuchtrip1", "../etc", "a", ""]) {
      const res = await post(code, { ops: [] });
      expect(res.status, code).toBe(404);
      expect(res.headers.get("cache-control")).toMatch(/no-store/);
      expect(await res.json()).toMatchObject({ error: expect.any(String), code: "not_found" });
    }
    expect(afterMock.tasks).toHaveLength(0);
  });

  it("400s garbage: not JSON, not an object, no ops array", async () => {
    const s = await setupTrip([2, 2]);
    for (const body of ["{nope", '"ops"', "[1,2]", "null", "{}", '{"ops": {"0": 1}}', '{"ops": "all of them"}', ""]) {
      const res = await post(s.trip.code, body);
      expect(res.status, body).toBe(400);
      expect(res.headers.get("cache-control")).toMatch(/no-store/);
      expect(res.headers.get("content-type")).toMatch(/json/); // the phone splits 400 JSON batches to find a poison op
      expect((await res.json()).error, body).toEqual(expect.any(String));
    }
    expect(afterMock.tasks).toHaveLength(0);
  });

  it(`400s more than ${MAX_OPS_PER_SYNC} ops without applying any; exactly ${MAX_OPS_PER_SYNC} is fine`, async () => {
    const s = await setupTrip([2, 2]);
    const ops = Array.from({ length: MAX_OPS_PER_SYNC + 1 }, () => mk("tee.open", { team_id: s.team.A, hole: 1 }));
    const res = await post(s.trip.code, { ops });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "too_many_ops", error: expect.stringContaining(String(MAX_OPS_PER_SYNC)) });
    expect((await loadTripState(db, s.trip.id)).team_round_state.every((r) => r.open_hole === null)).toBe(true);

    const ok = await syncOk(s.trip.code, ops.slice(0, MAX_OPS_PER_SYNC));
    expect(ok.results).toHaveLength(MAX_OPS_PER_SYNC);
    expect(ok.results.every((r) => r.status === "applied")).toBe(true);
  });

  it("413s an oversized body (the phone splits the batch)", async () => {
    const s = await setupTrip([2, 2]);
    const huge = { ops: [mk("post.create", { event_id: newId(), text: "x".repeat(1100 * 1024), photo_path: null })] };
    const res = await post(s.trip.code, huge);
    expect(res.status).toBe(413);
  });

  it("an empty batch answers with the snapshot and schedules nothing", async () => {
    const s = await setupTrip([2, 2]);
    afterMock.tasks.length = 0;
    const out = await syncOk(s.trip.code, []);
    expect(out.results).toEqual([]);
    expect(out.snapshot.state).toEqual(await loadTripState(db, s.trip.id));
    expect(afterMock.tasks).toHaveLength(0);
  });

  it("answers a SyncResponse whose snapshot is the database state, and never leaks the PIN hash", async () => {
    const s = await setupTrip([4, 3]);
    const ops = [mk("tee.open", { team_id: s.team.A, hole: 1, by: s.player.A1 }), drinkOp(s, "A", "A1", 1, "shotgun")];
    const res = await post(s.trip.code, { ops });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const text = await res.text();
    expect(text).not.toContain("scrypt$");
    expect(text).not.toContain("commissioner_pin_hash");
    const out = JSON.parse(text) as SyncResponse;
    expect(Object.keys(out).sort()).toEqual(["results", "snapshot"]);
    expect(out.results).toEqual(ops.map((o) => ({ id: o.id, status: "applied" })));
    expect(out.snapshot.state).toEqual(await loadTripState(db, s.trip.id));
    expect(out.snapshot.meta).toEqual({
      server_time: expect.stringMatching(/Z$/),
      photo_base_url: "/api/photos/",
      realtime: null,
      vapid_public_key: null,
      ai_enabled: false,
      push_enabled: false,
    });
    // The snapshot already carries the new events.
    expect(feedOf(out, "tee_off")).toHaveLength(1);
    expect(feedOf(out, "shotgun")).toHaveLength(1);
  });

  it("a transient database failure is a JSON 500 and commits nothing (the phone retries the batch)", async () => {
    const s = await setupTrip([2, 2]);
    // The trip lookup works; the sync transaction dies (connection reset mid-request).
    const failing: Db = {
      query: <T,>(sql: string, p?: unknown[]) => db.query<T>(sql, p),
      tx: async () => {
        throw Object.assign(new Error("connection reset"), { code: "08006" });
      },
    };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = drinkOp(s, "A", "A1", 1);
    setDbForTests(failing);
    const res = await post(s.trip.code, { ops: [d] });
    setDbForTests(db);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "server_error" });
    expect(err).toHaveBeenCalled();
    expect(afterMock.tasks).toHaveLength(0);
    expect((await syncOk(s.trip.code, [d])).results).toEqual([{ id: d.id, status: "applied" }]);
  });
});

// ---------------------------------------------------------------------------
// Spec scenarios through the route
// ---------------------------------------------------------------------------

describe("POST /api/t/[code]/sync: scenarios", () => {
  it("Airplane mode: log 10 mixed actions, reconnect, and every action syncs exactly once", async () => {
    const s = await setupTrip([4, 3]);
    const { team, player } = s;
    const postId = newId();
    const offline: Op[] = [
      mk("tee.open", { team_id: team.A, hole: 1, by: player.A1 }),
      mk("teeshot.set", { team_id: team.A, hole: 1, player_id: player.A3, by: player.A1 }),
      drinkOp(s, "A", "A1", 1),
      drinkOp(s, "A", "A2", 1, "shotgun"),
      mk("mulligan.use", { mulligan_id: newId(), team_id: team.A, hole: 1, source: "groom", by: player.A1 }),
      mk("score.set", { team_id: team.A, hole: 1, strokes: 3, by: player.A1 }),
      mk("post.create", { event_id: postId, text: "Signal is for quitters", photo_path: null, by: player.A4 }),
      mk("reaction.set", { feed_event_id: postId, player_id: player.A2, kind: "fire", on: true, by: player.A2 }),
      mk("contest.submit", {
        entry_id: newId(),
        hole: 4,
        player_id: player.A2,
        contest_type: "ld",
        distance_value: 287,
        angle_deg: null,
        lat: 41.1,
        lng: -75.6,
        gps_accuracy_m: 4,
        low_accuracy: false,
        photo_path: null,
        by: player.A2,
      }),
      drinkOp(s, "A", "A4", 1, "shot"),
    ];
    const first = await syncOk(s.trip.code, offline);
    expect(first.results).toEqual(offline.map((o) => ({ id: o.id, status: "applied" })));
    expect(feedOf(first, "groom_mulligan")).toHaveLength(1);
    expect(feedOf(first, "score_notable").map((e) => e.payload.kind)).toContain("birdie");
    const tables = ["drinks", "mulligans", "hole_scores", "contest_entries", "reactions", "feed_events"] as const;
    const sizes = async () => {
      const st = await loadTripState(db, s.trip.id);
      return Object.fromEntries(tables.map((t) => [t, st[t].length]));
    };
    const after1 = await sizes();
    expect(after1).toMatchObject({ drinks: 3, mulligans: 1, hole_scores: 1, contest_entries: 1, reactions: 1 });

    const again = await syncOk(s.trip.code, offline);
    expect(again.results).toEqual(offline.map((o) => ({ id: o.id, status: "duplicate" })));
    expect(await sizes()).toEqual(after1);

    const fresh = [drinkOp(s, "A", "A3", 2), mk("tee.open", { team_id: team.A, hole: 2, by: player.A1 }), mk("score.set", { team_id: team.A, hole: 2, strokes: 4, by: player.A1 })];
    const mixed = [offline[9], fresh[0], offline[0], fresh[1], offline[5], fresh[2]];
    const third = await syncOk(s.trip.code, mixed);
    expect(third.results.map((r) => r.status)).toEqual(["duplicate", "applied", "duplicate", "applied", "duplicate", "applied"]);
    const after3 = await sizes();
    expect(after3).toMatchObject({ drinks: 4, hole_scores: 2, mulligans: 1, reactions: 1 });
    expect(third.snapshot.state).toEqual(await loadTripState(db, s.trip.id));
  });

  it("Two phones edit the same hole score: last write wins and the feed shows the edit", async () => {
    const s = await setupTrip([2, 2]);
    const A = s.team.A;
    await syncOk(s.trip.code, [mk("tee.open", { team_id: A, hole: 1, by: s.player.A1 })]);
    const phone1 = mk("score.set", { team_id: A, hole: 1, strokes: 6, by: s.player.A1 });
    const stale = mk("score.set", { team_id: A, hole: 1, strokes: 7, by: s.player.A1 }); // taken offline before phone 2's edit
    const phone2 = mk("score.set", { team_id: A, hole: 1, strokes: 5, by: s.player.A2 });
    await syncOk(s.trip.code, [phone1]);
    const r2 = await syncOk(s.trip.code, [phone2]);
    expect(r2.snapshot.state.hole_scores.find((h) => h.team_id === A && h.hole === 1)).toMatchObject({ strokes: 5, edit_count: 1, updated_by: s.player.A2 });
    const edits = feedOf(r2, "score_edit");
    expect(edits).toHaveLength(1);
    expect(edits[0].payload).toMatchObject({ hole: 1, from: 6, to: 5 });

    const r3 = await syncOk(s.trip.code, [stale]);
    expect(r3.results).toEqual([{ id: stale.id, status: "applied" }]);
    expect(r3.snapshot.state.hole_scores.find((h) => h.team_id === A && h.hole === 1)).toMatchObject({ strokes: 5, edit_count: 1 });
    expect(feedOf(r3, "score_edit")).toHaveLength(1);
  });

  it("commissioner-only ops: forbidden without (or with another trip's) cookie, applied with a valid one", async () => {
    const s = await setupTrip([2, 2]);
    const other = await createTrip(db, { name: "Other", app_name: "Scramble", pin_hash: PIN_HASH });
    const fix = mk("score.set", { team_id: s.team.A, hole: 3, strokes: 2, as_commissioner: true });
    const move = mk("hole.update", { hole: 3, patch: { tee_lat: 41.1, tee_lng: -75.6 } });

    const anon = await syncOk(s.trip.code, [fix, move]);
    expect(anon.results.map((r) => [r.status, r.code])).toEqual([
      ["rejected", "forbidden"],
      ["rejected", "forbidden"],
    ]);
    const forged = await syncOk(s.trip.code, [mk("hole.update", { hole: 3, patch: { tee_lat: 1, tee_lng: 1 } })], commishCookie(other.id));
    expect(forged.results[0]).toMatchObject({ status: "rejected", code: "forbidden" });
    const tampered = { cookie: `${commissionerCookieName(s.trip.id)}=${makeCommissionerToken(s.trip.id).slice(0, -2)}xx` };
    expect((await syncOk(s.trip.code, [mk("trip.finalize", {})], tampered)).results[0]).toMatchObject({ status: "rejected", code: "forbidden" });
    const expired = { cookie: `${commissionerCookieName(s.trip.id)}=${makeCommissionerToken(s.trip.id, Date.now() - 13 * 3600_000)}` };
    expect((await syncOk(s.trip.code, [mk("trip.finalize", {})], expired)).results[0]).toMatchObject({ status: "rejected", code: "forbidden" });

    const fix2 = mk("score.set", { team_id: s.team.A, hole: 3, strokes: 2, as_commissioner: true });
    const move2 = mk("hole.update", { hole: 3, patch: { tee_lat: 41.1, tee_lng: -75.6 } });
    const ok = await syncOk(s.trip.code, [fix2, move2], s.cookie);
    expect(ok.results).toEqual([
      { id: fix2.id, status: "applied" },
      { id: move2.id, status: "applied" },
    ]);
    const overrides = feedOf(ok, "commissioner_override");
    expect(overrides.map((e) => e.payload.op_type).sort()).toEqual(["hole.update", "score.set"]);
    expect(ok.snapshot.state.holes.find((h) => h.number === 3)).toMatchObject({ tee_lat: 41.1, tee_lng: -75.6 });
  });

  it("parallel requests for one trip: one tee_off, one ghost beer, every op once, no deadlock", async () => {
    const s = await setupTrip([4, 3]);
    const B = s.team.B;
    const d1 = drinkOp(s, "B", "B1", 1);
    const d2 = drinkOp(s, "B", "B2", 1);
    const d3 = drinkOp(s, "B", "B3", 1);
    const phone1 = [mk("tee.open", { team_id: B, hole: 1, by: s.player.B1 }), d1, d2, d3];
    const phone2 = [mk("tee.open", { team_id: B, hole: 1, by: s.player.B2 }), d1, d2, d3];
    const [r1, r2] = await Promise.all([syncOk(s.trip.code, phone1), syncOk(s.trip.code, phone2)]);
    for (const op of [d1, d2, d3]) {
      const statuses = [r1, r2].map((r) => r.results.find((x) => x.id === op.id)!.status).sort();
      expect(statuses).toEqual(["applied", "duplicate"]);
    }
    const state = await loadTripState(db, s.trip.id);
    expect(state.feed_events.filter((e) => e.type === "tee_off")).toHaveLength(1);
    const ghosts = state.feed_events.filter((e) => e.type === "ghost_beer");
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0].payload.drink_id).toBe(d3.drink_id);
    expect(state.drinks).toHaveLength(3);
    // Both requests scheduled their post-commit work.
    expect(afterMock.tasks).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Post-commit hooks
// ---------------------------------------------------------------------------

describe("post-commit hooks", () => {
  it("the route schedules runPostCommit with after(): broadcast + hooks get the committed batch", async () => {
    const s = await setupTrip([4, 3]);
    afterMock.tasks.length = 0;
    const seen: PostCommitContext[] = [];
    hook("test:capture", (ctx) => {
      seen.push(ctx);
    });
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service");
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 202 }));
    vi.stubGlobal("fetch", fetchSpy);

    const d = drinkOp(s, "B", "B1", 2);
    const bad = mk("hole.update", { hole: 1, patch: { par: 3 } }); // no cookie: rejected
    const dup = d;
    const out = await syncOk(s.trip.code, [d, bad, dup]);
    // Nothing runs until after the response.
    expect(seen).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(afterMock.tasks).toHaveLength(1);

    const [report] = (await runScheduled()) as Array<{ broadcast: boolean; hooks: Record<string, string> }>;
    expect(report).toEqual({ broadcast: true, hooks: { "test:capture": "ok" } });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://abc.supabase.co/realtime/v1/api/broadcast");
    expect(JSON.parse(String(init.body)).messages[0]).toMatchObject({ topic: `trip:${s.trip.id}`, event: "changed" });

    expect(seen).toHaveLength(1);
    const ctx = seen[0];
    expect(ctx.trip).toEqual(out.snapshot.state.trip);
    expect(ctx.results).toEqual(out.results);
    expect(ctx.ops.map((o) => o.id)).toEqual([d.id]);
    expect(ctx.is_commissioner).toBe(false);
    expect(ctx.state).toEqual(out.snapshot.state);
    expect(ctx.events.feed.map((e) => e.type)).toEqual(["drinks"]);
    expect(out.snapshot.state.feed_events.map((e) => e.id)).toEqual(expect.arrayContaining(ctx.events.feed.map((e) => e.id)));
  });

  it("broadcasts even for a batch of duplicates (heals phones that missed a broadcast)", async () => {
    const s = await setupTrip([2, 2]);
    const d = drinkOp(s, "A", "A1", 1);
    await syncOk(s.trip.code, [d]);
    afterMock.tasks.length = 0;
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service");
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 202 }));
    vi.stubGlobal("fetch", fetchSpy);
    const out = await syncOk(s.trip.code, [d]);
    expect(out.results).toEqual([{ id: d.id, status: "duplicate" }]);
    const [report] = (await runScheduled()) as Array<{ broadcast: boolean }>;
    expect(report.broadcast).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("runPostCommit uses an injected broadcast when given", async () => {
    const trip = { id: newId() } as Trip;
    const broadcast = vi.fn(async () => true);
    const report = await runPostCommit({ trip, events: { feed: [], roast_triggers: [], push_triggers: [] }, ops: [], results: [] }, { broadcast });
    expect(broadcast).toHaveBeenCalledWith(trip.id);
    expect(report).toEqual({ broadcast: true, hooks: {} });
  });

  it("outside a Next request scope (after() throws) the post-commit work still runs, detached", async () => {
    const s = await setupTrip([2, 2]);
    afterMock.impl = () => {
      throw new Error("`after` was called outside a request scope.");
    };
    let resolveRan!: (ctx: PostCommitContext) => void;
    const ran = new Promise<PostCommitContext>((r) => (resolveRan = r));
    hook("test:detached", (ctx) => resolveRan(ctx));
    const d = drinkOp(s, "A", "A2", 1);
    const out = await syncOk(s.trip.code, [d]);
    expect(out.results).toEqual([{ id: d.id, status: "applied" }]);
    const ctx = await ran;
    expect(ctx.ops.map((o) => o.id)).toEqual([d.id]);
  });

  it("isolates failing, rejecting and hanging hooks; never throws; reports each outcome", async () => {
    const trip = { id: newId() } as Trip;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls: string[] = [];
    hook("test:throws", () => {
      calls.push("throws");
      throw new Error("sync boom");
    });
    hook("test:rejects", async () => {
      calls.push("rejects");
      throw new Error("async boom");
    });
    hook("test:hangs", () => new Promise(() => calls.push("hangs")), 30);
    hook("test:late-failure", () => new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 60)), 20);
    hook("test:ok", async () => {
      await new Promise((r) => setTimeout(r, 5));
      calls.push("ok");
    });
    const brokenBroadcast = vi.fn(async () => {
      throw new Error("broadcast exploded");
    });
    const ctx: PostCommitContext = { trip, events: { feed: [], roast_triggers: [], push_triggers: [] }, ops: [], results: [] };
    const report = await runPostCommit(ctx, { broadcast: brokenBroadcast });
    expect(report).toEqual({
      broadcast: false,
      hooks: { "test:throws": "error", "test:rejects": "error", "test:hangs": "timeout", "test:late-failure": "timeout", "test:ok": "ok" },
    });
    expect(calls.sort()).toEqual(["hangs", "ok", "rejects", "throws"]);
    expect(brokenBroadcast).toHaveBeenCalledWith(trip.id);
    // The late rejection after the timeout is logged, not an unhandled rejection.
    await new Promise((r) => setTimeout(r, 80));
    expect(err.mock.calls.some((c) => String(c[0]).includes("test:late-failure") && String(c[0]).includes("after timing out"))).toBe(true);
  });

  it("registry: register/replace/unregister by name; the returned disposer only removes its own entry", () => {
    const before = postCommitHookNames();
    const f1 = () => {};
    const f2 = () => {};
    const dispose1 = hook("test:reg", f1);
    expect(postCommitHookNames()).toEqual([...before, "test:reg"]);
    const dispose2 = hook("test:reg", f2); // replaces
    expect(postCommitHookNames().filter((n) => n === "test:reg")).toHaveLength(1);
    dispose1(); // stale disposer: no effect on the replacement
    expect(postCommitHookNames()).toContain("test:reg");
    dispose2();
    expect(postCommitHookNames()).toEqual(before);
    expect(unregisterPostCommitHook("test:reg")).toBe(false);
    expect(() => registerPostCommitHook("", f1)).toThrow(TypeError);
    expect(() => registerPostCommitHook("x", null as unknown as () => void)).toThrow(TypeError);
    expect(DEFAULT_HOOK_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
  });

  it("hooks run concurrently with each other and with the broadcast", async () => {
    const trip = { id: newId() } as Trip;
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    hook("test:slow", async () => {
      order.push("slow:start");
      await gate;
      order.push("slow:end");
    });
    hook("test:fast", () => {
      order.push("fast");
      release();
    });
    const report = await runPostCommit(
      { trip, events: { feed: [], roast_triggers: [], push_triggers: [] }, ops: [], results: [] },
      {
        broadcast: async () => {
          order.push("broadcast");
          return true;
        },
      },
    );
    expect(report.hooks).toEqual({ "test:slow": "ok", "test:fast": "ok" });
    expect(order.indexOf("fast")).toBeLessThan(order.indexOf("slow:end"));
    expect(order).toContain("broadcast");
  });

  it("hooks.ts is safe to import from scripts: no next/server (the route does the after())", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../src/lib/server/hooks.ts"), "utf8");
    expect(src).not.toMatch(/from\s+["']next\//);
    expect(src).not.toMatch(/require\(["']next\//);
    const apply = fs.readFileSync(path.resolve(__dirname, "../../src/lib/server/apply.ts"), "utf8");
    expect(apply).not.toMatch(/from\s+["']next\//);
  });
});
