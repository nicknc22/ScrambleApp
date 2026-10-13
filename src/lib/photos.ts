// Photo paths, shared by client, reducer and server (pure, no I/O). Paths are always
// `trips/<trip_id>/<kind>/<uuid>.jpg`: unguessable, immutable and scoped to one trip, so an op can
// only reference a photo of its own trip (never an external URL, a data: URI or another trip's file).
export const PHOTO_KINDS = ["drinks", "ld", "ctp", "posts"] as const;
export type PhotoKind = (typeof PHOTO_KINDS)[number];

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
export const PHOTO_PATH_RE = new RegExp(`^trips/(${UUID})/(${PHOTO_KINDS.join("|")})/(${UUID})\\.jpg$`);

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
