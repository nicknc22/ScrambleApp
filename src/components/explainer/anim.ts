// Tiny animation kit for the explainer's cartoons. Every frame is a pure function of the scene
// clock `t` (ms), so pausing, scrubbing (?scene=&at=), reduced motion (one hero frame) and video
// recording all come for free. No timers, no CSS keyframes, no randomness.

export const clamp01 = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x);
export const lerp = (a: number, b: number, p: number) => a + (b - a) * p;

/** Progress 0..1 of `t` through [start, end] (0 before, 1 after). */
export function seg(t: number, start: number, end: number): number {
  if (end <= start) return t >= end ? 1 : 0;
  return clamp01((t - start) / (end - start));
}

export const easeOut = (p: number) => 1 - (1 - p) * (1 - p) * (1 - p);
export const easeIn = (p: number) => p * p * p;
export const easeInOut = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
/** Overshoots a little, then settles: stickers slapping on. */
export function easeOutBack(p: number): number {
  const c1 = 1.9;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
}

/** Pop-in scale: 0 before `start`, overshoot, 1 after `start + dur`. */
export const pop = (t: number, start: number, dur = 320) => (t < start ? 0 : easeOutBack(seg(t, start, start + dur)));

/** Opacity fade in over [start, start + dur]. */
export const fadeIn = (t: number, start: number, dur = 220) => seg(t, start, start + dur);

/** A smooth 0..1..0 wobble with period `ms` (for bobbing and shaking). */
export const wave = (t: number, ms: number, phase = 0) => Math.sin(((t / ms) * 2 + phase) * Math.PI);

export interface Pt {
  x: number;
  y: number;
}

/** Piecewise-linear (eased) path through keyframes [{at, x, y}], held before the first and after the last. */
export function track(t: number, keys: Array<{ at: number } & Pt>, ease: (p: number) => number = easeInOut): Pt {
  if (keys.length === 0) return { x: 0, y: 0 };
  if (t <= keys[0].at) return { x: keys[0].x, y: keys[0].y };
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1];
    const b = keys[i];
    if (t <= b.at) {
      const p = ease(seg(t, a.at, b.at));
      return { x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p) };
    }
  }
  const last = keys[keys.length - 1];
  return { x: last.x, y: last.y };
}

/** Same as track() for a single number. */
export function trackNum(t: number, keys: Array<{ at: number; v: number }>, ease: (p: number) => number = easeInOut): number {
  return track(
    t,
    keys.map((k) => ({ at: k.at, x: k.v, y: 0 })),
    ease,
  ).x;
}

/**
 * Two-bone arm: shoulder -> elbow -> hand, bones `l1` and `l2`. Returns the elbow for a hand
 * target (clamped to reach). `bend` 1 or -1 picks which side the elbow sticks out.
 */
export function elbowFor(shoulder: Pt, hand: Pt, l1: number, l2: number, bend: 1 | -1): { elbow: Pt; hand: Pt } {
  let dx = hand.x - shoulder.x;
  let dy = hand.y - shoulder.y;
  let d = Math.hypot(dx, dy);
  const max = l1 + l2 - 0.001;
  const min = Math.abs(l1 - l2) + 0.001;
  if (d < 1e-6) {
    dx = 0;
    dy = 1;
    d = min;
  }
  const reach = Math.max(min, Math.min(max, d));
  const ux = dx / d;
  const uy = dy / d;
  const h = { x: shoulder.x + ux * reach, y: shoulder.y + uy * reach };
  // Distance from the shoulder along the shoulder-hand line to the elbow's foot, then out sideways.
  const a = (l1 * l1 - l2 * l2 + reach * reach) / (2 * reach);
  const off = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const elbow = { x: shoulder.x + ux * a - uy * off * bend, y: shoulder.y + uy * a + ux * off * bend };
  return { elbow, hand: h };
}

/** Deterministic pseudo-random numbers in [0, 1) from a seed (confetti, foam). */
export function rand(seed: number): number {
  let x = (Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) >>> 0) || 1;
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35) >>> 0;
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** Number shown by a counter rolling from `from` to `to` over [start, end]. */
export const countUp = (t: number, start: number, end: number, from: number, to: number) => Math.round(lerp(from, to, easeOut(seg(t, start, end))));
