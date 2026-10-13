// POST /api/t/<code>/sync: the phones' outbox endpoint.
//   body     SyncRequest {ops: Op[]} (at most 200 ops)
//   200      SyncResponse {results: one per op in request order, snapshot: the trip after the batch}
//   400      the request itself is unusable: not JSON, no ops array, too many ops (the phone's sync
//            worker splits a 400'd batch to isolate a poison op, so never 400 for a per-op problem:
//            those are "rejected" results)
//   404      unknown trip code; 413 body too large (the worker splits the batch); 500 transient
// Every op applies exactly once by id (resends answer "duplicate"). After the response, the
// post-commit work (Realtime broadcast + registered hooks) runs via after(). Never cached.
import "@/lib/server/integrations";
import { after } from "next/server";
import type { SyncResponse } from "@/lib/ops";
import { isCommissioner } from "@/lib/server/auth";
import { applyOpsToTrip, MAX_OPS_PER_SYNC } from "@/lib/server/apply";
import { runPostCommit, type PostCommitContext } from "@/lib/server/hooks";
import { badRequest, json, loadTripOr404, notFound, readJsonObject, withErrors } from "@/lib/server/http";
import { TripNotFoundError } from "@/lib/server/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 200 ops with 1000-character posts fit comfortably. (Not exported: route files may only export handlers + config.) */
const MAX_SYNC_BODY_BYTES = 1024 * 1024;

/** after(), or (outside a Next request scope: scripts, tests) a detached background task. */
function afterResponse(task: () => Promise<unknown>): void {
  try {
    after(task);
  } catch {
    void task().catch((e: unknown) => console.error("[sync] post-commit work failed", e));
  }
}

export const POST = withErrors(async (request: Request, ctx: { params: Promise<{ code: string }> }) => {
  const { code } = await ctx.params;
  const t = await loadTripOr404(code);
  if (t instanceof Response) return t;

  const body = await readJsonObject(request, MAX_SYNC_BODY_BYTES);
  if (body instanceof Response) return body;
  const ops = body.ops;
  if (!Array.isArray(ops)) return badRequest('Expected {"ops": [...]}. That sync was gibberish.');
  if (ops.length > MAX_OPS_PER_SYNC) {
    return badRequest(`Too many changes in one sync (max ${MAX_OPS_PER_SYNC}). Send them in smaller batches.`, "too_many_ops");
  }

  const comm = isCommissioner(request, t.trip.id);
  let out: Awaited<ReturnType<typeof applyOpsToTrip>>;
  try {
    out = await applyOpsToTrip({ db: t.db, trip: t.trip, ops, isCommissioner: comm });
  } catch (e) {
    if (e instanceof TripNotFoundError) return notFound(); // deleted mid-request (demo reset)
    throw e;
  }

  if (ops.length > 0) {
    const post: PostCommitContext = {
      trip: out.snapshot.state.trip,
      events: out.events,
      ops: out.applied,
      results: out.results,
      state: out.snapshot.state,
      is_commissioner: comm,
    };
    afterResponse(() => runPostCommit(post));
  }

  const response: SyncResponse = { results: out.results, snapshot: out.snapshot };
  return json(response);
});
