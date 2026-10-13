// Photo storage. Paths are always `trips/<trip_id>/<kind>/<uuid>.jpg` (unguessable, immutable;
// validated by the shared src/lib/photos.ts, the same rules the reducer applies to ops).
//   Supabase configured (URL + service key) → public bucket "photos" via supabase-js.
//   Otherwise → files under UPLOADS_DIR, served by GET /api/photos/[...path]. Never on Vercel (no
//   writable disk): there missing Storage config is a ConfigError, not a silently lost photo.
// Photo URL on the client = meta.photo_base_url + path.
// Uploads through the API (savePhotoUpload) are JPEG-only, at most 4 MB each, count against a
// per-trip quota (demo trips also against one ceiling for all demos together) recorded in
// photo_uploads, and are write-once: a stored path only takes the same bytes again (a retry).
// Demo seed photos go straight through putPhoto.
import fs from "node:fs/promises";
import nodePath from "node:path";
import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isTripPhotoPath, parsePhotoPath, PHOTO_KINDS, type PhotoKind, type PhotoPathParts } from "@/lib/photos";
import type { Db } from "./db";
import { ConfigError, isVercel, supabaseConfigured, supabaseServiceRoleKey, supabaseUrl, uploadsDir } from "./env";

export { isTripPhotoPath, parsePhotoPath, PHOTO_KINDS, type PhotoKind, type PhotoPathParts };

export const PHOTO_BUCKET = "photos";
/**
 * Upload size cap. Vercel refuses request bodies over 4.5 MB before the handler even runs, so the
 * app's own limit sits under that (phones send ~300 KB after compression).
 */
export const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

/** Per-trip upload budgets. A real round is ~200 photos; a public demo trip gets a sliver. */
export const PHOTO_QUOTA = {
  real: { files: 800, bytes: 600 * 1024 * 1024 },
  demo: { files: 80, bytes: 40 * 1024 * 1024 },
} as const;

/**
 * Every demo trip together ("Try the demo" is public): far under the Supabase free tier's 1 GB,
 * whatever the number of demos created per hour. Pruning old demos frees it up again.
 */
export const DEMO_PHOTO_CEILING = { files: 1000, bytes: 200 * 1024 * 1024 } as const;

/** JPEG: the SOI marker FF D8 followed by another marker (FF C0..FE: APPn, DQT, SOF, COM...). */
export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes[3] >= 0xc0 && bytes[3] <= 0xfe;
}

export class PhotoPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhotoPathError";
  }
}

/** The trip is out of photo space (count or bytes). */
export class PhotoQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhotoQuotaError";
  }
}

/** A different photo is already stored at that path (photos are write-once evidence). */
export class PhotoConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhotoConflictError";
  }
}

/** Is Supabase Storage the photo backend? */
export function usesSupabaseStorage(): boolean {
  return supabaseConfigured();
}

/** Base URL photos are served from (photo URL = base + path). */
export function photoBaseUrl(): string {
  const url = supabaseUrl();
  if (usesSupabaseStorage() && url) return `${url}/storage/v1/object/public/${PHOTO_BUCKET}/`;
  return "/api/photos/";
}

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

interface StorageGlobals {
  client?: { key: string; client: SupabaseClient };
  bucket?: Promise<void>;
}
const G = globalThis as typeof globalThis & { __scrambleStorage?: StorageGlobals };
const sg: StorageGlobals = (G.__scrambleStorage ??= {});

async function supabase(): Promise<SupabaseClient> {
  const url = supabaseUrl();
  const key = supabaseServiceRoleKey();
  if (!url || !key) throw new Error("Supabase Storage is not configured");
  const cacheKey = `${url}|${key}`;
  if (sg.client?.key !== cacheKey) {
    const { createClient } = await import("@supabase/supabase-js");
    sg.client = {
      key: cacheKey,
      client: createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      }),
    };
    sg.bucket = undefined;
  }
  return sg.client.client;
}

/** Create the public "photos" bucket if it doesn't exist (once per process). */
function ensureBucket(client: SupabaseClient): Promise<void> {
  if (!sg.bucket) {
    const p = (async () => {
      const got = await client.storage.getBucket(PHOTO_BUCKET);
      if (!got.error && got.data) return;
      const made = await client.storage.createBucket(PHOTO_BUCKET, { public: true });
      // Another instance may have created it in the meantime.
      if (made.error && !/exist/i.test(made.error.message)) {
        throw new Error(`Couldn't create the ${PHOTO_BUCKET} bucket: ${made.error.message}`);
      }
    })();
    sg.bucket = p;
    p.catch(() => {
      if (sg.bucket === p) sg.bucket = undefined;
    });
  }
  return sg.bucket;
}

