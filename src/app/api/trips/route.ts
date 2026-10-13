// POST /api/trips {pin, name?, app_name?} → 201 {code, trip_id, url} + commissioner cookie (and
// this device trusted for the new trip, see auth.ts).
// With COMMISSIONER_PIN_HASH set, the PIN must match it and the new trip uses that hash. Wrong
// PINs share the database throttle (bucket: trip_id null).
// Without it, only outside production (dev convenience): the trip's PIN becomes `pin`.
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH } from "@/lib/pin";
import {
  clientKey,
  commissionerSessionHeaders,
  hashPin,
  isValidPin,
  isWellFormedPinHash,
  pinRetryAfter,
  recordPinFailure,
  recordPinSuccess,
  verifyPin,
} from "@/lib/server/auth";
import { getDb } from "@/lib/server/db";
import { commissionerPinHash, isProduction } from "@/lib/server/env";
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
  const envHash = commissionerPinHash();
  if (envHash) {
    if (!isWellFormedPinHash(envHash)) {
      console.error("COMMISSIONER_PIN_HASH is malformed (in .env files, write every $ as \\$)");
      return errorJson(500, "The server's COMMISSIONER_PIN_HASH is mangled. In .env files, write every $ as \\$.", {
        code: "not_configured",
      });
    }
    const client = clientKey(request);
    const wait = await pinRetryAfter(db, null, client);
    if (wait > 0) {
      return errorJson(429, "Easy, tiger. Too many wrong PINs. Wait a few minutes.", {
        code: "throttled",
        retry_after: wait,
      });
    }
    if (!(await verifyPin(pin, envHash))) {
      await recordPinFailure(db, null, client);
      return errorJson(401, "Wrong PIN. Only the commissioner gets to start a trip.", { code: "bad_pin" });
    }
    await recordPinSuccess(db, null, client);
    pinHash = envHash;
  } else {
    if (isProduction()) {
      return errorJson(403, "Trip creation is locked: the server has no COMMISSIONER_PIN_HASH set.", {
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
