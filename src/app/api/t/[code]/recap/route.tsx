// GET /api/t/<code>/recap → the shareable recap card: a 1080x1350 PNG with final standings and
// award winners, rendered from the live data (derive) with next/og. 404 for unknown codes.
// Never cached (scores can still be fixed after finalizing). No external fonts or images.
import { ImageResponse } from "next/og";
import { derive } from "@/lib/engine";
import { getDb } from "@/lib/server/db";
import { NO_STORE_HEADERS, loadTripOr404, serverError, withErrors } from "@/lib/server/http";
import { loadTripState } from "@/lib/server/repo";
import { RECAP_HEIGHT, RECAP_WIDTH, RecapImage, buildRecapModel } from "@/components/awards/recap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withErrors(async (_request: Request, ctx: { params: Promise<{ code: string }> }) => {
  const { code } = await ctx.params;
  const db = getDb();
  const t = await loadTripOr404(code, db);
  if (t instanceof Response) return t;

  const state = await loadTripState(db, t.trip.id);
  const model = buildRecapModel(state, derive(state));

  // Render fully before answering so a rendering failure is a clean 500, not a truncated PNG.
  let png: ArrayBuffer;
  try {
    png = await new ImageResponse(<RecapImage model={model} />, { width: RECAP_WIDTH, height: RECAP_HEIGHT }).arrayBuffer();
  } catch (e) {
    console.error("[recap] render failed", e);
    return serverError("The recap card face-planted. Try again in a sec.");
  }
  return new Response(png, {
    status: 200,
    headers: {
      ...NO_STORE_HEADERS,
      "Content-Type": "image/png",
      "Content-Length": String(png.byteLength),
      "Content-Disposition": `inline; filename="recap.png"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
});
