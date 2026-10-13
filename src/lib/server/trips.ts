// Trip creation and snapshots (what GET /api/t/<code>/state returns).
import { JACK_FROST_HOLES } from "@/lib/course";
import { deriveId, newId, newTripCode } from "@/lib/ids";
import { DEFAULT_SETTINGS, type Hole, type Snapshot, type SnapshotMeta, type Trip, type UUID } from "@/lib/types";
import type { Write } from "@/lib/reducer";
import { pgErrorCode, UNIQUE_VIOLATION, type Db } from "./db";
import { aiEnabled } from "./env";
import { findTripByCode, insertTrip, persistWrites, readTripState } from "./repo";
import { realtimeMeta } from "./realtime";
import { photoBaseUrl } from "./storage";
import { getVapidKeys } from "./vapid";

export const DEFAULT_TRIP_NAME = "Jack Frost Scramble";
export const DEFAULT_APP_NAME = "Scramble";
export const MAX_TRIP_NAME = 80;
export const MAX_APP_NAME = 40;

/** Join codes as clients normalize them: lowercase [a-z0-9], 3..64 chars. */
const CODE_RE = /^[a-z0-9]{3,64}$/;

/** Normalize a code from a URL segment; null when it can't be a trip code. */
export function normalizeCode(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  let s = raw;
  try {
    s = decodeURIComponent(s);
  } catch {
    /* keep raw */
  }
  s = s.trim().toLowerCase();
  return CODE_RE.test(s) ? s : null;
}

export interface CreateTripInput {
  name: string;
  app_name: string;
  /** scrypt hash from auth.hashPin (or COMMISSIONER_PIN_HASH). */
  pin_hash: string;
  is_demo?: boolean;
  /** Fixed join code (demo/tests). Default: a random unguessable code. */
  code?: string;
  /** Clock override for tests. */
  now?: Date;
}

export class TripInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TripInputError";
  }
}

function cleanName(v: string, max: number, fallback: string): string {
  const s = String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return (s || fallback).slice(0, max);
}

/** The 18 Jack Frost National holes for a new trip (ids derived from the trip id: stable). */
export function seedHoles(tripId: UUID, nowIso: string): Hole[] {
  return JACK_FROST_HOLES.map((h) => ({
    id: deriveId(tripId, "hole", String(h.number)),
    trip_id: tripId,
    number: h.number,
    par: h.par,
    stroke_index: h.stroke_index,
    yardage: { ...h.yardage },
    tee_lat: null,
    tee_lng: null,
    green_lat: null,
    green_lng: null,
    contest: h.contest,
    updated_at: nowIso,
  }));
}

/**
 * Create a trip in setup with default settings and the 18 seeded holes, in one transaction.
 * Retries with a fresh random code on the (astronomically unlikely) code collision.
 */
export async function createTrip(db: Db, input: CreateTripInput): Promise<Trip> {
  if (!input.pin_hash) throw new TripInputError("A commissioner PIN hash is required");
  const fixedCode = input.code === undefined ? null : normalizeCode(input.code);
  if (input.code !== undefined && !fixedCode) throw new TripInputError("Trip codes are 3-64 letters and digits");
  const name = cleanName(input.name, MAX_TRIP_NAME, DEFAULT_TRIP_NAME);
  const appName = cleanName(input.app_name, MAX_APP_NAME, DEFAULT_APP_NAME);

  for (let attempt = 0; ; attempt++) {
    const nowIso = (input.now ?? new Date()).toISOString();
    const trip: Trip = {
      id: newId(),
      code: fixedCode ?? newTripCode(),
      name,
      app_name: appName,
      status: "setup",
      base_team_size: 4,
      settings: { ...DEFAULT_SETTINGS, team_match_payout: [...DEFAULT_SETTINGS.team_match_payout] },
      is_demo: !!input.is_demo,
      created_at: nowIso,
      started_at: null,
      finalized_at: null,
      updated_at: nowIso,
    };
    try {
      return await db.tx(async (t) => {
        const saved = await insertTrip(t, trip, input.pin_hash);
        const writes: Write[] = seedHoles(trip.id, nowIso).map((row) => ({ kind: "upsert", table: "holes", row }));
        await persistWrites(t, trip.id, writes);
        return saved;
      });
    } catch (e) {
      if (pgErrorCode(e) === UNIQUE_VIOLATION && !fixedCode && attempt < 4) continue;
      if (pgErrorCode(e) === UNIQUE_VIOLATION && fixedCode) throw new TripInputError(`Trip code "${fixedCode}" is taken`);
      throw e;
    }
  }
}

/**
 * The VAPID public key phones subscribe with; null = push off (PUSH_DISABLED=1). A key-store
 * failure turns push off for this one response instead of failing the read. Only the public half
 * of the pair ever goes into a snapshot. Call with the root db (not inside a transaction).
 */
let lastPushKeyErrorLog = 0;

export async function pushPublicKey(db: Db): Promise<string | null> {
  try {
    return (await getVapidKeys(db))?.publicKey ?? null;
  } catch (e) {
    // Every poll would hit this: log the full error at most once a minute.
    const now = Date.now();
    if (now - lastPushKeyErrorLog > 60_000) {
      lastPushKeyErrorLog = now;
      console.error("[push] couldn't load the VAPID keys; push is off for these responses", e);
    }
    return null;
  }
}

/** Runtime config sent with every snapshot. `vapidPublicKey` comes from pushPublicKey. */
export function snapshotMeta(tripId: UUID, vapidPublicKey: string | null, serverTime: string = new Date().toISOString()): SnapshotMeta {
  return {
    server_time: serverTime,
    photo_base_url: photoBaseUrl(),
    realtime: realtimeMeta(tripId),
    vapid_public_key: vapidPublicKey,
    ai_enabled: aiEnabled(),
    push_enabled: vapidPublicKey !== null,
  };
}

/**
 * Full snapshot of a trip: every row (one consistent read) + meta. Never includes the PIN hash.
 * server_time is taken BEFORE reading, so a snapshot stamped T contains every commit before T
 * (clients keep the snapshot with the latest server_time).
 */
export async function buildSnapshot(db: Db, trip: Pick<Trip, "id">): Promise<Snapshot> {
  const vapidPublicKey = await pushPublicKey(db);
  const serverTime = new Date().toISOString();
  const state = await readTripState(db, trip.id);
  return { state, meta: snapshotMeta(trip.id, vapidPublicKey, serverTime) };
}

/** Snapshot by join code; null when there's no such trip. */
export async function snapshotByCode(db: Db, code: string): Promise<Snapshot | null> {
  const c = normalizeCode(code);
  if (!c) return null;
  const found = await findTripByCode(db, c);
  return found ? buildSnapshot(db, found.trip) : null;
}
