// GET /api/t/<code>/recap: a real PNG rendered from the stored trip, with no network access.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, setDbForTests, type DbConnection } from "@/lib/server/db";
import { hashPin } from "@/lib/server/auth";
import { createTrip } from "@/lib/server/trips";
import { applyOpsToTrip } from "@/lib/server/apply";
import { JACK_FROST_HOLES } from "@/lib/course";
import type { Trip } from "@/lib/types";
import { GET as recapRoute } from "@/app/api/t/[code]/recap/route";
import { ImageResponse } from "next/og";
import sharp from "sharp";
import { RECAP_HEIGHT, RECAP_WIDTH, RecapImage, sanitizeOgText, type RecapModel } from "@/components/awards/recap";

let db: DbConnection;
const params = <T,>(p: T) => ({ params: Promise.resolve(p) });

beforeAll(async () => {
  db = await createTestDb();
  setDbForTests(db);
});

afterAll(async () => {
  setDbForTests(null);
  await db?.close();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** PNG signature + IHDR width/height. */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
  expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

async function finishedTrip(): Promise<Trip> {
  const trip = await createTrip(db, { name: "Nick's Last Stand 🍻", app_name: "Bach Golf ⛳", pin_hash: await hashPin("2468") });
  let t = Date.now() - 3 * 3600_000;
  const op = (o: Record<string, unknown>) => ({ id: randomUUID(), at: new Date((t += 1000)).toISOString(), by: null, ...o });
  const players = ["Big Nick 👑", "Dave", "Jonesy 🍺", "Welly", "Jon", "T-Bone", "Sam"].map((name, i) => ({
    id: randomUUID(),
    name,
    sort_order: i,
    is_groom: i === 0,
  }));
  const teams = [
    { id: randomUUID(), name: "Grip It & Sip It 🍺", sort_order: 0 },
    { id: randomUUID(), name: "Shank Redemption", sort_order: 1 },
  ];
  const setup = [
    ...players.map((p) => op({ type: "player.upsert", player: p })),
    ...teams.map((tm) => op({ type: "team.upsert", team: tm })),
    ...players.map((p, i) => op({ type: "team.assign", player_id: p.id, team_id: teams[i < 4 ? 0 : 1].id })),
    op({ type: "trip.update", patch: { settings: { team_match_ante_cents: 2000, contest_ante_cents: 500 } } }),
    op({ type: "trip.start" }),
  ];
  const play: Record<string, unknown>[] = [];
  teams.forEach((tm, ti) => {
    for (const h of JACK_FROST_HOLES) play.push(op({ type: "score.set", team_id: tm.id, hole: h.number, strokes: h.par - ti }));
    play.push(op({ type: "round.complete", team_id: tm.id }));
  });
  play.push(
    op({ type: "drink.log", drink_id: randomUUID(), team_id: teams[1].id, player_id: players[5].id, hole: 18, drink_type: "shotgun", photo_path: null }),
  );
  for (const batch of [setup, play, [op({ type: "trip.finalize" })]]) {
    const out = await applyOpsToTrip({ db, trip, ops: batch, isCommissioner: true });
    expect(out.results.filter((r) => r.status === "rejected")).toEqual([]);
  }
  return trip;
}

describe("GET /api/t/<code>/recap", () => {
  it("renders a 1080x1350 PNG, no-store, without touching the network (emoji in names are stripped)", async () => {
    const trip = await finishedTrip();
    // next/og loads its own wasm through fetch(data:...); anything else would be a network call
    // (twemoji / Google Fonts) that fails on a server without internet.
    const realFetch = globalThis.fetch;
    const network: string[] = [];
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("data:")) return realFetch(input, init);
      network.push(url);
      throw new Error("the recap card must not fetch fonts or emoji");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const res = await recapRoute(new Request(`http://localhost/api/t/${trip.code}/recap`), params({ code: trip.code }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("no-store");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(pngSize(bytes)).toEqual({ width: 1080, height: 1350 });
    expect(bytes.byteLength).toBeGreaterThan(20_000);
    expect(network).toEqual([]);
  }, 60_000);

  it("404s for an unknown code", async () => {
    const res = await recapRoute(new Request("http://localhost/api/t/nosuchtrip99/recap"), params({ code: "nosuchtrip99" }));
    expect(res.status).toBe(404);
  });

  it("still renders for a trip that hasn't started (no scores, no teams)", async () => {
    const trip = await createTrip(db, { name: "Empty", app_name: "Scramble", pin_hash: await hashPin("2468") });
    const res = await recapRoute(new Request(`http://localhost/api/t/${trip.code}/recap`), params({ code: trip.code }));
    expect(res.status).toBe(200);
    expect(pngSize(new Uint8Array(await res.arrayBuffer()))).toEqual({ width: 1080, height: 1350 });
  }, 60_000);
});

describe("recap card layout", () => {
  /** Raw RGB pixels of the rendered card. */
  async function renderPixels(model: RecapModel) {
    const png = Buffer.from(await new ImageResponse(<RecapImage model={model} />, { width: RECAP_WIDTH, height: RECAP_HEIGHT }).arrayBuffer());
    const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const dark = (x: number, y: number) => {
      const i = (y * info.width + x) * info.channels;
      // Ink (#0b0f0c, luminance ~14) only: the fairway green background is ~96.
      return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2] < 45;
    };
    return { dark, width: info.width, height: info.height };
  }

  it("keeps a long tied winner line inside its award tile (finding walkthrough/recap-award-text-clipped)", async () => {
    const tie = sanitizeOgText("The Groom's Last Stand & The Shank Redemption & Fore Play", 200);
    const model: RecapModel = {
      appName: "Scramble",
      tripName: "Recap",
      dateLabel: "",
      courseName: "",
      final: true,
      champion: null,
      standings: [],
      awards: [
        { title: "Mulligan Merchant", winners: tie, value: "3 mulligans", awarded: true },
        { title: "Worst hole", winners: "Fore Play", value: "hole 5: 9", awarded: true },
      ],
    };
    const { dark, height } = await renderPixels(model);
    // The first tile spans x 44..530 (49% of the 992px content box): its right border is 526..530,
    // its right padding 510..526. Find the tile's height from the border column...
    let best = { from: 0, len: 0 };
    for (let y = 0, run = 0; y < height; y++) {
      run = dark(528, y) ? run + 1 : 0;
      if (run > best.len) best = { from: y - run + 1, len: run };
    }
    expect(best.len).toBeGreaterThan(50);
    // ...then nothing may be drawn in the padding: text running into the border is clipped there.
    const inked: string[] = [];
    for (let y = best.from + 4; y < best.from + best.len - 4; y++) {
      for (let x = 512; x <= 523; x++) if (dark(x, y)) inked.push(`${x},${y}`);
    }
    expect(inked).toEqual([]);
  }, 60_000);
});
