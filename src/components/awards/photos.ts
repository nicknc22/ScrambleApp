// Gallery photos: every photo on an active row (drinks, contest entries, feed events), deduped by
// path, in round order. Pure (unit-tested in tests/ui/awards-logic.test.ts).
import type { ISODate, TripState, UUID } from "@/lib/types";

export type GalleryKind = "drink" | "shotgun" | "shot" | "ctp" | "ld" | "post" | "feed";

export interface GalleryPhoto {
  path: string;
  kind: GalleryKind;
  at: ISODate;
  player_id: UUID | null;
  team_id: UUID | null;
  hole: number | null;
}

const KIND_LABEL: Record<GalleryKind, string> = {
  drink: "Drink",
  shotgun: "Shotgun",
  shot: "Shot",
  ctp: "Closest to pin",
  ld: "Long drive",
  post: "Post",
  feed: "Feed",
};

export function galleryKindLabel(kind: GalleryKind): string {
  return KIND_LABEL[kind];
}

type PhotoSources = Pick<TripState, "drinks" | "contest_entries" | "feed_events">;

/** Every photo on an active row, deduped by path (drink/contest rows win over the feed event that echoes them), oldest first. */
export function collectPhotos(state: PhotoSources): GalleryPhoto[] {
  const byPath = new Map<string, GalleryPhoto>();
  const add = (p: GalleryPhoto) => {
    if (!p.path || typeof p.path !== "string" || byPath.has(p.path)) return;
    byPath.set(p.path, p);
  };
  for (const d of state.drinks) {
    if (d.deleted_at !== null || !d.photo_path) continue;
    add({ path: d.photo_path, kind: d.type, at: d.logged_at, player_id: d.player_id, team_id: d.team_id, hole: d.hole });
  }
  for (const e of state.contest_entries) {
    if (e.deleted_at !== null || !e.photo_path) continue;
    add({ path: e.photo_path, kind: e.type, at: e.created_at, player_id: e.player_id, team_id: e.team_id, hole: e.hole });
  }
  for (const f of state.feed_events) {
    if (f.deleted_at !== null || !f.photo_path) continue;
    const hole = typeof f.payload?.hole === "number" ? (f.payload.hole as number) : null;
    add({
      path: f.photo_path,
      kind: f.type === "post" ? "post" : "feed",
      at: f.created_at,
      player_id: f.player_id ?? f.actor_id,
      team_id: f.team_id,
      hole,
    });
  }
  return [...byPath.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Filesystem-safe slug: "Big Nick's Shotgun!" -> "big-nicks-shotgun". */
export function slugify(s: string, max = 40): string {
  const slug = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug;
}

/** "007-hole04-shotgun-big-nick.jpg" — sortable, unique per index. */
export function photoFileName(p: GalleryPhoto, index: number, playerName: string | null): string {
  const parts = [String(index + 1).padStart(3, "0")];
  if (p.hole !== null) parts.push(`hole${String(p.hole).padStart(2, "0")}`);
  parts.push(slugify(KIND_LABEL[p.kind]));
  const who = playerName ? slugify(playerName, 24) : "";
  if (who) parts.push(who);
  return `${parts.join("-")}.jpg`;
}

/** "jack-frost-scramble-photos.zip" */
export function zipFileName(tripName: string): string {
  return `${slugify(tripName) || "scramble"}-photos.zip`;
}
