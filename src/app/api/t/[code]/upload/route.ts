// POST /api/t/<code>/upload?path=trips/<trip_id>/<kind>/<uuid>.jpg with a raw image/jpeg body
// (≤ 8 MB) → {path}. Idempotent: re-uploading the same path overwrites it.
// Status codes matter to the client's outbox: 400/413/415 are permanent (stop retrying this
// photo), anything else is retried with backoff.
import { badRequest, errorJson, json, loadTripOr404, readBody, withErrors } from "@/lib/server/http";
import { isTripPhotoPath, MAX_PHOTO_BYTES, PhotoPathError, putPhoto } from "@/lib/server/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACCEPTED_TYPES = new Set(["image/jpeg", "image/jpg", "image/pjpeg", "application/octet-stream", ""]);

/** JPEG files start with the SOI marker FF D8 FF. */
function looksLikeJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
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
  if (Number.isFinite(declared) && declared > MAX_PHOTO_BYTES) {
    return errorJson(413, "That photo is enormous. 8 MB max.", { code: "too_large" });
  }

  const bytes = await readBody(request, MAX_PHOTO_BYTES);
  if (bytes === null) return errorJson(413, "That photo is enormous. 8 MB max.", { code: "too_large" });
  if (bytes.length === 0) return badRequest("Empty photo. Did the camera blink?");
  if (!looksLikeJpeg(bytes)) return errorJson(415, "That's not a JPEG.", { code: "unsupported_type" });

  try {
    await putPhoto(t.trip.id, path, bytes, "image/jpeg");
  } catch (e) {
    if (e instanceof PhotoPathError) return badRequest(e.message);
    throw e;
  }
  return json({ path });
});
