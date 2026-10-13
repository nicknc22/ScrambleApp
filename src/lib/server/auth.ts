// Commissioner auth: PIN hashing (scrypt), a signed short-lived commissioner cookie, a signed
// long-lived trusted-device cookie, and the wrong-PIN throttle (in Postgres, see pin_failures).
//
// PIN hash format: "scrypt:<salt b64url>:<hash b64url>" (N=16384, r=8, p=1, 32-byte key).
// No "$" on purpose: Next's .env loader expands "$name", which would silently mangle the hash.
// The older "scrypt$<salt>$<hash>" form is still accepted.
//
// Both cookies are bound to the trip's CURRENT PIN hash (a fingerprint of it is part of the signed
// payload, not of the cookie), so changing the PIN revokes every cookie issued before it. The
// device that changed the PIN gets fresh ones.
//
// Commissioner cookie "scramble_comm_<first 8 of trip id>" = "<tripId>.<expMs>.<sig>",
//   sig = base64url(HMAC-SHA256(secret, "<tripId>.<expMs>.<pin fingerprint>")), valid 12 h.
// Trusted-device cookie "scramble_dev_<first 8 of trip id>" = "<tripId>.<expMs>.<deviceId>.<sig>",
//   sig = base64url(HMAC-SHA256(secret, "dev.<tripId>.<expMs>.<deviceId>.<pin fingerprint>")),
//   valid 60 days. Set when the trip is created and on every successful unlock, and kept on Lock.
//   It grants nothing by itself: it only exempts this device from the SHARED wrong-PIN limits
//   (trip-wide and per IP), so friends mashing the pad can't lock the real commissioner out. The
//   device still needs the PIN and has its own per-device bucket.
import crypto from "node:crypto";
import { isValidPin, PIN_MAX_LENGTH, PIN_MIN_LENGTH, PIN_RE } from "@/lib/pin";
import { getDb, type Db } from "./db";
import { appSecret, commissionerPin, commissionerPinHash, isProduction, supabaseServiceRoleKey } from "./env";

export { isValidPin, PIN_RE };

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;

/** Commissioner session length. */
export const COMMISSIONER_TTL_MS = 12 * 60 * 60 * 1000;
/** Trusted-device cookie length: covers a trip created weeks before the round. */
export const TRUSTED_DEVICE_TTL_MS = 60 * 24 * 60 * 60 * 1000;

