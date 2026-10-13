// OpenStreetMap importer: Overpass parsing/matching (pure), planning, fetch fallbacks, and the
// POST /api/t/<code>/osm-import route against an in-memory PGlite. No network: fetch is mocked.
// tests/data/osm-jack-frost.json is a real Overpass answer for Jack Frost National (trimmed),
// © OpenStreetMap contributors, ODbL.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildOverpassQuery,
  cardFromHoles,
  centroidOf,
  fetchOverpass,
  holeNumberFromTags,
  parseOverpass,
  planOsmImport,
  prepareOsmImport,
  summarizeOsmImport,
  OSM_CLUB_NODE,
  type LatLng,
} from "@/lib/osm";
import { haversineYards } from "@/lib/engine/geo";
import { JACK_FROST_HOLES } from "@/lib/course";
import { applyOp } from "@/lib/reducer";
import { makeTrip } from "./fixtures";
import type { Hole, Snapshot, Trip } from "@/lib/types";
import { createTestDb, setDbForTests, type DbConnection } from "@/lib/server/db";
import { hashPin, resetPinThrottle } from "@/lib/server/auth";
import { createTrip } from "@/lib/server/trips";
import { POST as osmImportRoute } from "@/app/api/t/[code]/osm-import/route";
import { POST as commUnlock } from "@/app/api/t/[code]/commissioner/route";
import { GET as stateRoute } from "@/app/api/t/[code]/state/route";
import { POST as syncRoute } from "@/app/api/t/[code]/sync/route";
import { newId } from "@/lib/ids";

const REAL = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "osm-jack-frost.json"), "utf8")) as unknown;

// ---------------------------------------------------------------------------
// Synthetic geometry helpers
// ---------------------------------------------------------------------------

const ORIGIN = { lat: 41.09, lng: -75.65 };
const M_PER_DEG_LAT = 111_195;
/** Point `east` / `north` meters from ORIGIN. */
function at(east: number, north: number): LatLng {
  return {
    lat: ORIGIN.lat + north / M_PER_DEG_LAT,
    lng: ORIGIN.lng + east / (M_PER_DEG_LAT * Math.cos((ORIGIN.lat * Math.PI) / 180)),
  };
}
const geom = (pts: LatLng[]) => pts.map((p) => ({ lat: p.lat, lon: p.lng }));
let nextId = 1;
function holeWay(ref: string | number, pts: LatLng[], tags: Record<string, string> = {}) {
  return { type: "way", id: nextId++, tags: { golf: "hole", ref: String(ref), ...tags }, geometry: geom(pts) };
}
/** Square-ish polygon of `size` m centered on p. */
function box(p: LatLng, size = 12): LatLng[] {
  const f = M_PER_DEG_LAT;
  const dLat = size / 2 / f;
  const dLng = size / 2 / (f * Math.cos((p.lat * Math.PI) / 180));
  const ring = [
    { lat: p.lat - dLat, lng: p.lng - dLng },
    { lat: p.lat - dLat, lng: p.lng + dLng },
    { lat: p.lat + dLat, lng: p.lng + dLng },
    { lat: p.lat + dLat, lng: p.lng - dLng },
  ];
  return [...ring, ring[0]];
}
function featureWay(kind: "tee" | "green", center: LatLng, tags: Record<string, string> = {}) {
  return { type: "way", id: nextId++, tags: { golf: kind, landuse: "grass", ...tags }, geometry: geom(box(center)) };
}
function featureNode(kind: "tee" | "green", p: LatLng, tags: Record<string, string> = {}) {
  return { type: "node", id: nextId++, lat: p.lat, lon: p.lng, tags: { golf: kind, ...tags } };
}
const overpass = (elements: unknown[]) => ({ version: 0.6, osm3s: { timestamp_osm_base: "2026-05-06T03:25:00Z" }, elements });

const near = (a: LatLng | null, b: LatLng, m = 3) => {
  expect(a).not.toBeNull();
  expect(haversineYards(a!, b) * 0.9144).toBeLessThan(m);
};

function seedHoles(): Hole[] {
  return JACK_FROST_HOLES.map((h) => ({
    id: `hole-${h.number}`,
    trip_id: "trip",
    number: h.number,
    par: h.par,
    stroke_index: h.stroke_index,
    yardage: { ...h.yardage },
    tee_lat: null,
    tee_lng: null,
    green_lat: null,
    green_lng: null,
    contest: h.contest,
    updated_at: "2026-10-24T00:00:00.000Z",
  }));
}

