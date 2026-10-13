// POST /api/trips {pin, name?, app_name?} → 201 {code, trip_id, url} + commissioner cookie (and
// this device trusted for the new trip, see auth.ts).
// With a server PIN set (COMMISSIONER_PIN_HASH, else the plain COMMISSIONER_PIN), the PIN must
// match it. The new trip stores that hash, or a fresh scrypt hash of the plain PIN (never the PIN
// itself). Wrong PINs share the database throttle (bucket: trip_id null; per IP, plus a slow
// global cap whose waits stay short, so strangers can't keep the commissioner from creating the
// trip). A server PIN that is set but malformed refuses every attempt (not_configured).
// Without one, only outside production (dev convenience): the trip's PIN becomes `pin`.
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH } from "@/lib/pin";
import {
  attemptPin,
  clientKey,
  commissionerSessionHeaders,
  hashPin,
  isValidPin,
  retryAfterText,
  serverPin,
  verifyServerPin,
} from "@/lib/server/auth";
import { getDb } from "@/lib/server/db";
import { isProduction } from "@/lib/server/env";
import { badRequest, errorJson, json, readJsonObject, withErrors } from "@/lib/server/http";
import { createTrip, DEFAULT_APP_NAME, DEFAULT_TRIP_NAME, TripInputError } from "@/lib/server/trips";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withErrors(async (request: Request) => {
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const pin = typeof body.pin === "string" ? body.pin.trim() : "";
  const name = typeof body.name === "string" ? body.name : DEFAULT_TRIP_NAME;
  const appName = typeof body.app_name === "string" ? body.app_name : DEFAULT_APP_NAME;
  const db = getDb();

  let pinHash: string;
  const server = serverPin();
  if (server.kind === "invalid") {
    console.error(server.message);
    return errorJson(500, server.message, { code: "not_configured" });
  }
  if (server.kind !== "none") {
    const attempt = await attemptPin(db, null, clientKey(request), () => verifyServerPin(pin, server));
    if (attempt.status === "throttled") {
      return errorJson(429, `Easy, tiger. Too many wrong PINs. Try again in ${retryAfterText(attempt.retryAfter)}.`, {
        code: "throttled",
        retry_after: attempt.retryAfter,
      });
    }
    if (attempt.status === "wrong") return errorJson(401, "Wrong PIN. Only the commissioner gets to start a trip.", { code: "bad_pin" });
    pinHash = server.kind === "hash" ? server.hash : await hashPin(pin);
  } else {
    if (isProduction()) {
      return errorJson(403, "Trip creation is locked: the server has no COMMISSIONER_PIN set.", {
        code: "not_configured",
      });
    }
    if (!isValidPin(pin)) return badRequest(`The commissioner PIN is ${PIN_MIN_LENGTH} to ${PIN_MAX_LENGTH} digits.`);
    pinHash = await hashPin(pin);
  }

  try {
    const trip = await createTrip(db, { name, app_name: appName, pin_hash: pinHash });
    return json(
      { code: trip.code, trip_id: trip.id, url: `/t/${trip.code}` },
      { status: 201, headers: commissionerSessionHeaders(request, trip.id, pinHash) },
    );
  } catch (e) {
    if (e instanceof TripInputError) return badRequest(e.message);
    throw e;
  }
});
