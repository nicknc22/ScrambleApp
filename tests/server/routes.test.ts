// Route handlers called directly with Request objects against an in-memory PGlite.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, openDb, setDbForTests, type DbConnection } from "@/lib/server/db";
import { hashPin, resetPinThrottle } from "@/lib/server/auth";
import { createTrip } from "@/lib/server/trips";
import { broadcastTripChanged, isJwtKey, realtimeMeta } from "@/lib/server/realtime";
import { MAX_PHOTO_BYTES, PHOTO_QUOTA, photoBaseUrl, putPhoto, readLocalPhoto } from "@/lib/server/storage";
import { ConfigError } from "@/lib/server/env";
import { newId } from "@/lib/ids";
import type { Snapshot, Trip } from "@/lib/types";
import { POST as createTripRoute } from "@/app/api/trips/route";
import { GET as stateRoute } from "@/app/api/t/[code]/state/route";
import { POST as uploadRoute } from "@/app/api/t/[code]/upload/route";
import { GET as photoRoute } from "@/app/api/photos/[...path]/route";
import {
  DELETE as commLock,
  GET as commCheck,
  POST as commUnlock,
  PUT as commChangePin,
} from "@/app/api/t/[code]/commissioner/route";

let db: DbConnection;
let uploads: string;
let pinHash: string;

const BASE = "http://localhost:3000";
const params = <T>(p: T) => ({ params: Promise.resolve(p) });

function jsonReq(url: string, method: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(BASE + url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** "name=value" from a Set-Cookie header, for sending back. */
function cookiePair(res: Response): string {
  const sc = res.headers.get("set-cookie");
  expect(sc).toBeTruthy();
  return sc!.split(";")[0];
}

async function trip(name = "Route Trip"): Promise<Trip> {
  return createTrip(db, { name, app_name: "Scramble", pin_hash: pinHash });
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 2, 3, 4, 0xff, 0xd9]);

beforeAll(async () => {
  db = await createTestDb();
  setDbForTests(db);
  pinHash = await hashPin("2468");
  uploads = fs.mkdtempSync(path.join(os.tmpdir(), "scramble-uploads-"));
});

afterAll(async () => {
  setDbForTests(null);
  await db?.close();
  fs.rmSync(uploads, { recursive: true, force: true });
});

beforeEach(async () => {
  // Local mode: no Supabase, uploads in a temp dir.
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "APP_SECRET", "ANTHROPIC_API_KEY", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VERCEL"]) {
    vi.stubEnv(k, "");
  }
  vi.stubEnv("UPLOADS_DIR", uploads);
  vi.stubEnv("COMMISSIONER_PIN_HASH", "");
  await resetPinThrottle();
});

