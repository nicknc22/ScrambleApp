// Commissioner auth: PIN hashing, signed tokens (bound to the PIN), cookies, the DB throttle.
import { spawnSync } from "node:child_process";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  clearCommissionerCookie,
  clearTrustedDeviceCookie,
  commissionerCookie,
  commissionerCookieName,
  commissionerSessionHeaders,
  COMMISSIONER_TTL_MS,
  hashPin,
  isCommissioner,
  isValidPin,
  isWellFormedPinHash,
  makeCommissionerToken,
  makeTrustedDeviceToken,
  MAX_FAILS_PER_CLIENT,
  MAX_FAILS_PER_CLIENT_DAY,
  MAX_FAILS_PER_TRIP,
  MAX_FAILS_PER_TRIP_DAY,
  parseCookies,
  pinRetryAfter,
  recordPinFailure,
  recordPinSuccess,
  resetPinThrottle,
  trustedDeviceCookie,
  trustedDeviceCookieName,
  trustedDeviceId,
  TRUSTED_DEVICE_TTL_MS,
  verifyCommissionerToken,
  verifyPin,
  verifyTrustedDeviceToken,
} from "@/lib/server/auth";
import { createTestDb, type DbConnection } from "@/lib/server/db";
import { createTrip } from "@/lib/server/trips";
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH } from "@/lib/pin";

const TRIP = "0b6f5c3e-6a3c-4d7e-9a2b-1c2d3e4f5a6b";
const OTHER = "9f8e7d6c-5b4a-4321-8fed-cba987654321";
const PIN_HASH = "scrypt:c2FsdHNhbHRzYWx0c2FsdA:aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g";
const NEW_PIN_HASH = "scrypt:b3RoZXJzYWx0b3RoZXJzYQ:bmV3aGFzaG5ld2hhc2huZXdoYXNobmV3aGFzaG5ld2g";
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("PIN hashing", () => {
  it("hashes to scrypt:salt:hash (no $, so .env files can't mangle it) with a random salt and verifies", async () => {
    const h1 = await hashPin("2468");
    const h2 = await hashPin("2468");
    expect(h1).toMatch(/^scrypt:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]{43}$/);
    expect(h1).not.toContain("$");
    expect(h1).not.toBe(h2);
    expect(await verifyPin("2468", h1)).toBe(true);
    expect(await verifyPin("2468", h2)).toBe(true);
    expect(await verifyPin("2469", h1)).toBe(false);
    expect(await verifyPin("", h1)).toBe(false);
    expect(await verifyPin(2468, h1)).toBe(false);
    expect(await verifyPin(null, h1)).toBe(false);
  });

  it("still verifies legacy scrypt$salt$hash hashes", async () => {
    const legacy = (await hashPin("2468")).replace(/:/g, "$");
    expect(isWellFormedPinHash(legacy)).toBe(true);
    expect(await verifyPin("2468", legacy)).toBe(true);
    expect(await verifyPin("1111", legacy)).toBe(false);
  });

  it("never verifies against malformed hashes", async () => {
    for (const bad of ["", "scrypt$", "scrypt$abc", "bcrypt$a$b", "scrypt$$aGFzaA", "scrypt$c2FsdA$c2hvcnQ", "scrypt:", "scrypt::", "scrypt:c2FsdA:c2hvcnQ", null, undefined]) {
      expect(await verifyPin("2468", bad as string)).toBe(false);
    }
  });

  it("recognizes well-formed hashes (and the .env-mangled 'scrypt')", async () => {
    expect(isWellFormedPinHash(await hashPin("1234"))).toBe(true);
    expect(isWellFormedPinHash("scrypt")).toBe(false);
    expect(isWellFormedPinHash("scrypt$$")).toBe(false);
    expect(isWellFormedPinHash("scrypt::")).toBe(false);
    expect(isWellFormedPinHash("")).toBe(false);
    expect(isWellFormedPinHash(undefined)).toBe(false);
  });

  it("scripts/hash-pin.ts prints only the hash on stdout (used as $(...) in playwright.config.ts)", async () => {
    const r = spawnSync("npx", ["tsx", "scripts/hash-pin.ts", "2468"], { encoding: "utf8", cwd: process.cwd() });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^scrypt:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+\n$/);
    expect(await verifyPin("2468", r.stdout.trim())).toBe(true);
    const bad = spawnSync("npx", ["tsx", "scripts/hash-pin.ts", "12x"], { encoding: "utf8", cwd: process.cwd() });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toBe("");
  });

  it("validates new PINs as 4-12 digits (the same limits the unlock pad uses)", () => {
    expect([PIN_MIN_LENGTH, PIN_MAX_LENGTH]).toEqual([4, 12]);
    expect(isValidPin("1234")).toBe(true);
    expect(isValidPin("123456789012")).toBe(true);
    expect(isValidPin("123")).toBe(false);
    expect(isValidPin("1234567890123")).toBe(false);
    expect(isValidPin("12a4")).toBe(false);
    expect(isValidPin(1234)).toBe(false);
  });
});