// ---------------------------------------------------------------------------
// Parsing and matching
// ---------------------------------------------------------------------------

describe("parseOverpass", () => {
  it("nothing mapped is a clean, empty outcome", () => {
    const r = parseOverpass(overpass([]));
    expect(r.holes).toEqual([]);
    expect(r.found).toEqual({ hole_lines: 0, tees: 0, greens: 0 });
    const plan = planOsmImport(seedHoles(), r);
    expect(plan.updates).toEqual([]);
    expect(plan.missing_tees).toHaveLength(18);
    expect(summarizeOsmImport({ ...plan, found: r.found, holes: r.holes, dry_run: false })).toMatch(/nothing for this course/i);
  });

  it("never throws on garbage", () => {
    for (const junk of [null, undefined, "<html>busy</html>", 42, {}, { elements: "nope" }, { elements: [null, 1, "x", { type: "way" }] }]) {
      const r = parseOverpass(junk);
      expect(r.holes).toEqual([]);
    }
    const weird = parseOverpass(
      overpass([
        { type: "way", id: 1, tags: { golf: "hole", ref: "3" }, geometry: [{ lat: "x", lon: 2 }, null] },
        { type: "node", id: 2, tags: { golf: "green" }, lat: 999, lon: 0 },
        { type: "way", id: 3, tags: { golf: "tee" } },
      ]),
    );
    expect(weird.holes).toEqual([]);
  });

  it("hole lines alone: first node is the tee, last node the green", () => {
    const tee = at(0, 0);
    const bend = at(0, 200);
    const green = at(60, 340);
    const r = parseOverpass(overpass([holeWay(4, [tee, bend, green], { par: "5" })]));
    expect(r.holes).toHaveLength(1);
    const h = r.holes[0];
    expect(h.hole).toBe(4);
    expect(h.tee_source).toBe("hole_line");
    expect(h.green_source).toBe("hole_line");
    near(h.tee, tee, 0.05);
    near(h.green, green, 0.05);
    expect(h.osm_par).toBe(5);
    // 200 m + ~152 m along the dogleg
    expect(h.length_yd).toBeGreaterThan(380);
    expect(h.length_yd).toBeLessThan(390);
  });

  it("matches tee boxes and greens by centroid and picks the box that matches the card", () => {
    // Hole 1 runs north 400 m; back tee at the line start, two forward boxes along the line.
    const line = [at(0, 0), at(0, 400)];
    const back = at(0, 0);
    const middle = at(5, 33); // ~367 m to the green ≈ 401 yd
    const front = at(-6, 70); // ~330 m ≈ 361 yd
    const greenCenter = at(2, 405);
    const elements = [
      holeWay(1, line),
      featureWay("tee", back),
      featureWay("tee", middle),
      featureWay("tee", front),
      featureWay("green", greenCenter),
    ];
    const card = { 1: { par: 4, yards: 400, max_yards: 440 } };
    const r = parseOverpass(overpass(elements), { card });
    expect(r.matched).toEqual({ tees: 3, greens: 1 });
    const h = r.holes[0];
    expect(h.tee_source).toBe("tee_feature");
    expect(h.green_source).toBe("green_feature");
    expect(h.tee_boxes).toBe(3);
    near(h.tee, middle, 1);
    near(h.green, greenCenter, 1);
    expect(Math.abs(h.length_yd! - 400)).toBeLessThan(10);

    // Forward tees: the front box. No card: the back tee (nearest the line start).
    near(parseOverpass(overpass(elements), { card: { 1: { par: 4, yards: 360, max_yards: 440 } } }).holes[0].tee, front, 1);
    near(parseOverpass(overpass(elements)).holes[0].tee, back, 1);
  });

  it("flips a hole line drawn green -> tee", () => {
    const tee = at(500, 0);
    const green = at(500, 150);
    const r = parseOverpass(overpass([holeWay(3, [green, tee]), featureNode("green", at(501, 152))]));
    expect(r.notes.join(" ")).toMatch(/flipped/);
    near(r.holes[0].tee, tee, 0.05);
    near(r.holes[0].green, at(501, 152), 0.05);

    // With tee boxes mapped: flipped only when the tee box sits at the line's last node.
    const withTee = parseOverpass(overpass([holeWay(3, [green, tee]), featureNode("green", at(501, 152)), featureNode("tee", at(502, 2))]));
    expect(withTee.notes.join(" ")).toMatch(/flipped/);
    near(withTee.holes[0].tee, at(502, 2), 0.5);
  });

  it("ignores features that could belong to two holes, and features far from every hole", () => {
    // Two parallel holes 30 m apart: a tee box halfway between them is ambiguous.
    const elements = [
      holeWay(5, [at(0, 0), at(0, 350)]),
      holeWay(6, [at(30, 0), at(30, 350)]),
      featureWay("tee", at(15, 5)),
      featureWay("tee", at(400, 400)), // nowhere near
      featureWay("tee", at(1, 2)), // clearly hole 5
    ];
    const r = parseOverpass(overpass(elements));
    expect(r.found.tees).toBe(3);
    expect(r.matched.tees).toBe(1);
    expect(r.notes.join(" ")).toMatch(/could belong to two holes/);
    expect(r.notes.join(" ")).toMatch(/not near any numbered hole/);
    const h5 = r.holes.find((h) => h.hole === 5)!;
    expect(h5.tee_source).toBe("tee_feature");
    near(h5.tee, at(1, 2), 1);
    expect(r.holes.find((h) => h.hole === 6)!.tee_source).toBe("hole_line");
  });

  it("does not grab the next hole's tee sitting next to a par 3 green", () => {
    // Par 3 (hole 8) north 150 m; hole 9's tee box sits beside hole 8's green, hole 9 runs east.
    const elements = [
      holeWay(8, [at(0, 0), at(0, 150)]),
      holeWay(9, [at(25, 160), at(450, 160)]),
      featureWay("green", at(0, 152)),
      featureWay("tee", at(22, 158)),
    ];
    const r = parseOverpass(overpass(elements));
    const h8 = r.holes.find((h) => h.hole === 8)!;
    const h9 = r.holes.find((h) => h.hole === 9)!;
    expect(h8.tee_boxes).toBe(0);
    expect(h8.tee_source).toBe("hole_line");
    expect(h9.tee_boxes).toBe(1);
    near(h9.tee, at(22, 158), 1);
  });

  it("skips duplicate hole numbers as ambiguous", () => {
    const r = parseOverpass(overpass([holeWay(7, [at(0, 0), at(0, 300)]), holeWay(7, [at(900, 0), at(900, 300)]), holeWay(8, [at(0, 400), at(0, 550)])]));
    expect(r.holes.map((h) => h.hole)).toEqual([8]);
    expect(r.notes.join(" ")).toMatch(/Hole 7: 2 hole lines/);
  });

  it("resolves ways given as node references (out body; >; out skel)", () => {
    const a = at(0, 0);
    const b = at(0, 300);
    const els = [
      { type: "way", id: 50, nodes: [1, 2], tags: { golf: "hole", ref: "10" } },
      { type: "node", id: 1, lat: a.lat, lon: a.lng },
      { type: "node", id: 2, lat: b.lat, lon: b.lng },
    ];
    const r = parseOverpass(overpass(els));
    near(r.holes[0].tee, a, 0.05);
    near(r.holes[0].green, b, 0.05);
  });

  it("features with their own ref go straight to that hole", () => {
    const r = parseOverpass(overpass([featureNode("tee", at(0, 0), { ref: "12" }), featureNode("green", at(0, 450), { ref: "12" })]));
    expect(r.holes).toHaveLength(1);
    expect(r.holes[0]).toMatchObject({ hole: 12, tee_source: "tee_feature", green_source: "green_feature" });
  });

  it("skips a hole whose length is way off the card (wrong numbering)", () => {
    const r = parseOverpass(overpass([holeWay(3, [at(0, 0), at(0, 480)])]), { card: { 3: { par: 3, yards: 169, max_yards: 175 } } });
    const h = r.holes.find((x) => x.hole === 3);
    expect(h?.tee ?? null).toBeNull();
    expect(r.notes.join(" ")).toMatch(/Hole 3: the hole line is \d+ yd but the card says 175/);
  });

  it("notes a par mismatch without skipping", () => {
    const r = parseOverpass(overpass([holeWay(4, [at(0, 0), at(0, 420)], { par: "4" })]), { card: { 4: { par: 5, yards: 460, max_yards: 480 } } });
    expect(r.holes[0].tee).not.toBeNull();
    expect(r.notes.join(" ")).toMatch(/OpenStreetMap says par 4, the card says par 5/);
  });
});

