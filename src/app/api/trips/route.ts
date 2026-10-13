// POST /api/trips {pin, name?, app_name?} → 201 {code, trip_id, url} + commissioner cookie.
// With COMMISSIONER_PIN_HASH set, the PIN must match it and the new trip uses that hash.
// Without it, only outside production (dev convenience): the trip's PIN becomes `pin`.
import {
  clientKey,
  commissionerCookie,
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

/** Throttle bucket for trip creation (shares the PIN throttle, keyed apart from real trips). */
const CREATE_KEY = "create-trip";

export const POST = withErrors(async (request: Request) => {
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const pin = typeof body.pin === "string" ? body.pin.trim() : "";
  const name = typeof body.name === "string" ? body.name : DEFAULT_TRIP_NAME;
  const appName = typeof body.app_name === "string" ? body.app_name : DEFAULT_APP_NAME;

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
    const wait = pinRetryAfter(CREATE_KEY, client);
    if (wait > 0) {
      return errorJson(429, "Easy, tiger. Too many wrong PINs. Wait a few minutes.", {
        code: "throttled",
        retry_after: wait,
      });
    }
    if (!(await verifyPin(pin, envHash))) {
      recordPinFailure(CREATE_KEY, client);
      return errorJson(401, "Wrong PIN. Only the commissioner gets to start a trip.", { code: "bad_pin" });
    }
    recordPinSuccess(CREATE_KEY, client);
    pinHash = envHash;
  } else {
    if (isProduction()) {
      return errorJson(403, "Trip creation is locked: the server has no COMMISSIONER_PIN_HASH set.", {
        code: "not_configured",
      });
    }
    if (!isValidPin(pin)) return badRequest("The commissioner PIN is 4 to 12 digits.");
    pinHash = await hashPin(pin);
  }

  try {
    const trip = await createTrip(getDb(), { name, app_name: appName, pin_hash: pinHash });
    return json(
      { code: trip.code, trip_id: trip.id, url: `/t/${trip.code}` },
      { status: 201, headers: { "Set-Cookie": commissionerCookie(request, trip.id) } },
    );
  } catch (e) {
    if (e instanceof TripInputError) return badRequest(e.message);
    throw e;
  }
});
