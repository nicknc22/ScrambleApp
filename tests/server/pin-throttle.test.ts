// The wrong-PIN throttle under concurrency: a burst of simultaneous guesses must never check more
// PINs than the limits allow (the attempt is reserved before the slow scrypt check runs), and the
// shared buckets only ever cost the real commissioner a short wait.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, setDbForTests, type DbConnection } from "@/lib/server/db";
import {
  attemptPin,
  hashPin,
  MAX_FAILS_PER_CLIENT,
  MAX_FAILS_PER_TRIP,
  MAX_FAILS_PER_TRIP_DAY,
  PIN_SLOW_SPACING_MS,
  pinRetryAfter,
  resetPinThrottle,
} from "@/lib/server/auth";
import { createTrip } from "@/lib/server/trips";
import type { Trip } from "@/lib/types";
import { POST as createTripRoute } from "@/app/api/trips/route";
import { DELETE as commLock, POST as commUnlock, PUT as commChangePin } from "@/app/api/t/[code]/commissioner/route";

let db: DbConnection;
let pinHash: string;

const BASE = "http://localhost:3000";
const params = <T>(p: T) => ({ params: Promise.resolve(p) });
const jsonReq = (url: string, method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(BASE + url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

function tally(responses: Response[]): Record<number, number> {
  const out: Record<number, number> = {};
  for (const r of responses) out[r.status] = (out[r.status] ?? 0) + 1;
  return out;
}

const deviceCookie = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .find((c) => c.startsWith("scramble_dev_"))!;

async function trip(): Promise<Trip> {
  return createTrip(db, { name: "Burst Trip", app_name: "Scramble", pin_hash: pinHash });
}

beforeAll(async () => {
  db = await createTestDb();
  setDbForTests(db);
  pinHash = await hashPin("2468");
});

afterAll(async () => {
  setDbForTests(null);
  await db?.close();
});

beforeEach(async () => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "APP_SECRET", "VERCEL"]) vi.stubEnv(k, "");
  vi.stubEnv("COMMISSIONER_PIN_HASH", "");
  await resetPinThrottle(db);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("attemptPin", () => {
  it("checks at most the per-client limit when 50 guesses arrive at once", async () => {
    const t = await trip();
    let checked = 0;
    const verify = async () => {
      checked++;
      await new Promise((r) => setTimeout(r, 5)); // scrypt is slow; let the others pile up
      return false;
    };
    const results = await Promise.all(Array.from({ length: 50 }, () => attemptPin(db, t.id, "6.6.6.6", verify)));
    expect(checked).toBe(MAX_FAILS_PER_CLIENT);
    expect(results.filter((r) => r.status === "wrong")).toHaveLength(MAX_FAILS_PER_CLIENT);
    expect(results.filter((r) => r.status === "throttled")).toHaveLength(50 - MAX_FAILS_PER_CLIENT);
    const rows = await db.query<{ n: number }>("select count(*)::int as n from pin_failures where trip_id = $1", [t.id]);
    expect(rows[0].n).toBe(MAX_FAILS_PER_CLIENT);
  });

  it("the right PIN removes its reservation and clears the client's bucket", async () => {
    const t = await trip();
    for (let i = 0; i < 3; i++) expect((await attemptPin(db, t.id, "7.7.7.7", async () => false)).status).toBe("wrong");
    expect(await attemptPin(db, t.id, "7.7.7.7", async () => true)).toEqual({ status: "ok" });
    const rows = await db.query("select 1 from pin_failures where trip_id = $1", [t.id]);
    expect(rows).toEqual([]);
  });

  it("a throttled attempt reserves nothing and never runs the check", async () => {
    const t = await trip();
    for (let i = 0; i < MAX_FAILS_PER_CLIENT; i++) await attemptPin(db, t.id, "8.8.8.8", async () => false);
    const verify = vi.fn(async () => true);
    const r = await attemptPin(db, t.id, "8.8.8.8", verify);
    expect(r).toEqual({ status: "throttled", retryAfter: expect.any(Number) });
    expect(verify).not.toHaveBeenCalled();
    const rows = await db.query<{ n: number }>("select count(*)::int as n from pin_failures where trip_id = $1", [t.id]);
    expect(rows[0].n).toBe(MAX_FAILS_PER_CLIENT);
  });
});

describe("unlock burst from one client", () => {
  it("50 simultaneous wrong PINs: exactly 8 are checked (401), the rest get 429", async () => {
    const t = await trip();
    const url = `/api/t/${t.code}/commissioner`;
    const burst = await Promise.all(
      Array.from({ length: 50 }, (_, i) => commUnlock(jsonReq(url, "POST", { pin: String(100000 + i) }, { "x-forwarded-for": "6.6.6.6" }), params({ code: t.code }))),
    );
    expect(tally(burst)).toEqual({ 401: MAX_FAILS_PER_CLIENT, 429: 50 - MAX_FAILS_PER_CLIENT });
    // ...and the right PIN after the burst is throttled too, with no cookie.
    const late = await commUnlock(jsonReq(url, "POST", { pin: "2468" }, { "x-forwarded-for": "6.6.6.6" }), params({ code: t.code }));
    expect(late.status).toBe(429);
    expect(late.headers.get("set-cookie")).toBeNull();
  });

  it("once the burst filled the bucket, a second burst with the right PIN in it gets nothing", async () => {
    const t = await trip();
    const url = `/api/t/${t.code}/commissioner`;
    const p = params({ code: t.code });
    const send = (pin: string) => commUnlock(jsonReq(url, "POST", { pin }, { "x-forwarded-for": "6.6.6.7" }), p);
    await Promise.all(Array.from({ length: 20 }, (_, i) => send(String(200000 + i))));
    const second = await Promise.all(Array.from({ length: 20 }, (_, i) => send(i % 5 === 0 ? "2468" : String(210000 + i))));
    expect(tally(second)).toEqual({ 429: 20 });
    for (const r of second) expect(r.headers.get("set-cookie")).toBeNull();
  });

  it("a PIN-change burst can't brute-force the PIN either", async () => {
    const t = await trip();
    const url = `/api/t/${t.code}/commissioner`;
    const burst = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        commChangePin(jsonReq(url, "PUT", { pin: String(300000 + i), new_pin: "135791" }, { "x-forwarded-for": "6.6.6.8" }), params({ code: t.code })),
      ),
    );
    expect(tally(burst)).toEqual({ 401: MAX_FAILS_PER_CLIENT, 429: 40 - MAX_FAILS_PER_CLIENT });
  });

  it("trip creation: a burst against COMMISSIONER_PIN_HASH checks at most 8", async () => {
    vi.stubEnv("COMMISSIONER_PIN_HASH", pinHash);
    const burst = await Promise.all(
      Array.from({ length: 40 }, (_, i) => createTripRoute(jsonReq("/api/trips", "POST", { pin: String(400000 + i) }, { "x-forwarded-for": "6.6.6.9" }))),
    );
    expect(tally(burst)).toEqual({ 401: MAX_FAILS_PER_CLIENT, 429: 40 - MAX_FAILS_PER_CLIENT });
    const rows = await db.query<{ n: number }>("select count(*)::int as n from pin_failures where trip_id is null");
    expect(rows[0].n).toBe(MAX_FAILS_PER_CLIENT);
  });
});