describe("helpers", () => {
  it("holeNumberFromTags", () => {
    expect(holeNumberFromTags({ ref: "4" })).toBe(4);
    expect(holeNumberFromTags({ ref: "04" })).toBe(4);
    expect(holeNumberFromTags({ ref: "Hole 18" })).toBe(18);
    expect(holeNumberFromTags({ name: "Hole #7 - The Cliff" })).toBe(7);
    expect(holeNumberFromTags({ ref: "19" })).toBeNull();
    expect(holeNumberFromTags({ ref: "0" })).toBeNull();
    expect(holeNumberFromTags({ ref: "A" })).toBeNull();
    expect(holeNumberFromTags({})).toBeNull();
  });

  it("centroidOf weights by area", () => {
    // An L-ish polygon with many vertices bunched on one side: the vertex mean is pulled, the centroid isn't.
    const sq = [at(0, 0), at(10, 0), at(10, 1), at(10, 2), at(10, 3), at(10, 4), at(10, 10), at(0, 10), at(0, 0)];
    near(centroidOf(sq), at(5, 5), 0.2);
    expect(centroidOf([])).toBeNull();
    near(centroidOf([at(3, 4)]), at(3, 4), 0.01);
  });

  it("buildOverpassQuery asks for holes, tees and greens around the club", () => {
    const q = buildOverpassQuery();
    expect(q).toContain('way["golf"="hole"](around:1500,41.0947914,-75.6479826)');
    expect(q).toContain('node["golf"~"^(tee|green)$"]');
    expect(q).toContain("out geom;");
    expect(OSM_CLUB_NODE).toEqual({ lat: 41.0947914, lng: -75.6479826 });
  });
});

