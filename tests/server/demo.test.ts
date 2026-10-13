// Demo mode: simulated rounds through the real sync pipeline, reset, pruning and POST /api/demo.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, setDbForTests, type DbConnection } from "@/lib/server/db";
import { hashPin, resetPinThrottle } from "@/lib/server/auth";
import { applyOpsToTrip } from "@/lib/server/apply";
import {
  claimDemoSlot,
  createDemoTrip,
  DEMO_CREATES_PER_HOUR,
  DEMO_PHOTO_ASSETS,
  DEMO_PIN,
  DemoError,
  demoCourseLayout,
  demoPhotoBytes,
  demoRateLimit,
  demoTripId,
  pruneDemoTrips,
  resetDemoRateLimit,
  resetDemoTrip,
  type DemoResult,
} from "@/lib/server/demo";
import { findTripByCode, loadTripState } from "@/lib/server/repo";
import { putPhoto, readLocalPhoto } from "@/lib/server/storage";
import { createTrip } from "@/lib/server/trips";
import { derive } from "@/lib/engine";
import { haversineYards } from "@/lib/engine/geo";
import { JACK_FROST_HOLES } from "@/lib/course";
import { newId } from "@/lib/ids";
import type { FeedEventType, TripState } from "@/lib/types";
import { POST as demoRoute } from "@/app/api/demo/route";
import { GET as commCheck, POST as commUnlock } from "@/app/api/t/[code]/commissioner/route";

let db: DbConnection;
let uploads: string;

const BASE = "http://localhost:3000";
const NOW = new Date("2026-10-24T21:30:00.000Z");

function demoReq(body: unknown, ip = "10.1.1.1"): Request {
  return new Request(`${BASE}/api/demo`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

function cookiePair(res: Response): string {
  const sc = res.headers.get("set-cookie");
  expect(sc).toBeTruthy();
  return sc!.split(";")[0];
}

async function stateOf(r: DemoResult): Promise<TripState> {
  return loadTripState(db, r.trip.id);
}

const activeFeed = (s: TripState) => s.feed_events.filter((e) => e.deleted_at === null);
const feedTypes = (s: TripState) => new Set(activeFeed(s).map((e) => e.type));

/** Local mode: no Supabase, no AI/push, photos in a temp dir. Stubbed for the whole file (nested
 *  beforeAll hooks create demos with photos, and they run before any beforeEach). */
function localEnv(): void {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "APP_SECRET", "ANTHROPIC_API_KEY", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "COMMISSIONER_PIN_HASH"]) {
    vi.stubEnv(k, "");
  }
  vi.stubEnv("UPLOADS_DIR", uploads);
}

beforeAll(async () => {
  db = await createTestDb();
  setDbForTests(db);
  uploads = fs.mkdtempSync(path.join(os.tmpdir(), "scramble-demo-uploads-"));
  localEnv();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  setDbForTests(null);
  await db?.close();
  fs.rmSync(uploads, { recursive: true, force: true });
});

beforeEach(async () => {
  localEnv();
  resetDemoRateLimit();
  await resetPinThrottle();
  await db.query("delete from demo_creations");
});

const JUNK = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const filesUnder = (tripId: string): string[] => {
  const dir = path.join(uploads, "trips", tripId);
  return fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name) : [];
};


describe("demo course layout", () => {
  it("puts a tee and green on every hole, tee to green = the Membership yardage", () => {
    const layout = demoCourseLayout();
    expect(layout).toHaveLength(18);
    for (const h of layout) {
      const seed = JACK_FROST_HOLES[h.hole - 1];
      expect(Math.abs(haversineYards(h.tee, h.green) - seed.yardage.membership)).toBeLessThanOrEqual(2);
      // Within ~1.5 km of the clubhouse.
      expect(Math.abs(h.tee.lat - 41.0948)).toBeLessThan(0.015);
      expect(Math.abs(h.tee.lng + 75.648)).toBeLessThan(0.02);
    }
  });

  it("embeds real JPEGs", () => {
    for (const a of DEMO_PHOTO_ASSETS) {
      const b = demoPhotoBytes(a);
      expect(b.byteLength).toBeGreaterThan(1000);
      expect([b[0], b[1], b[2]]).toEqual([0xff, 0xd8, 0xff]);
      expect([b[b.length - 2], b[b.length - 1]]).toEqual([0xff, 0xd9]);
    }
  });
});

