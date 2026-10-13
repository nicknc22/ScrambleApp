// Commissioner auth: PIN hashing (scrypt) and a signed, short-lived, httpOnly cookie.
//
// PIN hash format: "scrypt:<salt b64url>:<hash b64url>" (N=16384, r=8, p=1, 32-byte key).
// No "$" on purpose: Next's .env loader expands "$name", which would silently mangle the hash.
// The older "scrypt$<salt>$<hash>" form is still accepted.
// Cookie "scramble_comm_<first 8 of trip id>" = "<tripId>.<expMs>.<sig>",
//   sig = base64url(HMAC-SHA256(secret, "<tripId>.<expMs>")).
import crypto from "node:crypto";
import { appSecret, commissionerPinHash, isProduction, supabaseServiceRoleKey } from "./env";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;

/** Commissioner session length. */
export const COMMISSIONER_TTL_MS = 12 * 60 * 60 * 1000;

/** New PINs: 4 to 12 digits. */
export const PIN_RE = /^\d{4,12}$/;

export function isValidPin(pin: unknown): pin is string {
  return typeof pin === "string" && PIN_RE.test(pin);
}

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
// Signed commissioner token
// ---------------------------------------------------------------------------

let warnedDevSecret = false;

/** APP_SECRET, else a hash of the service key / env PIN hash, else a fixed dev secret. */
export function signingSecret(): Buffer {
  const explicit = appSecret();
  if (explicit) return Buffer.from(explicit, "utf8");
  const material = supabaseServiceRoleKey() || commissionerPinHash();
  if (!material && isProduction() && !warnedDevSecret) {
    warnedDevSecret = true;
    console.warn("auth: no APP_SECRET, SUPABASE_SERVICE_ROLE_KEY or COMMISSIONER_PIN_HASH; using the dev cookie secret");
  }
  return crypto.createHash("sha256").update(material || "scramble-dev-secret").digest();
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", signingSecret()).update(payload).digest("base64url");
}

export function makeCommissionerToken(tripId: string, nowMs: number = Date.now(), ttlMs: number = COMMISSIONER_TTL_MS): string {
  const exp = Math.floor(nowMs + ttlMs);
  const payload = `${tripId}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

/** True when `token` is an unexpired, untampered token for this trip. */
export function verifyCommissionerToken(token: string | null | undefined, tripId: string, nowMs: number = Date.now()): boolean {
  if (!token || typeof token !== "string" || token.length > 300) return false;
  const lastDot = token.lastIndexOf(".");
  if (lastDot <= 0) return false;
  const payload = token.slice(0, lastDot);
  const sig = token.slice(lastDot + 1);
  const sepDot = payload.lastIndexOf(".");
  if (sepDot <= 0) return false;
  const tokenTrip = payload.slice(0, sepDot);
  const expStr = payload.slice(sepDot + 1);
  if (tokenTrip !== tripId || !/^\d{1,16}$/.test(expStr)) return false;
  if (Number(expStr) <= nowMs) return false;
  const expected = Buffer.from(sign(payload), "base64url");
  const given = Buffer.from(sig, "base64url");
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

export function commissionerCookieName(tripId: string): string {
  return `scramble_comm_${tripId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8)}`;
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

/** Set-Cookie value granting commissioner powers on this trip for 12 hours. */
export function commissionerCookie(request: Request, tripId: string, nowMs: number = Date.now()): string {
  return serializeCookie(commissionerCookieName(tripId), makeCommissionerToken(tripId, nowMs), {
    maxAgeSec: COMMISSIONER_TTL_MS / 1000,
    secure: secureFor(request),
  });
}

/** Set-Cookie value that removes the commissioner cookie. */
export function clearCommissionerCookie(request: Request, tripId: string): string {
  return serializeCookie(commissionerCookieName(tripId), "", { maxAgeSec: 0, secure: secureFor(request) });
}

/** Does this request carry a valid commissioner cookie for the trip? */
export function isCommissioner(request: Request, tripId: string, nowMs: number = Date.now()): boolean {
  const token = parseCookies(request.headers.get("cookie")).get(commissionerCookieName(tripId));
  return verifyCommissionerToken(token, tripId, nowMs);
}

// ---------------------------------------------------------------------------
// PIN attempt throttle (per process; good enough against a bored groomsman)
// ---------------------------------------------------------------------------

const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILS_PER_CLIENT = 8;
const MAX_FAILS_PER_TRIP = 40;

interface Bucket {
  count: number;
  resetAt: number;
}
const G = globalThis as typeof globalThis & { __scramblePinThrottle?: Map<string, Bucket> };
const buckets: Map<string, Bucket> = (G.__scramblePinThrottle ??= new Map());

function bucket(key: string, now: number): Bucket {
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + WINDOW_MS };
    buckets.set(key, b);
  }
  return b;
}

/** Best-effort client address (Vercel sets x-forwarded-for). */
export function clientKey(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || request.headers.get("x-real-ip")?.trim() || "local";
}

/** Seconds until another PIN attempt is allowed, or 0 when allowed now. */
export function pinRetryAfter(tripId: string, client: string, now: number = Date.now()): number {
  const per = bucket(`${tripId}|${client}`, now);
  const all = bucket(`${tripId}|*`, now);
  if (per.count >= MAX_FAILS_PER_CLIENT) return Math.ceil((per.resetAt - now) / 1000);
  if (all.count >= MAX_FAILS_PER_TRIP) return Math.ceil((all.resetAt - now) / 1000);
  return 0;
}

export function recordPinFailure(tripId: string, client: string, now: number = Date.now()): void {
  bucket(`${tripId}|${client}`, now).count++;
  bucket(`${tripId}|*`, now).count++;
  if (buckets.size > 5000) {
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }
}

export function recordPinSuccess(tripId: string, client: string): void {
  buckets.delete(`${tripId}|${client}`);
}

/** Tests only. */
export function resetPinThrottle(): void {
  buckets.clear();
}