// ---------------------------------------------------------------------------
// Real data: Jack Frost National is mapped
// ---------------------------------------------------------------------------

describe("Jack Frost National (real Overpass answer)", () => {
  const holes = seedHoles();
  const r = parseOverpass(REAL, { card: cardFromHoles(holes, "membership") });

  it("finds all 18 holes with a tee box and a green each", () => {
    expect(r.found).toEqual({ hole_lines: 18, tees: 80, greens: 18 });
    expect(r.holes.map((h) => h.hole)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
    for (const h of r.holes) {
      expect(h.tee_source).toBe("tee_feature");
      expect(h.green_source).toBe("green_feature");
      expect(h.osm_par).toBe(JACK_FROST_HOLES[h.hole - 1].par);
    }
  });

  it("picks the membership tee box: every hole plays within 15 yd of the card", () => {
    for (const h of r.holes) {
      const card = JACK_FROST_HOLES[h.hole - 1].yardage.membership;
      expect(Math.abs(h.length_yd! - card), `hole ${h.hole}: ${h.length_yd} vs ${card}`).toBeLessThanOrEqual(15);
    }
  });

  it("other tee sets pick other boxes", () => {
    const adv = parseOverpass(REAL, { card: cardFromHoles(holes, "advanced") });
    const fwd = parseOverpass(REAL, { card: cardFromHoles(holes, "forward") });
    const h4 = (x: typeof r) => x.holes.find((h) => h.hole === 4)!;
    expect(h4(adv).length_yd!).toBeGreaterThan(h4(r).length_yd!);
    expect(h4(fwd).length_yd!).toBeLessThan(h4(r).length_yd!);
  });

  it("every point is on the course (within 1.5 km of the club)", () => {
    for (const h of r.holes) {
      expect(haversineYards(h.tee!, OSM_CLUB_NODE)).toBeLessThan(1640);
      expect(haversineYards(h.green!, OSM_CLUB_NODE)).toBeLessThan(1640);
    }
  });

  it("the planned ops apply through the reducer and set every par 5 tee", () => {
    const f = makeTrip({ teams: [4, 3, 3], status: "setup" });
    let state = f.state;
    let n = 0;
    const prepared = prepareOsmImport(state, REAL, { now: "2026-10-22T12:00:00.000Z", newId: () => `op-${++n}` });
    expect(prepared.ops).toHaveLength(18);
    expect(prepared.report.filled_tees).toHaveLength(18);
    expect(prepared.report.message).toMatch(/Filled tees on all 18 and greens on all 18/);
    for (const op of prepared.ops) {
      const res = applyOp(state, op, { now: op.at, is_commissioner: true, side: "server" });
      expect(res.ok).toBe(true);
      if (res.ok) state = res.state;
    }
    for (const h of state.holes.filter((x) => x.par === 5)) {
      expect(h.tee_lat).not.toBeNull();
      expect(h.tee_lng).not.toBeNull();
    }
    // A second run has nothing to do.
    const again = prepareOsmImport(state, REAL, { now: "2026-10-22T12:01:00.000Z", newId: () => `op-${++n}` });
    expect(again.ops).toHaveLength(0);
    expect(again.report.message).toMatch(/Nothing new to fill/);
  });
});

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

describe("planOsmImport", () => {
  const parsed = parseOverpass(overpass([holeWay(1, [at(0, 0), at(0, 350)]), holeWay(2, [at(100, 0), at(100, 300)])]));

  it("fills only missing points by default", () => {
    const holes = seedHoles();
    holes[0] = { ...holes[0], tee_lat: 41.1, tee_lng: -75.6 }; // hole 1 tee placed by hand
    const plan = planOsmImport(holes, parsed);
    expect(plan.filled_tees).toEqual([2]);
    expect(plan.filled_greens).toEqual([1, 2]);
    expect(plan.kept_tees).toEqual([1]);
    expect(plan.updates).toEqual([
      { hole: 1, patch: { green_lat: parsed.holes[0].green!.lat, green_lng: parsed.holes[0].green!.lng } },
      {
        hole: 2,
        patch: {
          tee_lat: parsed.holes[1].tee!.lat,
          tee_lng: parsed.holes[1].tee!.lng,
          green_lat: parsed.holes[1].green!.lat,
          green_lng: parsed.holes[1].green!.lng,
        },
      },
    ]);
    expect(plan.missing_tees).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  });

  it("force replaces placed points but never rewrites identical ones", () => {
    const holes = seedHoles();
    holes[0] = { ...holes[0], tee_lat: 41.1, tee_lng: -75.6 };
    holes[1] = { ...holes[1], tee_lat: parsed.holes[1].tee!.lat, tee_lng: parsed.holes[1].tee!.lng };
    const plan = planOsmImport(holes, parsed, { force: true });
    expect(plan.filled_tees).toEqual([1]);
    expect(plan.kept_tees).toEqual([]);
    expect(plan.updates.find((u) => u.hole === 2)!.patch).not.toHaveProperty("tee_lat");
  });

  it("dry run builds no ops but reports what would change", () => {
    const f = makeTrip({ teams: [2], status: "live" });
    const p = prepareOsmImport(f.state, overpass([holeWay(9, [at(0, 0), at(0, 430)])]), { dryRun: true, now: "2026-10-24T17:00:00.000Z", newId: () => "x" });
    expect(p.ops).toEqual([]);
    expect(p.report.dry_run).toBe(true);
    expect(p.report.filled_tees).toEqual([9]);
    expect(p.report.message).toMatch(/Would fill tees on 9/);
  });
});

// ---------------------------------------------------------------------------
// fetchOverpass
// ---------------------------------------------------------------------------

describe("fetchOverpass", () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  it("falls through an HTML 'too busy' page to the next endpoint", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fake = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "https://a.example/api") {
        return new Response("<html><p><strong>Error</strong>: runtime error: The server is probably too busy</p></html>", { status: 200 });
      }
      return ok(overpass([]));
    };
    const r = await fetchOverpass({ fetch: fake, endpoints: ["https://a.example/api", "https://b.example/api"] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.endpoint).toBe("https://b.example/api");
      expect(r.errors[0]).toMatch(/too busy/);
    }
    expect(calls[0].init?.method).toBe("POST");
    expect(String(calls[0].init?.body)).toMatch(/^data=/);
    expect(decodeURIComponent(String(calls[0].init?.body).slice(5))).toContain('way["golf"="hole"]');
  });

  it("treats HTTP errors, runtime-error remarks, thrown errors and timeouts as failures", async () => {
    const fake = async (url: string, init?: RequestInit) => {
      if (url.endsWith("/429")) return new Response("slow down", { status: 429 });
      if (url.endsWith("/remark")) return ok({ elements: [], remark: "runtime error: Query timed out in \"query\" at line 3" });
      if (url.endsWith("/throw")) throw new TypeError("fetch failed");
      // hang until aborted
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    };
    const r = await fetchOverpass({ fetch: fake, endpoints: ["https://x/429", "https://x/remark", "https://x/throw", "https://x/hang"], timeoutMs: 50 });
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(4);
    expect(r.errors[0]).toMatch(/HTTP 429/);
    expect(r.errors[1]).toMatch(/runtime error/);
    expect(r.errors[2]).toMatch(/fetch failed/);
    expect(r.errors[3]).toMatch(/timed out/);
  });
});

