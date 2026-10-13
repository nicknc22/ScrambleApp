// Pure helpers for the commissioner Course editor (unit-tested in tests/ui/course-model.test.ts).
import type { Hole, HoleContest, TeeSet } from "@/lib/types";
import type { HoleUpdateOp } from "@/lib/ops";
import { haversineYards } from "@/lib/engine/geo";
import { JACK_FROST_CENTER } from "@/lib/course";

export interface LatLng {
  lat: number;
  lng: number;
}

export type PointKind = "tee" | "green";

export const TEE_SETS: readonly TeeSet[] = ["advanced", "membership", "forward"];
export const TEE_SET_LABEL: Record<TeeSet, string> = { advanced: "Advanced", membership: "Membership", forward: "Forward" };
export const TEE_SET_SHORT: Record<TeeSet, string> = { advanced: "Adv", membership: "Member", forward: "Fwd" };

export function contestLabel(c: HoleContest): string | null {
  if (c === "ctp") return "Closest to pin";
  if (c === "ld") return "Long drive";
  return null;
}

export function teeOf(h: Pick<Hole, "tee_lat" | "tee_lng">): LatLng | null {
  return h.tee_lat !== null && h.tee_lng !== null ? { lat: h.tee_lat, lng: h.tee_lng } : null;
}

export function greenOf(h: Pick<Hole, "green_lat" | "green_lng">): LatLng | null {
  return h.green_lat !== null && h.green_lng !== null ? { lat: h.green_lat, lng: h.green_lng } : null;
}

export function pointOf(h: Pick<Hole, "tee_lat" | "tee_lng" | "green_lat" | "green_lng">, kind: PointKind): LatLng | null {
  return kind === "tee" ? teeOf(h) : greenOf(h);
}

/** Long drive is measured from the tee point: par 5s (ld holes) without one can't be measured. */
export function needsLdTee(h: Pick<Hole, "contest" | "tee_lat" | "tee_lng">): boolean {
  return h.contest === "ld" && teeOf(h) === null;
}

export interface CourseSummary {
  holes: number;
  par: number;
  yards: Record<TeeSet, number>;
  tees: number;
  greens: number;
  /** Long-drive holes (par 5s). */
  ldHoles: number[];
  /** Long-drive holes still missing their tee point (REQUIRED). */
  ldMissing: number[];
  /** Holes missing a tee or a green. */
  incomplete: number[];
}

export function courseSummary(holes: readonly Hole[]): CourseSummary {
  const sorted = [...holes].sort((a, b) => a.number - b.number);
  const yards = { advanced: 0, membership: 0, forward: 0 } as Record<TeeSet, number>;
  for (const h of sorted) for (const t of TEE_SETS) yards[t] += Number(h.yardage?.[t]) || 0;
  return {
    holes: sorted.length,
    par: sorted.reduce((s, h) => s + h.par, 0),
    yards,
    tees: sorted.filter((h) => teeOf(h)).length,
    greens: sorted.filter((h) => greenOf(h)).length,
    ldHoles: sorted.filter((h) => h.contest === "ld").map((h) => h.number),
    ldMissing: sorted.filter(needsLdTee).map((h) => h.number),
    incomplete: sorted.filter((h) => !teeOf(h) || !greenOf(h)).map((h) => h.number),
  };
}

/** Straight-line tee -> green yards, or null without both points. */
export function teeToGreenYards(tee: LatLng | null, green: LatLng | null): number | null {
  if (!tee || !green) return null;
  return haversineYards(tee, green);
}

export type CardCheck = "ok" | "short" | "long";

/**
 * Compare the straight-line distance with the card yardage. Doglegs play longer than the straight
 * line, so "short" only trips well below the card; anything longer than the card is suspicious.
 */
export function cardCheck(straightYd: number | null, cardYd: number | null | undefined): CardCheck | null {
  if (straightYd === null || !cardYd || cardYd <= 0) return null;
  const diff = straightYd - cardYd;
  if (diff > Math.max(40, 0.12 * cardYd)) return "long";
  if (-diff > Math.max(60, 0.25 * cardYd)) return "short";
  return "ok";
}

export interface HoleDraft {
  par: number;
  stroke_index: number;
  yardage: Record<TeeSet, number>;
}

export function draftOf(h: Hole): HoleDraft {
  return {
    par: h.par,
    stroke_index: h.stroke_index,
    yardage: { advanced: h.yardage.advanced, membership: h.yardage.membership, forward: h.yardage.forward },
  };
}