// ---------------------------------------------------------------------------
// Local files
// ---------------------------------------------------------------------------

function uploadsRoot(): string {
  return nodePath.resolve(uploadsDir());
}

/** Absolute local file for a photo path, or null when the path isn't a valid photo path. */
export function localPhotoFile(path: string): string | null {
  if (!parsePhotoPath(path)) return null;
  const root = uploadsRoot();
  const file = nodePath.resolve(root, ...path.split("/"));
  // Belt and braces: the regex already forbids "..", but never leave the uploads root.
  if (!file.startsWith(root + nodePath.sep)) return null;
  return file;
}

/** Read a locally stored photo; null when missing or the path is invalid. */
export async function readLocalPhoto(path: string): Promise<Uint8Array<ArrayBuffer> | null> {
  const file = localPhotoFile(path);
  if (!file) return null;
  try {
    return new Uint8Array(await fs.readFile(/*turbopackIgnore: true*/ file));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/**
 * Store a photo (no quota, no write-once check: savePhotoUpload does those). Re-uploading the same
 * path overwrites it.
 */
export async function putPhoto(tripId: string, path: string, bytes: Uint8Array, contentType = "image/jpeg"): Promise<void> {
  if (!isTripPhotoPath(path, tripId)) throw new PhotoPathError("Bad photo path");
  if (bytes.byteLength === 0) throw new PhotoPathError("Empty photo");
  if (bytes.byteLength > MAX_PHOTO_BYTES) throw new PhotoPathError("Photo too large");
  if (!isJpeg(bytes)) throw new PhotoPathError("Not a JPEG");

  if (usesSupabaseStorage()) {
    const client = await supabase();
    await ensureBucket(client);
    const { error } = await client.storage.from(PHOTO_BUCKET).upload(path, bytes, {
      contentType,
      upsert: true,
      cacheControl: "31536000",
    });
    if (error) throw new Error(`Photo upload failed: ${error.message}`);
    return;
  }

  if (isVercel()) {
    // The deployment's disk is read-only (and thrown away): a local fallback can't work there.
    throw new ConfigError(
      "Server misconfigured: photo storage needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. Add them in Vercel → Settings → Environment Variables, then redeploy.",
    );
  }
  const file = localPhotoFile(path);
  if (!file) throw new PhotoPathError("Bad photo path");
  await fs.mkdir(nodePath.dirname(file), { recursive: true });
  // Write then rename so a reader never sees a half-written file.
  const tmp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(tmp, bytes);
  await fs.rename(tmp, file);
}

/** The upload budget for a trip. */
export function photoQuotaFor(trip: { is_demo: boolean }): { files: number; bytes: number } {
  return trip.is_demo ? PHOTO_QUOTA.demo : PHOTO_QUOTA.real;
}

export function sha256Hex(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/**
 * Store a photo uploaded through the API.
 * 1. Under an advisory lock (per trip; one lock for all demo trips, which share a ceiling), check
 *    the quota and RESERVE the path in photo_uploads with its size and sha256, then commit. Parallel
 *    uploads therefore can't overshoot the quota (PhotoQuotaError).
 * 2. Write the file. If that fails, release the reservation.
 * A path that is already stored takes only the same bytes again (an outbox retry: rewritten, no
 * new quota); different bytes are a PhotoConflictError, so nobody can swap out evidence later.
 */
export async function savePhotoUpload(db: Db, trip: { id: string; is_demo: boolean }, path: string, bytes: Uint8Array): Promise<void> {
  if (!isTripPhotoPath(path, trip.id)) throw new PhotoPathError("Bad photo path");
  const sha = sha256Hex(bytes);
  const quota = photoQuotaFor(trip);
  const reserved = await db.tx(async (tx) => {
    await tx.query("select pg_advisory_xact_lock(hashtextextended($1::text, 0))", [trip.is_demo ? "photos:demo" : `photos:${trip.id}`]);
    const [stored] = await tx.query<{ trip_id: string; bytes: number; sha256: string | null }>(
      "select trip_id, bytes, sha256 from photo_uploads where path = $1",
      [path],
    );
    if (stored) {
      // Rows from before 003_photo_sha256 have no hash: the same size is the best retry check.
      const same = stored.trip_id === trip.id && (stored.sha256 === null ? Number(stored.bytes) === bytes.byteLength : stored.sha256 === sha);
      if (!same) throw new PhotoConflictError("A different photo is already stored there.");
      if (stored.sha256 === null) await tx.query("update photo_uploads set sha256 = $2 where path = $1", [path, sha]);
      return false;
    }
    const [used] = await tx.query<{ files: number; bytes: number }>(
      "select count(*)::int as files, coalesce(sum(bytes), 0)::bigint as bytes from photo_uploads where trip_id = $1",
      [trip.id],
    );
    if (Number(used?.files ?? 0) >= quota.files || Number(used?.bytes ?? 0) + bytes.byteLength > quota.bytes) {
      throw new PhotoQuotaError(`This trip is out of photo space (${quota.files} photos max).`);
    }
    if (trip.is_demo) {
      const [all] = await tx.query<{ files: number; bytes: number }>(
        `select count(*)::int as files, coalesce(sum(p.bytes), 0)::bigint as bytes
           from photo_uploads p join trips t on t.id = p.trip_id where t.is_demo`,
      );
      if (Number(all?.files ?? 0) >= DEMO_PHOTO_CEILING.files || Number(all?.bytes ?? 0) + bytes.byteLength > DEMO_PHOTO_CEILING.bytes) {
        throw new PhotoQuotaError("The demo is out of photo space for now.");
      }
    }
    await tx.query("insert into photo_uploads (trip_id, path, bytes, sha256) values ($1, $2, $3, $4)", [trip.id, path, bytes.byteLength, sha]);
    return true;
  });
  try {
    await putPhoto(trip.id, path, bytes, "image/jpeg");
  } catch (e) {
    // A retry of a stored path keeps its row: the earlier upload (or a later retry) holds the file.
    if (reserved) await db.query("delete from photo_uploads where path = $1 and sha256 = $2", [path, sha]).catch(() => {});
    throw e;
  }
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const LIST_PAGE = 100;

/**
 * Delete every stored photo of a trip (demo cleanup: a deleted trip's rows go with it, its files
 * don't). Best effort: never throws.
 */
export async function removeTripPhotos(tripId: string): Promise<void> {
  if (!UUID_RE.test(tripId)) return;
  try {
    if (usesSupabaseStorage()) {
      const bucket = (await supabase()).storage.from(PHOTO_BUCKET);
      for (const kind of PHOTO_KINDS) {
        const prefix = `trips/${tripId}/${kind}`;
        // Each pass removes what it listed, so the next list starts over at what's left.
        for (let pass = 0; pass < 100; pass++) {
          const { data, error } = await bucket.list(prefix, { limit: LIST_PAGE });
          if (error) throw new Error(error.message);
          if (!data?.length) break;
          const removed = await bucket.remove(data.map((f) => `${prefix}/${f.name}`));
          if (removed.error) throw new Error(removed.error.message);
          if (data.length < LIST_PAGE) break;
        }
      }
      return;
    }
    const root = uploadsRoot();
    const dir = nodePath.resolve(root, "trips", tripId);
    if (!dir.startsWith(root + nodePath.sep)) return;
    await fs.rm(/*turbopackIgnore: true*/ dir, { recursive: true, force: true });
  } catch (e) {
    console.warn(`[storage] couldn't remove the photos of trip ${tripId}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// Download (server-side readers, e.g. the AI judge)
// ---------------------------------------------------------------------------

/**
 * A stored photo's bytes: from the public Supabase bucket when Storage is configured, else from
 * the local uploads dir. null when the path is invalid, missing, larger than `maxBytes`
 * (default MAX_PHOTO_BYTES), slow (`timeoutMs`, default 5 s) or anything else fails. Never throws.
 */
export async function getPhotoBytes(
  path: string,
  opts: { maxBytes?: number; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<Uint8Array | null> {
  const maxBytes = opts.maxBytes ?? MAX_PHOTO_BYTES;
  try {
    if (!parsePhotoPath(path)) return null;
    if (!usesSupabaseStorage()) {
      const bytes = await readLocalPhoto(path);
      return bytes && bytes.byteLength > 0 && bytes.byteLength <= maxBytes ? bytes : null;
    }
    const res = await (opts.fetchImpl ?? fetch)(photoBaseUrl() + path, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const declared = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > maxBytes) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    return bytes.byteLength > 0 && bytes.byteLength <= maxBytes ? bytes : null;
  } catch {
    return null;
  }
}