describe("shared buckets: a slow global cap, never a long lockout", () => {
  it("a burst from 100 rotating IPs checks at most the trip-wide 10-minute cap", async () => {
    const t = await trip();
    const url = `/api/t/${t.code}/commissioner`;
    const burst = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        commUnlock(jsonReq(url, "POST", { pin: String(500000 + i) }, { "x-forwarded-for": `198.18.${i}.1` }), params({ code: t.code })),
      ),
    );
    expect(tally(burst)).toEqual({ 401: MAX_FAILS_PER_TRIP, 429: 100 - MAX_FAILS_PER_TRIP });
    // The commissioner on a NEW device (no trusted cookie) waits minutes, not a day.
    const nick = await commUnlock(jsonReq(url, "POST", { pin: "2468" }, { "x-forwarded-for": "203.0.113.50" }), params({ code: t.code }));
    expect(nick.status).toBe(429);
    const body = await nick.json();
    expect(body.retry_after).toBeLessThanOrEqual(600);
    expect(body.error).toMatch(/\d+ minutes?|seconds?/);
  });

  it("past 100 shared failures a day, one attempt per 10 minutes instead of a 24 h lockout", async () => {
    const t = await trip();
    const now = Date.parse("2026-10-24T12:00:00Z");
    // 100 wrong guesses spread over 20 hours from rotating IPs (never 30 within 10 minutes).
    for (let i = 0; i < MAX_FAILS_PER_TRIP_DAY; i++) {
      expect((await attemptPin(db, t.id, `172.16.${i}.1`, async () => false, { now: now + i * 12 * 60_000 })).status).toBe("wrong");
    }
    const last = now + (MAX_FAILS_PER_TRIP_DAY - 1) * 12 * 60_000;
    // Right after the last guess: a short wait (not hours)...
    const wait = await pinRetryAfter(db, t.id, "203.0.113.51", { now: last + 60_000 });
    expect(wait).toBe((PIN_SLOW_SPACING_MS - 60_000) / 1000);
    // ...and once the spacing has passed, the next attempt (the commissioner's) is checked.
    expect(await attemptPin(db, t.id, "203.0.113.51", async () => true, { now: last + PIN_SLOW_SPACING_MS })).toEqual({ status: "ok" });
    // A scripted guesser still gets only one attempt per spacing.
    expect((await attemptPin(db, t.id, "172.16.200.1", async () => false, { now: last + PIN_SLOW_SPACING_MS + 1000 })).status).toBe("wrong");
    expect((await attemptPin(db, t.id, "172.16.201.1", async () => false, { now: last + PIN_SLOW_SPACING_MS + 2000 })).status).toBe("throttled");
  });

  it("trip creation: strangers can't lock the commissioner out for long", async () => {
    vi.stubEnv("COMMISSIONER_PIN_HASH", pinHash);
    // 4 strangers x 8 wrong guesses (no trip link needed for this endpoint).
    for (let s = 0; s < 4; s++) {
      for (let i = 0; i < MAX_FAILS_PER_CLIENT; i++) await createTripRoute(jsonReq("/api/trips", "POST", { pin: String(600000 + s * 10 + i) }, { "x-forwarded-for": `192.0.2.${s}` }));
    }
    const nick = await createTripRoute(jsonReq("/api/trips", "POST", { pin: "2468" }, { "x-forwarded-for": "203.0.113.52" }));
    expect(nick.status).toBe(429);
    expect((await nick.json()).retry_after).toBeLessThanOrEqual(600);
  });

  it("Lock keeps the device trusted, so the commissioner's phone isn't caught by other people's guesses", async () => {
    const t = await trip();
    const url = `/api/t/${t.code}/commissioner`;
    const p = params({ code: t.code });
    const unlocked = await commUnlock(jsonReq(url, "POST", { pin: "2468" }, { "x-forwarded-for": "203.0.113.53" }), p);
    const device = deviceCookie(unlocked);
    const lock = await commLock(jsonReq(url, "DELETE", undefined, { cookie: device }), p);
    expect(lock.headers.getSetCookie()).toEqual([expect.stringMatching(/^scramble_comm_[^=]+=; .*Max-Age=0/)]);
    for (let i = 0; i < MAX_FAILS_PER_TRIP; i++) {
      await commUnlock(jsonReq(url, "POST", { pin: String(700000 + i) }, { "x-forwarded-for": `198.19.${i}.1` }), p);
    }
    expect((await commUnlock(jsonReq(url, "POST", { pin: "2468" }, { cookie: device, "x-forwarded-for": "203.0.113.53" }), p)).status).toBe(200);
  });
});
