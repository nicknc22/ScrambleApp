// Pure geometry for the closest-to-pin green plot. No React, no DOM: unit tested in
// tests/ui/contests-geometry.test.ts.
//
// The plot is an SVG with a square viewBox of PLOT_SIZE units, the pin at the center.
// Angles follow ContestEntry.angle_deg: 0 = up (toward the back of the green), clockwise.
// The scale is linear: 30 ft sits at 44% of the plot size from the pin; anything further
// clamps to that ring (and shows its distance in the label).

export const PLOT_SIZE = 100;
export const PLOT_CENTER = PLOT_SIZE / 2;
/** Labeled rings, in feet. */
export const RING_FT = [5, 10, 20, 30] as const;
/** Distance of the outermost ring; entries further out clamp to it. */
export const MAX_PLOT_FT = 30;
/** Radius of the 30 ft ring in viewBox units (44% of the plot). */
export const MAX_PLOT_RADIUS = 0.44 * PLOT_SIZE;

export interface Point {
  x: number;
  y: number;
}

/** Angle in [0, 360). Non-finite input becomes 180 (short of the pin, the classic miss). */
export function normalizeAngle(deg: number): number {
  if (!Number.isFinite(deg)) return 180;
  const a = deg % 360;
  const n = a < 0 ? a + 360 : a;
  // -0 and floating dust like 359.99999999 stay sane.
  return n >= 360 ? 0 : n === 0 ? 0 : n;
}

/** Radius in viewBox units for a distance in feet, and whether it was clamped to the 30 ft ring. */
export function radiusForFeet(feet: number): { r: number; clamped: boolean } {
  const ft = Number.isFinite(feet) ? Math.max(0, feet) : 0;
  const clamped = ft > MAX_PLOT_FT;
  return { r: (Math.min(ft, MAX_PLOT_FT) / MAX_PLOT_FT) * MAX_PLOT_RADIUS, clamped };
}

/** Polar (radius in viewBox units, angle 0 = up, clockwise) to viewBox x/y. */
export function polarToPoint(r: number, angleDeg: number, center: Point = { x: PLOT_CENTER, y: PLOT_CENTER }): Point {
  const t = (normalizeAngle(angleDeg) * Math.PI) / 180;
  return { x: center.x + r * Math.sin(t), y: center.y - r * Math.cos(t) };
}

/** Where an entry sits on the plot: its distance (clamped to 30 ft) at its angle. */
export function plotPosition(feet: number, angleDeg: number | null | undefined): Point & { clamped: boolean } {
  const { r, clamped } = radiusForFeet(feet);
  const p = polarToPoint(r, angleDeg ?? 180);
  return { ...p, clamped };
}

/** Angle (0 = up, clockwise, [0, 360)) of a point relative to the center. The center itself is 180. */
export function angleFromPoint(p: Point, center: Point = { x: PLOT_CENTER, y: PLOT_CENTER }): number {
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return 180;
  // atan2(x, -y): 0 when straight up, 90 to the right.
  return normalizeAngle((Math.atan2(dx, -dy) * 180) / Math.PI);
}

/** A pointer position (client px) inside an element's bounding rect, in viewBox units. */
export function clientToViewBox(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  size: number = PLOT_SIZE,
): Point {
  const w = rect.width > 0 ? rect.width : 1;
  const h = rect.height > 0 ? rect.height : 1;
  return { x: ((clientX - rect.left) / w) * size, y: ((clientY - rect.top) / h) * size };
}

/** Pointer (client px) to marker angle around the pin. */
export function pointerToAngle(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }): number {
  return angleFromPoint(clientToViewBox(clientX, clientY, rect));
}

/** Snap an angle to the nearest `step` degrees (keyboard nudges, cleaner stored values). */
export function snapAngle(deg: number, step = 1): number {
  if (!(step > 0)) return normalizeAngle(deg);
  return normalizeAngle(Math.round(normalizeAngle(deg) / step) * step);
}

/**
 * Golfer-speak for a marker angle (the pin is "up" = toward the back of the green):
 * 0 long, 90 right, 180 short, 270 left, diagonals combine ("Long right").
 */
export function sideOfPin(angleDeg: number): string {
  const a = normalizeAngle(angleDeg);
  const sector = Math.round(a / 45) % 8;
  return ["Long", "Long right", "Right", "Short right", "Short", "Short left", "Left", "Long left"][sector];
}

// ---------------------------------------------------------------------------
// Feet + inches
// ---------------------------------------------------------------------------

