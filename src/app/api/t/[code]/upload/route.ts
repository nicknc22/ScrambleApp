// POST /api/t/<code>/upload?path=trips/<trip_id>/<kind>/<uuid>.jpg with a raw image/jpeg body
// (≤ 4 MB: Vercel refuses bodies over 4.5 MB before this handler runs) → {path}. Write-once:
// re-uploading the same bytes to a stored path is a harmless retry (200), different bytes are
// refused with 409 (nobody gets to swap out closest-to-pin evidence). Each trip has a photo quota
// (800 photos; 80 on a public demo trip, plus one ceiling for all demos), reserved atomically.
// Status codes matter to the client's outbox: 400/413/415 are permanent (stop retrying this
// photo), anything else is retried with backoff.
// A closest-to-pin photo that lands after its entry synced (photos never hold ops back) gets the
// AI judge here, after the response.
import { after } from "next/server";
import { judgeUploadedPhoto } from "@/lib/server/judge";
import { badRequest, errorJson, json, loadTripOr404, readBody, withErrors } from "@/lib/server/http";
import {
  isJpeg,
  isTripPhotoPath,
  MAX_PHOTO_BYTES,
  parsePhotoPath,
  PhotoConflictError,
  PhotoPathError,
  PhotoQuotaError,
  savePhotoUpload,
} from "@/lib/server/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** The AI judge (photo + one vision call, maybe a roast and pushes) runs after the response. */
export const maxDuration = 60;

const ACCEPTED_TYPES = new Set(["image/jpeg", "image/jpg", "image/pjpeg", "application/octet-stream", ""]);
const TOO_BIG = "That photo is enormous. 4 MB max.";

/** after(), or (outside a Next request scope: scripts, tests) a detached background task. */
function afterResponse(task: () => Promise<unknown>): void {
  const run = () => task().catch((e: unknown) => console.error("[upload] post-response work failed", e));
  try {
    after(run);
  } catch {
    void run();
  }
}

export const POST = withErrors(async (request: Request, ctx: { params: Promise<{ code: string }> }) => {
  const { code } = await ctx.params;
  const t = await loadTripOr404(code);
  if (t instanceof Response) return t;

  const path = new URL(request.url).searchParams.get("path");
  if (!isTripPhotoPath(path, t.trip.id)) {
    return badRequest("That photo path is cursed. Expected trips/<trip>/<kind>/<uuid>.jpg for this trip.");
  }
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!ACCEPTED_TYPES.has(type)) return errorJson(415, "Photos only, and JPEG at that.", { code: "unsupported_type" });
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_PHOTO_BYTES) return errorJson(413, TOO_BIG, { code: "too_large" });

  const bytes = await readBody(request, MAX_PHOTO_BYTES);
  if (bytes === null) return errorJson(413, TOO_BIG, { code: "too_large" });
  if (bytes.length === 0) return badRequest("Empty photo. Did the camera blink?");
  if (!isJpeg(bytes)) return errorJson(415, "That's not a JPEG.", { code: "unsupported_type" });

  try {
    await savePhotoUpload(t.db, t.trip, path, bytes);
  } catch (e) {
    if (e instanceof PhotoQuotaError) {
      // 413 = permanent for the phone's outbox: it stops retrying this photo.
      return errorJson(413, `${e.message} The commissioner has seen enough.`, { code: "photo_quota" });
    }
    if (e instanceof PhotoConflictError) {
      return errorJson(409, "Nice try. A different photo is already filed under that name, and evidence is final.", {
        code: "photo_exists",
      });
    }
    if (e instanceof PhotoPathError) return badRequest(e.message);
    throw e;
  }

  if (parsePhotoPath(path)?.kind === "ctp") {
    const trip = t.trip;
    afterResponse(() => judgeUploadedPhoto(trip, path));
  }
  return json({ path });
});
