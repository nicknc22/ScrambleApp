"use client";
// Stepper values the user dialed in but hasn't saved, per team (hole -> strokes). Module state
// (like drinkUndo.ts / mulliganUndo.ts) so a trip to Board or Feed and back doesn't throw away a
// 6 somebody was about to save; mirrored to sessionStorage so a reload of the tab keeps it too.
// Every storage access is wrapped: private mode / blocked storage / SSR just means no mirror.
import type { UUID } from "@/lib/types";
import { MAX_STROKES, MIN_STROKES } from "./model";

export type ScoreDrafts = Readonly<Record<number, number>>;

const EMPTY: ScoreDrafts = Object.freeze({});
const PREFIX = "scramble:score-drafts:";

/** Store key for one team on one trip. */
export const scoreDraftKey = (code: string, teamId: UUID) => `${code}:${teamId}`;

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Only whole strokes 1..20 on holes 1..18 survive (anything else in storage is junk). */
export function sanitizeDrafts(raw: unknown): Record<number, number> {
  const out: Record<number, number> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const hole = Number(k);
    if (!Number.isInteger(hole) || hole < 1 || hole > 18) continue;
    if (typeof v !== "number" || !Number.isInteger(v) || v < MIN_STROKES || v > MAX_STROKES) continue;
    out[hole] = v;
  }
  return out;
}

/**
 * Drop drafts that aren't unsaved changes any more: the hole's saved strokes already equal the
 * draft (saved here or on another phone). Returns `drafts` itself when nothing changed.
 */
export function pruneSavedDrafts(drafts: ScoreDrafts, lines: readonly { strokes: number | null }[]): ScoreDrafts {
  let out: Record<number, number> | null = null;
  for (const [k, v] of Object.entries(drafts)) {
    const hole = Number(k);
    if (lines[hole - 1]?.strokes !== v) continue;
    out ??= { ...drafts };
    delete out[hole];
  }
  return out ?? drafts;
}

export interface ScoreDraftStore {
  get(key: string): ScoreDrafts;
  set(key: string, drafts: ScoreDrafts): void;
  /** Forget one hole's draft (saved, or teed off without a score). */
  clear(key: string, hole: number): void;
}

export function createScoreDraftStore(getStorage: () => DraftStorage | null): ScoreDraftStore {
  const mem = new Map<string, ScoreDrafts>();

  const read = (key: string): ScoreDrafts => {
    try {
      const raw = getStorage()?.getItem(PREFIX + key);
      if (!raw) return EMPTY;
      const clean = sanitizeDrafts(JSON.parse(raw));
      return Object.keys(clean).length > 0 ? clean : EMPTY;
    } catch {
      return EMPTY;
    }
  };

  const store: ScoreDraftStore = {
    get(key) {
      const cached = mem.get(key);
      if (cached) return cached;
      const stored = read(key);
      mem.set(key, stored);
      return stored;
    },
    set(key, drafts) {
      const clean = sanitizeDrafts(drafts);
      const empty = Object.keys(clean).length === 0;
      mem.set(key, empty ? EMPTY : clean);
      try {
        const s = getStorage();
        if (!s) return;
        if (empty) s.removeItem(PREFIX + key);
        else s.setItem(PREFIX + key, JSON.stringify(clean));
      } catch {
        /* storage full or blocked: the in-memory copy still covers tab switches */
      }
    },
    clear(key, hole) {
      const cur = store.get(key);
      if (cur[hole] === undefined) return;
      const next = { ...cur };
      delete next[hole];
      store.set(key, next);
    },
  };
  return store;
}

function sessionStorageOrNull(): DraftStorage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** This tab's unsaved stepper values. */
export const scoreDrafts: ScoreDraftStore = createScoreDraftStore(sessionStorageOrNull);