/** ctp distance_value from the feet/inches inputs. Inches clamp to 0..11, everything to >= 0. */
export function feetInchesToFeet(feet: number, inches: number): number {
  const f = Number.isFinite(feet) ? Math.max(0, Math.trunc(feet)) : 0;
  const i = Number.isFinite(inches) ? Math.min(11, Math.max(0, Math.trunc(inches))) : 0;
  return f + i / 12;
}

/** Split decimal feet into whole feet + inches, rounded to the nearest inch (12" carries into a foot). */
export function feetToFeetInches(value: number): { feet: number; inches: number } {
  const total = Number.isFinite(value) ? Math.max(0, Math.round(value * 12)) : 0;
  return { feet: Math.floor(total / 12), inches: total % 12 };
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export interface LabelInput {
  id: string;
  /** Dot position in viewBox units. */
  x: number;
  y: number;
  text: string;
}

export interface LabelBox {
  id: string;
  /** Top-left of the label box. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Which side of the dot the label sits on. */
  side: "left" | "right";
  /** Where the leader line from the dot meets the label. */
  anchorX: number;
  anchorY: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LabelLayoutOptions {
  fontSize?: number;
  /** Gap between dot and label. */
  gap?: number;
  /** Viewbox size (labels stay inside). */
  size?: number;
  /** Things labels must not cover (other dots, the pin). */
  obstacles?: readonly Box[];
}

/** Rough text width in viewBox units for a bold sans font (no DOM measuring on the server). */
export function estimateTextWidth(text: string, fontSize: number): number {
  let units = 0;
  for (const ch of Array.from(text)) {
    if (/[\u{1F000}-\u{1FFFF}\u2600-\u27BF]/u.test(ch)) units += 1.15;
    else if (/[MW@%]/.test(ch)) units += 0.9;
    else if (/[A-Z0-9]/.test(ch)) units += 0.68;
    else if (/[ilj.,'"!|:;]/.test(ch)) units += 0.3;
    else if (ch === " ") units += 0.3;
    else units += 0.58;
  }
  return units * fontSize;
}

export function boxesOverlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Square box around a dot (for label obstacles). */
export function dotBox(x: number, y: number, r: number): Box {
  return { x: x - r, y: y - r, w: 2 * r, h: 2 * r };
}

/**
 * Place name labels next to their dots without covering each other, other dots or the pin.
 * Labels go on the side away from the pin (right of it -> right), flip when that runs off the
 * plot, then nudge down/up past collisions. Deterministic; input order is the priority (place the
 * leader first so it keeps its natural spot).
 */
export function layoutLabels(points: readonly LabelInput[], opts: LabelLayoutOptions = {}): LabelBox[] {
  const fontSize = opts.fontSize ?? 3.6;
  const gap = opts.gap ?? 2.6;
  const size = opts.size ?? PLOT_SIZE;
  const obstacles = opts.obstacles ?? [];
  const padX = fontSize * 0.45;
  const h = fontSize * 1.45;
  const step = h * 0.55;
  const center = size / 2;
  const clampY = (y: number) => Math.min(Math.max(0, y), size - h);
  const placed: LabelBox[] = [];
  const free = (b: Box) => !placed.some((q) => boxesOverlap(b, q)) && !obstacles.some((o) => boxesOverlap(b, o));

  for (const p of points) {
    const w = Math.min(size, estimateTextWidth(p.text, fontSize) + padX * 2);
    const fits = (side: "left" | "right") => (side === "right" ? p.x + gap + w <= size : p.x - gap - w >= 0);
    const preferred: "left" | "right" = p.x >= center ? "right" : "left";
    const other: "left" | "right" = preferred === "right" ? "left" : "right";
    const sides = [preferred, other].filter(fits);
    if (sides.length === 0) sides.push("right");

    const boxFor = (side: "left" | "right", y: number): LabelBox => {
      const x = Math.min(Math.max(0, side === "right" ? p.x + gap : p.x - gap - w), size - w);
      return { id: p.id, x, y: clampY(y), w, h, side, anchorX: side === "right" ? x : x + w, anchorY: 0 };
    };

    let chosen: LabelBox | null = null;
    for (const side of sides) {
      const base = p.y - h / 2;
      for (let i = 0; i <= 24; i++) {
        const k = Math.ceil(i / 2) * step;
        const box = boxFor(side, i === 0 ? base : i % 2 === 1 ? base + k : base - k);
        if (free(box)) {
          chosen = box;
          break;
        }
      }
      if (chosen) break;
    }
    // Hopelessly crowded: natural spot on the preferred side (overlap beats vanishing).
    if (!chosen) chosen = boxFor(sides[0], p.y - h / 2);
    chosen.anchorY = chosen.y + h / 2;
    placed.push(chosen);
  }
  return placed;
}
