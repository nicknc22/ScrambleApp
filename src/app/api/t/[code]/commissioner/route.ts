// Commissioner unlock for one trip.
//   GET              → {is_commissioner}
//   POST {pin}       → verify against the trip's PIN hash, set the 12 h cookie → {ok: true}
//   DELETE           → clear the cookie → {ok: true}
//   PUT {pin, new_pin} → change the trip's PIN (4-12 digits) after verifying the current one
// Wrong PINs are throttled per client (and per trip) in this process.
import {
  clearCommissionerCookie,
  clientKey,
  commissionerCookie,
  hashPin,
  isCommissioner,
  isValidPin,
  pinRetryAfter,
  recordPinFailure,
  recordPinSuccess,
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
  return errorJson(429, "Easy, tiger. Too many wrong PINs. Wait a few minutes.", {
    code: "throttled",
    retry_after: seconds,
  });
}

/** Throttle + verify. Returns null when the PIN is right, else the error Response. */
async function checkPin(request: Request, t: TripContext, pin: unknown): Promise<Response | null> {
  const client = clientKey(request);
  const wait = pinRetryAfter(t.trip.id, client);
  if (wait > 0) return throttled(wait);
  if (!(await verifyPin(typeof pin === "string" ? pin.trim() : pin, t.pinHash))) {
    recordPinFailure(t.trip.id, client);
    return wrongPin();
  }
  recordPinSuccess(t.trip.id, client);
  return null;
}

export const GET = withErrors(async (request: Request, ctx: Ctx) => {
  const t = await loadTripOr404((await ctx.params).code);
  if (t instanceof Response) return t;
  return json({ is_commissioner: isCommissioner(request, t.trip.id) });
});

export const POST = withErrors(async (request: Request, ctx: Ctx) => {
  const t = await loadTripOr404((await ctx.params).code);
  if (t instanceof Response) return t;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const denied = await checkPin(request, t, body.pin);
  if (denied) return denied;
  return json(
    { ok: true, is_commissioner: true },
    { headers: { "Set-Cookie": commissionerCookie(request, t.trip.id) } },
  );
});

export const DELETE = withErrors(async (request: Request, ctx: Ctx) => {
  const t = await loadTripOr404((await ctx.params).code);
  if (t instanceof Response) return t;
  return json(
    { ok: true, is_commissioner: false },
    { headers: { "Set-Cookie": clearCommissionerCookie(request, t.trip.id) } },
  );
});

export const PUT = withErrors(async (request: Request, ctx: Ctx) => {
  const t = await loadTripOr404((await ctx.params).code);
  if (t instanceof Response) return t;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const newPin = typeof body.new_pin === "string" ? body.new_pin.trim() : "";
  if (!isValidPin(newPin)) return badRequest("The new PIN has to be 4 to 12 digits.");
  const denied = await checkPin(request, t, body.pin);
  if (denied) return denied;
  await setTripPinHash(t.db, t.trip.id, await hashPin(newPin));
  return json(
    { ok: true, is_commissioner: true },
    { headers: { "Set-Cookie": commissionerCookie(request, t.trip.id) } },
  );
});
