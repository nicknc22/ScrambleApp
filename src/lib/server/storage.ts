// Photo storage. Paths are always `trips/<trip_id>/<kind>/<uuid>.jpg` (unguessable, immutable).
//   Supabase configured (URL + service key) → public bucket "photos" via supabase-js.
//   Otherwise → files under UPLOADS_DIR, served by GET /api/photos/[...path].
// Photo URL on the client = meta.photo_base_url + path.
import fs from "node:fs/promises";
import nodePath from "node:path";
import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseConfigured, supabaseServiceRoleKey, supabaseUrl, uploadsDir } from "./env";

export const PHOTO_BUCKET = "photos";
export const PHOTO_KINDS = ["drinks", "ld", "ctp", "posts"] as const;
export type PhotoKind = (typeof PHOTO_KINDS)[number];
/** Upload size cap (phones send ~300 KB after compression). */
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const PHOTO_PATH_RE = new RegExp(`^trips/(${UUID})/(drinks|ld|ctp|posts)/(${UUID})\\.jpg$`);

export interface PhotoPathParts {
  tripId: string;
  kind: PhotoKind;
  id: string;
}

export function parsePhotoPath(path: unknown): PhotoPathParts | null {
  if (typeof path !== "string") return null;
  const m = PHOTO_PATH_RE.exec(path);
  return m ? { tripId: m[1], kind: m[2] as PhotoKind, id: m[3] } : null;
}

/** `path` is a well-formed photo path belonging to this trip. */
export function isTripPhotoPath(path: unknown, tripId: string): path is string {
  const p = parsePhotoPath(path);
  return !!p && p.tripId === tripId;
}

export class PhotoPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhotoPathError";
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

/** Store a photo. Idempotent: re-uploading the same path overwrites it. */
export async function putPhoto(tripId: string, path: string, bytes: Uint8Array, contentType = "image/jpeg"): Promise<void> {
  if (!isTripPhotoPath(path, tripId)) throw new PhotoPathError("Bad photo path");
  if (bytes.byteLength === 0) throw new PhotoPathError("Empty photo");
  if (bytes.byteLength > MAX_PHOTO_BYTES) throw new PhotoPathError("Photo too large");

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

  const file = localPhotoFile(path);
  if (!file) throw new PhotoPathError("Bad photo path");
  await fs.mkdir(nodePath.dirname(file), { recursive: true });
  // Write then rename so a reader never sees a half-written file.
  const tmp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(tmp, bytes);
  await fs.rename(tmp, file);
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
