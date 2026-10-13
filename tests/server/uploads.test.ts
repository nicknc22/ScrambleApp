// Photo uploads under pressure: the quota is reserved atomically (parallel uploads can't overshoot
// it), demo trips share one ceiling, and a stored photo can't be replaced by different bytes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, setDbForTests, type DbConnection } from "@/lib/server/db";
import { hashPin } from "@/lib/server/auth";
import { createTrip } from "@/lib/server/trips";
import { DEMO_PHOTO_CEILING, PHOTO_QUOTA, readLocalPhoto, savePhotoUpload, sha256Hex } from "@/lib/server/storage";
import { newId } from "@/lib/ids";
import type { Trip } from "@/lib/types";
import { POST as uploadRoute } from "@/app/api/t/[code]/upload/route";

let db: DbConnection;
let uploads: string;
let pinHash: string;

const BASE = "http://localhost:3000";

/** A JPEG-looking body of `size` bytes; `fill` makes different photos differ. */
function jpeg(size: number, fill = 1): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(size).fill(fill);
  b.set([0xff, 0xd8, 0xff, 0xe0]);
  b.set([0xff, 0xd9], size - 2);
  return b;
}

const upload = (t: Trip, p: string, body: Uint8Array<ArrayBuffer>) =>
  uploadRoute(
    new Request(`${BASE}/api/t/${t.code}/upload?path=${encodeURIComponent(p)}`, { method: "POST", headers: { "content-type": "image/jpeg" }, body }),
    { params: Promise.resolve({ code: t.code }) },
  );

function tally(responses: Response[]): Record<number, number> {
  const out: Record<number, number> = {};
  for (const r of responses) out[r.status] = (out[r.status] ?? 0) + 1;
  return out;
}

const trip = (is_demo = false) => createTrip(db, { name: is_demo ? "Demo" : "Real", app_name: "Scramble", pin_hash: pinHash, is_demo });
const photoPath = (t: Trip, kind = "posts") => `trips/${t.id}/${kind}/${newId()}.jpg`;
const filesOf = (t: Trip) => {
  const dir = path.join(uploads, "trips", t.id);
  return fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith(".jpg")) : [];
};

beforeAll(async () => {
  db = await createTestDb();
  setDbForTests(db);
  pinHash = await hashPin("2468");
  uploads = fs.mkdtempSync(path.join(os.tmpdir(), "scramble-uploads-"));
});

afterAll(async () => {
  setDbForTests(null);
  await db?.close();
  fs.rmSync(uploads, { recursive: true, force: true });
});

