// GET /api/t/<code>/state → Snapshot (every row of the trip + runtime meta). Never cached.
import { json, loadTripOr404, withErrors } from "@/lib/server/http";
import { buildSnapshot } from "@/lib/server/trips";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withErrors(async (_request: Request, ctx: { params: Promise<{ code: string }> }) => {
  const { code } = await ctx.params;
  const t = await loadTripOr404(code);
  if (t instanceof Response) return t;
  return json(await buildSnapshot(t.db, t.trip));
});