describe("commissioner token", () => {
  const now = Date.parse("2026-10-24T12:00:00Z");

  it("round-trips and expires after 12 hours", () => {
    const token = makeCommissionerToken(TRIP, PIN_HASH, now);
    const [trip, exp, sig] = token.split(".");
    expect(trip).toBe(TRIP);
    expect(Number(exp)).toBe(now + COMMISSIONER_TTL_MS);
    expect(sig).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token.split(".")).toHaveLength(3); // the PIN fingerprint is signed, not carried
    expect(verifyCommissionerToken(token, TRIP, PIN_HASH, now)).toBe(true);
    expect(verifyCommissionerToken(token, TRIP, PIN_HASH, now + COMMISSIONER_TTL_MS - 1)).toBe(true);
    expect(verifyCommissionerToken(token, TRIP, PIN_HASH, now + COMMISSIONER_TTL_MS)).toBe(false);
  });

  it("is revoked by a PIN change: a token only verifies against the PIN hash it was issued for", () => {
    const token = makeCommissionerToken(TRIP, PIN_HASH, now);
    expect(verifyCommissionerToken(token, TRIP, PIN_HASH, now)).toBe(true);
    expect(verifyCommissionerToken(token, TRIP, NEW_PIN_HASH, now)).toBe(false);
    expect(verifyCommissionerToken(makeCommissionerToken(TRIP, NEW_PIN_HASH, now), TRIP, NEW_PIN_HASH, now)).toBe(true);
  });

  it("rejects tampering, other trips and garbage", () => {
    const token = makeCommissionerToken(TRIP, PIN_HASH, now);
    const [, exp, sig] = token.split(".");
    expect(verifyCommissionerToken(token, OTHER, PIN_HASH, now)).toBe(false);
    expect(verifyCommissionerToken(`${TRIP}.${Number(exp) + 1000}.${sig}`, TRIP, PIN_HASH, now)).toBe(false);
    expect(verifyCommissionerToken(`${OTHER}.${exp}.${sig}`, OTHER, PIN_HASH, now)).toBe(false);
    const mid = Math.floor(sig.length / 2);
    const flipped = sig.slice(0, mid) + (sig[mid] === "A" ? "B" : "A") + sig.slice(mid + 1);
    expect(verifyCommissionerToken(`${TRIP}.${exp}.${flipped}`, TRIP, PIN_HASH, now)).toBe(false);
    expect(verifyCommissionerToken(`${TRIP}.${exp}.`, TRIP, PIN_HASH, now)).toBe(false);
    expect(verifyCommissionerToken(`${TRIP}.${exp}`, TRIP, PIN_HASH, now)).toBe(false);
    expect(verifyCommissionerToken(`${TRIP}.-5.${sig}`, TRIP, PIN_HASH, now)).toBe(false);
    expect(verifyCommissionerToken(`${token}.x`, TRIP, PIN_HASH, now)).toBe(false);
    for (const g of ["", "x", "...", null, undefined, "a".repeat(500)]) {
      expect(verifyCommissionerToken(g as string, TRIP, PIN_HASH, now)).toBe(false);
    }
  });

  it("rejects EVERY other spelling of the signature, even last characters that decode to the same bytes", () => {
    // The last of 43 base64url characters carries 4 bits: 4 different characters decode to the
    // same 32 bytes. Comparing decoded bytes made a "tampered" token verify 1 time in 16.
    for (let i = 0; i < 20; i++) {
      const token = makeCommissionerToken(TRIP, PIN_HASH, now + i * 1000);
      const body = token.slice(0, -1);
      const last = token.slice(-1);
      const accepted = [...B64URL].filter((c) => verifyCommissionerToken(body + c, TRIP, PIN_HASH, now));
      expect(accepted).toEqual([last]);
    }
  });

  it("is signed with APP_SECRET when set (changing the secret invalidates tokens)", () => {
    vi.stubEnv("APP_SECRET", "one");
    const token = makeCommissionerToken(TRIP, PIN_HASH, now);
    expect(verifyCommissionerToken(token, TRIP, PIN_HASH, now)).toBe(true);
    vi.stubEnv("APP_SECRET", "two");
    expect(verifyCommissionerToken(token, TRIP, PIN_HASH, now)).toBe(false);
    vi.stubEnv("APP_SECRET", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    const t2 = makeCommissionerToken(TRIP, PIN_HASH, now);
    expect(verifyCommissionerToken(t2, TRIP, PIN_HASH, now)).toBe(true);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    vi.stubEnv("COMMISSIONER_PIN_HASH", "scrypt$x$y");
    expect(verifyCommissionerToken(t2, TRIP, PIN_HASH, now)).toBe(false);
  });
});

