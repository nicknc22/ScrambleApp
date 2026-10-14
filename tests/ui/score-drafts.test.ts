// Unsaved stepper values that survive a trip to another tab (finding: unsaved score lost on tab switch).
import { describe, expect, it } from "vitest";
import { createScoreDraftStore, pruneSavedDrafts, sanitizeDrafts, scoreDraftKey } from "@/components/play/scoreDrafts";

class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string): string | null {
    return this.data.has(k) ? this.data.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.data.set(k, String(v));
  }
  removeItem(k: string): void {
    this.data.delete(k);
  }
}

/** Private mode / blocked storage: every call throws. */
const throwing = {
  getItem(): string | null {
    throw new Error("SecurityError");
  },
  setItem(): void {
    throw new Error("QuotaExceededError");
  },
  removeItem(): void {
    throw new Error("SecurityError");
  },
};

describe("score drafts store", () => {
  const key = scoreDraftKey("abc123", "team-1");

  it("keys by trip and team", () => {
    expect(key).toBe("abc123:team-1");
    expect(scoreDraftKey("abc123", "team-2")).not.toBe(key);
  });

  it("get / set / clear, mirrored to storage", () => {
    const storage = new MemoryStorage();
    const store = createScoreDraftStore(() => storage);
    expect(store.get(key)).toEqual({});
    store.set(key, { 1: 6, 4: 3 });
    expect(store.get(key)).toEqual({ 1: 6, 4: 3 });
    expect(JSON.parse(storage.getItem(`scramble:score-drafts:${key}`)!)).toEqual({ 1: 6, 4: 3 });
    // Another team's drafts are separate.
    expect(store.get(scoreDraftKey("abc123", "team-2"))).toEqual({});

    store.clear(key, 1);
    expect(store.get(key)).toEqual({ 4: 3 });
    store.clear(key, 9); // nothing there: no-op
    expect(store.get(key)).toEqual({ 4: 3 });
    store.clear(key, 4);
    expect(store.get(key)).toEqual({});
    // Nothing left: the storage entry is gone, not an empty object.
    expect(storage.getItem(`scramble:score-drafts:${key}`)).toBeNull();
  });

  it("a fresh store (a reload of the tab) reads what the last one wrote", () => {
    const storage = new MemoryStorage();
    createScoreDraftStore(() => storage).set(key, { 2: 7 });
    expect(createScoreDraftStore(() => storage).get(key)).toEqual({ 2: 7 });
  });

  it("works with storage that throws (private mode) and with no storage at all", () => {
    const store = createScoreDraftStore(() => throwing);
    expect(store.get(key)).toEqual({});
    expect(() => store.set(key, { 1: 6 })).not.toThrow();
    // The in-memory copy still covers a tab switch.
    expect(store.get(key)).toEqual({ 1: 6 });
    expect(() => store.clear(key, 1)).not.toThrow();
    expect(store.get(key)).toEqual({});

    const none = createScoreDraftStore(() => null);
    none.set(key, { 3: 2 });
    expect(none.get(key)).toEqual({ 3: 2 });

    const getterThrows = createScoreDraftStore(() => {
      throw new Error("SecurityError");
    });
    expect(getterThrows.get(key)).toEqual({});
    expect(() => getterThrows.set(key, { 5: 5 })).not.toThrow();
    expect(getterThrows.get(key)).toEqual({ 5: 5 });
  });

  it("ignores junk in storage", () => {
    const storage = new MemoryStorage();
    storage.setItem(`scramble:score-drafts:${key}`, "{not json");
    expect(createScoreDraftStore(() => storage).get(key)).toEqual({});
    storage.setItem(`scramble:score-drafts:${key}`, JSON.stringify({ 1: 6, 0: 4, 19: 4, 2: 0, 3: 21, 4: 4.5, 5: "4", x: 3, 18: 20 }));
    expect(createScoreDraftStore(() => storage).get(key)).toEqual({ 1: 6, 18: 20 });
    expect(sanitizeDrafts(null)).toEqual({});
    expect(sanitizeDrafts([4, 5])).toEqual({});
  });
});

describe("pruneSavedDrafts", () => {
  const lines = Array.from({ length: 18 }, (_, i) => ({ strokes: i === 0 ? 5 : i === 1 ? null : 4 }));

  it("drops drafts the saved score already matches, keeps real unsaved changes", () => {
    // Hole 1 saved 5 (draft 5: already saved), hole 2 empty (draft 6: unsaved), hole 3 saved 4 (draft 3: unsaved).
    expect(pruneSavedDrafts({ 1: 5, 2: 6, 3: 3 }, lines)).toEqual({ 2: 6, 3: 3 });
  });

  it("returns the same object when nothing changes", () => {
    const d = { 2: 6, 3: 3 };
    expect(pruneSavedDrafts(d, lines)).toBe(d);
    const empty = {};
    expect(pruneSavedDrafts(empty, lines)).toBe(empty);
  });
});