beforeEach(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "ANTHROPIC_API_KEY", "VERCEL"]) vi.stubEnv(k, "");
  vi.stubEnv("UPLOADS_DIR", uploads);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("atomic photo quota", () => {
  it("120 simultaneous uploads to a demo trip store exactly its 80-photo quota", async () => {
    const t = await trip(true);
    const body = jpeg(2000);
    const res = await Promise.all(Array.from({ length: 120 }, () => upload(t, photoPath(t), body)));
    expect(tally(res)).toEqual({ 200: PHOTO_QUOTA.demo.files, 413: 120 - PHOTO_QUOTA.demo.files });
    const [row] = await db.query<{ n: number }>("select count(*)::int as n from photo_uploads where trip_id = $1", [t.id]);
    expect(row.n).toBe(PHOTO_QUOTA.demo.files);
    expect(filesOf(t)).toHaveLength(PHOTO_QUOTA.demo.files);
  });

  it("simultaneous big uploads can't overshoot the byte quota", async () => {
    const t = await trip(true);
    const size = 2 * 1024 * 1024;
    const fit = Math.floor(PHOTO_QUOTA.demo.bytes / size);
    const body = jpeg(size);
    const res = await Promise.all(Array.from({ length: fit + 15 }, () => upload(t, photoPath(t), body)));
    expect(tally(res)).toEqual({ 200: fit, 413: 15 });
    const [row] = await db.query<{ bytes: number }>("select coalesce(sum(bytes), 0)::int as bytes from photo_uploads where trip_id = $1", [t.id]);
    expect(row.bytes).toBeLessThanOrEqual(PHOTO_QUOTA.demo.bytes);
    expect(filesOf(t)).toHaveLength(fit);
  });

  it("a failed write releases the reservation", async () => {
    const t = await trip();
    vi.stubEnv("VERCEL", "1"); // no Supabase Storage on Vercel: putPhoto throws a ConfigError
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const p = photoPath(t);
    expect((await upload(t, p, jpeg(500))).status).toBe(500);
    err.mockRestore();
    expect(await db.query("select 1 from photo_uploads where path = $1", [p])).toEqual([]);
    vi.stubEnv("VERCEL", "");
    expect((await upload(t, p, jpeg(500, 2))).status).toBe(200); // a later, different photo is fine
  });

  it("all demo trips together stay under one ceiling; real trips don't count against it", async () => {
    const filler = await trip(true);
    // Fill the shared demo ceiling (minus 100 bytes) with rows on another demo trip.
    await db.query(
      `insert into photo_uploads (trip_id, path, bytes)
       select $1::uuid, 'trips/' || $1::text || '/posts/' || gen_random_uuid() || '.jpg', $2::int from generate_series(1, 1)`,
      [filler.id, DEMO_PHOTO_CEILING.bytes - 100],
    );
    const demo = await trip(true);
    const res = await upload(demo, photoPath(demo), jpeg(500));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: "photo_quota" });
    const real = await trip();
    expect((await upload(real, photoPath(real), jpeg(500))).status).toBe(200);
    await db.query("delete from trips where id = $1", [filler.id]); // pruning a demo frees it up
    expect((await upload(demo, photoPath(demo), jpeg(500))).status).toBe(200);
  });
});

describe("write-once photos", () => {
  it("a different photo at a stored path is refused with 409; the same bytes again are a harmless retry", async () => {
    const t = await trip();
    const p = photoPath(t, "ctp");
    const original = jpeg(800, 1);
    expect((await upload(t, p, original)).status).toBe(200);
    const swapped = await upload(t, p, jpeg(800, 7));
    expect(swapped.status).toBe(409);
    expect(await swapped.json()).toMatchObject({ code: "photo_exists" });
    expect(await readLocalPhoto(p)).toEqual(original);
    expect((await upload(t, p, original)).status).toBe(200); // the outbox retrying
    const rows = await db.query<{ bytes: number; sha256: string }>("select bytes, sha256 from photo_uploads where path = $1", [p]);
    expect(rows).toEqual([{ bytes: 800, sha256: sha256Hex(original) }]);
  });

  it("two phones racing different bytes to one path: one wins, the other gets 409, and the file is the winner's", async () => {
    const t = await trip();
    const p = photoPath(t, "ctp");
    const a = jpeg(900, 3);
    const b = jpeg(900, 4);
    const [ra, rb] = await Promise.all([upload(t, p, a), upload(t, p, b)]);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    expect(await readLocalPhoto(p)).toEqual(ra.status === 200 ? a : b);
  });

  it("rows from before the sha256 column: the same size is taken as a retry (and hashed), another size is refused", async () => {
    const t = await trip();
    const p = photoPath(t, "drinks");
    const original = jpeg(600, 5);
    await db.query("insert into photo_uploads (trip_id, path, bytes) values ($1, $2, $3)", [t.id, p, original.length]);
    expect((await upload(t, p, jpeg(601, 5))).status).toBe(409);
    expect((await upload(t, p, original)).status).toBe(200);
    expect((await db.query<{ sha256: string }>("select sha256 from photo_uploads where path = $1", [p]))[0].sha256).toBe(sha256Hex(original));
    expect((await upload(t, p, jpeg(600, 6))).status).toBe(409);
  });

  it("savePhotoUpload is write-once for direct callers too", async () => {
    const t = await trip();
    const p = photoPath(t, "ld");
    await savePhotoUpload(db, t, p, jpeg(700, 1));
    await expect(savePhotoUpload(db, t, p, jpeg(700, 2))).rejects.toMatchObject({ name: "PhotoConflictError" });
    await expect(savePhotoUpload(db, t, p, jpeg(700, 1))).resolves.toBeUndefined();
  });
});
