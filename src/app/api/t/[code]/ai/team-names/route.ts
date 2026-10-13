// POST /api/t/<code>/ai/team-names {seed?} → 200 {names: string[5], ai: boolean}
// Five unhinged golf / drinking / bachelor-party team names from the fast model, skipping names
// the trip's teams already use. AI off, slow (8 s), failing or rate limited → five built-in names
// with ai: false (never an error for that). Light per-trip rate limit on AI calls; 404 for an
// unknown trip code. Never cached.
import { generateTeamNames, aiAvailable } from "@/lib/server/ai";
import { demoAiEnabled } from "@/lib/server/env";
import { json, loadTripOr404, readJsonObject, withErrors } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** AI generations per trip per window (each extra tap still gets names: the built-in list). */
const RATE_LIMIT = 12;
const RATE_WINDOW_MS = 10 * 60_000;

const G = globalThis as typeof globalThis & { __scrambleTeamNameCalls?: Map<string, number[]> };
const calls: Map<string, number[]> = (G.__scrambleTeamNameCalls ??= new Map());

/** Record an AI call for the trip unless it's over the limit. */
function takeSlot(tripId: string, now = Date.now()): boolean {
  const recent = (calls.get(tripId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    calls.set(tripId, recent);
    return false;
  }
  recent.push(now);
  calls.set(tripId, recent);
  if (calls.size > 500) {
    for (const [k, v] of calls) if (v.every((t) => now - t >= RATE_WINDOW_MS)) calls.delete(k);
  }
  return true;
}

export const POST = withErrors(async (request: Request, ctx: { params: Promise<{ code: string }> }) => {
  const { code } = await ctx.params;
  const t = await loadTripOr404(code);
  if (t instanceof Response) return t;
  const body = await readJsonObject(request, 8 * 1024);
  const seed = body instanceof Response ? null : typeof body.seed === "string" ? body.seed : null;

  let existing: string[] = [];
  try {
    const rows = await t.db.query<{ name: string }>("select name from teams where trip_id = $1 and deleted_at is null", [t.trip.id]);
    existing = rows.map((r) => r.name);
  } catch {
    existing = [];
  }

  const useAi = aiAvailable() && (!t.trip.is_demo || demoAiEnabled()) && takeSlot(t.trip.id);
  const result = await generateTeamNames({ tripId: t.trip.id, seed, existing }, useAi ? {} : { client: null });
  return json(result);
});
