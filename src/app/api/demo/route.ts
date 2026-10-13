// POST /api/demo {code?, mode?} → {code, trip_id, url, mode} + the demo trip's commissioner cookie.
//   no code                 → a brand-new demo trip (mode default "partial"), 201
//   code of a demo trip     → wipe and re-simulate it with the same code (Reset demo), 200
//   code of a real trip     → 403 (demo tools never touch real trips)
//   unknown code            → 404
// mode: "partial" (round live, teams on 15/12/7), "full" (all 18 + finalized), "setup" (not started).
// Demo trips' commissioner PIN is 0000. Light per-process rate limit (429). After the response:
// a Realtime "changed" broadcast (other phones on a reset demo refetch) and pruning of week-old demos.
import { after } from "next/server";
import { clientKey, commissionerCookie } from "@/lib/server/auth";
import { getDb } from "@/lib/server/db";
import {
  createDemoTrip,
  DEMO_MODES,
  DemoError,
  demoRateLimit,
  isDemoMode,
  pruneDemoTrips,
  resetDemoTrip,
  type DemoMode,
  type DemoResult,
} from "@/lib/server/demo";
import { badRequest, errorJson, json, readJsonObject, withErrors } from "@/lib/server/http";
import { broadcastTripChanged } from "@/lib/server/realtime";
import { normalizeCode } from "@/lib/server/trips";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** A simulated round is ~100 small transactions; give a slow database room. */
export const maxDuration = 60;

/** after(), or (outside a Next request scope: tests, scripts) a detached background task. */
function afterResponse(task: () => Promise<unknown>): void {
  const run = () => task().catch((e: unknown) => console.error("[demo] post-response work failed", e));
  try {
    after(run);
  } catch {
    void run();
  }
}

export const POST = withErrors(async (request: Request) => {
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;

  let mode: DemoMode = "partial";
  if (body.mode !== undefined && body.mode !== null) {
    if (!isDemoMode(body.mode)) return badRequest(`Demo mode must be one of: ${DEMO_MODES.join(", ")}.`);
    mode = body.mode;
  }
  let code: string | null = null;
  if (body.code !== undefined && body.code !== null && body.code !== "") {
    code = typeof body.code === "string" ? normalizeCode(body.code) : null;
    if (!code) return badRequest("That's not a trip code.");
  }

  const wait = demoRateLimit(clientKey(request));
  if (wait > 0) {
    return errorJson(429, "Easy, tiger. That's a lot of fake golf. Try again in a minute.", { code: "throttled", retry_after: wait });
  }

  const db = getDb();
  let result: DemoResult;
  try {
    result = code ? await resetDemoTrip(db, code, { mode }) : await createDemoTrip(db, { mode });
  } catch (e) {
    if (e instanceof DemoError) return errorJson(e.status, e.message, { code: e.code });
    throw e;
  }

  const tripId = result.trip.id;
  if (code) afterResponse(() => broadcastTripChanged(tripId));
  else afterResponse(() => pruneDemoTrips(db));

  return json(
    { code: result.code, trip_id: tripId, url: result.url, mode: result.mode },
    { status: code ? 200 : 201, headers: { "Set-Cookie": commissionerCookie(request, tripId) } },
  );
});
