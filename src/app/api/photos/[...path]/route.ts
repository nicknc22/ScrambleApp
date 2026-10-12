// GET /api/photos/trips/<trip_id>/<kind>/<uuid>.jpg → the locally stored photo (dev / no Supabase).
// Paths are immutable, so photos cache forever. 404 when photos live in Supabase Storage.
import { notFound, withErrors } from "@/lib/server/http";
import { readLocalPhoto, usesSupabaseStorage } from "@/lib/server/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withErrors(async (_request: Request, ctx: { params: Promise<{ path: string[] }> }) => {
  if (usesSupabaseStorage()) return notFound("Photos are served from storage, not here.");
  const { path } = await ctx.params;
  const joined = Array.isArray(path) ? path.join("/") : String(path ?? "");
  const bytes = await readLocalPhoto(joined);
  if (!bytes) return notFound("No such photo. It may still be uploading.");
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
