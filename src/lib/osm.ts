// OpenStreetMap course importer: turn an Overpass API response into per-hole tee and green
// points, and plan the hole.update ops that prefill them. Parsing and matching are pure (unit
// tested with fixture JSON); fetchOverpass is the only I/O and takes an injectable fetch.
// Used by scripts/osm-import.ts and POST /api/t/<code>/osm-import (both server-side). The
// Course screen only imports types from here.
//
// Matching (spec "Tee and green points"):
//   - golf=hole ways carry ref = hole number. First node ≈ tee (mappers start at the back tee),
//     last node ≈ green. A line drawn backwards (a green right at its first node) is flipped.
//   - golf=green features (ways, nodes, multipolygons) match by centroid to the nearest hole's
//     green end; golf=tee features match to the nearest hole's tee end (the first part of the
//     hole line, since forward tees sit along it). A feature carrying its own ref goes straight
//     to that hole. Anything that is about as close to two holes is ambiguous and ignored.
//   - A hole usually has several tee boxes. With the card yardage of the tees the group plays,
//     the box whose playing length best matches the card wins; otherwise the back tee.
//   - Sanity: a hole whose length is way off the card is skipped (wrong numbering, other course).
// The course may not be mapped at all: "nothing found" is a normal, clean outcome.
import type { HoleUpdateOp } from "./ops";
import type { Hole, ISODate, TeeSet, TripState, UUID } from "./types";
import { haversineMeters, metersToYards } from "./engine/geo";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Jack Frost National Golf Club, OpenStreetMap node 7200997832. */
export const OSM_CLUB_NODE = { lat: 41.0947914, lng: -75.6479826 } as const;
/** Search radius around the club node (the whole course fits in ~1.2 km). */
export const OSM_SEARCH_RADIUS_M = 1500;
/** Tried in order; the second is a mirror for when the main instance is overloaded. */
export const OVERPASS_ENDPOINTS: readonly string[] = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
export const OVERPASS_TIMEOUT_MS = 60_000;
export const OSM_USER_AGENT = "ScrambleApp/1.0 (golf scramble course import; one-off)";

/** A tee box farther than this from every hole's tee end is ignored. */
export const TEE_MAX_M = 45;
/** A green farther than this from every hole's green end is ignored. */
export const GREEN_MAX_M = 60;
/** The runner-up hole must be at least this much farther, or the feature is ambiguous. */
export const AMBIGUITY_MARGIN_M = 20;
/** Tee boxes sit on the first part of the hole line: at most this far along it... */
const TEE_ZONE_MAX_M = 250;
/** ...and at most this share of the line (keeps a par 3's green end out of its tee zone). */
const TEE_ZONE_SHARE = 0.6;
/** A green this close to a line's first node means the line was drawn green -> tee. */
const REVERSED_LINE_M = 35;

// ---------------------------------------------------------------------------
// Overpass response shapes (only what we read)
// ---------------------------------------------------------------------------

export interface LatLng {
  lat: number;
  lng: number;
}

interface RawPoint {
  lat?: unknown;
  lon?: unknown;
}

interface RawElement {
  type?: unknown;
  id?: unknown;
  lat?: unknown;
  lon?: unknown;
  center?: RawPoint;
  nodes?: unknown;
  geometry?: unknown;
  members?: unknown;
  tags?: unknown;
}

export interface OverpassResponse {
  elements: RawElement[];
  remark?: string;
  osm3s?: { timestamp_osm_base?: string };
}

