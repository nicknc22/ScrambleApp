// Commissioner unlock for one trip.
//   GET                → {is_commissioner}
//   POST {pin}         → verify against the trip's PIN hash, set the 12 h cookie + trust this
//                        device for 60 days → {ok: true}
//   DELETE             → lock: clear the commissioner cookie → {ok: true}. The device stays
//                        trusted (that grants nothing without the PIN; see auth.ts).
//   PUT {pin, new_pin} → change the trip's PIN (4-12 digits) after verifying the current one.
//                        Every cookie issued for the old PIN stops working; this device gets new ones.
// Wrong PINs are throttled in the database (per client; per trip as a slow cap with short waits),
// each attempt reserved before the PIN is checked so bursts can't sneak extra guesses in. A trusted
// device only answers to its own bucket, so other people's wrong guesses can't lock it out.
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH } from "@/lib/pin";
import {
  attemptPin,
  clearCommissionerCookie,
  clientKey,
  commissionerSessionHeaders,
  deviceClientKey,
  hashPin,
  isCommissioner,
  isValidPin,
  retryAfterText,
  trustedDeviceId,
  verifyPin,
} from "@/lib/server/auth";
import { badRequest, errorJson, json, loadTripOr404, readJsonObject, withErrors, type TripContext } from "@/lib/server/http";
import { setTripPinHash } from "@/lib/server/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ code: string }> };

const WRONG_PIN = [
  "Wrong PIN. The real commissioner would know it.",
  "Nope. That PIN is about as accurate as your tee shots.",
  "Wrong PIN. Nice try, groomsman.",
  "Denied. Put the phone down and go hit a drive.",
  "That's not it. The commissioner has been notified (not really).",
];

function wrongPin(): Response {
  const message = WRONG_PIN[Math.floor(Math.random() * WRONG_PIN.length)];
  return errorJson(401, message, { code: "bad_pin" });
}

function throttled(seconds: number): Response {
  return errorJson(429, `Easy, tiger. Too many wrong PINs. Try again in ${retryAfterText(seconds)}.`, {
    code: "throttled",
    retry_after: seconds,
  });
}

/**
 * Throttle + verify. Returns null when the PIN is right, else the error Response. The throttle is
 * checked (and the attempt reserved) before the PIN, so a throttled request learns nothing about
 * its PIN and a burst can't check more PINs than the limit.
 */
async function checkPin(request: Request, t: TripContext, pin: unknown): Promise<Response | null> {
  const device = trustedDeviceId(request, t.trip.id, t.pinHash);
  const client = device ? deviceClientKey(device) : clientKey(request);
  const attempt = await attemptPin(t.db, t.trip.id, client, () => verifyPin(typeof pin === "string" ? pin.trim() : pin, t.pinHash), {
    trusted: device !== null,
  });
  if (attempt.status === "throttled") return throttled(attempt.retryAfter);
  return attempt.status === "ok" ? null : wrongPin();
}

export const GET = withErrors(async (request: Request, ctx: Ctx) => {
  const t = await loadTripOr404((await ctx.params).code);
  if (t instanceof Response) return t;
  return json({ is_commissioner: isCommissioner(request, t.trip.id, t.pinHash) });
});

export const POST = withErrors(async (request: Request, ctx: Ctx) => {
  const t = await loadTripOr404((await ctx.params).code);
  if (t instanceof Response) return t;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const denied = await checkPin(request, t, body.pin);
  if (denied) return denied;
  return json({ ok: true, is_commissioner: true }, { headers: commissionerSessionHeaders(request, t.trip.id, t.pinHash) });
});

export const DELETE = withErrors(async (request: Request, ctx: Ctx) => {
  const t = await loadTripOr404((await ctx.params).code);
  if (t instanceof Response) return t;
  // The trusted-device cookie stays: Lock is "powers off", not "forget this phone", and dropping it
  // would let other people's wrong guesses keep the commissioner's own phone waiting.
  return json({ ok: true, is_commissioner: false }, { headers: [["Set-Cookie", clearCommissionerCookie(request, t.trip.id)]] });
});

export const PUT = withErrors(async (request: Request, ctx: Ctx) => {
  const t = await loadTripOr404((await ctx.params).code);
  if (t instanceof Response) return t;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const newPin = typeof body.new_pin === "string" ? body.new_pin.trim() : "";
  if (!isValidPin(newPin)) return badRequest(`The new PIN has to be ${PIN_MIN_LENGTH} to ${PIN_MAX_LENGTH} digits.`);
  const denied = await checkPin(request, t, body.pin);
  if (denied) return denied;
  const newHash = await hashPin(newPin);
  await setTripPinHash(t.db, t.trip.id, newHash);
  return json({ ok: true, is_commissioner: true }, { headers: commissionerSessionHeaders(request, t.trip.id, newHash) });
});
