// Commissioner auth: PIN hashing, signed tokens, cookies, throttle.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearCommissionerCookie,
  commissionerCookie,
  commissionerCookieName,
  COMMISSIONER_TTL_MS,
  hashPin,
  isCommissioner,
  isValidPin,
  makeCommissionerToken,
  parseCookies,
  pinRetryAfter,
  recordPinFailure,
  recordPinSuccess,
  resetPinThrottle,
  verifyCommissionerToken,
  verifyPin,
} from "@/lib/server/auth";

const TRIP = "0b6f5c3e-6a3c-4d7e-9a2b-1c2d3e4f5a6b";
const OTHER = "9f8e7d6c-5b4a-4321-8fed-cba987654321";

afterEach(() => {
  vi.unstubAllEnvs();
  resetPinThrottle();
});

describe("PIN hashing", () => {
  it("hashes to scrypt$salt$hash with a random salt and verifies", async () => {
    const h1 = await hashPin("2468");
    const h2 = await hashPin("2468");
    expect(h1).toMatch(/^scrypt\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(h1).not.toBe(h2);
    expect(await verifyPin("2468", h1)).toBe(true);
    expect(await verifyPin("2468", h2)).toBe(true);
    expect(await verifyPin("2469", h1)).toBe(false);
    expect(await verifyPin("", h1)).toBe(false);
    expect(await verifyPin(2468, h1)).toBe(false);
    expect(await verifyPin(null, h1)).toBe(false);
  });

  it("never verifies against malformed hashes", async () => {
    for (const bad of ["", "scrypt$", "scrypt$abc", "bcrypt$a$b", "scrypt$$aGFzaA", "scrypt$c2FsdA$c2hvcnQ", null, undefined]) {
      expect(await verifyPin("2468", bad as string)).toBe(false);
    }
  });

  it("validates new PINs as 4-12 digits", () => {
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
    const token = makeCommissionerToken(TRIP, now);
    const [trip, exp, sig] = [token.slice(0, 36), token.split(".")[1], token.split(".")[2]];
    expect(trip).toBe(TRIP);
    expect(Number(exp)).toBe(now + COMMISSIONER_TTL_MS);
    expect(sig).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verifyCommissionerToken(token, TRIP, now)).toBe(true);
    expect(verifyCommissionerToken(token, TRIP, now + COMMISSIONER_TTL_MS - 1)).toBe(true);
    expect(verifyCommissionerToken(token, TRIP, now + COMMISSIONER_TTL_MS)).toBe(false);
  });

  it("rejects tampering, other trips and garbage", () => {
    const token = makeCommissionerToken(TRIP, now);
    const [, exp, sig] = token.split(".");
    expect(verifyCommissionerToken(token, OTHER, now)).toBe(false);
    expect(verifyCommissionerToken(`${TRIP}.${Number(exp) + 1000}.${sig}`, TRIP, now)).toBe(false);
    expect(verifyCommissionerToken(`${OTHER}.${exp}.${sig}`, OTHER, now)).toBe(false);
    const flipped = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
    expect(verifyCommissionerToken(`${TRIP}.${exp}.${flipped}`, TRIP, now)).toBe(false);
    expect(verifyCommissionerToken(`${TRIP}.${exp}.`, TRIP, now)).toBe(false);
    expect(verifyCommissionerToken(`${TRIP}.${exp}`, TRIP, now)).toBe(false);
    expect(verifyCommissionerToken(`${TRIP}.-5.${sig}`, TRIP, now)).toBe(false);
    for (const g of ["", "x", "...", null, undefined, "a".repeat(500)]) {
      expect(verifyCommissionerToken(g as string, TRIP, now)).toBe(false);
    }
  });

  it("is signed with APP_SECRET when set (changing the secret invalidates tokens)", () => {
    vi.stubEnv("APP_SECRET", "one");
    const token = makeCommissionerToken(TRIP, now);
    expect(verifyCommissionerToken(token, TRIP, now)).toBe(true);
    vi.stubEnv("APP_SECRET", "two");
    expect(verifyCommissionerToken(token, TRIP, now)).toBe(false);
    vi.stubEnv("APP_SECRET", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    const t2 = makeCommissionerToken(TRIP, now);
    expect(verifyCommissionerToken(t2, TRIP, now)).toBe(true);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    vi.stubEnv("COMMISSIONER_PIN_HASH", "scrypt$x$y");
    expect(verifyCommissionerToken(t2, TRIP, now)).toBe(false);
  });
});

describe("cookies", () => {
  const req = (url = "http://localhost:3000/api/x", headers: Record<string, string> = {}) => new Request(url, { headers });

  it("names the cookie per trip", () => {
    expect(commissionerCookieName(TRIP)).toBe("scramble_comm_0b6f5c3e");
    expect(commissionerCookieName(OTHER)).toBe("scramble_comm_9f8e7d6c");
  });

  it("sets an httpOnly, lax, 12h cookie; Secure on https and in production", () => {
    const dev = commissionerCookie(req(), TRIP);
    expect(dev).toMatch(/^scramble_comm_0b6f5c3e=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200$/);
    expect(commissionerCookie(req("https://scramble.example/api/x"), TRIP)).toMatch(/; Secure$/);
    expect(commissionerCookie(req("http://internal/api/x", { "x-forwarded-proto": "https" }), TRIP)).toMatch(/; Secure$/);
    vi.stubEnv("NODE_ENV", "production");
    expect(commissionerCookie(req("http://scramble.example/api/x"), TRIP)).toMatch(/; Secure$/);
    // production over plain http on localhost/LAN (e2e, laptop fallback): Secure would be dropped
    expect(commissionerCookie(req("http://localhost:3100/api/x"), TRIP)).not.toMatch(/Secure/);
    expect(commissionerCookie(req("http://192.168.1.20:3000/api/x"), TRIP)).not.toMatch(/Secure/);
  });

  it("clears with Max-Age=0", () => {
    expect(clearCommissionerCookie(req(), TRIP)).toMatch(/^scramble_comm_0b6f5c3e=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=/);
  });

  it("isCommissioner reads the cookie header", () => {
    const setCookie = commissionerCookie(req(), TRIP);
    const pair = setCookie.split(";")[0];
    expect(isCommissioner(req(undefined, { cookie: `other=1; ${pair}; x=y` }), TRIP)).toBe(true);
    expect(isCommissioner(req(undefined, { cookie: pair }), OTHER)).toBe(false);
    expect(isCommissioner(req(undefined, { cookie: pair.replace(/.$/, "x") }), TRIP)).toBe(false);
    expect(isCommissioner(req(), TRIP)).toBe(false);
    // a valid token for OTHER placed under TRIP's cookie name doesn't work
    const otherToken = makeCommissionerToken(OTHER);
    expect(isCommissioner(req(undefined, { cookie: `${commissionerCookieName(TRIP)}=${otherToken}` }), TRIP)).toBe(false);
  });

  it("parseCookies handles quoting, encoding and duplicates", () => {
    const m = parseCookies('a=1; b="two"; c=%7Bx%7D; a=ignored; bad; =x');
    expect(m.get("a")).toBe("1");
    expect(m.get("b")).toBe("two");
    expect(m.get("c")).toBe("{x}");
    expect(m.size).toBe(3);
  });
});

describe("PIN throttle", () => {
  it("blocks a client after 8 failures in the window; success resets that client", () => {
    const now = 1_000_000;
    for (let i = 0; i < 7; i++) recordPinFailure(TRIP, "1.2.3.4", now);
    expect(pinRetryAfter(TRIP, "1.2.3.4", now)).toBe(0);
    recordPinFailure(TRIP, "1.2.3.4", now);
    expect(pinRetryAfter(TRIP, "1.2.3.4", now)).toBe(600);
    expect(pinRetryAfter(TRIP, "5.6.7.8", now)).toBe(0);
    expect(pinRetryAfter(OTHER, "1.2.3.4", now)).toBe(0);
    expect(pinRetryAfter(TRIP, "1.2.3.4", now + 600_000)).toBe(0); // window over
    for (let i = 0; i < 8; i++) recordPinFailure(TRIP, "9.9.9.9", now);
    recordPinSuccess(TRIP, "9.9.9.9");
    expect(pinRetryAfter(TRIP, "9.9.9.9", now)).toBe(0);
  });

  it("caps total failures per trip across clients", () => {
    const now = 2_000_000;
    for (let i = 0; i < 40; i++) recordPinFailure(TRIP, `10.0.0.${i}`, now);
    expect(pinRetryAfter(TRIP, "10.0.1.1", now)).toBeGreaterThan(0);
  });
});