describe("createDemoTrip", () => {
  let partial: DemoResult;
  let ps: TripState;

  beforeAll(async () => {
    partial = await createDemoTrip(db, { mode: "partial", now: NOW });
    ps = await loadTripState(db, partial.trip.id);
  });

  it("partial: a live demo trip built only from accepted ops", () => {
    expect(partial.stats.rejected).toEqual([]);
    expect(partial.stats.applied).toBe(partial.stats.ops);
    expect(partial.stats.batches).toBeGreaterThan(40);
    expect(partial.code).toMatch(/^demo[a-z0-9]{8}$/);
    expect(partial.url).toBe(`/t/${partial.code}`);
    expect(ps.trip).toMatchObject({ name: "Demo Scramble", is_demo: true, status: "live", id: demoTripId(partial.code) });
    expect(ps.trip.settings.team_match_ante_cents).toBe(2000);
    expect(ps.trip.settings.contest_ante_cents).toBe(500);
    expect(ps.trip.settings.team_match_payout).toEqual([70, 30]);
  });

  it("partial: 10 players with nicknames and fake venmo handles, one groom Nick, teams of 4/3/3", () => {
    const d = derive(ps, { strict: true });
    expect(d.players).toHaveLength(10);
    expect(d.players.every((p) => p.nickname && p.venmo_handle && /NotReal/.test(p.venmo_handle))).toBe(true);
    const grooms = d.players.filter((p) => p.is_groom);
    expect(grooms.map((p) => p.name)).toEqual(["Nick"]);
    expect(d.teams.map((t) => d.teamSize[t.id])).toEqual([4, 3, 3]);
    expect(d.teams.every((t) => t.tee_time !== null)).toBe(true);
    expect(Object.keys(d.teamOfPlayer)).toHaveLength(10);
    // Every hole has tee and green points; Kevin sits out one pot.
    expect(ps.holes.every((h) => h.tee_lat !== null && h.green_lng !== null)).toBe(true);
    expect(ps.pot_optouts.filter((o) => o.deleted_at === null)).toHaveLength(1);
  });

  it("partial: teams mid-round on different holes with the round live", () => {
    const d = derive(ps, { strict: true });
    const open = d.teams.map((t) => d.openWindow[t.id]);
    expect(open).toEqual([15, 12, 7]);
    for (const t of d.teams) {
      const row = d.standings.find((r) => r.team_id === t.id)!;
      expect(row.status).toBe("playing");
      expect(row.thru).toBe(d.openWindow[t.id]! - 1);
    }
    // Simulated time ends before "now" (nothing from the future).
    const latest = Math.max(...ps.feed_events.map((e) => Date.parse(e.created_at)));
    expect(latest).toBeLessThanOrEqual(NOW.getTime());
    expect(latest).toBeGreaterThan(NOW.getTime() - 15 * 60_000);
  });

  it("partial: the feed has ghost beers, a drive miss, the Groom's Mulligan, a score edit and a commissioner override", () => {
    const types = feedTypes(ps);
    for (const t of [
      "round_started",
      "tee_off",
      "drinks",
      "shotgun",
      "shot",
      "ghost_beer",
      "drive_miss",
      "groom_mulligan",
      "mulligan_used",
      "score_edit",
      "commissioner_override",
      "score_notable",
      "lead_change",
      "contest_entry",
      "post",
    ] as FeedEventType[]) {
      expect(types, t).toContain(t);
    }
    const feed = activeFeed(ps);
    expect(feed.filter((e) => e.type === "groom_mulligan")).toHaveLength(1);
    expect(feed.filter((e) => e.type === "drive_miss")).toHaveLength(1);
    const edit = feed.find((e) => e.type === "score_edit")!;
    expect(edit.payload).toMatchObject({ hole: 5, from: 5, to: 4 });
    const override = feed.find((e) => e.type === "commissioner_override")!;
    expect(override.payload.op_type).toBe("score.set");
    // Some birdies and a double.
    const kinds = feed.filter((e) => e.type === "score_notable").map((e) => e.payload.kind);
    expect(kinds).toContain("birdie");
    expect(kinds).toContain("double");
    // People react.
    expect(ps.reactions.filter((r) => r.deleted_at === null).length).toBeGreaterThan(5);
  });

  it("partial: drinks, mulligans and contest entries look like a real round", async () => {
    const d = derive(ps, { strict: true });
    const drinks = ps.drinks.filter((x) => x.deleted_at === null);
    const byType = (t: string) => drinks.filter((x) => x.type === t).length;
    expect(byType("drink")).toBeGreaterThan(byType("shotgun") + byType("shot"));
    expect(byType("shotgun") + byType("shot")).toBeGreaterThan(0);
    expect(Object.values(d.drinkValues).some((v) => v.ghost)).toBe(true);
    // A drink logged by a teammate.
    expect(drinks.some((x) => x.logged_by !== null && x.logged_by !== x.player_id)).toBe(true);

    const groom = ps.mulligans.filter((m) => m.source === "groom" && m.deleted_at === null);
    expect(groom).toHaveLength(1);
    expect(d.mulligans[groom[0].team_id].groom_used).toBe(true);
    expect(Object.values(d.mulligans).every((b) => b.used_earned <= b.earned)).toBe(true);

    const entries = ps.contest_entries.filter((e) => e.deleted_at === null);
    for (const e of entries.filter((x) => x.type === "ctp")) {
      expect(e.distance_value).toBeGreaterThanOrEqual(2);
      expect(e.distance_value).toBeLessThanOrEqual(40);
      expect(e.angle_deg).not.toBeNull();
    }
    for (const e of entries.filter((x) => x.type === "ld")) {
      const hole = ps.holes.find((h) => h.number === e.hole)!;
      expect(hole.par).toBe(5);
      const yd = haversineYards({ lat: hole.tee_lat!, lng: hole.tee_lng! }, { lat: e.lat!, lng: e.lng! });
      expect(yd).toBeGreaterThanOrEqual(220);
      expect(yd).toBeLessThanOrEqual(320);
      expect(Math.abs(yd - e.distance_value)).toBeLessThanOrEqual(1);
    }
    // One weak-GPS drive waits for the commissioner.
    expect(entries.filter((e) => e.status === "flagged")).toHaveLength(1);
    expect(d.contests.every((c) => c.entries.length > 0 || c.hole >= 16)).toBe(true);

    // Scores around par.
    for (const s of ps.hole_scores.filter((x) => x.strokes !== null)) {
      const par = ps.holes.find((h) => h.number === s.hole)!.par;
      expect(s.strokes! - par).toBeGreaterThanOrEqual(-2);
      expect(s.strokes! - par).toBeLessThanOrEqual(2);
    }

    // Photos were stored and are readable.
    const paths = [
      ...drinks.map((x) => x.photo_path),
      ...entries.map((x) => x.photo_path),
      ...ps.feed_events.filter((e) => e.type === "post").map((e) => e.photo_path),
    ].filter((p): p is string => !!p);
    expect(paths.length).toBe(partial.stats.photos);
    expect(paths.length).toBeGreaterThan(5);
    for (const p of paths.slice(0, 5)) {
      const bytes = await readLocalPhoto(p);
      expect(bytes?.[0]).toBe(0xff);
    }
  });

  it("partial: projected money sums to zero and pending contest holes stay out of the ledger", () => {
    const d = derive(ps, { strict: true });
    expect(d.money.final).toBe(false);
    expect(d.money.ledger.reduce((a, r) => a + r.net_cents, 0)).toBe(0);
    expect(d.money.pots.find((p) => p.key === "contest:18")!.status).toBe("pending");
  });

  it("full: every team plays 18, the trip is final and the ledger sums to zero", async () => {
    const full = await createDemoTrip(db, { mode: "full", now: NOW });
    expect(full.stats.rejected).toEqual([]);
    const s = await stateOf(full);
    expect(s.trip.status).toBe("final");
    expect(s.trip.finalized_at).not.toBeNull();
    const d = derive(s, { strict: true });
    expect(d.standings.map((r) => [r.thru, r.status])).toEqual([
      [18, "complete"],
      [18, "complete"],
      [18, "complete"],
    ]);
    expect(d.money.final).toBe(true);
    expect(d.money.ledger.reduce((a, r) => a + r.net_cents, 0)).toBe(0);
    expect(d.money.pots.every((p) => p.status !== "pending")).toBe(true);
    const paid = d.money.payments.reduce((a, p) => a + p.amount_cents, 0);
    const owed = d.money.ledger.filter((r) => r.net_cents > 0).reduce((a, r) => a + r.net_cents, 0);
    expect(paid).toBe(owed);
    // The weak-GPS drive was approved before finalizing.
    expect(s.contest_entries.filter((e) => e.deleted_at === null && e.status === "flagged")).toHaveLength(0);

    const types = feedTypes(s);
    for (const t of ["ghost_beer", "drive_miss", "groom_mulligan", "score_edit", "commissioner_override", "round_complete", "final_results"] as FeedEventType[]) {
      expect(types, t).toContain(t);
    }
    expect(activeFeed(s).filter((e) => e.type === "round_complete")).toHaveLength(3);
    expect(d.awards.find((a) => a.key === "champions")!.awarded).toBe(true);
    expect(d.awards.find((a) => a.key === "longest_drive")!.photo_path).not.toBeNull();
    expect(d.awards.find((a) => a.key === "closest_pin")!.photo_path).not.toBeNull();
  });

  it("setup: roster, teams, pots and course ready, round not started", async () => {
    const setup = await createDemoTrip(db, { mode: "setup", now: NOW, photos: false });
    expect(setup.stats.rejected).toEqual([]);
    const s = await stateOf(setup);
    expect(s.trip.status).toBe("setup");
    expect(s.team_round_state).toHaveLength(0);
    expect(s.hole_scores).toHaveLength(0);
    expect(s.players.filter((p) => !p.deleted_at)).toHaveLength(10);
    expect(s.holes.every((h) => h.tee_lat !== null)).toBe(true);
    const d = derive(s, { strict: true });
    expect(d.teams.map((t) => d.teamSize[t.id])).toEqual([4, 3, 3]);
  });

  it("is deterministic for a seed and varies with it", async () => {
    const a = await createDemoTrip(db, { mode: "partial", code: "demoseeda", seed: 7, now: NOW, photos: false });
    const b = await createDemoTrip(db, { mode: "partial", code: "demoseedb", seed: 7, now: NOW, photos: false });
    const c = await createDemoTrip(db, { mode: "partial", code: "demoseedc", seed: 8, now: NOW, photos: false });
    const card = async (r: DemoResult) =>
      (await stateOf(r)).hole_scores.map((x) => `${x.hole}:${x.strokes}`).sort().join(",");
    expect(await card(a)).toBe(await card(b));
    expect(await card(c)).not.toBe(await card(a));
  });

  it("refuses a code that's taken", async () => {
    await expect(createDemoTrip(db, { mode: "setup", code: partial.code, now: NOW })).rejects.toMatchObject({ status: 409 });
    await expect(createDemoTrip(db, { mode: "setup", code: "x!", now: NOW })).rejects.toBeInstanceOf(DemoError);
  });
});