describe("trusted-device token", () => {
  const now = Date.parse("2026-10-10T12:00:00Z");
  const DEVICE = "dGhpc2lzYWRldmljZWlk";

  it("round-trips for 60 days, bound to the trip and its current PIN", () => {
    const token = makeTrustedDeviceToken(TRIP, PIN_HASH, DEVICE, now);
    expect(token.split(".")).toHaveLength(4);
    expect(verifyTrustedDeviceToken(token, TRIP, PIN_HASH, now)).toBe(DEVICE);
    expect(verifyTrustedDeviceToken(token, TRIP, PIN_HASH, now + TRUSTED_DEVICE_TTL_MS - 1)).toBe(DEVICE);
    expect(verifyTrustedDeviceToken(token, TRIP, PIN_HASH, now + TRUSTED_DEVICE_TTL_MS)).toBeNull();
    expect(verifyTrustedDeviceToken(token, OTHER, PIN_HASH, now)).toBeNull();
    expect(verifyTrustedDeviceToken(token, TRIP, NEW_PIN_HASH, now)).toBeNull();
  });

  it("can't be forged from a commissioner token or by swapping the device id", () => {
    const comm = makeCommissionerToken(TRIP, PIN_HASH, now);
    expect(verifyTrustedDeviceToken(comm, TRIP, PIN_HASH, now)).toBeNull();
    const token = makeTrustedDeviceToken(TRIP, PIN_HASH, DEVICE, now);
    const [trip, exp, , sig] = token.split(".");
    expect(verifyTrustedDeviceToken(`${trip}.${exp}.someoneelsesdevice1.${sig}`, TRIP, PIN_HASH, now)).toBeNull();
    expect(verifyCommissionerToken(`${trip}.${exp}.${sig}`, TRIP, PIN_HASH, now)).toBe(false);
    for (const g of ["", "a.b.c.d", null, undefined, `${trip}.${exp}.short.${sig}`]) {
      expect(verifyTrustedDeviceToken(g as string, TRIP, PIN_HASH, now)).toBeNull();
    }
  });
});

