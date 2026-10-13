// Web Push subscriptions for a trip (the client side is src/lib/client/push.ts).
//   POST   {player_id, subscription: PushSubscription.toJSON()}  → 200 {ok, push_enabled}
//          Upserts by endpoint (a device that re-subscribes, or moves to another player/trip,
//          updates its row). 400 when the player isn't an active player of this trip or the
//          subscription is malformed / not a known browser push service.
//   DELETE {player_id?, endpoint}                                → 200 {ok, removed}
// 404 for an unknown trip code. Never cached.
import { badRequest, json, loadTripOr404, readJsonObject, withErrors } from "@/lib/server/http";
import { pushAvailable, parsePushSubscription, removePushSubscription, savePushSubscription } from "@/lib/server/push";
import { isUuid } from "@/lib/server/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 16 * 1024;

export const POST = withErrors(async (request: Request, ctx: { params: Promise<{ code: string }> }) => {
  const { code } = await ctx.params;
  const t = await loadTripOr404(code);
  if (t instanceof Response) return t;
  const body = await readJsonObject(request, MAX_BODY_BYTES);
  if (body instanceof Response) return body;

  if (!isUuid(body.player_id)) return badRequest("Who are you? Pick your name first.", "unknown_player");
  const sub = parsePushSubscription(body.subscription);
  if (!sub) return badRequest("That push subscription is busted. Try turning notifications off and on.", "bad_subscription");

  const saved = await savePushSubscription(t.db, t.trip.id, body.player_id, sub);
  if (!saved) return badRequest("You're not on this trip's roster. Ask the commissioner.", "unknown_player");
  return json({ ok: true, push_enabled: pushAvailable() });
});

export const DELETE = withErrors(async (request: Request, ctx: { params: Promise<{ code: string }> }) => {
  const { code } = await ctx.params;
  const t = await loadTripOr404(code);
  if (t instanceof Response) return t;
  const body = await readJsonObject(request, MAX_BODY_BYTES);
  if (body instanceof Response) return body;

  const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
  if (!endpoint || endpoint.length > 2048) return badRequest("Which subscription? Send its endpoint.", "bad_subscription");
  const removed = await removePushSubscription(t.db, t.trip.id, endpoint);
  return json({ ok: true, removed });
});