/** True for something shaped like an Overpass JSON answer (an object with an elements array). */
export function isOverpassResponse(v: unknown): v is OverpassResponse {
  return !!v && typeof v === "object" && Array.isArray((v as { elements?: unknown }).elements);
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type PointSource = "tee_feature" | "green_feature" | "hole_line";

export interface OsmHole {
  hole: number;
  tee: LatLng | null;
  /** tee_feature: a mapped tee box; hole_line: the hole line's first node (usually the back tee). */
  tee_source: PointSource | null;
  green: LatLng | null;
  green_source: PointSource | null;
  /** Tee boxes matched to this hole. */
  tee_boxes: number;
  /** Playing length from the chosen tee to the green along the hole line, yards (null without a line). */
  length_yd: number | null;
  /** par tag on the hole line, if any. */
  osm_par: number | null;
}

export interface OsmParseResult {
  /** Holes with at least one point, sorted by number. */
  holes: OsmHole[];
  /** Raw counts of what the response contained. */
  found: { hole_lines: number; tees: number; greens: number };
  /** Features matched to a hole. */
  matched: { tees: number; greens: number };
  /** Human-readable notes: ignored/ambiguous features, skipped holes, card mismatches. */
  notes: string[];
}

/** Card data per hole number, used to pick the right tee box and sanity-check lengths. */
export interface CardHole {
  par: number;
  /** Yardage of the tees the group plays. */
  yards: number;
  /** Longest card yardage (back tees), for checking a hole line that starts at the tips. */
  max_yards: number;
}

export interface OsmParseOptions {
  card?: Record<number, CardHole>;
}

/** Card data from a trip's holes for the tee set it plays. */
export function cardFromHoles(holes: readonly Hole[], teeSet: TeeSet): Record<number, CardHole> {
  const out: Record<number, CardHole> = {};
  for (const h of holes) {
    const yards = Number(h.yardage?.[teeSet]);
    const all = Object.values(h.yardage ?? {}).map(Number).filter((n) => Number.isFinite(n) && n > 0);
    if (!Number.isFinite(yards) || yards <= 0) continue;
    out[h.number] = { par: h.par, yards, max_yards: Math.max(yards, ...all) };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Geometry (local planar frame: fine for distances of a few km)
// ---------------------------------------------------------------------------

const EARTH_R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;

interface XY {
  x: number;
  y: number;
}

function frame(origin: LatLng) {
  const kx = rad(1) * EARTH_R * Math.cos(rad(origin.lat));
  const ky = rad(1) * EARTH_R;
  return {
    to: (p: LatLng): XY => ({ x: (p.lng - origin.lng) * kx, y: (p.lat - origin.lat) * ky }),
    from: (q: XY): LatLng => ({ lat: origin.lat + q.y / ky, lng: origin.lng + q.x / kx }),
  };
}

const dist = (a: LatLng, b: LatLng) => haversineMeters(a, b);

function samePoint(a: LatLng, b: LatLng): boolean {
  return a.lat === b.lat && a.lng === b.lng;
}

/** Area-weighted centroid of a ring (vertex mean for lines/degenerate shapes). */
export function centroidOf(points: readonly LatLng[]): LatLng | null {
  if (points.length === 0) return null;
  let pts = points;
  if (pts.length > 1 && samePoint(pts[0], pts[pts.length - 1])) pts = pts.slice(0, -1);
  const mean = { lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length, lng: pts.reduce((s, p) => s + p.lng, 0) / pts.length };
  if (pts.length < 3) return mean;
  const f = frame(mean);
  const q = pts.map(f.to);
  let a2 = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < q.length; i++) {
    const p0 = q[i];
    const p1 = q[(i + 1) % q.length];
    const cross = p0.x * p1.y - p1.x * p0.y;
    a2 += cross;
    cx += (p0.x + p1.x) * cross;
    cy += (p0.y + p1.y) * cross;
  }
  if (Math.abs(a2) < 1e-6) return mean;
  return f.from({ x: cx / (3 * a2), y: cy / (3 * a2) });
}

function lineLength(line: readonly LatLng[]): number {
  let s = 0;
  for (let i = 1; i < line.length; i++) s += dist(line[i - 1], line[i]);
  return s;
}

interface Projection {
  /** Distance from the point to the (clipped) line, m. */
  d: number;
  /** Position of the closest point along the line from its start, m. */
  along: number;
}

/** Closest point on the first `maxAlong` meters of a polyline. */
function projectOnto(p: LatLng, line: readonly LatLng[], maxAlong = Number.POSITIVE_INFINITY): Projection {
  const f = frame(p);
  const P = { x: 0, y: 0 };
  let best: Projection = { d: Number.POSITIVE_INFINITY, along: 0 };
  let walked = 0;
  for (let i = 1; i < line.length && walked < maxAlong; i++) {
    const A = f.to(line[i - 1]);
    const B = f.to(line[i]);
    const segLen = Math.hypot(B.x - A.x, B.y - A.y);
    const usable = Math.min(segLen, maxAlong - walked);
    let t = 0;
    if (segLen > 0) {
      t = ((P.x - A.x) * (B.x - A.x) + (P.y - A.y) * (B.y - A.y)) / (segLen * segLen);
      t = Math.max(0, Math.min(usable / segLen, t));
    }
    const C = { x: A.x + t * (B.x - A.x), y: A.y + t * (B.y - A.y) };
    const d = Math.hypot(C.x - P.x, C.y - P.y);
    if (d < best.d) best = { d, along: walked + t * segLen };
    walked += segLen;
  }
  if (line.length === 1) best = { d: dist(p, line[0]), along: 0 };
  return best;
}

/** Playing length (m) from a tee box to the green along the hole line. */
function playLength(tee: LatLng, line: readonly LatLng[], green: LatLng): number {
  if (line.length < 2) return dist(tee, green);
  const route = [...line.slice(0, -1), green];
  const total = lineLength(route);
  const pr = projectOnto(tee, route, total);
  // Behind the first node: add the distance back to it.
  const behind = pr.along <= 0 ? dist(tee, route[0]) : 0;
  return behind + Math.max(0, total - pr.along);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function rawPoint(v: unknown): LatLng | null {
  if (!v || typeof v !== "object") return null;
  const lat = num((v as RawPoint).lat);
  const lng = num((v as RawPoint).lon);
  if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

function tagsOf(e: RawElement): Record<string, string> {
  const t = e.tags;
  if (!t || typeof t !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(t as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
  return out;
}

/** Hole number from a ref tag ("4", "04", "Hole 4") or a "Hole 4" name; null when not 1..18. */
export function holeNumberFromTags(tags: Record<string, string>): number | null {
  const fromRef = /^\s*(?:hole\s*)?#?\s*(\d{1,2})\s*$/i.exec(tags.ref ?? "");
  const fromName = /\bhole\s*#?\s*(\d{1,2})\b/i.exec(tags.name ?? "");
  const m = fromRef ?? fromName;
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 18 ? n : null;
}

function elementKey(e: RawElement): string {
  return `${typeof e.type === "string" ? e.type : "?"}/${typeof e.id === "number" || typeof e.id === "string" ? e.id : "?"}`;
}

/** Points of a way: inline geometry (out geom) or node refs resolved against node elements. */
function wayPoints(e: RawElement, nodes: Map<string, LatLng>): LatLng[] {
  if (Array.isArray(e.geometry)) return e.geometry.map(rawPoint).filter((p): p is LatLng => p !== null);
  if (Array.isArray(e.nodes)) {
    return e.nodes.map((id) => nodes.get(String(id))).filter((p): p is LatLng => p !== undefined);
  }
  return [];
}

/** Outer ring points of a multipolygon relation (out geom). */
function relationPoints(e: RawElement, nodes: Map<string, LatLng>): LatLng[] {
  if (!Array.isArray(e.members)) return [];
  const out: LatLng[] = [];
  for (const m of e.members as RawElement[]) {
    if (!m || typeof m !== "object" || m.type !== "way") continue;
    const role = (m as { role?: unknown }).role;
    if (role !== undefined && role !== "" && role !== "outer") continue;
    out.push(...wayPoints(m, nodes));
  }
  return out;
}

interface Feature {
  key: string;
  kind: "tee" | "green";
  at: LatLng;
  ref: number | null;
}

interface HoleLine {
  key: string;
  hole: number;
  line: LatLng[];
  par: number | null;
}

const fmtM = (m: number) => `${Math.round(m)} m`;
const yd = (m: number) => Math.round(metersToYards(m));

/**
 * Parse an Overpass JSON response into per-hole tee/green points. Never throws: anything that
 * isn't usable is skipped (with a note where it matters).
 */
export function parseOverpass(json: unknown, opts: OsmParseOptions = {}): OsmParseResult {
  const notes: string[] = [];
  const empty: OsmParseResult = { holes: [], found: { hole_lines: 0, tees: 0, greens: 0 }, matched: { tees: 0, greens: 0 }, notes };
  if (!isOverpassResponse(json)) {
    notes.push("That wasn't an Overpass response.");
    return empty;
  }
  const elements = json.elements.filter((e): e is RawElement => !!e && typeof e === "object");

  const nodes = new Map<string, LatLng>();
  for (const e of elements) {
    if (e.type !== "node") continue;
    const p = rawPoint(e);
    if (p) nodes.set(String(e.id), p);
  }

  // Collect hole lines and tee/green features (deduped by element id).
  const seen = new Set<string>();
  const lines: HoleLine[] = [];
  const features: Feature[] = [];
  for (const e of elements) {
    const key = elementKey(e);
    if (seen.has(key)) continue;
    seen.add(key);
    const tags = tagsOf(e);
    const golf = tags.golf;
    if (golf !== "hole" && golf !== "tee" && golf !== "green") continue;
    let pts: LatLng[] = [];
    if (e.type === "node") {
      const p = rawPoint(e);
      if (p) pts = [p];
    } else if (e.type === "way") {
      pts = wayPoints(e, nodes);
    } else if (e.type === "relation") {
      pts = relationPoints(e, nodes);
    }
    if (pts.length === 0) {
      const c = rawPoint(e.center);
      if (c) pts = [c];
    }
    if (golf === "hole") {
      if (e.type !== "way" || pts.length < 2) continue;
      const hole = holeNumberFromTags(tags);
      if (hole === null) {
        notes.push(`Ignored a hole line with no usable hole number (${key}).`);
        continue;
      }
      const par = num(tags.par);
      lines.push({ key, hole, line: pts, par: par !== null && Number.isInteger(par) ? par : null });
    } else {
      const at = centroidOf(pts);
      if (!at) continue;
      features.push({ key, kind: golf, at, ref: holeNumberFromTags(tags) });
    }
  }

  const tees = features.filter((f) => f.kind === "tee");
  const greens = features.filter((f) => f.kind === "green");
  const found = { hole_lines: lines.length, tees: tees.length, greens: greens.length };

  // One line per hole number; duplicates are ambiguous (two courses, or a hole split in pieces).
  const byHole = new Map<number, HoleLine[]>();
  for (const l of lines) byHole.set(l.hole, [...(byHole.get(l.hole) ?? []), l]);
  const holeLines: HoleLine[] = [];
  for (const [hole, ls] of byHole) {
    if (ls.length > 1) notes.push(`Hole ${hole}: ${ls.length} hole lines in OpenStreetMap, skipped as ambiguous.`);
    else holeLines.push(ls[0]);
  }
  holeLines.sort((a, b) => a.hole - b.hole);

  // Flip lines drawn green -> tee: a green at the first node, none at the last, and the tee
  // boxes (if any are mapped) at the last node rather than the first. The next hole's tee often
  // sits right by the previous green, so a green near the first node alone proves nothing.
  const nearest = (fs: Feature[], p: LatLng) => fs.reduce((m, f) => Math.min(m, dist(f.at, p)), Number.POSITIVE_INFINITY);
  for (const l of holeLines) {
    const first = l.line[0];
    const last = l.line[l.line.length - 1];
    const greenAtFirst = nearest(greens, first) <= REVERSED_LINE_M;
    const greenAtLast = nearest(greens, last) <= GREEN_MAX_M;
    const teeAtFirst = nearest(tees, first) <= TEE_MAX_M;
    const teeAtLast = nearest(tees, last) <= TEE_MAX_M;
    if (greenAtFirst && !greenAtLast && !teeAtFirst && (teeAtLast || tees.length === 0)) {
      l.line = [...l.line].reverse();
      notes.push(`Hole ${l.hole}: the hole line was drawn green to tee; flipped it.`);
    }
  }

  // Match features to holes.
  const teesOf = new Map<number, Feature[]>();
  const greensOf = new Map<number, Feature[]>();
  const add = (m: Map<number, Feature[]>, hole: number, f: Feature) => m.set(hole, [...(m.get(hole) ?? []), f]);
  let ambiguous = 0;
  let unmatched = 0;

  const teeZone = (l: HoleLine) => Math.min(TEE_ZONE_MAX_M, TEE_ZONE_SHARE * lineLength(l.line));
  for (const f of features) {
    if (f.ref !== null) {
      add(f.kind === "tee" ? teesOf : greensOf, f.ref, f);
      continue;
    }
    if (holeLines.length === 0) {
      unmatched++;
      continue;
    }
    const scored = holeLines
      .map((l) => ({
        hole: l.hole,
        d: f.kind === "tee" ? projectOnto(f.at, l.line, teeZone(l)).d : dist(f.at, l.line[l.line.length - 1]),
      }))
      .sort((a, b) => a.d - b.d);
    const [best, second] = scored;
    const max = f.kind === "tee" ? TEE_MAX_M : GREEN_MAX_M;
    if (best.d > max) {
      unmatched++;
      continue;
    }
    if (second && second.d - best.d < AMBIGUITY_MARGIN_M) {
      ambiguous++;
      continue;
    }
    add(f.kind === "tee" ? teesOf : greensOf, best.hole, f);
  }
  if (ambiguous > 0) notes.push(`Ignored ${ambiguous} tee/green feature${ambiguous === 1 ? "" : "s"} that could belong to two holes.`);
  if (unmatched > 0) notes.push(`Ignored ${unmatched} tee/green feature${unmatched === 1 ? "" : "s"} not near any numbered hole.`);

  // Resolve each hole.
  const card = opts.card ?? {};
  const lineByHole = new Map(holeLines.map((l) => [l.hole, l]));
  const numbers = new Set<number>([...lineByHole.keys(), ...teesOf.keys(), ...greensOf.keys()]);
  const holes: OsmHole[] = [];
  let matchedTees = 0;
  let matchedGreens = 0;

  for (const n of [...numbers].sort((a, b) => a - b)) {
    const l = lineByHole.get(n) ?? null;
    const c = card[n];
    const holeTees = teesOf.get(n) ?? [];
    const holeGreens = greensOf.get(n) ?? [];
    matchedTees += holeTees.length;
    matchedGreens += holeGreens.length;

    // Green: the mapped green nearest the line's end (or the only one), else the line's end.
    let green: LatLng | null = null;
    let greenSource: PointSource | null = null;
    if (holeGreens.length > 0) {
      const end = l ? l.line[l.line.length - 1] : null;
      const g = end ? [...holeGreens].sort((a, b) => dist(a.at, end) - dist(b.at, end))[0] : holeGreens.length === 1 ? holeGreens[0] : null;
      if (g) {
        green = g.at;
        greenSource = "green_feature";
      } else {
        notes.push(`Hole ${n}: ${holeGreens.length} greens tagged for it and no hole line to pick one; skipped the green.`);
      }
    } else if (l) {
      green = l.line[l.line.length - 1];
      greenSource = "hole_line";
    }

    // Tee: the box matching the card yardage, else the back tee (first node / farthest box).
    let tee: LatLng | null = null;
    let teeSource: PointSource | null = null;
    let lengthM: number | null = null;
    if (holeTees.length > 0 && l && green) {
      const g = green;
      const options = holeTees.map((t) => ({ t, len: playLength(t.at, l.line, g) }));
      let pick: (typeof options)[number];
      if (c) {
        pick = [...options].sort((a, b) => Math.abs(yd(a.len) - c.yards) - Math.abs(yd(b.len) - c.yards))[0];
      } else {
        const start = l.line[0];
        pick = [...options].sort((a, b) => dist(a.t.at, start) - dist(b.t.at, start))[0];
      }
      tee = pick.t.at;
      teeSource = "tee_feature";
      lengthM = pick.len;
      if (c) {
        const off = Math.abs(yd(pick.len) - c.yards);
        if (off > Math.max(60, 0.25 * c.yards)) {
          notes.push(`Hole ${n}: no tee box near the ${c.yards} yd card (closest plays ${yd(pick.len)} yd); skipped the tee.`);
          tee = null;
          teeSource = null;
          lengthM = null;
        }
      }
    } else if (holeTees.length === 1 && !l) {
      tee = holeTees[0].at;
      teeSource = "tee_feature";
    } else if (holeTees.length > 1 && !l) {
      notes.push(`Hole ${n}: ${holeTees.length} tee boxes tagged for it and no hole line to pick one; skipped the tee.`);
    } else if (l) {
      tee = l.line[0];
      teeSource = "hole_line";
      lengthM = green ? playLength(tee, l.line, green) : lineLength(l.line);
      if (c) {
        const off = Math.abs(yd(lengthM) - c.max_yards);
        if (off > Math.max(80, 0.3 * c.max_yards)) {
          notes.push(`Hole ${n}: the hole line is ${yd(lengthM)} yd but the card says ${c.max_yards} yd from the tips; skipped the tee.`);
          tee = null;
          teeSource = null;
          lengthM = null;
        }
      }
    }

    // Whole-hole sanity: a par 3 that's 500 yd is somebody else's hole.
    if (tee && green) {
      const straight = dist(tee, green);
      if (straight < 40) {
        notes.push(`Hole ${n}: tee and green are only ${fmtM(straight)} apart; skipped.`);
        tee = green = null;
        teeSource = greenSource = null;
        lengthM = null;
      }
    }
    if (l && c && l.par !== null && l.par !== c.par) {
      notes.push(`Hole ${n}: OpenStreetMap says par ${l.par}, the card says par ${c.par}. Double-check it on the map.`);
    }
    if (!tee && !green) continue;
    holes.push({
      hole: n,
      tee: tee ? roundPoint(tee) : null,
      tee_source: teeSource,
      green: green ? roundPoint(green) : null,
      green_source: greenSource,
      tee_boxes: holeTees.length,
      length_yd: lengthM === null ? null : yd(lengthM),
      osm_par: l?.par ?? null,
    });
  }

  return { holes, found, matched: { tees: matchedTees, greens: matchedGreens }, notes };
}

/** 7 decimals ≈ 1 cm. */
export function roundCoord(v: number): number {
  return Math.round(v * 1e7) / 1e7;
}

function roundPoint(p: LatLng): LatLng {
  return { lat: roundCoord(p.lat), lng: roundCoord(p.lng) };
}

// ---------------------------------------------------------------------------
// Planning the prefill
// ---------------------------------------------------------------------------

export interface OsmImportPlan {
  updates: Array<{ hole: number; patch: HoleUpdateOp["patch"] }>;
  /** Hole numbers whose tee / green gets filled (or replaced with force). */
  filled_tees: number[];
  filled_greens: number[];
  /** Found in OSM but left alone because the hole already has a point (no force). */
  kept_tees: number[];
  kept_greens: number[];
  /** Still without a point after the import. */
  missing_tees: number[];
  missing_greens: number[];
}

const hasPoint = (lat: number | null, lng: number | null) => lat !== null && lng !== null;

/** Which points to write: only missing ones unless `force`. Equal points are never rewritten. */
export function planOsmImport(holes: readonly Hole[], parsed: OsmParseResult, opts: { force?: boolean } = {}): OsmImportPlan {
  const force = !!opts.force;
  const plan: OsmImportPlan = {
    updates: [],
    filled_tees: [],
    filled_greens: [],
    kept_tees: [],
    kept_greens: [],
    missing_tees: [],
    missing_greens: [],
  };
  const osm = new Map(parsed.holes.map((h) => [h.hole, h]));
  for (const h of [...holes].sort((a, b) => a.number - b.number)) {
    const o = osm.get(h.number);
    const patch: HoleUpdateOp["patch"] = {};
    const hasTee = hasPoint(h.tee_lat, h.tee_lng);
    const hasGreen = hasPoint(h.green_lat, h.green_lng);
    let teeAfter = hasTee;
    let greenAfter = hasGreen;
    if (o?.tee) {
      const same = hasTee && roundCoord(h.tee_lat!) === o.tee.lat && roundCoord(h.tee_lng!) === o.tee.lng;
      if (!hasTee || (force && !same)) {
        patch.tee_lat = o.tee.lat;
        patch.tee_lng = o.tee.lng;
        plan.filled_tees.push(h.number);
        teeAfter = true;
      } else if (!same) {
        plan.kept_tees.push(h.number);
      }
    }
    if (o?.green) {
      const same = hasGreen && roundCoord(h.green_lat!) === o.green.lat && roundCoord(h.green_lng!) === o.green.lng;
      if (!hasGreen || (force && !same)) {
        patch.green_lat = o.green.lat;
        patch.green_lng = o.green.lng;
        plan.filled_greens.push(h.number);
        greenAfter = true;
      } else if (!same) {
        plan.kept_greens.push(h.number);
      }
    }
    if (!teeAfter) plan.missing_tees.push(h.number);
    if (!greenAfter) plan.missing_greens.push(h.number);
    if (Object.keys(patch).length > 0) plan.updates.push({ hole: h.number, patch });
  }
  return plan;
}

// ---------------------------------------------------------------------------
// The report the route/script hand back
// ---------------------------------------------------------------------------

export interface OsmImportReport {
  /** OpenStreetMap was reached (false: network/Overpass trouble, nothing changed). */
  ok: boolean;
  /** Overpass endpoint that answered. */
  source: string | null;
  /** OSM data timestamp, when Overpass reports it. */
  osm_timestamp: string | null;
  force: boolean;
  dry_run: boolean;
  found: OsmParseResult["found"];
  matched: OsmParseResult["matched"];
  holes: OsmHole[];
  filled_tees: number[];
  filled_greens: number[];
  kept_tees: number[];
  kept_greens: number[];
  missing_tees: number[];
  missing_greens: number[];
  /** hole.update ops applied (0 for a dry run). */
  applied: number;
  /** One-line human summary. */
  message: string;
  notes: string[];
  errors: string[];
}

function holeList(ns: number[]): string {
  return ns.length === 18 ? "all 18" : ns.join(", ");
}

/** One-line summary of an import. */
export function summarizeOsmImport(r: Pick<OsmImportReport, "found" | "filled_tees" | "filled_greens" | "kept_tees" | "kept_greens" | "dry_run" | "holes">): string {
  const { found } = r;
  if (found.hole_lines + found.tees + found.greens === 0) {
    return "OpenStreetMap has nothing for this course. Tap the tees and greens on the map yourself.";
  }
  const parts = [
    `Found ${found.hole_lines} hole line${found.hole_lines === 1 ? "" : "s"}, ${found.tees} tee box${found.tees === 1 ? "" : "es"} and ${found.greens} green${found.greens === 1 ? "" : "s"}.`,
  ];
  if (r.holes.length === 0) {
    parts.push("None of it matched a hole cleanly, so nothing changed.");
    return parts.join(" ");
  }
  const verb = r.dry_run ? "Would fill" : "Filled";
  const filled: string[] = [];
  if (r.filled_tees.length) filled.push(`tees on ${holeList(r.filled_tees)}`);
  if (r.filled_greens.length) filled.push(`greens on ${holeList(r.filled_greens)}`);
  parts.push(filled.length ? `${verb} ${filled.join(" and ")}.` : "Nothing new to fill.");
  const kept = r.kept_tees.length + r.kept_greens.length;
  if (kept) parts.push(`Left ${kept} point${kept === 1 ? "" : "s"} you already placed alone.`);
  return parts.join(" ");
}

export interface PreparedOsmImport {
  parsed: OsmParseResult;
  plan: OsmImportPlan;
  /** hole.update ops for the commissioner to apply (empty for nothing to do). */
  ops: HoleUpdateOp[];
  report: OsmImportReport;
}

/** Parse + plan + build ops against the current trip state. Pure (ids and time are injected). */
export function prepareOsmImport(
  state: Pick<TripState, "holes" | "trip">,
  json: unknown,
  opts: { force?: boolean; dryRun?: boolean; now: ISODate; newId: () => UUID; by?: UUID | null; source?: string | null },
): PreparedOsmImport {
  const card = cardFromHoles(state.holes, state.trip.settings?.tee_set ?? "membership");
  const parsed = parseOverpass(json, { card });
  const plan = planOsmImport(state.holes, parsed, { force: opts.force });
  const ops: HoleUpdateOp[] = opts.dryRun
    ? []
    : plan.updates.map((u) => ({ id: opts.newId(), at: opts.now, by: opts.by ?? null, type: "hole.update", hole: u.hole, patch: u.patch }));
  const timestamp = isOverpassResponse(json) ? (json.osm3s?.timestamp_osm_base ?? null) : null;
  const report: OsmImportReport = {
    ok: true,
    source: opts.source ?? null,
    osm_timestamp: typeof timestamp === "string" ? timestamp : null,
    force: !!opts.force,
    dry_run: !!opts.dryRun,
    found: parsed.found,
    matched: parsed.matched,
    holes: parsed.holes,
    filled_tees: plan.filled_tees,
    filled_greens: plan.filled_greens,
    kept_tees: plan.kept_tees,
    kept_greens: plan.kept_greens,
    missing_tees: plan.missing_tees,
    missing_greens: plan.missing_greens,
    applied: 0,
    message: "",
    notes: [...parsed.notes],
    errors: [],
  };
  report.message = summarizeOsmImport(report);
  return { parsed, plan, ops, report };
}

// ---------------------------------------------------------------------------
// Overpass I/O
// ---------------------------------------------------------------------------

/** golf=hole lines and golf=tee/green features around the club, with inline geometry. */
export function buildOverpassQuery(center: LatLng = OSM_CLUB_NODE, radiusM = OSM_SEARCH_RADIUS_M, timeoutSec = 60): string {
  const around = `(around:${Math.round(radiusM)},${center.lat},${center.lng})`;
  return [
    `[out:json][timeout:${timeoutSec}];`,
    "(",
    `  way["golf"="hole"]${around};`,
    `  way["golf"~"^(tee|green)$"]${around};`,
    `  node["golf"~"^(tee|green)$"]${around};`,
    `  relation["golf"~"^(tee|green)$"]${around};`,
    ");",
    "out geom;",
  ].join("\n");
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface FetchOverpassOptions {
  fetch?: FetchLike;
  endpoints?: readonly string[];
  /** Per endpoint. Default 60 s. */
  timeoutMs?: number;
  query?: string;
}

export type OverpassFetchResult =
  | { ok: true; json: OverpassResponse; endpoint: string; errors: string[] }
  | { ok: false; errors: string[] };

function shortError(e: unknown): string {
  if (e instanceof Error) return e.name === "AbortError" || e.name === "TimeoutError" ? "timed out" : e.message || e.name;
  return String(e);
}

/**
 * POST the query to each endpoint in turn until one answers with usable JSON. An HTML error page
 * ("server too busy"), a non-2xx status, a timeout or an Overpass runtime-error remark all count
 * as failures and move on to the next endpoint. Never throws.
 */
export async function fetchOverpass(opts: FetchOverpassOptions = {}): Promise<OverpassFetchResult> {
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const endpoints = opts.endpoints ?? OVERPASS_ENDPOINTS;
  const timeoutMs = opts.timeoutMs ?? OVERPASS_TIMEOUT_MS;
  const query = opts.query ?? buildOverpassQuery(OSM_CLUB_NODE, OSM_SEARCH_RADIUS_M, Math.max(5, Math.floor(timeoutMs / 1000)));
  const errors: string[] = [];
  for (const endpoint of endpoints) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await doFetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          Accept: "application/json",
          "User-Agent": OSM_USER_AGENT,
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        errors.push(`${endpoint}: HTTP ${res.status}`);
        continue;
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        const busy = /too busy|timeout|rate_limited|runtime error/i.test(text);
        errors.push(`${endpoint}: ${busy ? "server too busy" : "answer wasn't JSON"}`);
        continue;
      }
      if (!isOverpassResponse(json)) {
        errors.push(`${endpoint}: unexpected answer`);
        continue;
      }
      if (typeof json.remark === "string" && /error|timed out|timeout/i.test(json.remark)) {
        errors.push(`${endpoint}: ${json.remark.slice(0, 160)}`);
        continue;
      }
      return { ok: true, json, endpoint, errors };
    } catch (e) {
      errors.push(`${endpoint}: ${shortError(e)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, errors };
}

/** Report for "OpenStreetMap couldn't be reached" (nothing changed). */
export function unreachableReport(errors: string[], opts: { force?: boolean; dryRun?: boolean } = {}): OsmImportReport {
  return {
    ok: false,
    source: null,
    osm_timestamp: null,
    force: !!opts.force,
    dry_run: !!opts.dryRun,
    found: { hole_lines: 0, tees: 0, greens: 0 },
    matched: { tees: 0, greens: 0 },
    holes: [],
    filled_tees: [],
    filled_greens: [],
    kept_tees: [],
    kept_greens: [],
    missing_tees: [],
    missing_greens: [],
    applied: 0,
    message: "Couldn't reach OpenStreetMap (the Overpass servers are flaky). Nothing changed. Try again in a minute, or tap the points on the map.",
    notes: [],
    errors,
  };
}