describe("cookies", () => {
  const req = (url = "http://localhost:3000/api/x", headers: Record<string, string> = {}) => new Request(url, { headers });

  it("names the cookies per trip", () => {
    expect(commissionerCookieName(TRIP)).toBe("scramble_comm_0b6f5c3e");
    expect(commissionerCookieName(OTHER)).toBe("scramble_comm_9f8e7d6c");
    expect(trustedDeviceCookieName(TRIP)).toBe("scramble_dev_0b6f5c3e");
  });

  it("sets an httpOnly, lax, 12h cookie; Secure on https and in production", () => {
    const dev = commissionerCookie(req(), TRIP, PIN_HASH);
    expect(dev).toMatch(/^scramble_comm_0b6f5c3e=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200$/);
    expect(commissionerCookie(req("https://scramble.example/api/x"), TRIP, PIN_HASH)).toMatch(/; Secure$/);
    expect(commissionerCookie(req("http://internal/api/x", { "x-forwarded-proto": "https" }), TRIP, PIN_HASH)).toMatch(/; Secure$/);
    vi.stubEnv("NODE_ENV", "production");
    expect(commissionerCookie(req("http://scramble.example/api/x"), TRIP, PIN_HASH)).toMatch(/; Secure$/);
    // production over plain http on localhost/LAN (e2e, laptop fallback): Secure would be dropped
    expect(commissionerCookie(req("http://localhost:3100/api/x"), TRIP, PIN_HASH)).not.toMatch(/Secure/);
    expect(commissionerCookie(req("http://192.168.1.20:3000/api/x"), TRIP, PIN_HASH)).not.toMatch(/Secure/);
  });

  it("clears with Max-Age=0", () => {
    expect(clearCommissionerCookie(req(), TRIP)).toMatch(/^scramble_comm_0b6f5c3e=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=/);
    expect(clearTrustedDeviceCookie(req(), TRIP)).toMatch(/^scramble_dev_0b6f5c3e=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=/);
  });

  it("isCommissioner reads the cookie header and checks the trip's current PIN", () => {
    const setCookie = commissionerCookie(req(), TRIP, PIN_HASH);
    const pair = setCookie.split(";")[0];
    const [name, value] = [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)];
    expect(isCommissioner(req(undefined, { cookie: `other=1; ${pair}; x=y` }), TRIP, PIN_HASH)).toBe(true);
    expect(isCommissioner(req(undefined, { cookie: pair }), TRIP, NEW_PIN_HASH)).toBe(false);
    expect(isCommissioner(req(undefined, { cookie: pair }), OTHER, PIN_HASH)).toBe(false);
    const mid = Math.floor(value.length * 0.9);
    const tampered = `${name}=${value.slice(0, mid)}${value[mid] === "A" ? "B" : "A"}${value.slice(mid + 1)}`;
    expect(isCommissioner(req(undefined, { cookie: tampered }), TRIP, PIN_HASH)).toBe(false);
    expect(isCommissioner(req(), TRIP, PIN_HASH)).toBe(false);
    // a valid token for OTHER placed under TRIP's cookie name doesn't work
    const otherToken = makeCommissionerToken(OTHER, PIN_HASH);
    expect(isCommissioner(req(undefined, { cookie: `${commissionerCookieName(TRIP)}=${otherToken}` }), TRIP, PIN_HASH)).toBe(false);
  });

  it("session headers: the commissioner cookie first, then a 60-day trusted-device cookie that keeps its device id", () => {
    const [[k1, comm], [k2, dev]] = commissionerSessionHeaders(req(), TRIP, PIN_HASH);
    expect([k1, k2]).toEqual(["Set-Cookie", "Set-Cookie"]);
    expect(comm).toMatch(/^scramble_comm_0b6f5c3e=/);
    expect(dev).toMatch(/^scramble_dev_0b6f5c3e=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=5184000$/);
    const devPair = dev.split(";")[0];
    const id = trustedDeviceId(req(undefined, { cookie: devPair }), TRIP, PIN_HASH);
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(trustedDeviceId(req(undefined, { cookie: devPair }), TRIP, NEW_PIN_HASH)).toBeNull();
    // Re-trusting the same browser (e.g. after a PIN change) keeps its id.
    const again = trustedDeviceCookie(req(undefined, { cookie: devPair }), TRIP, NEW_PIN_HASH).split(";")[0];
    expect(trustedDeviceId(req(undefined, { cookie: again }), TRIP, NEW_PIN_HASH)).toBe(id);
  });

  it("parseCookies handles quoting, encoding and duplicates", () => {
    const m = parseCookies('a=1; b="two"; c=%7Bx%7D; a=ignored; bad; =x');
    expect(m.get("a")).toBe("1");
    expect(m.get("b")).toBe("two");
    expect(m.get("c")).toBe("{x}");
    expect(m.size).toBe(3);
  });
});