describe("resetDemoTrip", () => {
  it("keeps the code (and trip id) and wipes every old row", async () => {
    const first = await createDemoTrip(db, { mode: "partial", code: "demoreset1", now: NOW, photos: false });
    const before = await stateOf(first);
    // Somebody plays on in the demo: a post that isn't part of the simulation.
    const extra = newId();
    const nick = before.players.find((p) => p.name === "Nick")!;
    const out = await applyOpsToTrip({
      db,
      trip: first.trip,
      ops: [{ id: newId(), type: "post.create", event_id: extra, text: "this should vanish", photo_path: null, at: new Date().toISOString(), by: nick.id }],
      isCommissioner: false,
    });
    expect(out.results[0].status).toBe("applied");

    const again = await resetDemoTrip(db, "demoreset1", { mode: "full", now: NOW, photos: false });
    expect(again.code).toBe("demoreset1");
    expect(again.trip.id).toBe(first.trip.id);
    const after = await stateOf(again);
    expect(after.trip.status).toBe("final");
    expect(after.feed_events.some((e) => e.id === extra)).toBe(false);
    // Player ids survive the reset, so phones stay "logged in".
    expect(after.players.map((p) => p.id).sort()).toEqual(before.players.map((p) => p.id).sort());
    const rows = await db.query<{ n: number }>("select count(*)::int as n from trips where code = $1", ["demoreset1"]);
    expect(rows[0].n).toBe(1);
    // No duplicate rows from the first round (e.g. 3 round_complete events, not more).
    expect(after.feed_events.filter((e) => e.type === "round_complete")).toHaveLength(3);
    const applied = await db.query<{ n: number }>("select count(*)::int as n from applied_ops where trip_id = $1", [after.trip.id]);
    expect(applied[0].n).toBe(again.stats.ops);
  });

  it("never touches a real trip, and 404s an unknown code", async () => {
    const real = await createTrip(db, { name: "The Real One", app_name: "Scramble", pin_hash: await hashPin("2468") });
    await expect(resetDemoTrip(db, real.code, { mode: "partial" })).rejects.toMatchObject({ status: 403, code: "not_demo" });
    expect(await findTripByCode(db, real.code)).not.toBeNull();
    await expect(resetDemoTrip(db, "nosuchdemo", { mode: "partial" })).rejects.toMatchObject({ status: 404 });
  });

  it("pruneDemoTrips drops demos older than 48 hours, with their photos; never real trips", async () => {
    const old = await createDemoTrip(db, { mode: "setup", code: "demoold01", now: new Date(NOW.getTime() - 50 * 3600_000), photos: false });
    const young = await createDemoTrip(db, { mode: "setup", code: "demoyoung1", now: new Date(NOW.getTime() - 30 * 3600_000), photos: false });
    const real = await createTrip(db, {
      name: "Old real trip",
      app_name: "Scramble",
      pin_hash: await hashPin("2468"),
      now: new Date(NOW.getTime() - 30 * 24 * 3600_000),
    });
    // Somebody uploaded junk into the old demo.
    await putPhoto(old.trip.id, `trips/${old.trip.id}/posts/${newId()}.jpg`, JUNK);
    expect(filesUnder(old.trip.id)).toHaveLength(1);
    const n = await pruneDemoTrips(db, { now: NOW });
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await findTripByCode(db, old.code)).toBeNull();
    expect(filesUnder(old.trip.id)).toEqual([]);
    expect(await findTripByCode(db, young.code)).not.toBeNull();
    expect(await findTripByCode(db, real.code)).not.toBeNull();
  });

  it("a reset clears the old trip's photos (uploads included) before re-seeding", async () => {
    const first = await createDemoTrip(db, { mode: "full", code: "demophotos1", now: NOW });
    const seeded = filesUnder(first.trip.id).length;
    expect(seeded).toBeGreaterThan(0);
    await putPhoto(first.trip.id, `trips/${first.trip.id}/posts/${newId()}.jpg`, JUNK);
    expect(filesUnder(first.trip.id)).toHaveLength(seeded + 1);
    await resetDemoTrip(db, "demophotos1", { mode: "full", now: NOW });
    expect(filesUnder(first.trip.id)).toHaveLength(seeded);
    await resetDemoTrip(db, "demophotos1", { mode: "setup", now: NOW });
    expect(filesUnder(first.trip.id)).toEqual([]);
  });
});