// ---------------------------------------------------------------------------
// POST /api/t/<code>/osm-import
// ---------------------------------------------------------------------------

describe("POST /api/t/<code>/osm-import", () => {
  let db: DbConnection;
  let pinHash: string;
  const BASE = "http://localhost:3000";
  const params = <T>(p: T) => ({ params: Promise.resolve(p) });
  const post = (url: string, body: unknown, cookie?: string) =>
    new Request(BASE + url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    db = await createTestDb();
    setDbForTests(db);
    pinHash = await hashPin("2468");
  });
  afterAll(async () => {
    setDbForTests(null);
    await db?.close();
  });
  beforeEach(() => {
    for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "APP_SECRET", "ANTHROPIC_API_KEY", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"]) {
      vi.stubEnv(k, "");
    }
    vi.stubEnv("COMMISSIONER_PIN_HASH", "");
    resetPinThrottle();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function setup(): Promise<{ trip: Trip; cookie: string }> {
    const trip = await createTrip(db, { name: "OSM Trip", app_name: "Scramble", pin_hash: pinHash });
    const res = await commUnlock(post(`/api/t/${trip.code}/commissioner`, { pin: "2468" }), params({ code: trip.code }));
    expect(res.status).toBe(200);
    return { trip, cookie: res.headers.get("set-cookie")!.split(";")[0] };
  }
  async function snapshot(code: string): Promise<Snapshot> {
    const res = await stateRoute(new Request(`${BASE}/api/t/${code}/state`), params({ code }));
    return (await res.json()) as Snapshot;
  }
  function mockOverpass(answer: () => Response | Promise<Response>) {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(String(url));
      return answer();
    });
    return calls;
  }

  it("is commissioner only", async () => {
    const { trip } = await setup();
    const calls = mockOverpass(() => new Response(JSON.stringify(REAL)));
    const res = await osmImportRoute(post(`/api/t/${trip.code}/osm-import`, {}), params({ code: trip.code }));
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("404 for an unknown trip", async () => {
    const res = await osmImportRoute(post(`/api/t/nosuchtrip/osm-import`, {}), params({ code: "nosuchtrip" }));
    expect(res.status).toBe(404);
  });

  it("fills missing points, keeps hand-placed ones, then force replaces them", async () => {
    const { trip, cookie } = await setup();
    // The commissioner placed hole 4's tee by hand first.
    const sync = await syncRoute(
      post(
        `/api/t/${trip.code}/sync`,
        { ops: [{ id: newId(), at: new Date().toISOString(), by: null, type: "hole.update", hole: 4, patch: { tee_lat: 41.1, tee_lng: -75.66 } }] },
        cookie,
      ),
      params({ code: trip.code }),
    );
    expect(sync.status).toBe(200);

    const calls = mockOverpass(() => new Response(JSON.stringify(REAL), { headers: { "content-type": "application/json" } }));
    const res = await osmImportRoute(post(`/api/t/${trip.code}/osm-import`, {}, cookie), params({ code: trip.code }));
    expect(res.status).toBe(200);
    const report = await res.json();
    expect(calls[0]).toBe("https://overpass-api.de/api/interpreter");
    expect(report.ok).toBe(true);
    expect(report.found).toEqual({ hole_lines: 18, tees: 80, greens: 18 });
    expect(report.filled_tees).toHaveLength(17);
    expect(report.kept_tees).toEqual([4]);
    expect(report.filled_greens).toHaveLength(18);
    expect(report.applied).toBe(18);

    let snap = await snapshot(trip.code);
    expect(snap.state.holes.find((h) => h.number === 4)).toMatchObject({ tee_lat: 41.1, tee_lng: -75.66 });
    expect(snap.state.holes.every((h) => h.green_lat !== null && h.green_lng !== null)).toBe(true);
    // Setup-phase edits are just setup: no override spam in the feed.
    expect(snap.state.feed_events.filter((e) => e.type === "commissioner_override")).toHaveLength(0);

    // Running it again changes nothing.
    const again = await (await osmImportRoute(post(`/api/t/${trip.code}/osm-import`, {}, cookie), params({ code: trip.code }))).json();
    expect(again.applied).toBe(0);
    expect(again.filled_tees).toEqual([]);

    // Dry run with force reports the replacement without writing.
    const dry = await (await osmImportRoute(post(`/api/t/${trip.code}/osm-import`, { force: true, dry_run: true }, cookie), params({ code: trip.code }))).json();
    expect(dry.filled_tees).toEqual([4]);
    expect(dry.applied).toBe(0);
    snap = await snapshot(trip.code);
    expect(snap.state.holes.find((h) => h.number === 4)!.tee_lat).toBe(41.1);

    const forced = await (await osmImportRoute(post(`/api/t/${trip.code}/osm-import`, { force: true }, cookie), params({ code: trip.code }))).json();
    expect(forced.applied).toBe(1);
    snap = await snapshot(trip.code);
    expect(snap.state.holes.find((h) => h.number === 4)!.tee_lat).not.toBe(41.1);
  });

  it("nothing mapped is a clean 200 with nothing changed", async () => {
    const { trip, cookie } = await setup();
    mockOverpass(() => new Response(JSON.stringify(overpass([]))));
    const res = await osmImportRoute(post(`/api/t/${trip.code}/osm-import`, {}, cookie), params({ code: trip.code }));
    expect(res.status).toBe(200);
    const report = await res.json();
    expect(report).toMatchObject({ ok: true, applied: 0, filled_tees: [], filled_greens: [] });
    expect(report.message).toMatch(/nothing for this course/i);
  });

  it("Overpass down: 502 with a friendly message, after trying both endpoints", async () => {
    const { trip, cookie } = await setup();
    const calls = mockOverpass(() => new Response("<html>too busy</html>", { status: 504 }));
    const res = await osmImportRoute(post(`/api/t/${trip.code}/osm-import`, {}, cookie), params({ code: trip.code }));
    expect(res.status).toBe(502);
    const report = await res.json();
    expect(report.ok).toBe(false);
    expect(report.message).toMatch(/Couldn't reach OpenStreetMap/);
    expect(calls).toEqual(["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]);
    const snap = await snapshot(trip.code);
    expect(snap.state.holes.every((h) => h.tee_lat === null)).toBe(true);
  });

  it("mid-round imports post commissioner overrides", async () => {
    const { trip, cookie } = await setup();
    // Minimal live trip: one team of two.
    const p1 = newId();
    const p2 = newId();
    const team = newId();
    const now = () => new Date().toISOString();
    const ops = [
      { id: newId(), at: now(), by: null, type: "player.upsert", player: { id: p1, name: "Nick" } },
      { id: newId(), at: now(), by: null, type: "player.upsert", player: { id: p2, name: "Dan" } },
      { id: newId(), at: now(), by: null, type: "team.upsert", team: { id: team, name: "Bogey Boys" } },
      { id: newId(), at: now(), by: null, type: "team.assign", player_id: p1, team_id: team },
      { id: newId(), at: now(), by: null, type: "team.assign", player_id: p2, team_id: team },
      { id: newId(), at: now(), by: null, type: "trip.start" },
    ];
    const s = await syncRoute(post(`/api/t/${trip.code}/sync`, { ops }, cookie), params({ code: trip.code }));
    const body = await s.json();
    expect(body.results.every((r: { status: string }) => r.status === "applied")).toBe(true);

    mockOverpass(() => new Response(JSON.stringify(overpass([holeWay(4, [at(0, 0), at(0, 440)])]))));
    const report = await (await osmImportRoute(post(`/api/t/${trip.code}/osm-import`, {}, cookie), params({ code: trip.code }))).json();
    expect(report.applied).toBe(1);
    const snap = await snapshot(trip.code);
    const overrides = snap.state.feed_events.filter((e) => e.type === "commissioner_override");
    expect(overrides).toHaveLength(1);
    expect(String(overrides[0].payload.summary)).toMatch(/hole 4 tee point/);
  });
});