describe("PIN throttle (pin_failures)", () => {
  let db: DbConnection;
  const now = Date.parse("2026-10-24T12:00:00Z");
  let trip: string;
  let other: string;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db?.close();
  });
  const fresh = async () => {
    await resetPinThrottle(db);
    trip = (await createTrip(db, { name: "Throttle", app_name: "Scramble", pin_hash: PIN_HASH })).id;
    other = (await createTrip(db, { name: "Other", app_name: "Scramble", pin_hash: PIN_HASH })).id;
  };

  it("blocks a client after 8 failures in 10 minutes; success resets that client", async () => {
    await fresh();
    for (let i = 0; i < MAX_FAILS_PER_CLIENT - 1; i++) await recordPinFailure(db, trip, "1.2.3.4", now);
    expect(await pinRetryAfter(db, trip, "1.2.3.4", { now })).toBe(0);
    await recordPinFailure(db, trip, "1.2.3.4", now);
    expect(await pinRetryAfter(db, trip, "1.2.3.4", { now })).toBe(600);
    expect(await pinRetryAfter(db, trip, "1.2.3.4", { now: now + 60_000 })).toBe(540);
    expect(await pinRetryAfter(db, trip, "5.6.7.8", { now })).toBe(0);
    expect(await pinRetryAfter(db, other, "1.2.3.4", { now })).toBe(0);
    expect(await pinRetryAfter(db, null, "1.2.3.4", { now })).toBe(0); // trip creation is its own bucket
    expect(await pinRetryAfter(db, trip, "1.2.3.4", { now: now + 600_000 })).toBe(0); // window over
    for (let i = 0; i < MAX_FAILS_PER_CLIENT; i++) await recordPinFailure(db, trip, "9.9.9.9", now);
    await recordPinSuccess(db, trip, "9.9.9.9");
    expect(await pinRetryAfter(db, trip, "9.9.9.9", { now })).toBe(0);
  });

  it("caps total failures per trip across clients (30 per 10 min), but not for a trusted device", async () => {
    await fresh();
    for (let i = 0; i < MAX_FAILS_PER_TRIP; i++) await recordPinFailure(db, trip, `10.0.0.${i}`, now + i);
    expect(await pinRetryAfter(db, trip, "10.0.1.1", { now: now + 100 })).toBeGreaterThan(0);
    expect(await pinRetryAfter(db, trip, "dev:commissionerphone", { now: now + 100, trusted: true })).toBe(0);
    expect(await pinRetryAfter(db, other, "10.0.1.1", { now: now + 100 })).toBe(0);
    // The trusted device still has its own bucket.
    for (let i = 0; i < MAX_FAILS_PER_CLIENT; i++) await recordPinFailure(db, trip, "dev:commissionerphone", now + 200);
    expect(await pinRetryAfter(db, trip, "dev:commissionerphone", { now: now + 300, trusted: true })).toBeGreaterThan(0);
  });

  it("caps a slow guesser rotating IPs at 100 per day", async () => {
    await fresh();
    // 100 failures spread over 20 hours: never 30 within 10 minutes, but the daily cap holds.
    for (let i = 0; i < MAX_FAILS_PER_TRIP_DAY; i++) await recordPinFailure(db, trip, `172.16.${i}.1`, now + i * 12 * 60_000);
    const later = now + 20 * 3600_000;
    const wait = await pinRetryAfter(db, trip, "172.16.200.1", { now: later });
    expect(wait).toBeGreaterThan(3 * 3600);
    expect(wait).toBeLessThanOrEqual(24 * 3600);
    expect(await pinRetryAfter(db, trip, "dev:phone", { now: later, trusted: true })).toBe(0);
    expect(await pinRetryAfter(db, trip, "172.16.200.1", { now: now + 24 * 3600_000 + 1 })).toBe(0);
  });

  it("caps one client (a trusted device too) at 30 a day, even when it paces itself", async () => {
    await fresh();
    // 30 failures, one every 15 minutes: never 8 within 10 minutes.
    for (let i = 0; i < MAX_FAILS_PER_CLIENT_DAY; i++) await recordPinFailure(db, trip, "dev:friendsphone", now + i * 15 * 60_000);
    const later = now + 30 * 15 * 60_000;
    expect(await pinRetryAfter(db, trip, "dev:friendsphone", { now: later, trusted: true })).toBeGreaterThan(0);
    expect(await pinRetryAfter(db, trip, "dev:nicksphone", { now: later, trusted: true })).toBe(0);
  });

  it("lives in the database (every server instance sees it) and housekeeps old rows", async () => {
    await fresh();
    await recordPinFailure(db, trip, "1.1.1.1", now - 3 * 24 * 3600_000);
    await recordPinFailure(db, trip, "1.1.1.1", now);
    const rows = await db.query<{ client: string; trip_id: string }>("select client, trip_id from pin_failures");
    expect(rows).toEqual([{ client: "1.1.1.1", trip_id: trip }]);
  });
});