describe("POST /api/demo", () => {
  it("no code → 201 new partial demo + a commissioner cookie that works (PIN 0000 too)", async () => {
    const res = await demoRoute(demoReq({}));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { code: string; trip_id: string; url: string; mode: string };
    expect(body.code).toMatch(/^demo/);
    expect(body.url).toBe(`/t/${body.code}`);
    expect(body.mode).toBe("partial");
    const found = await findTripByCode(db, body.code);
    expect(found?.trip).toMatchObject({ is_demo: true, status: "live" });

    const cookie = cookiePair(res);
    const ctx = { params: Promise.resolve({ code: body.code }) };
    const check = await commCheck(new Request(`${BASE}/api/t/${body.code}/commissioner`, { headers: { cookie } }), ctx);
    expect(await check.json()).toEqual({ is_commissioner: true });

    const unlock = await commUnlock(
      new Request(`${BASE}/api/t/${body.code}/commissioner`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin: DEMO_PIN }),
      }),
      { params: Promise.resolve({ code: body.code }) },
    );
    expect(unlock.status).toBe(200);
  });

  it("code of a demo → 200 reset (same code), mode full", async () => {
    const created = await createDemoTrip(db, { mode: "setup", code: "demoroute1", now: NOW, photos: false });
    const res = await demoRoute(demoReq({ code: "DemoRoute1", mode: "full" }, "10.1.1.2"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: string; trip_id: string; mode: string };
    expect(body).toMatchObject({ code: "demoroute1", trip_id: created.trip.id, mode: "full" });
    expect(res.headers.get("set-cookie")).toContain("scramble_comm_");
    expect((await findTripByCode(db, "demoroute1"))?.trip.status).toBe("final");
  });

  it("code of a real trip → 403; unknown → 404; bad input → 400", async () => {
    const real = await createTrip(db, { name: "Saturday", app_name: "Scramble", pin_hash: await hashPin("2468") });
    const forbidden = await demoRoute(demoReq({ code: real.code }, "10.1.1.3"));
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get("set-cookie")).toBeNull();
    expect((await findTripByCode(db, real.code))?.trip.is_demo).toBe(false);

    expect((await demoRoute(demoReq({ code: "nosuchdemo2" }, "10.1.1.3"))).status).toBe(404);
    expect((await demoRoute(demoReq({ mode: "bogus" }, "10.1.1.3"))).status).toBe(400);
    expect((await demoRoute(demoReq({ code: "../etc" }, "10.1.1.3"))).status).toBe(400);
  });

  it("caps demo creates + resets per hour for everyone together (in the database)", async () => {
    const t0 = new Date("2026-10-20T10:00:00.000Z");
    for (let i = 0; i < DEMO_CREATES_PER_HOUR; i++) expect(await claimDemoSlot(db, `10.7.${i}.1`, new Date(t0.getTime() + i * 1000))).toBe(0);
    const wait = await claimDemoSlot(db, "10.7.200.1", new Date(t0.getTime() + 60_000));
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(3600);
    expect(await claimDemoSlot(db, "10.7.200.1", new Date(t0.getTime() + 3601_000))).toBe(0);

    // Through the route: a fresh client still gets 429 while the hour is full.
    await db.query("delete from demo_creations");
    await db.query(
      "insert into demo_creations (client, created_at) select 'x', now() from generate_series(1, $1::int)",
      [DEMO_CREATES_PER_HOUR],
    );
    const res = await demoRoute(demoReq({}, "10.1.77.1"));
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: "throttled", retry_after: expect.any(Number) });
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("rate limits per client", async () => {
    for (let i = 0; i < 6; i++) expect(demoRateLimit("10.9.9.9", NOW.getTime() + i)).toBe(0);
    expect(demoRateLimit("10.9.9.9", NOW.getTime() + 10)).toBeGreaterThan(0);
    expect(demoRateLimit("10.9.9.8", NOW.getTime() + 10)).toBe(0);
    expect(demoRateLimit("10.9.9.9", NOW.getTime() + 61_000)).toBe(0);

    resetDemoRateLimit();
    for (let i = 0; i < 6; i++) demoRateLimit("10.1.1.9");
    const res = await demoRoute(demoReq({}, "10.1.1.9"));
    expect(res.status).toBe(429);
    expect(((await res.json()) as { code: string }).code).toBe("throttled");
  });
});
