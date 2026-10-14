// The /t/<code> link preview image: trip name from the database with a short timeout, a
// fallback that never errors, and a real 1200x630 PNG.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, setDbForTests, type DbConnection } from "@/lib/server/db";
import { hashPin } from "@/lib/server/auth";
import { createTrip } from "@/lib/server/trips";
import Image, { OG_FALLBACK, alt, contentType, nameFontSize, ogText, renderOgImage, size } from "@/app/t/[code]/opengraph-image";

let db: DbConnection;

beforeAll(async () => {
  db = await createTestDb();
  setDbForTests(db);
});

afterAll(async () => {
  setDbForTests(null);
  await db.close();
});

/** Width and height from a PNG's IHDR chunk. */
function pngSize(buf: Uint8Array): { width: number; height: number } {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe("og image metadata", () => {
  it("is a 1200x630 PNG with alt text", () => {
    expect(size).toEqual({ width: 1200, height: 630 });
    expect(contentType).toBe("image/png");
    expect(alt.length).toBeGreaterThan(10);
  });
});

describe("ogText", () => {
  it("reads the trip name and course", async () => {
    const pinHash = await hashPin("2468");
    const trip = await createTrip(db, { name: "Caster's Last Stand", app_name: "Scramble", pin_hash: pinHash });
    expect(await ogText(trip.code)).toEqual({ name: "Caster's Last Stand", course: "Jack Frost National" });
    // Codes are matched like the page does (case, stray spaces).
    expect((await ogText(` ${trip.code.toUpperCase()} `)).name).toBe("Caster's Last Stand");
  });

  it("falls back for an unknown or malformed code without erroring", async () => {
    expect(await ogText("nosuchtrip9")).toEqual(OG_FALLBACK);
    let called = false;
    expect(
      await ogText("../../etc", async () => {
        called = true;
        return null;
      }),
    ).toEqual(OG_FALLBACK);
    expect(called).toBe(false);
  });

  it("falls back when the database is slow or broken", async () => {
    const t0 = Date.now();
    expect(await ogText("slowtrip1", () => new Promise(() => {}), 50)).toEqual(OG_FALLBACK);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(
      await ogText("brokentrip", async () => {
        throw new Error("connection refused");
      }),
    ).toEqual(OG_FALLBACK);
  });

  it("clips silly-long names and blank fields fall back", async () => {
    const long = await ogText("longtrip1", async () => ({ name: "x".repeat(200), course: "" }));
    expect(long.name.length).toBeLessThanOrEqual(48);
    expect(long.name.endsWith("…")).toBe(true);
    expect(long.course).toBe(OG_FALLBACK.course);
    expect((await ogText("blanktrip", async () => ({ name: "   ", course: "Pebble" }))).name).toBe(OG_FALLBACK.name);
  });

  it("long names get a smaller font", () => {
    expect(nameFontSize("Short")).toBeGreaterThan(nameFontSize("A much much longer trip name here"));
  });
});

describe("rendering", () => {
  it("renders a real 1200x630 PNG, and the route answers for an unknown code", async () => {
    const res = renderOgImage({ name: "Jack Frost Scramble", course: "Jack Frost National" });
    expect(res.headers.get("content-type")).toBe("image/png");
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(buf.slice(0, 8))).toEqual(PNG_MAGIC);
    expect(pngSize(buf)).toEqual({ width: 1200, height: 630 });

    const route = await Image({ params: Promise.resolve({ code: "nosuchtrip9" }) });
    expect(route.status).toBe(200);
    const png = new Uint8Array(await route.arrayBuffer());
    expect(pngSize(png)).toEqual({ width: 1200, height: 630 });
  }, 60_000);
});