/** Problems that block saving (same limits as the reducer), keyed by field. */
export function draftErrors(d: HoleDraft): Partial<Record<"par" | "stroke_index" | TeeSet, string>> {
  const out: Partial<Record<"par" | "stroke_index" | TeeSet, string>> = {};
  if (!Number.isInteger(d.par) || d.par < 3 || d.par > 6) out.par = "Par is 3 to 6.";
  if (!Number.isInteger(d.stroke_index) || d.stroke_index < 1 || d.stroke_index > 18) out.stroke_index = "Stroke index is 1 to 18.";
  for (const t of TEE_SETS) {
    const y = d.yardage[t];
    if (!Number.isFinite(y) || y < 0 || y > 1000) out[t] = "0 to 1000 yd.";
  }
  return out;
}

/** Only the fields that changed (an empty object means nothing to save). */
export function holeDraftPatch(h: Hole, d: HoleDraft): HoleUpdateOp["patch"] {
  const patch: HoleUpdateOp["patch"] = {};
  if (d.par !== h.par) patch.par = d.par;
  if (d.stroke_index !== h.stroke_index) patch.stroke_index = d.stroke_index;
  const changed: Partial<Record<TeeSet, number>> = {};
  for (const t of TEE_SETS) if (d.yardage[t] !== h.yardage[t]) changed[t] = d.yardage[t];
  if (Object.keys(changed).length > 0) patch.yardage = changed as Record<TeeSet, number>;
  return patch;
}

/** Points draft for the map sheet. undefined = untouched, null = cleared. */
export interface PointsDraft {
  tee?: LatLng | null;
  green?: LatLng | null;
}

const roundCoord = (v: number) => Math.round(v * 1e7) / 1e7;
const samePoint = (a: LatLng | null, b: LatLng | null) =>
  a === b || (!!a && !!b && roundCoord(a.lat) === roundCoord(b.lat) && roundCoord(a.lng) === roundCoord(b.lng));

/** hole.update patch for changed points (coordinates rounded to 7 decimals ≈ 1 cm). */
export function pointsPatch(h: Hole, d: PointsDraft): HoleUpdateOp["patch"] {
  const patch: HoleUpdateOp["patch"] = {};
  if (d.tee !== undefined && !samePoint(d.tee, teeOf(h))) {
    patch.tee_lat = d.tee ? roundCoord(d.tee.lat) : null;
    patch.tee_lng = d.tee ? roundCoord(d.tee.lng) : null;
  }
  if (d.green !== undefined && !samePoint(d.green, greenOf(h))) {
    patch.green_lat = d.green ? roundCoord(d.green.lat) : null;
    patch.green_lng = d.green ? roundCoord(d.green.lng) : null;
  }
  return patch;
}

/** The point as currently drafted (draft wins over the saved row). */
export function draftedPoint(h: Hole, d: PointsDraft, kind: PointKind): LatLng | null {
  const v = d[kind];
  return v === undefined ? pointOf(h, kind) : v;
}

/** Where to start placing: the first long-drive hole missing its tee, else the first incomplete hole, else 1. */
export function firstHoleToPlace(holes: readonly Hole[]): number {
  const s = courseSummary(holes);
  return s.ldMissing[0] ?? s.incomplete[0] ?? 1;
}

/** Which point to place first on a hole: the tee unless it's set and the green isn't. */
export function initialMode(h: Hole): PointKind {
  return teeOf(h) && !greenOf(h) ? "green" : "tee";
}

export interface MapView {
  center: LatLng;
  zoom: number;
  /** Fit these when there are two or more. */
  fit: LatLng[] | null;
}

/**
 * Initial view for a hole: its own points; else next to the previous hole's green (the next tee
 * is usually a short walk away); else the course center.
 */
export function viewForHole(hole: Hole, holes: readonly Hole[]): MapView {
  const pts = [teeOf(hole), greenOf(hole)].filter((p): p is LatLng => p !== null);
  if (pts.length === 2) return { center: midpoint(pts[0], pts[1]), zoom: 17, fit: pts };
  if (pts.length === 1) return { center: pts[0], zoom: 17, fit: null };
  const prev = holes.find((h) => h.number === hole.number - 1);
  const anchor = prev ? (greenOf(prev) ?? teeOf(prev)) : null;
  if (anchor) return { center: anchor, zoom: 17, fit: null };
  return { center: { ...JACK_FROST_CENTER }, zoom: 16, fit: null };
}

export function midpoint(a: LatLng, b: LatLng): LatLng {
  return { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
}

/** Stroke indexes used by more than one hole (soft warning: the card should have 1..18 once each). */
export function duplicateStrokeIndexes(holes: readonly Pick<Hole, "number" | "stroke_index">[]): Map<number, number[]> {
  const by = new Map<number, number[]>();
  for (const h of holes) by.set(h.stroke_index, [...(by.get(h.stroke_index) ?? []), h.number]);
  return new Map([...by].filter(([, ns]) => ns.length > 1));
}

/** "41.09479, -75.64798" */
export function formatPoint(p: LatLng | null): string {
  return p ? `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}` : "Not set";
}
