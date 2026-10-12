"use client";
// Per-device identity: which player this phone belongs to ("tap your name"), stored in
// localStorage per trip code. Every accessor is defensive: localStorage can be missing
// (SSR), throw (Safari private mode / disabled storage) or be full.
import type { UUID } from "../types";

/** Minimal localStorage-like interface (injectable for tests). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const meKey = (code: string) => `scramble:me:${code}`;
export const commissionerKey = (code: string) => `scramble:commish:${code}`;
/** Last trip opened on this device, so "/" (the PWA start_url) can jump straight back into it. */
export const LAST_TRIP_KEY = "scramble:last-trip";

/** window.localStorage, or null when unavailable (SSR, blocked storage). Never throws. */
export function safeStorage(): StorageLike | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readItem(key: string, storage: StorageLike | null = safeStorage()): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

/** Returns false when the write failed (quota, private mode). */
export function writeItem(key: string, value: string | null, storage: StorageLike | null = safeStorage()): boolean {
  if (!storage) return false;
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function loadMe(code: string, storage: StorageLike | null = safeStorage()): UUID | null {
  const v = readItem(meKey(code), storage);
  return v && v.trim() ? v : null;
}

export function saveMe(code: string, playerId: UUID | null, storage: StorageLike | null = safeStorage()): boolean {
  return writeItem(meKey(code), playerId, storage);
}

export function loadCommissionerHint(code: string, storage: StorageLike | null = safeStorage()): boolean {
  return readItem(commissionerKey(code), storage) === "1";
}

export function saveCommissionerHint(code: string, on: boolean, storage: StorageLike | null = safeStorage()): void {
  writeItem(commissionerKey(code), on ? "1" : null, storage);
}

export function getLastTripCode(storage: StorageLike | null = safeStorage()): string | null {
  return readItem(LAST_TRIP_KEY, storage);
}

export function setLastTripCode(code: string | null, storage: StorageLike | null = safeStorage()): void {
  writeItem(LAST_TRIP_KEY, code, storage);
}