function scrypt(pin: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(pin, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/**
 * True for a complete "scrypt:<salt>:<hash>" (or legacy "scrypt$<salt>$<hash>") string. A legacy
 * hash pasted unescaped into .env.local turns into just "scrypt" (Next expands "$name"); callers
 * use this to say so instead of reporting "wrong PIN" forever.
 */
export function isWellFormedPinHash(hash: string | null | undefined): boolean {
  return typeof hash === "string" && /^scrypt([:$])[A-Za-z0-9_-]{16,}\1[A-Za-z0-9_-]{43}$/.test(hash.trim());
}

export async function hashPin(pin: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_LEN);
  const key = await scrypt(pin, salt);
  return `scrypt:${salt.toString("base64url")}:${key.toString("base64url")}`;
}

/** Constant-time check of a PIN against a stored hash. Malformed hashes never verify. */
export async function verifyPin(pin: unknown, stored: string | null | undefined): Promise<boolean> {
  if (typeof pin !== "string" || pin.length === 0 || pin.length > 64 || !stored) return false;
  const parts = stored.trim().split(stored.includes(":") ? ":" : "$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "base64url");
  const expected = Buffer.from(parts[2], "base64url");
  if (salt.length === 0 || expected.length !== KEY_LEN) return false;
  let actual: Buffer;
  try {
    actual = await scrypt(pin, salt);
  } catch {
    return false;
  }
  return crypto.timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------------
// The server's commissioner PIN (guards trip creation, seeds each new trip's PIN)
// ---------------------------------------------------------------------------

/**
 * COMMISSIONER_PIN_HASH when set (a scrypt hash), else the plain COMMISSIONER_PIN (4-12 digits,
 * typed straight into the host's dashboard). Set but unusable is "invalid", with a message naming
 * the variable (never its value): callers refuse instead of letting any PIN in.
 */
export type ServerPin =
  | { kind: "none" }
  | { kind: "invalid"; message: string }
  | { kind: "hash"; hash: string }
  | { kind: "plain"; pin: string };

export function serverPin(): ServerPin {
  const hash = commissionerPinHash();
  if (hash) {
    if (isWellFormedPinHash(hash)) return { kind: "hash", hash };
    return { kind: "invalid", message: "The server's COMMISSIONER_PIN_HASH is mangled. In .env files, write every $ as \\$." };
  }
  const pin = commissionerPin();
  if (pin) {
    if (isValidPin(pin)) return { kind: "plain", pin };
    return {
      kind: "invalid",
      message: `The server's COMMISSIONER_PIN must be ${PIN_MIN_LENGTH} to ${PIN_MAX_LENGTH} digits and nothing else. Fix it in the hosting settings and redeploy.`,
    };
  }
  return { kind: "none" };
}

/** Does `pin` match the server's PIN? scrypt for a hash; constant time for a plain PIN. */
export async function verifyServerPin(pin: unknown, server: ServerPin): Promise<boolean> {
  if (server.kind === "hash") return verifyPin(pin, server.hash);
  if (server.kind !== "plain" || typeof pin !== "string" || pin.length === 0 || pin.length > 64) return false;
  // Equal-length digests: timingSafeEqual needs them, and neither content nor length leaks.
  const digest = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest();
  return crypto.timingSafeEqual(digest(pin), digest(server.pin));
}

// ---------------------------------------------------------------------------
// Signed tokens
// ---------------------------------------------------------------------------

let warnedDevSecret = false;

/**
 * APP_SECRET, else a hash of the service key / env PIN hash / env plain PIN, else a fixed dev
 * secret. The plain PIN only ever goes in hashed (with a label); a short PIN still can't be
 * brute-forced from a cookie, because every signature also covers the trip's PIN fingerprint,
 * which comes from its salted hash and never leaves the server.
 */
export function signingSecret(): Buffer {
  const explicit = appSecret();
  if (explicit) return Buffer.from(explicit, "utf8");
  const plainPin = commissionerPin();
  const material = supabaseServiceRoleKey() || commissionerPinHash() || (plainPin && `commissioner-pin:${plainPin}`);
  if (!material && isProduction() && !warnedDevSecret) {
    warnedDevSecret = true;
    console.warn("auth: no APP_SECRET, SUPABASE_SERVICE_ROLE_KEY, COMMISSIONER_PIN_HASH or COMMISSIONER_PIN; using the dev cookie secret");
  }
  return crypto.createHash("sha256").update(material || "scramble-dev-secret").digest();
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", signingSecret()).update(payload).digest("base64url");
}

/**
 * Compare signatures as their exact base64url text (constant time). Decoding first would accept
 * non-canonical spellings: the last of 43 characters carries only 4 bits, so 4 different last
 * characters decode to the same bytes.
 */
function sameSignature(given: string, expected: string): boolean {
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Short hash of the trip's current PIN hash, mixed into every signature (PIN change = revoke). */
export function pinFingerprint(pinHash: string): string {
  return crypto.createHash("sha256").update(`pin:${pinHash}`).digest("base64url").slice(0, 22);
}

const EXP_RE = /^\d{1,16}$/;
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

export function makeCommissionerToken(tripId: string, pinHash: string, nowMs: number = Date.now(), ttlMs: number = COMMISSIONER_TTL_MS): string {
  const payload = `${tripId}.${Math.floor(nowMs + ttlMs)}`;
  return `${payload}.${sign(`${payload}.${pinFingerprint(pinHash)}`)}`;
}

/** True when `token` is an unexpired, untampered token for this trip and its current PIN. */
export function verifyCommissionerToken(token: string | null | undefined, tripId: string, pinHash: string, nowMs: number = Date.now()): boolean {
  if (!token || typeof token !== "string" || token.length > 300) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [tokenTrip, expStr, sig] = parts;
  if (tokenTrip !== tripId || !EXP_RE.test(expStr) || Number(expStr) <= nowMs) return false;
  return sameSignature(sig, sign(`${tokenTrip}.${expStr}.${pinFingerprint(pinHash)}`));
}

export function newDeviceId(): string {
  return crypto.randomBytes(16).toString("base64url");
}

export function makeTrustedDeviceToken(
  tripId: string,
  pinHash: string,
  deviceId: string,
  nowMs: number = Date.now(),
  ttlMs: number = TRUSTED_DEVICE_TTL_MS,
): string {
  const payload = `${tripId}.${Math.floor(nowMs + ttlMs)}.${deviceId}`;
  return `${payload}.${sign(`dev.${payload}.${pinFingerprint(pinHash)}`)}`;
}

/** The device id of a valid trusted-device token for this trip and its current PIN, else null. */
export function verifyTrustedDeviceToken(token: string | null | undefined, tripId: string, pinHash: string, nowMs: number = Date.now()): string | null {
  if (!token || typeof token !== "string" || token.length > 300) return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [tokenTrip, expStr, deviceId, sig] = parts;
  if (tokenTrip !== tripId || !EXP_RE.test(expStr) || Number(expStr) <= nowMs || !DEVICE_ID_RE.test(deviceId)) return null;
  return sameSignature(sig, sign(`dev.${tokenTrip}.${expStr}.${deviceId}.${pinFingerprint(pinHash)}`)) ? deviceId : null;
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

const cookieSuffix = (tripId: string) => tripId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8);

export function commissionerCookieName(tripId: string): string {
  return `scramble_comm_${cookieSuffix(tripId)}`;
}

export function trustedDeviceCookieName(tripId: string): string {
  return `scramble_dev_${cookieSuffix(tripId)}`;
}

/** Parse a Cookie header into name → value (first occurrence wins). */
export function parseCookies(header: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (!name || out.has(name)) continue;
    let value = part.slice(i + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    try {
      value = decodeURIComponent(value);
    } catch {
      /* keep raw */
    }
    out.set(name, value);
  }
  return out;
}

/** The request came in over HTTPS (directly or via Vercel's proxy). */
export function isHttpsRequest(request: Request): boolean {
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (proto) return proto === "https";
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

/** localhost, 127.x, ::1, private LAN ranges and *.local: places `next start` runs over plain http. */
function isLocalHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    h === "localhost" ||
    h === "::1" ||
    h.endsWith(".local") ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  );
}

/**
 * Secure on HTTPS and in production (Vercel). Exception: production over plain http on a local
 * host (e2e's `next start` on localhost, a laptop serving phones on the LAN), where a Secure
 * cookie would be dropped by Safari and the commissioner could never unlock.
 */
function secureFor(request: Request): boolean {
  if (isHttpsRequest(request)) return true;
  if (!isProduction()) return false;
  try {
    return !isLocalHost(new URL(request.url).hostname);
  } catch {
    return true;
  }
}

export interface CookieOptions {
  maxAgeSec: number;
  secure: boolean;
}

export function serializeCookie(name: string, value: string, opts: CookieOptions): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${Math.max(0, Math.floor(opts.maxAgeSec))}`];
  if (opts.maxAgeSec <= 0) parts.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

/** Set-Cookie value granting commissioner powers on this trip (at its current PIN) for 12 hours. */
export function commissionerCookie(request: Request, tripId: string, pinHash: string, nowMs: number = Date.now()): string {
  return serializeCookie(commissionerCookieName(tripId), makeCommissionerToken(tripId, pinHash, nowMs), {
    maxAgeSec: COMMISSIONER_TTL_MS / 1000,
    secure: secureFor(request),
  });
}

/** Set-Cookie value that removes the commissioner cookie. */
export function clearCommissionerCookie(request: Request, tripId: string): string {
  return serializeCookie(commissionerCookieName(tripId), "", { maxAgeSec: 0, secure: secureFor(request) });
}

/** Does this request carry a valid commissioner cookie for the trip at its current PIN? */
export function isCommissioner(request: Request, tripId: string, pinHash: string, nowMs: number = Date.now()): boolean {
  const token = parseCookies(request.headers.get("cookie")).get(commissionerCookieName(tripId));
  return verifyCommissionerToken(token, tripId, pinHash, nowMs);
}

/** The device id from a valid trusted-device cookie for the trip at its current PIN, else null. */
export function trustedDeviceId(request: Request, tripId: string, pinHash: string, nowMs: number = Date.now()): string | null {
  const token = parseCookies(request.headers.get("cookie")).get(trustedDeviceCookieName(tripId));
  return verifyTrustedDeviceToken(token, tripId, pinHash, nowMs);
}

/** Set-Cookie value (re)trusting this device for 60 days; keeps its device id if it has one. */
export function trustedDeviceCookie(request: Request, tripId: string, pinHash: string, nowMs: number = Date.now()): string {
  const token = parseCookies(request.headers.get("cookie")).get(trustedDeviceCookieName(tripId));
  // An id from an older PIN's cookie is fine to keep: the new signature binds it to the new PIN.
  const prior = token?.split(".")[2];
  const deviceId = prior && DEVICE_ID_RE.test(prior) ? prior : newDeviceId();
  return serializeCookie(trustedDeviceCookieName(tripId), makeTrustedDeviceToken(tripId, pinHash, deviceId, nowMs), {
    maxAgeSec: TRUSTED_DEVICE_TTL_MS / 1000,
    secure: secureFor(request),
  });
}

export function clearTrustedDeviceCookie(request: Request, tripId: string): string {
  return serializeCookie(trustedDeviceCookieName(tripId), "", { maxAgeSec: 0, secure: secureFor(request) });
}

/**
 * Set-Cookie headers after creating a trip or entering the right PIN: commissioner powers
 * (first: callers and tests read the first cookie) + this device trusted.
 */
export function commissionerSessionHeaders(request: Request, tripId: string, pinHash: string, nowMs: number = Date.now()): [string, string][] {
  return [
    ["Set-Cookie", commissionerCookie(request, tripId, pinHash, nowMs)],
    ["Set-Cookie", trustedDeviceCookie(request, tripId, pinHash, nowMs)],
  ];
}

// ---------------------------------------------------------------------------
// Wrong-PIN throttle (pin_failures; shared by every server instance, survives cold starts)
// ---------------------------------------------------------------------------
//
// Checked BEFORE the PIN is verified (a throttled request never learns whether its PIN was right,
// so the throttle can't be used as an oracle). attemptPin reserves the attempt as a failure under
// a per-bucket advisory lock before the slow scrypt check runs, so a burst of simultaneous guesses
// can never check more PINs than the limits below.
//   per client (primary)  8 wrong PINs per 10 min and 30 per 24 h from one IP (or one trusted
//                         device). Only this bucket can lock anyone out for long.
//   per trip (shared)     a slow global cap on everyone together that only ever costs a short wait:
//                         30 per 10 min, and past 100 in 24 h one attempt per 10 min (~250 a day
//                         at most for a guesser rotating IPs), so strangers can't lock the
//                         commissioner out of a new device for more than ~10 minutes at a time.
// A trusted device (see above) skips the shared bucket: only its own per-device bucket applies.
// tripId null = trip creation, checked against the server's PIN (serverPin above; same buckets).

export const PIN_WINDOW_MS = 10 * 60 * 1000;
export const PIN_DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_FAILS_PER_CLIENT = 8;
export const MAX_FAILS_PER_CLIENT_DAY = 30;
export const MAX_FAILS_PER_TRIP = 30;
/** Shared failures in 24 h after which the shared bucket admits one attempt per PIN_SLOW_SPACING_MS. */
export const MAX_FAILS_PER_TRIP_DAY = 100;
export const PIN_SLOW_SPACING_MS = 10 * 60 * 1000;

/** Best-effort client address (Vercel sets x-forwarded-for). */
export function clientKey(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (fwd || request.headers.get("x-real-ip")?.trim() || "local").slice(0, 100);
}

/** Throttle client key of a trusted device. */
export const deviceClientKey = (deviceId: string) => `dev:${deviceId}`;

/** Seconds until the oldest failure that keeps `rows` (newest first) at the limit leaves the window. */
function waitFor(rows: { created_at: string }[], limit: number, windowMs: number, now: number): number {
  if (rows.length < limit) return 0;
  return secondsUntil(Date.parse(rows[limit - 1].created_at) + windowMs, now);
}

function secondsUntil(at: number, now: number): number {
  return at > now ? Math.max(1, Math.ceil((at - now) / 1000)) : 0;
}

export interface PinThrottleOptions {
  /** A trusted device: only its own bucket counts. */
  trusted?: boolean;
  now?: number;
}

/** Seconds until another PIN attempt is allowed from `client`, or 0 when allowed now. */
export async function pinRetryAfter(db: Db, tripId: string | null, client: string, opts: PinThrottleOptions = {}): Promise<number> {
  const now = opts.now ?? Date.now();
  const since = (ms: number) => new Date(now - ms).toISOString();
  const mine = await db.query<{ created_at: string }>(
    `select created_at from pin_failures
      where trip_id is not distinct from $1::uuid and client = $2 and created_at > $3
      order by created_at desc limit $4`,
    [tripId, client, since(PIN_DAY_MS), MAX_FAILS_PER_CLIENT_DAY],
  );
  let wait = Math.max(waitFor(mine, MAX_FAILS_PER_CLIENT, PIN_WINDOW_MS, now), waitFor(mine, MAX_FAILS_PER_CLIENT_DAY, PIN_DAY_MS, now));
  if (!opts.trusted) {
    const all = await db.query<{ created_at: string }>(
      `select created_at from pin_failures
        where trip_id is not distinct from $1::uuid and created_at > $2
        order by created_at desc limit $3`,
      [tripId, since(PIN_DAY_MS), MAX_FAILS_PER_TRIP_DAY],
    );
    wait = Math.max(wait, waitFor(all, MAX_FAILS_PER_TRIP, PIN_WINDOW_MS, now));
    // A busy day: no lockout, just one shared attempt per spacing.
    if (all.length >= MAX_FAILS_PER_TRIP_DAY) wait = Math.max(wait, secondsUntil(Date.parse(all[0].created_at) + PIN_SLOW_SPACING_MS, now));
  }
  return wait;
}

export async function recordPinFailure(db: Db, tripId: string | null, client: string, now: number = Date.now()): Promise<void> {
  await db.query("insert into pin_failures (trip_id, client, created_at) values ($1, $2, $3)", [tripId, client, new Date(now).toISOString()]);
  // Housekeeping: nothing older than the longest window matters.
  await db.query("delete from pin_failures where created_at < $1", [new Date(now - 2 * PIN_DAY_MS).toISOString()]);
}

export type PinAttemptResult = { status: "ok" } | { status: "wrong" } | { status: "throttled"; retryAfter: number };

/**
 * One throttled PIN attempt, safe under concurrency. In one transaction holding a per-bucket
 * advisory lock (transaction-scoped: fine on PGlite and the Supavisor transaction pooler), check
 * the throttle and RESERVE the attempt as a failure; only then run `verify` (scrypt, outside the
 * transaction so no pooled connection waits on it). The right PIN deletes the reservation and
 * clears the client's own bucket; a wrong one keeps it as the recorded failure.
 */
export async function attemptPin(
  db: Db,
  tripId: string | null,
  client: string,
  verify: () => Promise<boolean>,
  opts: PinThrottleOptions = {},
): Promise<PinAttemptResult> {
  const now = opts.now ?? Date.now();
  const wait = await db.tx(async (tx) => {
    await tx.query("select pg_advisory_xact_lock(hashtextextended($1::text, 0))", [`pin:${tripId ?? "create"}`]);
    const w = await pinRetryAfter(tx, tripId, client, { ...opts, now });
    if (w === 0) await recordPinFailure(tx, tripId, client, now); // the reservation
    return w;
  });
  if (wait > 0) return { status: "throttled", retryAfter: wait };
  if (!(await verify())) return { status: "wrong" };
  await recordPinSuccess(db, tripId, client); // drops the reservation with the rest of the bucket
  return { status: "ok" };
}

/** "Try again in 4 minutes" for a throttle wait in seconds (the copy has to match the real wait). */
export function retryAfterText(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

/** The right PIN clears that client's own bucket (the shared ones keep counting). */
export async function recordPinSuccess(db: Db, tripId: string | null, client: string): Promise<void> {
  await db.query("delete from pin_failures where trip_id is not distinct from $1::uuid and client = $2", [tripId, client]);
}

/** Tests and operators: forget every wrong PIN (all trips). Never throws. */
export async function resetPinThrottle(db: Db = getDb()): Promise<void> {
  await db.query("delete from pin_failures").catch(() => {});
}
