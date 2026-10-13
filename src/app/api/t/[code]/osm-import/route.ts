// POST /api/t/<code>/osm-import: prefill hole tee/green points from OpenStreetMap (commissioner).
//   body   {force?: boolean, dry_run?: boolean}   (empty body = fill only missing points)
//   200    OsmImportReport (ok: true). "Nothing found" is a normal 200 with empty counts.
//   403    no commissioner cookie; 404 unknown trip
//   502    OsmImportReport (ok: false) when no Overpass endpoint answered; nothing changed
// The points are written as hole.update ops through the same pipeline as the sync route (so
// they post "Commissioner override" feed events while the round is live, and phones refresh).
import { after } from "next/server";
import { isCommissioner } from "@/lib/server/auth";
import { applyOpsToTrip } from "@/lib/server/apply";
import { runPostCommit } from "@/lib/server/hooks";
import { errorJson, json, loadTripOr404, notFound, readJsonObject, withErrors } from "@/lib/server/http";
import { loadTripState, TripNotFoundError } from "@/lib/server/repo";
import { newId } from "@/lib/ids";
import { fetchOverpass, prepareOsmImport, unreachableReport } from "@/lib/osm";
import type { TripState } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Two Overpass endpoints at up to 60 s each, plus the write. */
export const maxDuration = 150;

function afterResponse(task: () => Promise<unknown>): void {
  try {
    after(task);
  } catch {
    void task().catch((e: unknown) => console.error("[osm-import] post-commit work failed", e));
  }
}

export const POST = withErrors(async (request: Request, ctx: { params: Promise<{ code: string }> }) => {
  const { code } = await ctx.params;
  const t = await loadTripOr404(code);
  if (t instanceof Response) return t;
  if (!isCommissioner(request, t.trip.id)) {
    return errorJson(403, "Commissioner only. Unlock in Settings first.", { code: "forbidden" });
  }
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const force = body.force === true;
  const dryRun = body.dry_run === true;

  const fetched = await fetchOverpass();
  if (!fetched.ok) {
    console.warn("[osm-import] Overpass unreachable:", fetched.errors.join("; "));
    return json(unreachableReport(fetched.errors, { force, dryRun }), { status: 502 });
  }

  let state: TripState;
  try {
    state = await loadTripState(t.db, t.trip.id);
  } catch (e) {
    if (e instanceof TripNotFoundError) return notFound();
    throw e;
  }
  const prepared = prepareOsmImport(state, fetched.json, {
    force,
    dryRun,
    now: new Date().toISOString(),
    newId,
    source: fetched.endpoint,
  });
  const report = prepared.report;
  report.errors.push(...fetched.errors);

  if (prepared.ops.length > 0) {
    let out: Awaited<ReturnType<typeof applyOpsToTrip>>;
    try {
      out = await applyOpsToTrip({ db: t.db, trip: t.trip, ops: prepared.ops, isCommissioner: true });
    } catch (e) {
      if (e instanceof TripNotFoundError) return notFound();
      throw e;
    }
    report.applied = out.results.filter((r) => r.status === "applied").length;
    for (const r of out.results) {
      if (r.status === "rejected") report.notes.push(`A hole update was rejected: ${r.reason ?? r.code ?? "unknown"}`);
    }
    afterResponse(() =>
      runPostCommit({
        trip: out.snapshot.state.trip,
        events: out.events,
        ops: out.applied,
        results: out.results,
        state: out.snapshot.state,
        is_commissioner: true,
      }),
    );
  }
  return json(report);
});
