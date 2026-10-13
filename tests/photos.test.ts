import { describe, expect, it } from "vitest";
import { isTripPhotoPath, parsePhotoPath, PHOTO_KINDS, PHOTO_PATH_RE } from "@/lib/photos";

const TRIP = "0f8fad5b-d9cb-469f-a165-70867728950e";
const OTHER = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const ID = "e4eaaaf2-d142-11e1-b3e4-080027620cdd";

describe("photo paths", () => {
  it("parses trips/<trip>/<kind>/<uuid>.jpg for every kind", () => {
    for (const kind of PHOTO_KINDS) {
      expect(parsePhotoPath(`trips/${TRIP}/${kind}/${ID}.jpg`)).toEqual({ tripId: TRIP, kind, id: ID });
    }
    expect(PHOTO_KINDS).toEqual(["drinks", "ld", "ctp", "posts"]);
    expect(PHOTO_PATH_RE.test(`trips/${TRIP}/posts/${ID}.jpg`)).toBe(true);
    // Uppercase hex is a valid uuid spelling.
    expect(parsePhotoPath(`trips/${TRIP}/ctp/${ID.toUpperCase()}.jpg`)?.id).toBe(ID.toUpperCase());
  });

  it("refuses anything else: URLs, data URIs, traversal, other kinds/extensions, non-strings, huge strings", () => {
    const bad: unknown[] = [
      null,
      undefined,
      42,
      {},
      "",
      "https://attacker.example/pixel.jpg",
      "data:image/svg+xml,<svg/>",
      `trips/${TRIP}/drinks/${ID}.png`,
      `trips/${TRIP}/selfies/${ID}.jpg`,
      `trips/${TRIP}/drinks/../../${ID}.jpg`,
      `trips/${TRIP}/drinks/${ID}.jpg?x=1`,
      ` trips/${TRIP}/drinks/${ID}.jpg`,
      `trips/${TRIP}/drinks/${ID}.jpg\n`,
      `/trips/${TRIP}/drinks/${ID}.jpg`,
      `trips/not-a-uuid/drinks/${ID}.jpg`,
      `trips/${TRIP}/drinks/1.jpg`,
      `trips/${TRIP}/drinks/${"a".repeat(1_000_000)}.jpg`,
    ];
    for (const p of bad) expect(parsePhotoPath(p), String(p).slice(0, 60)).toBeNull();
  });

  it("isTripPhotoPath: only this trip's photos", () => {
    const path = `trips/${TRIP}/drinks/${ID}.jpg`;
    expect(isTripPhotoPath(path, TRIP)).toBe(true);
    expect(isTripPhotoPath(path, OTHER)).toBe(false);
    expect(isTripPhotoPath("https://x.example/a.jpg", TRIP)).toBe(false);
    expect(isTripPhotoPath(null, TRIP)).toBe(false);
  });
});
