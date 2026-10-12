// Jack Frost National (1 Jack Frost Mountain Rd, Blakeslee, PA) — par 72.
// Source: GolfingRecord scorecard. Verify against the card at the course.
// Yardage is display only; long drive uses each hole's tee point (set on the Course screen).
import type { HoleContest, TeeSet } from "./types";

export interface CourseHoleSeed {
  number: number;
  par: number;
  stroke_index: number;
  yardage: Record<TeeSet, number>;
  contest: HoleContest;
}

export const JACK_FROST_NAME = "Jack Frost National";

export const JACK_FROST_HOLES: readonly CourseHoleSeed[] = [
  { number: 1, par: 4, stroke_index: 11, yardage: { advanced: 415, membership: 380, forward: 354 }, contest: "none" },
  { number: 2, par: 4, stroke_index: 5, yardage: { advanced: 365, membership: 324, forward: 283 }, contest: "none" },
  { number: 3, par: 3, stroke_index: 17, yardage: { advanced: 175, membership: 169, forward: 162 }, contest: "ctp" },
  { number: 4, par: 5, stroke_index: 7, yardage: { advanced: 527, membership: 492, forward: 463 }, contest: "ld" },
  { number: 5, par: 4, stroke_index: 15, yardage: { advanced: 338, membership: 329, forward: 291 }, contest: "none" },
  { number: 6, par: 4, stroke_index: 3, yardage: { advanced: 424, membership: 415, forward: 366 }, contest: "none" },
  { number: 7, par: 4, stroke_index: 9, yardage: { advanced: 413, membership: 376, forward: 367 }, contest: "none" },
  { number: 8, par: 3, stroke_index: 13, yardage: { advanced: 196, membership: 168, forward: 152 }, contest: "ctp" },
  { number: 9, par: 5, stroke_index: 1, yardage: { advanced: 495, membership: 471, forward: 434 }, contest: "ld" },
  { number: 10, par: 4, stroke_index: 8, yardage: { advanced: 436, membership: 407, forward: 365 }, contest: "none" },
  { number: 11, par: 3, stroke_index: 18, yardage: { advanced: 147, membership: 144, forward: 130 }, contest: "ctp" },
  { number: 12, par: 5, stroke_index: 2, yardage: { advanced: 560, membership: 496, forward: 428 }, contest: "ld" },
  { number: 13, par: 4, stroke_index: 10, yardage: { advanced: 367, membership: 335, forward: 297 }, contest: "none" },
  { number: 14, par: 4, stroke_index: 6, yardage: { advanced: 464, membership: 436, forward: 407 }, contest: "none" },
  { number: 15, par: 4, stroke_index: 14, yardage: { advanced: 354, membership: 349, forward: 313 }, contest: "none" },
  { number: 16, par: 3, stroke_index: 16, yardage: { advanced: 172, membership: 162, forward: 140 }, contest: "ctp" },
  { number: 17, par: 4, stroke_index: 12, yardage: { advanced: 389, membership: 368, forward: 334 }, contest: "none" },
  { number: 18, par: 5, stroke_index: 4, yardage: { advanced: 504, membership: 476, forward: 443 }, contest: "ld" },
];

/** Every par 3 is closest to pin, every par 5 is long drive. */
export function contestForPar(par: number): HoleContest {
  if (par === 3) return "ctp";
  if (par === 5) return "ld";
  return "none";
}

/** Rough center of the course, for the satellite map's initial view. */
export const JACK_FROST_CENTER = { lat: 41.0954, lng: -75.6716 };