/** Every "name=value" a response sets, by name. */
function setCookies(res: Response): Map<string, string> {
  const out = new Map<string, string>();
  for (const sc of res.headers.getSetCookie()) {
    const pair = sc.split(";")[0];
    out.set(pair.slice(0, pair.indexOf("=")), pair);
  }
  return out;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/trips", () => {
  it("with COMMISSIONER_PIN_HASH: wrong PIN → 401, right PIN → 201 + code + commissioner cookie", async () => {
    vi.stubEnv("COMMISSIONER_PIN_HASH", pinHash);
    const bad = await createTripRoute(jsonReq("/api/trips", "POST", { pin: "1111", name: "Nope" }));
    expect(bad.status).toBe(401);
    expect((await bad.json()).error).toMatch(/PIN/);

    const res = await createTripRoute(jsonReq("/api/trips", "POST", { pin: "2468", name: "Jack Frost Bachelor" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.code).toMatch(/^[a-z2-9]{10}$/);
    expect(body.url).toBe(`/t/${body.code}`);
    const cookie = cookiePair(res);
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly; SameSite=Lax; Max-Age=43200/);
    // ...and the creating phone is a trusted device for this trip (60 days).
    expect([...setCookies(res).keys()]).toEqual([cookie.split("=")[0], expect.stringMatching(/^scramble_dev_/)]);
    expect(res.headers.getSetCookie()[1]).toMatch(/Max-Age=5184000/);

    // The trip exists, uses the env hash, and the cookie makes us commissioner.
    const st = await stateRoute(jsonReq(`/api/t/${body.code}/state`, "GET"), params({ code: body.code }));
    const snap = (await st.json()) as Snapshot;
    expect(snap.state.trip.name).toBe("Jack Frost Bachelor");
    expect(snap.state.trip.app_name).toBe("Scramble");
    const check = await commCheck(jsonReq(`/api/t/${body.code}/commissioner`, "GET", undefined, { cookie }), params({ code: body.code }));
    expect(await check.json()).toEqual({ is_commissioner: true });
    const unlock = await commUnlock(jsonReq(`/api/t/${body.code}/commissioner`, "POST", { pin: "2468" }), params({ code: body.code }));
    expect(unlock.status).toBe(200);
  });

  it("explains a COMMISSIONER_PIN_HASH mangled by .env $-expansion instead of saying 'wrong PIN'", async () => {
    vi.stubEnv("COMMISSIONER_PIN_HASH", "scrypt");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await createTripRoute(jsonReq("/api/trips", "POST", { pin: "2468" }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/\\\$/);
    err.mockRestore();
  });

  it("throttles repeated wrong PINs with 429 (in the database)", async () => {
    vi.stubEnv("COMMISSIONER_PIN_HASH", pinHash);
    for (let i = 0; i < 8; i++) {
      expect((await createTripRoute(jsonReq("/api/trips", "POST", { pin: "0000" }))).status).toBe(401);
    }
    const res = await createTripRoute(jsonReq("/api/trips", "POST", { pin: "2468" }));
    expect(res.status).toBe(429);
    const rows = await db.query<{ n: number }>("select count(*)::int as n from pin_failures where trip_id is null");
    expect(rows[0].n).toBe(8);
  });

  it("without COMMISSIONER_PIN_HASH in dev: the trip's PIN is the one given; defaults the names", async () => {
    expect((await createTripRoute(jsonReq("/api/trips", "POST", { pin: "12" }))).status).toBe(400);
    const res = await createTripRoute(jsonReq("/api/trips", "POST", { pin: "9753" }));
    expect(res.status).toBe(201);
    const { code } = await res.json();
    const snap = (await (await stateRoute(jsonReq(`/api/t/${code}/state`, "GET"), params({ code }))).json()) as Snapshot;
    expect(snap.state.trip.name).toBe("Jack Frost Scramble");
    expect(snap.state.trip.app_name).toBe("Scramble");
    expect((await commUnlock(jsonReq(`/api/t/${code}/commissioner`, "POST", { pin: "9753" }), params({ code }))).status).toBe(200);
    expect((await commUnlock(jsonReq(`/api/t/${code}/commissioner`, "POST", { pin: "2468" }), params({ code }))).status).toBe(401);
  });

  it("without COMMISSIONER_PIN_HASH in production: refuses", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await createTripRoute(jsonReq("/api/trips", "POST", { pin: "2468" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/COMMISSIONER_PIN_HASH/);
  });

  it("rejects non-JSON bodies", async () => {
    const res = await createTripRoute(new Request(BASE + "/api/trips", { method: "POST", body: "pin=1234" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBeTruthy();
  });
});

describe("GET /api/t/[code]/state", () => {
  it("returns the snapshot with meta, no-store, and never the PIN hash", async () => {
    const t = await trip();
    const res = await stateRoute(jsonReq(`/api/t/${t.code}/state`, "GET"), params({ code: t.code }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    const text = await res.text();
    expect(text).not.toContain("scrypt$");
    expect(text).not.toContain("commissioner_pin_hash");
    const snap = JSON.parse(text) as Snapshot;
    expect(snap.state.trip).toEqual(t);
    expect(snap.state.holes).toHaveLength(18);
    for (const k of ["players", "teams", "team_members", "team_round_state", "hole_scores", "drinks", "mulligans", "contest_entries", "pot_optouts", "feed_events", "reactions"] as const) {
      expect(snap.state[k], k).toEqual([]);
    }
    expect(snap.meta).toEqual({
      server_time: expect.stringMatching(/Z$/),
      photo_base_url: "/api/photos/",
      realtime: null,
      vapid_public_key: null,
      ai_enabled: false,
      push_enabled: false,
    });
  });

  it("normalizes the code (case, whitespace, url-encoding)", async () => {
    const t = await trip();
    const res = await stateRoute(jsonReq(`/api/t/x/state`, "GET"), params({ code: encodeURIComponent(` ${t.code.toUpperCase()} `) }));
    expect(res.status).toBe(200);
  });

  it("404s unknown and malformed codes with JSON", async () => {
    for (const code of ["nosuchtrip1", "../etc", "a", "x".repeat(100), ""]) {
      const res = await stateRoute(jsonReq(`/api/t/x/state`, "GET"), params({ code }));
      expect(res.status, code).toBe(404);
      expect((await res.json()).error).toBeTruthy();
    }
  });

  it("reports Supabase realtime, storage URL, push and AI in meta when configured", async () => {
    const t = await trip();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co/");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service");
    vi.stubEnv("VAPID_PUBLIC_KEY", "vapid-pub");
    vi.stubEnv("VAPID_PRIVATE_KEY", "vapid-priv");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant");
    const snap = (await (await stateRoute(jsonReq(`/api/t/${t.code}/state`, "GET"), params({ code: t.code }))).json()) as Snapshot;
    expect(snap.meta).toMatchObject({
      photo_base_url: "https://abc.supabase.co/storage/v1/object/public/photos/",
      realtime: { url: "https://abc.supabase.co", anon_key: "anon", topic: `trip:${t.id}` },
      vapid_public_key: "vapid-pub",
      ai_enabled: true,
      push_enabled: true,
    });
    expect(JSON.stringify(snap)).not.toContain("service");
    expect(JSON.stringify(snap)).not.toContain("vapid-priv");
  });
});

describe("/api/t/[code]/commissioner", () => {
  it("unlocks with the PIN, checks, locks; cookies don't cross trips", async () => {
    const t = await trip();
    const other = await trip("Other");
    const url = `/api/t/${t.code}/commissioner`;
    const p = params({ code: t.code });

    expect(await (await commCheck(jsonReq(url, "GET"), p)).json()).toEqual({ is_commissioner: false });

    const wrong = await commUnlock(jsonReq(url, "POST", { pin: "1357" }), p);
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();
    expect((await wrong.json()).error).toBeTruthy();
    expect((await commUnlock(jsonReq(url, "POST", {}), p)).status).toBe(401);

    const ok = await commUnlock(jsonReq(url, "POST", { pin: "2468" }), p);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true });
    const cookie = cookiePair(ok);

    expect(await (await commCheck(jsonReq(url, "GET", undefined, { cookie }), p)).json()).toEqual({ is_commissioner: true });
    const otherCheck = await commCheck(jsonReq(`/api/t/${other.code}/commissioner`, "GET", undefined, { cookie }), params({ code: other.code }));
    expect(await otherCheck.json()).toEqual({ is_commissioner: false });

    const lock = await commLock(jsonReq(url, "DELETE", undefined, { cookie }), p);
    expect(lock.status).toBe(200);
    expect(lock.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    // Locking clears the commissioner cookie only: the phone stays a trusted device (that grants
    // nothing without the PIN) so other people's wrong guesses can't keep it waiting later.
    expect(lock.headers.getSetCookie()).toEqual([expect.stringMatching(/^scramble_comm_[^=]+=; .*Max-Age=0/)]);
    const cleared = cookiePair(lock);
    expect(await (await commCheck(jsonReq(url, "GET", undefined, { cookie: cleared }), p)).json()).toEqual({ is_commissioner: false });
  });

  it("changes the PIN after verifying the current one", async () => {
    const t = await trip();
    const url = `/api/t/${t.code}/commissioner`;
    const p = params({ code: t.code });
    expect((await commChangePin(jsonReq(url, "PUT", { pin: "2468", new_pin: "12" }), p)).status).toBe(400);
    expect((await commChangePin(jsonReq(url, "PUT", { pin: "2468", new_pin: "12ab" }), p)).status).toBe(400);
    expect((await commChangePin(jsonReq(url, "PUT", { pin: "0000", new_pin: "8642" }), p)).status).toBe(401);
    const ok = await commChangePin(jsonReq(url, "PUT", { pin: "2468", new_pin: "8642" }), p);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toMatch(/^scramble_comm_/);
    expect((await commUnlock(jsonReq(url, "POST", { pin: "2468" }), p)).status).toBe(401);
    expect((await commUnlock(jsonReq(url, "POST", { pin: "8642" }), p)).status).toBe(200);
    // The PIN change must not leak into the snapshot
    const text = await (await stateRoute(jsonReq(`/api/t/${t.code}/state`, "GET"), p)).text();
    expect(text).not.toContain("scrypt$");
  });

  it("a PIN change revokes every commissioner cookie issued for the old PIN (except the changer's new one)", async () => {
    const t = await trip();
    const url = `/api/t/${t.code}/commissioner`;
    const p = params({ code: t.code });
    // Nick unlocks on a friend's phone and forgets to lock it...
    const friend = cookiePair(await commUnlock(jsonReq(url, "POST", { pin: "2468" }), p));
    const nick = cookiePair(await commUnlock(jsonReq(url, "POST", { pin: "2468" }), p));
    expect(await (await commCheck(jsonReq(url, "GET", undefined, { cookie: friend }), p)).json()).toEqual({ is_commissioner: true });
    // ...then changes the PIN from his own phone.
    const changed = await commChangePin(jsonReq(url, "PUT", { pin: "2468", new_pin: "97531" }, { cookie: nick }), p);
    expect(changed.status).toBe(200);
    const fresh = cookiePair(changed);
    expect(await (await commCheck(jsonReq(url, "GET", undefined, { cookie: friend }), p)).json()).toEqual({ is_commissioner: false });
    expect(await (await commCheck(jsonReq(url, "GET", undefined, { cookie: nick }), p)).json()).toEqual({ is_commissioner: false });
    expect(await (await commCheck(jsonReq(url, "GET", undefined, { cookie: fresh }), p)).json()).toEqual({ is_commissioner: true });
  });

  it("accepts a 12-digit PIN end to end (the unlock pad allows 12 too)", async () => {
    const t = await trip();
    const url = `/api/t/${t.code}/commissioner`;
    const p = params({ code: t.code });
    expect((await commChangePin(jsonReq(url, "PUT", { pin: "2468", new_pin: "555123456789" }), p)).status).toBe(200);
    expect((await commUnlock(jsonReq(url, "POST", { pin: "55512345" }), p)).status).toBe(401);
    expect((await commUnlock(jsonReq(url, "POST", { pin: "555123456789" }), p)).status).toBe(200);
    expect((await commChangePin(jsonReq(url, "PUT", { pin: "555123456789", new_pin: "5551234567890" }), p)).status).toBe(400);
  });

  it("griefers can't lock out the commissioner's trusted device; everyone else gets 429 even with the right PIN", async () => {
    const t = await trip();
    const url = `/api/t/${t.code}/commissioner`;
    const p = params({ code: t.code });
    // The commissioner unlocked on his phone once: it's now a trusted device.
    const first = await commUnlock(jsonReq(url, "POST", { pin: "2468" }, { "x-forwarded-for": "203.0.113.9" }), p);
    const device = [...setCookies(first).entries()].find(([k]) => k.startsWith("scramble_dev_"))![1];

    // Five friends x 8 wrong guesses (and a scripted guesser rotating IPs).
    for (let f = 0; f < 5; f++) {
      for (let i = 0; i < 8; i++) await commUnlock(jsonReq(url, "POST", { pin: String(1000 + f * 8 + i) }, { "x-forwarded-for": `198.51.100.${f}` }), p);
    }
    // A stranger with the right PIN: throttled before the PIN is even checked (no oracle, no cookie).
    const stranger = await commUnlock(jsonReq(url, "POST", { pin: "2468" }, { "x-forwarded-for": "192.0.2.77" }), p);
    expect(stranger.status).toBe(429);
    expect(stranger.headers.get("set-cookie")).toBeNull();
    const strangerWrong = await commUnlock(jsonReq(url, "POST", { pin: "9999" }, { "x-forwarded-for": "192.0.2.78" }), p);
    expect(strangerWrong.status).toBe(429);

    // His session expired; his phone (same clubhouse IP as a griefer, even) still unlocks.
    const back = await commUnlock(jsonReq(url, "POST", { pin: "2468" }, { cookie: device, "x-forwarded-for": "198.51.100.0" }), p);
    expect(back.status).toBe(200);
    expect(await (await commCheck(jsonReq(url, "GET", undefined, { cookie: cookiePair(back) }), p)).json()).toEqual({ is_commissioner: true });
    // ...and can change the PIN.
    const changed = await commChangePin(jsonReq(url, "PUT", { pin: "2468", new_pin: "86420" }, { cookie: device }), p);
    expect(changed.status).toBe(200);
    // The old PIN's device cookie is revoked with the PIN; the response re-trusts this phone.
    expect((await commUnlock(jsonReq(url, "POST", { pin: "86420" }, { cookie: device }), p)).status).toBe(429);
    const retrusted = [...setCookies(changed).entries()].find(([k]) => k.startsWith("scramble_dev_"))![1];
    expect((await commUnlock(jsonReq(url, "POST", { pin: "86420" }, { cookie: retrusted }), p)).status).toBe(200);
  });

  it("a trusted device still has its own wrong-PIN limit", async () => {
    const t = await trip();
    const url = `/api/t/${t.code}/commissioner`;
    const p = params({ code: t.code });
    const device = [...setCookies(await commUnlock(jsonReq(url, "POST", { pin: "2468" }), p)).entries()].find(([k]) => k.startsWith("scramble_dev_"))![1];
    for (let i = 0; i < 8; i++) {
      expect((await commUnlock(jsonReq(url, "POST", { pin: String(3000 + i) }, { cookie: device, "x-forwarded-for": `10.9.${i}.1` }), p)).status).toBe(401);
    }
    expect((await commUnlock(jsonReq(url, "POST", { pin: "2468" }, { cookie: device, "x-forwarded-for": "10.9.99.1" }), p)).status).toBe(429);
  });

  it("throttles PIN guessing per client with 429, other clients unaffected", async () => {
    const t = await trip();
    const url = `/api/t/${t.code}/commissioner`;
    const p = params({ code: t.code });
    const from = (ip: string, pin: string) => commUnlock(jsonReq(url, "POST", { pin }, { "x-forwarded-for": ip }), p);
    for (let i = 0; i < 8; i++) expect((await from("1.1.1.1", String(1000 + i))).status).toBe(401);
    const blocked = await from("1.1.1.1", "2468");
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).retry_after).toBeGreaterThan(0);
    expect((await from("2.2.2.2", "2468")).status).toBe(200);
  });

  it("404s for unknown trips", async () => {
    const res = await commUnlock(jsonReq(`/api/t/nope/commissioner`, "POST", { pin: "2468" }), params({ code: "nopenopenope" }));
    expect(res.status).toBe(404);
  });
});

describe("uploads and local photos", () => {
  const upload = (code: string, p: string | null, body: BodyInit | null, type = "image/jpeg") =>
    uploadRoute(
      new Request(`${BASE}/api/t/${code}/upload${p === null ? "" : `?path=${encodeURIComponent(p)}`}`, {
        method: "POST",
        headers: type ? { "content-type": type } : {},
        body,
      }),
      params({ code }),
    );
  const getPhoto = (p: string) => photoRoute(new Request(`${BASE}/api/photos/${p}`), params({ path: p.split("/") }));

  it("stores a JPEG and serves it back with immutable caching; a re-upload of other bytes is refused", async () => {
    const t = await trip();
    const p = `trips/${t.id}/drinks/${newId()}.jpg`;
    const res = await upload(t.code, p, JPEG);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: p });
    expect(fs.existsSync(path.join(uploads, p))).toBe(true);

    const got = await getPhoto(p);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/jpeg");
    expect(got.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(JPEG);

    // Photos are write-once evidence: other bytes → 409, the same bytes (a retry) → 200.
    const v2 = new Uint8Array([...JPEG.slice(0, -2), 9, 9, 0xff, 0xd9]);
    expect((await upload(t.code, p, v2)).status).toBe(409);
    expect((await upload(t.code, p, JPEG)).status).toBe(200);
    expect(new Uint8Array(await (await getPhoto(p)).arrayBuffer())).toEqual(JPEG);
    expect(fs.readdirSync(path.dirname(path.join(uploads, p))).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("rejects bad paths (400), other trips' paths (400), wrong types (415), empty (400) and too big (413)", async () => {
    const t = await trip();
    const other = await trip("Other");
    const good = `trips/${t.id}/posts/${newId()}.jpg`;
    expect((await upload(t.code, null, JPEG)).status).toBe(400);
    for (const bad of [
      `trips/${t.id}/selfies/${newId()}.jpg`,
      `trips/${t.id}/posts/${newId()}.png`,
      `trips/${t.id}/posts/not-a-uuid.jpg`,
      `trips/${t.id}/../${other.id}/posts/${newId()}.jpg`,
      `/trips/${t.id}/posts/${newId()}.jpg`,
      `trips/${other.id}/posts/${newId()}.jpg`,
    ]) {
      expect((await upload(t.code, bad, JPEG)).status, bad).toBe(400);
    }
    expect((await upload(t.code, good, JPEG, "text/html")).status).toBe(415);
    expect((await upload(t.code, good, new TextEncoder().encode("<html>"))).status).toBe(415);
    expect((await upload(t.code, good, new Uint8Array(0))).status).toBe(400);
    // 4 MB max: Vercel refuses bodies over 4.5 MB before the handler runs.
    expect(MAX_PHOTO_BYTES).toBe(4 * 1024 * 1024);
    const big = new Uint8Array(MAX_PHOTO_BYTES + 1);
    big.set(JPEG.slice(0, 4));
    expect((await upload(t.code, good, big)).status).toBe(413);
    // FF D8 FF and then not a JPEG marker: junk with a JPEG-looking prefix.
    expect((await upload(t.code, good, new Uint8Array([0xff, 0xd8, 0xff, 0x00, 1, 2, 3]))).status).toBe(415);
    expect((await upload("nosuchtrip9", good, JPEG)).status).toBe(404);
    expect(await readLocalPhoto(good)).toBeNull();
  });

  it("caps photos per trip (800; 80 on a demo trip), but a retry of a stored path always goes through", async () => {
    const t = await trip();
    const p = (kind = "drinks") => `trips/${t.id}/${kind}/${newId()}.jpg`;
    const first = p();
    expect((await upload(t.code, first, JPEG)).status).toBe(200);
    const recorded = await db.query<{ path: string; bytes: number }>("select path, bytes from photo_uploads where trip_id = $1", [t.id]);
    expect(recorded).toEqual([{ path: first, bytes: JPEG.length }]);
    // Fill the trip up to the cap.
    await db.query(
      `insert into photo_uploads (trip_id, path, bytes)
       select $1::uuid, 'trips/' || $1::text || '/posts/' || gen_random_uuid() || '.jpg', 1000 from generate_series(1, $2::int)`,
      [t.id, PHOTO_QUOTA.real.files - 1],
    );
    const full = await upload(t.code, p(), JPEG);
    expect(full.status).toBe(413); // permanent for the phone's outbox: it stops retrying
    expect(await full.json()).toMatchObject({ code: "photo_quota" });
    expect((await upload(t.code, first, JPEG)).status).toBe(200); // idempotent retry
    // Other trips are unaffected.
    const other = await trip("Other");
    expect((await upload(other.code, `trips/${other.id}/posts/${newId()}.jpg`, JPEG)).status).toBe(200);

    const demo = await createTrip(db, { name: "Demo", app_name: "Scramble", pin_hash: pinHash, is_demo: true });
    for (let i = 0; i < PHOTO_QUOTA.demo.files; i++) {
      await db.query("insert into photo_uploads (trip_id, path, bytes) values ($1, $2, 10)", [demo.id, `trips/${demo.id}/posts/${newId()}.jpg`]);
    }
    expect((await upload(demo.code, `trips/${demo.id}/posts/${newId()}.jpg`, JPEG)).status).toBe(413);
  });

  it("caps bytes per trip too", async () => {
    const t = await createTrip(db, { name: "Demo bytes", app_name: "Scramble", pin_hash: pinHash, is_demo: true });
    await db.query("insert into photo_uploads (trip_id, path, bytes) values ($1, $2, $3)", [t.id, `trips/${t.id}/posts/${newId()}.jpg`, PHOTO_QUOTA.demo.bytes - 10]);
    expect((await upload(t.code, `trips/${t.id}/posts/${newId()}.jpg`, JPEG)).status).toBe(413);
  });

  it("accepts a missing content type when the bytes are JPEG", async () => {
    const t = await trip();
    const p = `trips/${t.id}/ctp/${newId()}.jpg`;
    expect((await upload(t.code, p, JPEG, "")).status).toBe(200);
  });

  it("photo route 404s for missing, malformed and traversal paths, and when Supabase serves photos", async () => {
    const t = await trip();
    fs.writeFileSync(path.join(uploads, "secret.txt"), "nope");
    expect((await getPhoto(`trips/${t.id}/drinks/${newId()}.jpg`)).status).toBe(404);
    expect((await photoRoute(new Request(`${BASE}/api/photos/x`), params({ path: ["..", "secret.txt"] }))).status).toBe(404);
    expect((await photoRoute(new Request(`${BASE}/api/photos/x`), params({ path: ["trips", "..", "..", "secret.txt"] }))).status).toBe(404);
    expect(await readLocalPhoto("../secret.txt")).toBeNull();

    const p = `trips/${t.id}/ld/${newId()}.jpg`;
    await putPhoto(t.id, p, JPEG);
    expect((await getPhoto(p)).status).toBe(200);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service");
    expect((await getPhoto(p)).status).toBe(404);
    expect(photoBaseUrl()).toBe("https://abc.supabase.co/storage/v1/object/public/photos/");
  });
});

describe("missing production config fails loudly (Vercel)", () => {
  it("no DATABASE_URL on Vercel: a 500 that names DATABASE_URL instead of an opaque crash", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("PGLITE_DIR", "memory://"); // if the guard ever regresses, don't litter the repo
    await expect(openDb()).rejects.toBeInstanceOf(ConfigError);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    setDbForTests(null);
    try {
      const res = await stateRoute(jsonReq("/api/t/whatever/state", "GET"), params({ code: "whatever12" }));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.code).toBe("not_configured");
      expect(body.error).toMatch(/DATABASE_URL/);
      expect(err).toHaveBeenCalledWith(expect.stringMatching(/DATABASE_URL/));
    } finally {
      setDbForTests(db);
      err.mockRestore();
    }
  });

  it("no Supabase Storage on Vercel: uploads answer a clear 500 instead of writing to a read-only disk", async () => {
    const t = await trip();
    vi.stubEnv("VERCEL", "1");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const p = `trips/${t.id}/drinks/${newId()}.jpg`;
    const res = await uploadRoute(
      new Request(`${BASE}/api/t/${t.code}/upload?path=${encodeURIComponent(p)}`, { method: "POST", headers: { "content-type": "image/jpeg" }, body: JPEG }),
      params({ code: t.code }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("not_configured");
    expect(body.error).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(fs.existsSync(path.join(uploads, p))).toBe(false);
    expect(await db.query("select 1 from photo_uploads where path = $1", [p])).toEqual([]); // reservation released
    err.mockRestore();
  });
});

describe("realtime broadcast", () => {
  it("is a no-op without Supabase", async () => {
    const fetchSpy = vi.fn();
    expect(await broadcastTripChanged(newId(), fetchSpy as unknown as typeof fetch)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(realtimeMeta(newId())).toBeNull();
  });

  const LEGACY_SERVICE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJl";

  it("POSTs the invalidation with the service key; swallows failures", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", LEGACY_SERVICE_KEY);
    const tripId = newId();
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 202 }));
    expect(await broadcastTripChanged(tripId, fetchSpy as unknown as typeof fetch)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://abc.supabase.co/realtime/v1/api/broadcast");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ apikey: LEGACY_SERVICE_KEY, Authorization: `Bearer ${LEGACY_SERVICE_KEY}` });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(init.body));
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toMatchObject({ topic: `trip:${tripId}`, event: "changed", payload: { at: expect.stringMatching(/Z$/) } });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await broadcastTripChanged(tripId, (async () => new Response("no", { status: 500 })) as unknown as typeof fetch)).toBe(false);
    expect(await broadcastTripChanged(tripId, (async () => { throw new Error("offline"); }) as unknown as typeof fetch)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("sends a new-format sb_secret_ key only as apikey (it isn't a JWT, so never as a Bearer token)", async () => {
    // Built at runtime so secret scanners don't mistake the test value for a real Supabase key.
    const FAKE_SB_SECRET = ["sb", "secret", "test", "only", "not", "a", "real", "key"].join("_");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_abc123");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", FAKE_SB_SECRET);
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 202 }));
    expect(await broadcastTripChanged(newId(), fetchSpy as unknown as typeof fetch)).toBe(true);
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe(FAKE_SB_SECRET);
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("authorization");
    expect(isJwtKey(LEGACY_SERVICE_KEY)).toBe(true);
    expect(isJwtKey(FAKE_SB_SECRET)).toBe(false);
  });
});
